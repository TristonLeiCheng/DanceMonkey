const { test } = require("node:test");
const assert = require("node:assert/strict");
const treeState = require("../src/tree-state");

const tree = [
  {
    type: "folder",
    path: "Projects",
    children: [
      { type: "folder", path: "Projects/Alpha", children: [] },
      { type: "file", path: "Projects/readme.md" },
    ],
  },
  { type: "folder", path: "Archive", children: [] },
  { type: "file", path: "welcome.md" },
];

test("first run expands only top-level folders", () => {
  assert.deepEqual([...treeState.restore(tree, null)], ["Projects", "Archive"]);
});

test("saved expansion state survives reload, including intentionally collapsed all", () => {
  assert.deepEqual([...treeState.restore(tree, '["Projects/Alpha"]')], ["Projects/Alpha"]);
  assert.deepEqual([...treeState.restore(tree, "[]")], []);
});

test("missing and malformed saved folder paths are discarded", () => {
  assert.deepEqual([...treeState.restore(tree, '["Deleted","Projects","Projects/readme.md",42]')], ["Projects"]);
  assert.deepEqual([...treeState.restore(tree, "not-json")], []);
});

test("renaming a folder remaps it and all expanded descendants", () => {
  const renamed = treeState.remap(new Set(["Projects", "Projects/Alpha", "Archive"]), "Projects", "Work");
  assert.deepEqual([...renamed], ["Work", "Work/Alpha", "Archive"]);
});

function memoryStorage(values = {}) {
  const data = new Map(Object.entries(values));
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
}

test("vaults with identical folder paths retain independent expansion states", () => {
  const storage = memoryStorage();
  treeState.restoreForVault(storage, "/vault-a", tree);
  treeState.saveForVault(storage, "/vault-a", new Set());
  assert.deepEqual([...treeState.restoreForVault(storage, "/vault-b", tree)], ["Projects", "Archive"]);
  treeState.saveForVault(storage, "/vault-b", new Set(["Projects/Alpha"]));
  assert.deepEqual([...treeState.restoreForVault(storage, "/vault-a", tree)], []);
  assert.deepEqual([...treeState.restoreForVault(storage, "/vault-b", tree)], ["Projects/Alpha"]);
});

test("legacy expansion preference is assigned to the first vault only", () => {
  const storage = memoryStorage({ "lumen-workspace-expanded-folders": "[]" });
  assert.deepEqual([...treeState.restoreForVault(storage, "/vault-a", tree)], []);
  assert.deepEqual([...treeState.restoreForVault(storage, "/vault-b", tree)], ["Projects", "Archive"]);
  assert.deepEqual([...treeState.restoreForVault(storage, "/vault-a", tree)], []);
});

test("vault tree works when preference storage is unavailable", () => {
  const storage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.deepEqual([...treeState.restoreForVault(storage, "/vault-a", tree)], ["Projects", "Archive"]);
  assert.doesNotThrow(() => treeState.saveForVault(storage, "/vault-a", new Set()));
});

test('sidebar width survives a new session, clamps bounds and tolerates unavailable storage', () => {
  const storage = memoryStorage();
  assert.equal(treeState.restoreWidth(storage), 226);
  assert.equal(treeState.saveWidth(storage, 347.4), 347);
  assert.equal(treeState.restoreWidth(storage), 347);
  assert.equal(treeState.saveWidth(storage, 999), 420);
  assert.equal(treeState.saveWidth(storage, 120), 160);
  for (const value of ['bad', 'Infinity', '-1', '0', '']) assert.equal(treeState.restoreWidth(memoryStorage({ 'lumen-workspace-sidebar-width': value })), 226);
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(treeState.restoreWidth(blocked), 226);
  assert.equal(treeState.saveWidth(blocked, 300), 300);
});
