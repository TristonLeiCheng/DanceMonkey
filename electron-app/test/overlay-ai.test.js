const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../src/app.js"), "utf8");
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
const tick = () => new Promise(setImmediate);

function setup(overrides = {}) {
  const input = { value: "", style: {}, scrollHeight: 65 };
  const send = { disabled: true };
  const box = { scrollHeight: 500, scrollTop: 400, clientHeight: 100 };
  const body = { innerHTML: "" };
  const calls = [], saved = [], renders = [];
  const settings = { model: "test-model", globalChatSystemPrompt: "default prompt", promptSnippets: [{ systemPrompt: "selected prompt" }] };
  let chunk;
  const context = vm.createContext({
    root: { querySelector: (selector) => ({ ".ai-input": input, '[data-act="send-ai"]': send, ".ai-messages": box, ".ai-message.streaming .ai-message-body": body })[selector] || null },
    api: { ai: {
      getSettings: overrides.getSettings || (async () => settings),
      chat: async (payload) => { calls.push(payload); return overrides.chat ? overrides.chat(payload) : { success: true, text: "reply" }; },
      cancel: overrides.cancel || (async () => {}),
      onChunk: (callback) => { chunk = callback; },
    } },
    persist: async (partial) => { if (overrides.persist) await overrides.persist(partial); saved.push(partial); },
    renders, newId: () => "test-request", focusLater: () => {}, renderAiMarkdown: (text) => text,
  });
  vm.runInContext(`
    let aiDraft = '', aiBusy = false, aiStopping = false, aiError = '', aiNotice = '', aiStreamingText = '', aiRequestId = null;
    let aiSettings = null, activeSnippet = '', state = { aiMessages: [] };
    function render() { renders.push({ aiBusy, aiStopping, aiDraft, aiError, aiNotice }); }
    ${section("    function bindAiComposer()", "    async function openAiPanel()")}
    ${section("    async function sendAi()", "    function createBook()")}
    ${section("    api.ai.onChunk(", "    function focusLater(")}
  `, context);
  const run = (code) => vm.runInContext(code, context);
  run("bindAiComposer()");
  return { run, input, send, box, body, calls, saved, renders, chunk: (value) => chunk(value) };
}

test("IME candidates and Shift+Enter never send; ordinary Enter sends once", async () => {
  const h = setup();
  h.input.value = "中文输入"; h.input.oninput();
  let prevented = 0;
  for (const flags of [{ isComposing: true }, { keyCode: 229 }, { shiftKey: true }]) {
    h.input.onkeydown({ key: "Enter", preventDefault: () => { prevented += 1; }, ...flags });
  }
  await tick();
  assert.equal(h.calls.length, 0);
  assert.equal(prevented, 0);
  h.input.onkeydown({ key: "Enter", preventDefault: () => { prevented += 1; } });
  await tick();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].messages[0].content, "中文输入");
  assert.equal(prevented, 1);
});

test("composer sizes to its draft and disables blank submission", async () => {
  const h = setup();
  h.input.value = "  \n "; h.input.oninput();
  assert.equal(h.send.disabled, true);
  await h.run("sendAi()");
  assert.equal(h.calls.length, 0);
  h.input.value = "a longer draft"; h.input.scrollHeight = 500; h.input.oninput();
  assert.equal(h.send.disabled, false);
  assert.equal(h.input.style.height, "132px");
  h.input.value = "short"; h.input.scrollHeight = 40; h.input.oninput();
  assert.equal(h.input.style.height, "58px");
});

test("busy starts before settings load so rapid Enter cannot duplicate a request", async () => {
  let finishSettings;
  const h = setup({ getSettings: () => new Promise((resolve) => { finishSettings = resolve; }) });
  h.run("aiDraft = 'one question'");
  const first = h.run("sendAi()");
  await h.run("sendAi()");
  assert.equal(h.run("aiBusy"), true);
  finishSettings({ model: "model", globalChatSystemPrompt: "default" });
  await first;
  assert.equal(h.calls.length, 1);
  assert.equal(h.run("aiBusy"), false);
});

