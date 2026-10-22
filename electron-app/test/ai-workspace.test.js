const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const settings = {
  model: "test-model",
  globalChatSystemPrompt: "GLOBAL DEFAULT",
  modelProfiles: [{ model: "test-model", name: "Test" }],
  promptSnippets: [{ title: "First", systemPrompt: "SELECTED PROMPT" }],
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const clone = (value) => JSON.parse(JSON.stringify(value));
const escape = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const unescape = (value) => value.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

function fixture(options = {}) {
  const calls = { getSettings: [], saveSettings: [], setState: [], chat: [], cancel: [], copied: [] };
  let saved = { aiMessages: clone(options.messages || []) };
  let chunkListener = null;
  let unsubscribeCount = 0;
  function element(value = "") {
    return { value, textContent: "", innerHTML: "", disabled: false, style: {}, dataset: {},
      scrollHeight: 1000, clientHeight: 300, scrollTop: 700,
      classList: { contains: () => false, toggle() {}, add() {}, remove() {} },
      focus() {}, setSelectionRange() {}, setAttribute() {}, removeAttribute() {},
      addEventListener(name, handler) { this[`on${name}`] = handler; },
      removeEventListener(name) { this[`on${name}`] = null; },
      scrollTo({ top }) { this.scrollTop = top; },
    };
  }
  const nodes = {
    input: element(), model: element("test-model"), snippet: element(),
    messages: element(), body: element(), status: element(), send: element(),
  };
  const selectors = new Map([
    [".ws-ai-input", nodes.input], [".ws-ai-model", nodes.model], [".ws-ai-snippet", nodes.snippet],
    [".ws-ai-messages", nodes.messages], [".ws-ai-message.streaming .ws-ai-message-body", nodes.body],
    [".ws-ai-status", nodes.status], [".ws-ai-send", nodes.send],
    ['[data-module-action="ai-send"]', nodes.send],
  ]);
  const document = { querySelector: (selector) => selectors.get(selector) || null, querySelectorAll: () => [] };
  const api = {
    platform: "darwin",
    getState: async () => clone(saved),
    setState: async (next) => {
      calls.setState.push(clone(next));
      if (options.setState) await options.setState(next);
      saved = clone(next);
      return clone(saved);
    },
    ai: {
      getSettings: async () => {
        calls.getSettings.push(true);
        return options.getSettings ? options.getSettings() : clone(settings);
      },
      saveSettings: async (value) => {
        calls.saveSettings.push(clone(value));
        return options.saveSettings ? options.saveSettings(value) : clone(value);
      },
      chat: async (value) => {
        calls.chat.push(clone(value));
        return options.chat ? options.chat(value) : { success: true, text: "Answer" };
      },
      cancel: async (id) => {
        calls.cancel.push(id);
        if (options.cancel) return options.cancel(id);
        return { success: true };
      },
      onChunk: (listener) => {
        chunkListener = listener;
        return () => { if (chunkListener === listener) chunkListener = null; unsubscribeCount += 1; };
      },
    },
  };
  const clipboard = { writeText: async (text) => { calls.copied.push(text); } };
  const context = vm.createContext({
    window: { DMZenModel: require("../src/zen-model"), navigator: { clipboard }, ...options.window },
    document, navigator: { clipboard }, console, setTimeout, clearTimeout,
    requestAnimationFrame: (callback) => { callback(); return 1; },
    cancelAnimationFrame() {},
  });
  for (const file of ["project-manager.js", "workspace-modules.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../src", file), "utf8"), context);
  }
  let modules;
  function render() {
    const html = modules.render("ai");
    const input = html.match(/<textarea\b[^>]*class="[^"]*ws-ai-input[^>]*>([\s\S]*?)<\/textarea>/);
    if (input) nodes.input.value = unescape(input[1]);
    const send = html.match(/<button\b[^>]*data-module-action="ai-send"[^>]*>/);
    nodes.send.disabled = !!send && /\bdisabled\b/.test(send[0]);
    modules.bindSearch(document);
    return html;
  }
  modules = context.window.DMWorkspaceModules.create(api, { esc: escape, attr: escape, rerender: () => render() });
  function input(value) {
    nodes.input.value = value;
    nodes.input.oninput?.({ target: nodes.input });
  }
  async function click(action, value = "") {
    return modules.handleClick({ target: {
      classList: { contains: () => false },
      closest: () => ({ dataset: { moduleAction: action, value: String(value) } }),
    }, preventDefault() {}, stopPropagation() {} });
  }
  render();
  return { modules, nodes, api, calls, render, input, click,
    messages: () => saved.aiMessages,
    emit: (requestId, chunk) => chunkListener?.({ requestId, chunk }),
    unsubscribeCount: () => unsubscribeCount,
  };
}

