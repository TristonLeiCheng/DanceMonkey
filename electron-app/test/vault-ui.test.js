const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const treeState = require("../src/tree-state");

const source = fs.readFileSync(path.join(__dirname, "../src/workspace-app.js"), "utf8");
function extract(start, end) { return source.slice(source.indexOf(start), source.indexOf(end)); }
const helpers = extract("  function flatten(", "  function renderMarkdown(");
const vaultFunctions = extract("  function applyTree(", "  async function refreshTree(");
const reloadFunction = extract("  async function reloadSyncedNotes(", "  api.githubSync?.onEditor(");

function editorContext(overrides = {}) {
  const values = new Map();
  const context = vm.createContext({
    window: { DMTreeState: treeState },
    localStorage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    root: { inert: false },
    alert() {},
    closeDialog() {}, closePalette() {}, renderShell() {},
    saveActive: async () => {},
    api: {
      vaults: { list: async () => ({ vaults: [{ root: "/B", name: "B" }] }), select: async () => ({ success: true }) },
      workspace: { list: async () => ({ root: "/B", tree: [{ type: "folder", path: "Shared", children: [] }, { type: "file", path: "same.md" }] }), read: async () => "B content" },
    },
    ...overrides,
  });
  vm.runInContext(`
    let tree = [{type:'folder',path:'Shared',children:[]},{type:'file',path:'Shared/a.md'}];
    let vaultRoot = '/A'; let vaults = []; let vaultSwitching = false; let syncPaused = false;
    let activePath = 'same.md'; let selectedPath = 'Shared';
    let content = 'A content'; let savedContent = 'A content';
    let expanded = new Set(); let expandedRestored = true;
    let modulesReady = false; let modulesInstance = null;
    ${helpers} ${vaultFunctions} ${reloadFunction}
  `, context);
  return context;
}

test("selecting the root overrides the parent of the currently open note", () => {
  const context = editorContext();
  vm.runInContext("activePath = 'Shared/a.md'; selectedPath = ''", context);
  assert.equal(vm.runInContext("selectedFolder()", context), "");
  vm.runInContext("selectedPath = 'Shared'", context);
  assert.equal(vm.runInContext("selectedFolder()", context), "Shared");
  vm.runInContext("selectedPath = 'Shared/a.md'", context);
  assert.equal(vm.runInContext("selectedFolder()", context), "Shared");
});

test("switching clears the old editor even when both vaults have the same path", async () => {
  const context = editorContext();
  await vm.runInContext("changeVault('/B')", context);
  assert.equal(vm.runInContext("vaultRoot", context), "/B");
  assert.equal(vm.runInContext("activePath", context), null);
  assert.equal(vm.runInContext("selectedPath", context), "");
  assert.equal(vm.runInContext("content", context), "");
  assert.equal(vm.runInContext("savedContent", context), "");
  assert.equal(context.root.inert, false);
  assert.deepEqual([...vm.runInContext("expanded", context)], ["Shared"]);
  vm.runInContext("applyTree({root:'/A',tree:[{type:'folder',path:'Shared',children:[]}]})", context);
  assert.deepEqual([...vm.runInContext("expanded", context)], []);
});

test("a failed save prevents switching and preserves the draft", async () => {
  let selected = false;
  const messages = [];
  const context = editorContext({
    alert: (message) => messages.push(message),
    saveActive: async () => { throw new Error("disk full"); },
    api: {
      vaults: { select: async () => { selected = true; } },
      workspace: { list: async () => ({ root: "/A", tree: [] }) },
    },
  });
  vm.runInContext("content = 'unsaved draft'", context);
  await vm.runInContext("changeVault('/B')", context);
  assert.equal(selected, false);
  assert.equal(vm.runInContext("vaultRoot", context), "/A");
  assert.equal(vm.runInContext("content", context), "unsaved draft");
  assert.deepEqual(messages, ["disk full"]);
  assert.equal(context.root.inert, false);
});

