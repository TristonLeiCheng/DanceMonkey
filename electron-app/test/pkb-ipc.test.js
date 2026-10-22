const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function harness() {
  const handlers = new Map();
  const state = { root: "/A", trusted: true, generation: 2, initialized: 0, refreshed: 0, confirmed: 1 };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../electron/pkb-ipc.js"), "utf8"), {
    module,
    require: () => ({ createPkb: (root) => ({
      status: () => ({ initialized: false }),
      preview: () => ({ directories: ["00_Inbox"], files: ["_System/index.md"], warnings: [] }),
      initialize: () => { state.initialized++; return { initialized: true }; },
      createNote: (input) => ({ path: `${root}/${input.title}.md` }),
      search: (query) => [{ path: `${root}/${query}.md` }],
    }) }),
  });
  module.exports.registerPkbIpc({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    dialog: { showMessageBox: async () => { state.onDialog?.(); return { response: state.confirmed }; } },
    BrowserWindow: { fromWebContents: () => null },
    getRoot: () => state.root,
    githubNotes: {
      trusted: () => state.trusted,
      assertWritable: (generation) => { if (generation !== state.generation) throw new Error("stale generation"); },
      runLocalOperation: async (fn) => { state.onRun?.(); try { return fn(); } finally { state.refreshed++; } },
    },
    refreshNotes: () => state.refreshed++,
  });
  return { state, call: (name, input = { root: "/A" }, generation = 2) => handlers.get(`pkb:${name}`)({ sender: {} }, input, generation) };
}

test("PKB initialization requires native confirmation and refreshes after coordinated write", async () => {
  const h = harness();
  assert.equal(h.call("preview").root, "/A");
  assert.equal((await h.call("initialize")).initialized, true);
  assert.equal(h.state.initialized, 1);
  assert.equal(h.state.refreshed, 1);
});

test("canceling initialization creates nothing", async () => {
  const h = harness(); h.state.confirmed = 0;
  assert.equal((await h.call("initialize")).canceled, true);
  assert.equal(h.state.initialized, 0);
});

test("untrusted renderers and stale vault requests cannot access PKB", async () => {
  const h = harness(); h.state.trusted = false;
  assert.throws(() => h.call("search", { root: "/A", query: "secret" }), /主窗口/);
  await assert.rejects(h.call("initialize"), /主窗口/);
  h.state.trusted = true; h.state.root = "/B";
  assert.throws(() => h.call("preview"), /切换/);
  assert.throws(() => h.call("createNote", { root: "/A", title: "test" }), /切换/);
});

test("vault changes during confirmation or editor preparation abort initialization", async () => {
  for (const phase of ["onDialog", "onRun"]) {
    const h = harness(); h.state[phase] = () => { h.state.root = "/B"; };
    await assert.rejects(h.call("initialize"), /切换/);
    assert.equal(h.state.initialized, 0);
  }
});

test("template writes honor generation and carry explicit vault identity", () => {
  const h = harness();
  assert.throws(() => h.call("createNote", { root: "/A", title: "test" }, 1), /stale/);
  assert.equal(h.call("createNote", { root: "/A", title: "test" }).path, "/A/test.md");
});