for (const stage of ["getSettings", "saveSettings", "setState"]) {
  test(`AI sending acquires one busy lock before awaiting ${stage}`, async () => {
    const gate = deferred();
    let entered = 0;
    const f = fixture({ [stage]: async (value) => {
      entered += 1;
      if (entered === 1) await gate.promise;
      return stage === "getSettings" ? clone(settings) : value;
    } });
    f.nodes.model.value = "selected-model";
    f.input("Only one question");
    const first = f.click("ai-send");
    await tick();
    assert.equal(entered, 1);
    await f.click("ai-send");
    assert.equal(entered, 1);
    gate.resolve();
    await first;
    assert.equal(f.calls.chat.length, 1);
    assert.equal(f.messages().filter((message) => message.role === "user").length, 1);
    assert.equal(f.messages()[0].content, "Only one question");
  });

  test(`AI failure in ${stage} releases busy state and permits another request`, async () => {
    let fail = true;
    const f = fixture({ [stage]: async (value) => {
      if (fail) { fail = false; throw new Error(`${stage} failed`); }
      return stage === "getSettings" ? clone(settings) : value;
    } });
    f.nodes.model.value = "selected-model";
    f.input("First question");
    await f.click("ai-send");
    assert.match(f.modules.render("ai"), new RegExp(`${stage} failed`));
    assert.doesNotMatch(f.modules.render("ai"), /data-module-action="ai-stop"/);
    f.input("Question after failure");
    await f.click("ai-send");
    assert.equal(f.calls.chat.length, 1);
    assert.equal(f.calls.chat[0].messages.at(-1).content, "Question after failure");
    assert.equal(f.messages().at(-1).role, "assistant");
  });
}

test("AI Enter respects IME composition and Shift, and blank input cannot send", async () => {
  const f = fixture();
  await f.modules.loadAi();
  f.input("   \n ");
  assert.equal(f.nodes.send.disabled, true);
  await f.click("ai-send");
  assert.equal(f.calls.chat.length, 0);
  f.input("中文输入");
  assert.equal(f.nodes.send.disabled, false);
  let prevented = 0;
  for (const flags of [{ isComposing: true }, { keyCode: 229 }, { shiftKey: true }]) {
    f.nodes.input.onkeydown({ key: "Enter", preventDefault: () => { prevented += 1; }, ...flags });
    await tick();
  }
  assert.equal(prevented, 0);
  assert.equal(f.calls.chat.length, 0);
  f.nodes.input.onkeydown({ key: "Enter", preventDefault: () => { prevented += 1; } });
  await tick();
  assert.equal(prevented, 1);
  assert.equal(f.calls.chat.length, 1);
});

test("default AI prompt remains independent of selecting and clearing a snippet", async () => {
  const f = fixture();
  await f.modules.loadAi();
  for (const [selected, expected] of [["", "GLOBAL DEFAULT"], ["0", "SELECTED PROMPT"], ["", "GLOBAL DEFAULT"]]) {
    f.nodes.snippet.value = selected;
    f.nodes.snippet.onchange?.();
    f.input(`Question ${f.calls.chat.length}`);
    await f.click("ai-send");
    assert.equal(f.calls.chat.at(-1).systemPrompt, expected);
  }
});

test("an empty conversation suggestion fills a draft without making an AI request", async () => {
  const f = fixture();
  const html = f.modules.render("ai");
  const suggestion = html.match(/<button\b[^>]*data-module-action="ai-prompt"[^>]*data-value="(\d+)"/);
  assert.ok(suggestion);
  await f.click("ai-prompt", suggestion[1]);
  assert.notEqual(f.nodes.input.value.trim(), "");
  assert.equal(f.nodes.send.disabled, false);
  assert.equal(f.calls.chat.length, 0);
  assert.equal(f.calls.setState.length, 0);
});

test("retry reuses the failed user message without duplicating it", async () => {
  let attempts = 0;
  const f = fixture({ chat: async () => ++attempts === 1
    ? { success: false, error: "Network unavailable" } : { success: true, text: "Recovered answer" } });
  f.input("Retry this question");
  await f.click("ai-send");
  assert.match(f.modules.render("ai"), /data-module-action="ai-retry"/);
  assert.deepEqual(f.messages(), [{ role: "user", content: "Retry this question" }]);
  await f.click("ai-retry");
  assert.equal(f.calls.chat.length, 2);
  assert.deepEqual(f.calls.chat[1].messages, f.calls.chat[0].messages);
  assert.equal(f.messages().filter((message) => message.role === "user").length, 1);
  assert.equal(f.messages().at(-1).content, "Recovered answer");
});

