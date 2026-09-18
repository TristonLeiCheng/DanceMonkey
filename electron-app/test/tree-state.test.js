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