test("IPC rejection and settings failure release the composer and preserve input/history", async () => {
  const failedSettings = setup({ getSettings: async () => { throw new Error("settings unavailable"); } });
  failedSettings.run("aiDraft = 'keep my question'");
  await failedSettings.run("sendAi()");
  assert.equal(failedSettings.run("aiBusy"), false);
  assert.equal(failedSettings.run("aiDraft"), "keep my question");
  assert.match(failedSettings.run("aiError"), /settings unavailable/);

  const rejected = setup({ chat: async () => { throw new Error("IPC unavailable"); } });
  rejected.run("aiDraft = 'question'");
  await rejected.run("sendAi()");
  assert.equal(rejected.run("aiBusy"), false);
  assert.equal(rejected.saved[0].aiMessages[0].content, "question");
  assert.match(rejected.run("aiError"), /IPC unavailable/);
});

test("stopping keeps partial text and does not present cancellation as an error", async () => {
  let finish, cancelled = 0;
  const h = setup({ chat: () => new Promise((resolve) => { finish = resolve; }), cancel: async () => { cancelled += 1; } });
  h.run("aiDraft = 'question'");
  const pending = h.run("sendAi()");
  await tick();
  h.chunk({ requestId: "test-request", chunk: "已生成的片段" });
  await h.run("stopAi()");
  await h.run("stopAi()");
  assert.equal(cancelled, 1);
  assert.equal(h.run("aiStopping"), true);
  finish({ success: false, error: "aborted" });
  await pending;
  assert.equal(h.saved[0].aiMessages[1].content, "已生成的片段");
  assert.equal(h.run("aiError"), "");
  assert.match(h.run("aiNotice"), /已停止.*已保留/);
  assert.equal(h.run("aiBusy"), false);
});

test("stopping while settings load prevents the request from starting", async () => {
  let finishSettings;
  const h = setup({ getSettings: () => new Promise((resolve) => { finishSettings = resolve; }) });
  h.run("aiDraft = 'unsent question'");
  const pending = h.run("sendAi()");
  await h.run("stopAi()");
  finishSettings({ model: "model" });
  await pending;
  assert.equal(h.calls.length, 0);
  assert.equal(h.run("aiDraft"), "unsent question");
  assert.equal(h.run("aiBusy"), false);
});

test("history write failure cannot leave generation busy or duplicate the reply", async () => {
  const h = setup({ persist: async () => { throw new Error("disk full"); } });
  await h.run("aiDraft = 'question'; sendAi()");
  assert.equal(h.calls.length, 1);
  assert.equal(h.run("aiBusy"), false);
  assert.equal(h.run("state.aiMessages.length"), 2);
  assert.equal(h.run("state.aiMessages[1].content"), "reply");
  assert.match(h.run("aiError"), /保存失败.*disk full/);
});

test("default prompt selection restores configured prompt after a snippet", async () => {
  const h = setup();
  await h.run("aiDraft = 'one'; activeSnippet = '0'; sendAi()");
  await h.run("aiDraft = 'two'; activeSnippet = ''; sendAi()");
  assert.equal(h.calls[0].systemPrompt, "selected prompt");
  assert.equal(h.calls[1].systemPrompt, "default prompt");
  assert.equal(h.run("aiSettings.globalChatSystemPrompt"), "default prompt");
});

test("streaming follows the bottom but does not move a reader reviewing earlier text", () => {
  const h = setup();
  h.run("aiRequestId = 'test-request'");
  h.box.scrollTop = 25;
  h.chunk({ requestId: "test-request", chunk: "first" });
  assert.equal(h.body.innerHTML, "first");
  assert.equal(h.box.scrollTop, 25);
  h.box.scrollTop = 390;
  h.chunk({ requestId: "test-request", chunk: " second" });
  assert.equal(h.box.scrollTop, 500);
  h.chunk({ requestId: "stale-request", chunk: "ignored" });
  assert.equal(h.body.innerHTML, "first second");
});