test("a failed answer save leaves a retryable conversation and releases the busy lock", async () => {
  let saves = 0;
  const f = fixture({ setState: async () => { if (++saves === 2) throw new Error("Answer save failed"); } });
  f.input("Keep my question");
  await f.click("ai-send");
  assert.match(f.modules.render("ai"), /Answer save failed/);
  assert.match(f.modules.render("ai"), /data-module-action="ai-retry"/);
  assert.doesNotMatch(f.modules.render("ai"), /data-module-action="ai-stop"/);
  assert.deepEqual(f.messages(), [{ role: "user", content: "Keep my question" }]);
  await f.click("ai-retry");
  assert.equal(f.calls.chat.length, 2);
  assert.equal(f.messages().filter((message) => message.role === "user").length, 1);
  assert.equal(f.messages().filter((message) => message.role === "assistant").length, 1);
});

test("stop keeps streamed text, ignores foreign chunks, and allows a follow-up", async () => {
  const response = deferred();
  let requests = 0;
  const f = fixture({
    chat: () => ++requests === 1 ? response.promise : { success: true, text: "Continued answer" },
    cancel: async () => response.resolve({ success: false, error: "已停止生成。" }),
  });
  f.input("Start streaming");
  const pending = f.click("ai-send");
  await tick();
  const requestId = f.calls.chat[0].requestId;
  f.emit("other-request", "FOREIGN");
  f.emit(requestId, "Partial **answer**");
  assert.match(f.nodes.body.innerHTML, /Partial/);
  assert.doesNotMatch(f.nodes.body.innerHTML, /FOREIGN/);
  await f.click("ai-stop");
  await pending;
  assert.deepEqual(f.calls.cancel, [requestId]);
  assert.equal(f.messages().at(-1).role, "assistant");
  assert.equal(f.messages().at(-1).content, "Partial **answer**");
  assert.equal(f.unsubscribeCount(), 1);
  assert.doesNotMatch(f.modules.render("ai"), /data-module-action="ai-retry"/);
  f.emit(requestId, "LATE CHUNK");
  assert.equal(f.messages().at(-1).content, "Partial **answer**");
  f.input("Continue");
  await f.click("ai-send");
  assert.equal(f.calls.chat[1].messages[1].content, "Partial **answer**");
  assert.equal(f.messages().at(-1).content, "Continued answer");
});

test("AI copy uses the original message text and fallback Markdown escapes untrusted HTML", async () => {
  const raw = '**Bold**\n<img src=x onerror="bad()"><script>bad()</script>';
  const f = fixture();
  f.modules.syncAiMessages([{ role: "user", content: "Question" }, { role: "assistant", content: raw }]);
  const html = f.modules.render("ai");
  const copyButton = html.match(/<button\b[^>]*data-module-action="ai-copy"[^>]*>/);
  assert.ok(copyButton);
  assert.match(copyButton[0], /data-value="1"/);
  assert.doesNotMatch(html, /<img|<script/);
  await f.click("ai-copy", "1");
  assert.deepEqual(f.calls.copied, [raw]);
});

test("AI Markdown rendering uses sanitized output for messages and streaming chunks", async () => {
  const response = deferred();
  const sanitized = [];
  const f = fixture({
    chat: () => response.promise,
    window: {
      marked: { parse: (text) => `<unsafe>${text}</unsafe>` },
      DOMPurify: { sanitize: (html) => { sanitized.push(html); return "<p>safe output</p>"; } },
    },
  });
  f.modules.syncAiMessages([{ role: "assistant", content: "stored <script>bad()</script>" }]);
  assert.match(f.modules.render("ai"), /<p>safe output<\/p>/);
  assert.doesNotMatch(f.modules.render("ai"), /<unsafe>|<script>/);
  f.input("Stream next");
  const pending = f.click("ai-send");
  await tick();
  f.emit(f.calls.chat[0].requestId, "stream <script>bad()</script>");
  assert.equal(f.nodes.body.innerHTML, "<p>safe output</p>");
  assert.ok(sanitized.some((html) => html.includes("stream <script>")));
  response.resolve({ success: true, text: "done" });
  await pending;
});

test("streaming follows the bottom but preserves a reader's scroll position", async () => {
  const response = deferred();
  const f = fixture({ chat: () => response.promise });
  f.input("Long answer");
  const pending = f.click("ai-send");
  await tick();
  const requestId = f.calls.chat[0].requestId;
  f.nodes.messages.scrollHeight = 1400;
  f.nodes.messages.scrollTop = 1100;
  f.nodes.messages.onscroll?.();
  f.nodes.messages.scrollHeight = 1650;
  f.emit(requestId, "First chunk");
  assert.ok(f.nodes.messages.scrollTop >= f.nodes.messages.scrollHeight - f.nodes.messages.clientHeight);
  f.nodes.messages.scrollTop = 120;
  f.nodes.messages.onscroll?.();
  f.emit(requestId, "More content");
  assert.equal(f.nodes.messages.scrollTop, 120);
  response.resolve({ success: true, text: "Complete answer" });
  await pending;
  assert.equal(f.nodes.messages.scrollTop, 120);
});
