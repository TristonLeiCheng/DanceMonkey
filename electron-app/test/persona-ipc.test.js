const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const vm = require("node:vm");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dm-persona-ipc-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { registerPersonaIpc } = require("../electron/persona-ipc");
  const handlers = new Map();
  const sender = new EventEmitter();
  sender.isDestroyed = () => false;
  sender.sent = [];
  sender.send = (...args) => sender.sent.push(args);
  const state = { trusted: true, root, dialog: { canceled: true }, calls: [], canceled: [] };
  state.workspace = { root, read: (file) => fs.readFileSync(path.join(root, file), "utf8") };
  const service = {
    get: async (id) => ({ id }),
    addSources: async (input) => { state.calls.push(input); return { id: input.id, sources: input.sources }; },
    cancel: (id) => { state.canceled.push(id); return true; },
    generate: (...args) => state.generate(...args),
    chat: (...args) => state.chat(...args),
  };
  registerPersonaIpc({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, service,
    dialog: { showOpenDialog: async () => { state.onDialog?.(); return state.dialog; } },
    BrowserWindow: { fromWebContents: () => null }, trusted: () => state.trusted,
    getWorkspace: () => state.workspace,
  });
  return { state, sender, call: (name, input, source = sender) => handlers.get(`personas:${name}`)({ sender: source }, input) };
}

test("persona IPC rejects untrusted windows before opening files or calling models", async (t) => {
  const h = fixture(t); h.state.trusted = false;
  for (const method of ["get", "importFiles", "generate", "chat", "cancel"]) {
    await assert.rejects(h.call(method, { id: "p" }), /主窗口/);
  }
  assert.equal(h.state.calls.length, 0);
});

test("file picker cancellation is read-only and import reports unsupported files", async (t) => {
  const h = fixture(t);
  assert.deepEqual(await h.call("importFiles", { id: "p" }), { canceled: true });
  fs.writeFileSync(path.join(h.state.root, "article.md"), "# 思考\n做决定前先列出证据。");
  fs.writeFileSync(path.join(h.state.root, "image.png"), Buffer.from([0, 255, 13]));
  h.state.dialog = { canceled: false, filePaths: ["article.md", "image.png"].map((name) => path.join(h.state.root, name)) };
  const result = await h.call("importFiles", { id: "p", kind: "article" });
  assert.equal(result.persona.sources.length, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].name, "image.png");
  assert.equal(h.state.calls.length, 1);
});

test("note imports check vault identity, traversal, extensions and retain source title", async (t) => {
  const h = fixture(t);
  fs.writeFileSync(path.join(h.state.root, "经验.md"), "先研究再判断。");
  for (const paths of [["../secret.md"], ["/secret.md"], ["file.json"], []]) {
    await assert.rejects(h.call("importNotes", { id: "p", paths }));
  }
  await assert.rejects(h.call("importNotes", { id: "p", root: "/another", paths: ["经验.md"] }), /切换/);
  const person = await h.call("importNotes", { id: "p", root: h.state.root, paths: ["经验.md"] });
  assert.equal(person.sources[0].title, "经验.md");
  assert.equal(person.sources[0].kind, "note");
  assert.equal(person.sources[0].text, "先研究再判断。");
});

test("cancellation belongs to requesting window and listeners are cleaned after completion", async (t) => {
  const h = fixture(t);
  let finish;
  h.state.generate = (_input, progress) => { progress("正在提取观点"); return new Promise((resolve) => { finish = resolve; }); };
  const task = h.call("generate", { id: "p", requestId: "gen-1" });
  await new Promise(setImmediate);
  assert.equal(h.sender.listenerCount("destroyed"), 1);
  assert.equal(await h.call("cancel", "gen-1", {}), false);
  assert.equal(await h.call("cancel", "gen-1"), true);
  assert.equal(h.sender.sent.at(-1)[1].message, "正在提取观点");
  await assert.rejects(h.call("generate", { id: "p", requestId: "gen-1" }), /正在执行/);
  finish({ card: {} }); await task;
  assert.equal(h.sender.listenerCount("destroyed"), 0);
  assert.equal(await h.call("cancel", "gen-1"), false);
});

test("closing a requesting window cancels work and model failure releases its request", async (t) => {
  const h = fixture(t);
  let fail;
  h.state.chat = (_input, chunk) => { chunk("片段"); return new Promise((_resolve, reject) => { fail = reject; }); };
  const task = h.call("chat", { id: "p", requestId: "chat-1", message: "你好" });
  await new Promise(setImmediate);
  h.sender.emit("destroyed");
  assert.deepEqual(h.state.canceled, ["chat-1"]);
  fail(new Error("network failed"));
  await assert.rejects(task, /network failed/);
  assert.equal(h.sender.listenerCount("destroyed"), 0);
  assert.equal(await h.call("cancel", "chat-1"), false);
});

test("preload forwards persona operations independently of vault write coordination", async () => {
  let api;
  const calls = [], listeners = new Map();
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../electron/preload.js"), "utf8"), {
    process: { platform: "darwin", argv: [] },
    require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
      ipcRenderer: { invoke: async (...args) => { calls.push(args); return 1; }, on: (key, fn) => listeners.set(key, fn), removeListener: (key) => listeners.delete(key) } }),
  });
  await api.personas.addSources({ id: "p", sources: [] });
  await api.personas.get("p");
  assert.deepEqual(calls.at(-1), ["personas:get", "p"]);
  assert.equal(calls.find(([name]) => name === "personas:addSources").length, 2);
  let chunk;
  const off = api.personas.onChunk((value) => { chunk = value; });
  listeners.get("personas:chunk")({}, { requestId: "r", chunk: "x" });
  assert.equal(chunk.chunk, "x"); off();
  assert.equal(listeners.has("personas:chunk"), false);
});
