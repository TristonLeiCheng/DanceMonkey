const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { registerOutlookIpc } = require("../electron/outlook-ipc");

function fixture() {
  const handlers = new Map(), sender = new EventEmitter();
  const state = { trusted: true, sent: [], cancelled: [], calls: [] };
  sender.isDestroyed = () => Boolean(state.closed);
  sender.send = (...args) => state.sent.push(args);
  const auth = Object.fromEntries(["status", "configure", "connect", "disconnect"].map((name) => [name, async (...args) => { state.calls.push([name, ...args]); return { connected: name === "connect" }; }]));
  const importer = { cancelAll: () => state.cancelled.push("all"), cancel: (id) => { state.cancelled.push(id); return true; },
    importAndGenerate: (...args) => state.run(...args) };
  registerOutlookIpc({ ipcMain: { handle: (key, fn) => handlers.set(key, fn) }, trusted: () => state.trusted, auth, importer });
  return { state, sender, call: (method, input, source = sender) => handlers.get("outlook:" + method)({ sender: source }, input) };
}
test("Outlook IPC rejects untrusted callers and never exposes a raw mail/token endpoint", async () => {
  const f = fixture(); f.state.trusted = false;
  for (const name of ["status", "configure", "connect", "disconnect", "cancel", "importAndGenerate"]) await assert.rejects(f.call(name, {}), /主窗口/);
  assert.deepEqual(f.state.calls, []); assert.deepEqual(f.state.cancelled, []);
});
test("changing Outlook identity cancels import work before authorizing a different account", async () => {
  const f = fixture();
  await f.call("configure", { clientId: "id", tenantId: "tenant" }); await f.call("connect"); await f.call("disconnect");
  assert.deepEqual(f.state.cancelled, ["all", "all", "all"]);
  assert.deepEqual(f.state.calls.map((item) => item[0]), ["configure", "connect", "disconnect"]);
});
test("Outlook cancellation belongs to requesting window and closing it aborts the import", async () => {
  const f = fixture(); let finish;
  f.state.run = async (input, progress) => { progress("正在读取邮件"); return new Promise((resolve) => { finish = resolve; }); };
  const request = f.call("importAndGenerate", { requestId: "import-1", id: "person" });
  await new Promise(setImmediate);
  assert.equal(await f.call("cancel", "import-1", {}), false);
  assert.equal(await f.call("cancel", "import-1"), true);
  await assert.rejects(f.call("importAndGenerate", { requestId: "import-1" }), /正在执行/);
  f.sender.emit("destroyed");
  assert.deepEqual(f.state.cancelled, ["import-1", "import-1"]);
  assert.deepEqual(f.state.sent[0], ["outlook:progress", { requestId: "import-1", message: "正在读取邮件" }]);
  finish({ persona: {} }); await request;
  assert.equal(f.sender.listenerCount("destroyed"), 0); assert.equal(await f.call("cancel", "import-1"), false);
});
test("Outlook errors release request ownership and navigation revokes progress delivery", async () => {
  const f = fixture();
  f.state.run = async (_input, progress) => { f.state.trusted = false; progress("不应送达"); };
  await assert.rejects(f.call("importAndGenerate", { requestId: "r", id: "p" }), /关闭/);
  assert.equal(f.state.sent.length, 0); assert.equal(f.sender.listenerCount("destroyed"), 0);
  f.state.trusted = true; f.state.run = async () => ({ ok: true });
  assert.deepEqual(await f.call("importAndGenerate", { requestId: "r", id: "p" }), { ok: true });
});
test("preload exposes scoped Outlook commands and removable progress listeners only", async () => {
  let api; const calls = [], listeners = new Map();
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../electron/preload.js"), "utf8"), {
    process: { platform: "darwin", argv: [] }, require: () => ({ contextBridge: { exposeInMainWorld: (_key, value) => { api = value; } },
      ipcRenderer: { invoke: async (...args) => calls.push(args), on: (key, fn) => listeners.set(key, fn), removeListener: (key) => listeners.delete(key) } }),
  });
  await api.outlook.status(); await api.outlook.configure({ clientId: "client", tenantId: "tenant" });
  await api.outlook.importAndGenerate({ id: "p", requestId: "r", email: "person@example.com" }); await api.outlook.cancel("r");
  assert.deepEqual(calls.map((call) => call[0]).filter((name) => name.startsWith("outlook:")), ["outlook:status", "outlook:configure", "outlook:importAndGenerate", "outlook:cancel"]);
  assert.equal(api.outlook.getAccessToken, undefined);
  let progress; const off = api.outlook.onProgress((value) => { progress = value; });
  listeners.get("outlook:progress")({}, { requestId: "r", message: "读取中" }); assert.equal(progress.message, "读取中");
  off(); assert.equal(listeners.has("outlook:progress"), false);
});
