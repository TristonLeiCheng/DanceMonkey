const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { registerProjectAiIpc, ORIGIN_ERROR } = require("../electron/project-ai-ipc");

function harness(overrides = {}) {
  const handlers = new Map();
  const mainFrame = { url: "http://127.0.0.1/index.html" };
  const trustedSender = { mainFrame, isDestroyed: () => false, send() {} };
  const calls = { writable: [], applied: [], chat: [] };
  const zen = {
    load: () => ({ projects: [{ Id: "p1", Name: "官网改版" }], tasks: [] }),
    updateProject: (id, input) => ({ updated: id, input }),
  };
  const { channels } = registerProjectAiIpc({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    trusted: (event) => event.sender === trustedSender,
    getGeneration: () => 7,
    assertWritable: (generation) => { calls.writable.push(generation); if (generation !== 7) throw new Error("笔记库正在同步"); },
    aiService: { chat: async (payload) => { calls.chat.push(payload); return "ok"; }, cancel: () => false },
    personaService: { cancel: () => true, review: async () => ({ text: "审阅" }) },
    getWorkspace: () => ({ root: "/vault", createAiNote: (input) => ({ path: `AI 输出/${input.title}.md` }) }),
    getZenStore: () => zen,
    getChatStore: () => ({ get: (root, id) => [{ role: "user", content: `${root}:${id}` }], getBrief: (root, day) => ({ root, day }) }),
    getNoteChatStore: () => ({ reconcile() {} }),
    listNotes: () => [],
    localDay: () => "2026-11-19",
    ...overrides,
  });
  const events = {
    trusted: { sender: trustedSender, senderFrame: mainFrame },
    otherWindow: { sender: { mainFrame, isDestroyed: () => false, send() {} }, senderFrame: mainFrame },
    subFrame: { sender: trustedSender, senderFrame: { url: "about:blank" } },
  };
  return { handlers, channels, events, calls };
}

const preloadChannels = () => {
  const source = fs.readFileSync(path.join(__dirname, "../electron/preload.js"), "utf8");
  return [...new Set([...source.matchAll(/["'](projectAi:[\w:]+)["']/g)].map((match) => match[1]))].sort();
};

test("every projectAi channel the preload exposes is registered through the guarded module, and main.js registers none directly", () => {
  const { channels } = harness();
  assert.deepEqual([...channels].sort(), preloadChannels());
  assert.equal(channels.length, 16);
  const main = fs.readFileSync(path.join(__dirname, "../electron/main.js"), "utf8");
  assert.doesNotMatch(main, /ipcMain\.handle\(\s*["']projectAi:/);
  assert.match(main, /registerProjectAiIpc\(\{/);
});

test("every projectAi channel rejects other windows and sub-frames before doing any work", async () => {
  const { handlers, channels, events, calls } = harness();
  for (const channel of channels) {
    for (const event of [events.otherWindow, events.subFrame, {}]) {
      await assert.rejects(async () => handlers.get(channel)(event, "p1", {}, 7), { message: ORIGIN_ERROR }, `${channel} must reject`);
    }
  }
  assert.deepEqual(calls, { writable: [], applied: [], chat: [] }, "no handler body ran");
});

test("trusted main-frame requests still reach the stores, and writes keep the sync generation check", async () => {
  const { handlers, events, calls } = harness();
  assert.deepEqual(await handlers.get("projectAi:history:get")(events.trusted, "p1"), [{ role: "user", content: "/vault:p1" }]);
  assert.deepEqual(await handlers.get("projectAi:brief:get")(events.trusted), { root: "/vault", day: "2026-11-19" });
  const saved = await handlers.get("projectAi:saveNote")(events.trusted, { projectId: "p1", title: "官网改版：总结", body: "x" }, 7);
  assert.equal(saved.path, "AI 输出/官网改版：总结.md");
  assert.equal(saved.linked, true);
  assert.throws(() => handlers.get("projectAi:applyAction")(events.trusted, "p1", { type: "create_task", title: "x" }, 3), /笔记库正在同步/);
  assert.deepEqual(calls.writable, [7, 3]);
  assert.equal(await handlers.get("projectAi:cancel")(events.trusted, "persona-request"), true);
});

test("chat from a stale vault generation is refused without calling the model", async () => {
  const { handlers, events, calls } = harness();
  const result = await handlers.get("projectAi:chat")(events.trusted, { projectId: "p1", generation: 6, messages: [] });
  assert.equal(result.success, false);
  assert.match(result.error, /笔记库已变化/);
  assert.equal(calls.chat.length, 0);
});
