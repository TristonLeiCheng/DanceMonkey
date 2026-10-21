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
  vm.runInContext(`let saveTimer = null; let saveInFlight = Promise.resolve(); let activePath = 'note.md'; let content = 'first edit'; let savedContent = 'old'; ${saveFunction}`, context);
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