test("canceling the directory picker retains the current document", async () => {
  const context = editorContext({ api: {
    vaults: { open: async () => ({ canceled: true }), list: async () => ({ vaults: [{ root: "/A", name: "A" }] }) },
    workspace: { list: async () => ({ root: "/A", tree: [{ type: "file", path: "same.md" }] }), read: async () => "A content" },
  } });
  await vm.runInContext("changeVault()", context);
  assert.equal(vm.runInContext("activePath", context), "same.md");
  assert.equal(vm.runInContext("content", context), "A content");
  assert.equal(vm.runInContext("vaultRoot", context), "/A");
});

test("a failed renderer resume reconciles with the already committed vault", async () => {
  const messages = [];
  const context = editorContext({
    alert: (message) => messages.push(message),
    api: {
      vaults: { select: async () => { throw new Error("resume failed"); }, list: async () => ({ vaults: [{ root: "/B", name: "B" }] }) },
      workspace: { list: async () => ({ root: "/B", tree: [{ type: "file", path: "same.md" }] }) },
    },
  });
  await vm.runInContext("changeVault('/B')", context);
  assert.equal(vm.runInContext("vaultRoot", context), "/B");
  assert.equal(vm.runInContext("activePath", context), null);
  assert.equal(vm.runInContext("content", context), "");
  assert.equal(context.root.inert, false);
  assert.deepEqual(messages, ["resume failed"]);
});

test("a concurrent switch is ignored until the first switch finishes", async () => {
  let finishSave;
  let switches = 0;
  const context = editorContext({
    saveActive: () => new Promise((resolve) => { finishSave = resolve; }),
    api: {
      vaults: { select: async () => { switches += 1; return { success: true }; }, list: async () => ({ vaults: [] }) },
      workspace: { list: async () => ({ root: "/B", tree: [] }) },
    },
  });
  const first = vm.runInContext("changeVault('/B')", context);
  await vm.runInContext("changeVault('/C')", context);
  assert.equal(switches, 0);
  assert.equal(context.root.inert, true);
  finishSave();
  await first;
  assert.equal(switches, 1);
  assert.equal(vm.runInContext("vaultRoot", context), "/B");
});

test("a late folder creation response cannot modify the new vault's tree state", async () => {
  let finishCreate;
  let refreshes = 0;
  const context = editorContext({
    root: { inert: false, querySelector: (selector) => selector === ".ws-dialog-input" ? { value: "new-folder" } : { value: "Shared" } },
    refreshTree: async () => { refreshes += 1; },
    api: { workspace: { createFolder: () => new Promise((resolve) => { finishCreate = resolve; }) } },
  });
  vm.runInContext(`let dialog = { kind:'folder', parent:'Shared' }; ${extract("  async function confirmDialog(", "  function openPalette(")}`, context);
  const creation = vm.runInContext("confirmDialog()", context);
  await new Promise(setImmediate);
  vm.runInContext("applyTree({root:'/B',tree:[]})", context);
  finishCreate("Shared/new-folder");
  await creation;
  assert.equal(vm.runInContext("expanded.size", context), 0);
  assert.equal(refreshes, 0);
});

test("a late tree refresh cannot put the old vault back on screen", async () => {
  let finishList;
  const context = editorContext({ api: { workspace: { list: () => new Promise((resolve) => { finishList = resolve; }) } } });
  vm.runInContext(extract("  async function refreshTree(", "  async function openFile("), context);
  const refresh = vm.runInContext("refreshTree()", context);
  vm.runInContext("applyTree({root:'/B',tree:[]})", context);
  finishList({ root: "/A", tree: [{ type: "file", path: "old.md" }] });
  await refresh;
  assert.equal(vm.runInContext("vaultRoot", context), "/B");
  assert.equal(vm.runInContext("tree.length", context), 0);
});

test("a late file read cannot reopen the previous vault's document", async () => {
  let finishRead;
  const context = editorContext({ api: { workspace: { read: () => new Promise((resolve) => { finishRead = resolve; }) } } });
  vm.runInContext(extract("  async function openFile(", "  function saveActive("), context);
  const open = vm.runInContext("openFile('Shared/a.md')", context);
  await new Promise(setImmediate);
  vm.runInContext("applyTree({root:'/B',tree:[]})", context);
  finishRead("late A content");
  await open;
  assert.equal(vm.runInContext("activePath", context), null);
  assert.equal(vm.runInContext("content", context), "");
});
