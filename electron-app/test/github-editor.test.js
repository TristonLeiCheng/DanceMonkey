const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("editor save records the submitted snapshot, not newer text typed during IPC", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/workspace-app.js"), "utf8");
  const saveFunction = source.slice(source.indexOf("  function saveActive() {"), source.indexOf("  async function reloadSyncedNotes()"));
  assert.ok(saveFunction.includes("const snapshot = content"));
  let finish;
  const calls = [];
  const status = {};
  const context = vm.createContext({ clearTimeout, Promise, root: { querySelector: () => status },
    api: { workspace: { write: (target, content) => { calls.push({ target, content }); return new Promise((resolve) => { finish = resolve; }); } } } });
  vm.runInContext(`let noteImageTransfer = null; let markdownEditor = null; let saveTimer = null; let saveInFlight = Promise.resolve(); let activePath = 'note.md'; let content = 'first edit'; let savedContent = 'old'; ${saveFunction}`, context);
  const request = vm.runInContext("saveActive()", context);
  await new Promise(setImmediate);
  vm.runInContext("content = 'newer edit'", context);
  finish();
  await request;
  assert.equal(vm.runInContext("savedContent", context), "first edit");
  assert.equal(status.textContent, "保存中…");
  const next = vm.runInContext("saveActive()", context);
  await new Promise(setImmediate);
  finish();
  await next;
  assert.deepEqual(calls, [{ target: "note.md", content: "first edit" }, { target: "note.md", content: "newer edit" }]);
  assert.equal(status.textContent, "已保存");
});

function sourceSection(file, start, end) {
  const source = fs.readFileSync(path.join(__dirname, "../src", file), "utf8");
  return source.slice(source.indexOf(start), source.indexOf(end));
}

test("rejected task-editor preparation preserves its form through resume and allows retry", async () => {
  let editor;
  let editing = true;
  let refreshes = 0;
  let saves = 0;
  let closes = 0;
  const form = { title: "未提交的任务标题", selectionStart: 4 };
  const root = { inert: false, querySelector: () => null, form };
  const context = vm.createContext({
    root,
    api: { githubSync: { onEditor: (callback) => { editor = callback; } } },
    modulesInstance: { prepareSync: () => { if (editing) throw new Error("先保存任务"); } },
    saveActive: async () => { saves += 1; },
    reloadSyncedNotes: async () => { refreshes += 1; root.form = null; },
    closeDialog: () => { closes += 1; }, closePalette: () => { closes += 1; },
  });
  vm.runInContext(`let syncPaused = false, syncDraftBlocked = false, vaultSwitching = false;
    let modulesReady = true;
    ${sourceSection("workspace-app.js", "  api.githubSync?.onEditor", "  async function openPkbSetup()")}`, context);
  await assert.rejects(editor({ phase: "prepare" }), /先保存任务/);
  assert.equal(root.inert, true);
  await editor({ phase: "resume" });
  assert.equal(root.form, form);
  assert.equal(root.form.title, "未提交的任务标题");
  assert.equal(root.form.selectionStart, 4);
  assert.equal(root.inert, false);
  assert.equal(refreshes + saves + closes, 0);
  assert.equal(vm.runInContext("syncPaused || syncDraftBlocked", context), false);

  editing = false;
  await editor({ phase: "prepare" });
  await editor({ phase: "resume" });
  assert.equal(saves, 1);
  assert.equal(refreshes, 1);
  assert.equal(root.inert, false);
});

test("same-vault resume refreshes tasks without resetting project state or GitHub preview", async () => {
  let taskReloads = 0;
  let vaultReloads = 0;
  let renders = 0;
  let changed = false;
  const context = vm.createContext({
    api: { workspace: { list: async () => ({ root: "/notes", tree: [] }) } },
    applyTree: () => changed,
    loadVaults: async () => {},
    modulesInstance: {
      reloadSyncedTasks: async () => { taskReloads += 1; },
      reloadVault: async () => { vaultReloads += 1; },
    },
    renderShell: () => { renders += 1; },
  });
  vm.runInContext(`let modulesReady = true, activePath = null;
    ${sourceSection("workspace-app.js", "  async function reloadSyncedNotes()", "  api.githubSync?.onEditor")}`, context);
  await vm.runInContext("reloadSyncedNotes()", context);
  assert.equal(taskReloads, 1);
  assert.equal(vaultReloads, 0);
  changed = true;
  await vm.runInContext("reloadSyncedNotes()", context);
  assert.equal(taskReloads, 1);
  assert.equal(vaultReloads, 1);
  assert.equal(renders, 2);
});

test("overlay task input survives editor prepare and resume without submitting a task", async () => {
  let editor;
  let rendered = "";
  let taskWrites = 0;
  const input = { value: "" };
  const escape = (value) => String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  const context = vm.createContext({
    root: { inert: false, querySelector: () => input },
    api: { getState: async () => ({}), githubSync: { onEditor: (callback) => { editor = callback; } },
      zenTask: { load: async () => ({ tasks: [], projects: [] }), addTask: async () => { taskWrites += 1; } } },
    adopt: () => {}, applyZen: () => {},
    zenStats: () => ({ open: 0, urgent: 0, overdue: 0 }), zenDone: () => false,
    escapeAttr: escape, escapeHtml: escape, focusLater: () => {},
    captureRender: (html) => { rendered = html; },
  });
  vm.runInContext(`let zenDraft = '', zenTasks = [], zenProjects = [], zenError = '', syncPaused = false;
    let pendingNoteSave = Promise.resolve(), noteSaveError = null;
    let renamingId = null, pendingDeleteId = null, skipRender = false;
    ${sourceSection("app.js", "    function renderZenTodos()", "    function renderAiMarkdown")}
    function render() { captureRender(renderZenTodos()); }
    ${sourceSection("app.js", "      const zenInput = root.querySelector", "      const newBook = root.querySelector")}
    ${sourceSection("app.js", "    api.githubSync?.onEditor", "    api.onShellMode")}`, context);
  input.value = '待办 <草稿> "保留"';
  input.oninput();
  await editor({ phase: "prepare" });
  await editor({ phase: "resume" });
  assert.match(rendered, /value="待办 &lt;草稿> &quot;保留&quot;"/);
  assert.equal(taskWrites, 0);
});
