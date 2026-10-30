const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function preload(pendingChannel = "workspace:write") {
  let api;
  const listeners = new Map();
  const calls = [];
  const sent = [];
  let finishWrite;
  const ipcRenderer = {
    invoke: async (channel, ...args) => {
      calls.push([channel, ...args]);
      if (channel === "githubSync:generation") return 4;
      if (channel === pendingChannel) return new Promise((resolve) => { finishWrite = resolve; });
      return {};
    },
    on: (channel, cb) => listeners.set(channel, cb),
    removeListener: (channel) => listeners.delete(channel),
    send: (...args) => sent.push(args),
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../electron/preload.js"), "utf8"), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } }, ipcRenderer }),
    process: { platform: "darwin", argv: [] },
  });
  return { api, listeners, calls, sent, finishWrite: () => finishWrite({}) };
}

test("preload editor prepare acknowledgement waits for all in-flight note IPC writes", async () => {
  const harness = preload();
  harness.api.githubSync.onEditor(async () => {});
  const write = harness.api.workspace.write("test.md", "latest");
  await new Promise(setImmediate);
  const prepare = harness.listeners.get("githubSync:editor")({}, { id: "operation", phase: "prepare", generation: 4 });
  await new Promise(setImmediate);
  assert.equal(harness.sent.length, 0);
  harness.finishWrite();
  await Promise.all([prepare, write]);
  assert.equal(harness.sent[0][0], "githubSync:editor-ready");
  assert.equal(harness.sent[0][1].id, "operation");
  assert.equal(harness.calls.find(([channel]) => channel === "workspace:write")[3], 4);
});

test("appearance writes carry their vault and generation and participate in editor preparation", async () => {
  const h = preload('workspace:setAppearance');
  h.api.githubSync.onEditor(async () => {});
  const writing = h.api.workspace.setAppearance('计划.md', { emoji: '⭐' }, '/A');
  await new Promise(setImmediate);
  const preparing = h.listeners.get('githubSync:editor')({}, { id: 'appearance', phase: 'prepare', generation: 4 });
  await new Promise(setImmediate);
  assert.equal(h.sent.length, 0);
  const call = h.calls.find(([channel]) => channel === 'workspace:setAppearance');
  assert.equal(call[3], '/A'); assert.equal(call[4], 4);
  h.finishWrite(); await Promise.all([writing, preparing]);
  assert.equal(h.sent[0][1].id, 'appearance');
});

test("vault switches are not tracked as writes but task mutations are", async () => {
  const switching = preload("vaults:select");
  switching.api.githubSync.onEditor(async () => {});
  const change = switching.api.vaults.select("/B");
  await new Promise(setImmediate);
  await switching.listeners.get("githubSync:editor")({}, { id: "switch", phase: "prepare", generation: 4 });
  assert.equal(switching.sent.length, 1);
  switching.finishWrite();
  await change;

  const tasks = preload("zentask:addTask");
  tasks.api.githubSync.onEditor(async () => {});
  const write = tasks.api.zenTask.addTask({ title: "A task" });
  await new Promise(setImmediate);
  const prepare = tasks.listeners.get("githubSync:editor")({}, { id: "tasks", phase: "prepare", generation: 4 });
  await new Promise(setImmediate);
  assert.equal(tasks.sent.length, 0);
  tasks.finishWrite();
  await Promise.all([write, prepare]);
  assert.equal(tasks.calls.find(([channel]) => channel === "zentask:addTask")[2], 4);
});

test("PKB initialization does not deadlock editor preparation and template writes are tracked", async () => {
  const setup = preload("pkb:initialize");
  setup.api.githubSync.onEditor(async () => {});
  const initializing = setup.api.pkb.initialize("/A");
  await new Promise(setImmediate);
  await setup.listeners.get("githubSync:editor")({}, { id: "pkb", phase: "prepare", generation: 4 });
  assert.equal(setup.sent.length, 1);
  setup.finishWrite();
  await initializing;

  const notes = preload("pkb:createNote");
  notes.api.githubSync.onEditor(async () => {});
  const writing = notes.api.pkb.createNote({ root: "/A", title: "new" });
  await new Promise(setImmediate);
  const preparing = notes.listeners.get("githubSync:editor")({}, { id: "template", phase: "prepare", generation: 4 });
  await new Promise(setImmediate);
  assert.equal(notes.sent.length, 0);
  notes.finishWrite();
  await Promise.all([writing, preparing]);
  assert.equal(notes.calls.find(([channel]) => channel === "pkb:createNote")[2], 4);
});

test("preload resume adopts the new write generation before editor callback", async () => {
  const harness = preload();
  await new Promise(setImmediate);
  harness.api.githubSync.onEditor(async () => { await harness.api.workspace.createFile("", "after"); });
  await harness.listeners.get("githubSync:editor")({}, { id: "resume", phase: "resume", generation: 5 });
  assert.equal(harness.calls.find(([channel]) => channel === "workspace:createFile")[3], 5);
  assert.equal(harness.sent[0][1].error, undefined);
});

test("preload reports a failed editor flush without exposing raw errors", async () => {
  const harness = preload();
  harness.api.githubSync.onEditor(async () => { throw new Error("private content"); });
  await harness.listeners.get("githubSync:editor")({}, { id: "failed", phase: "prepare", generation: 4 });
  assert.equal(harness.sent[0][1].error, true);
  assert.equal(JSON.stringify(harness.sent).includes("private content"), false);
  assert.equal(harness.api.githubSync.getToken, undefined);
});

test("quit acknowledgement waits for the renderer flush and all pending note writes", async () => {
  const h = preload(); let flushed = false;
  h.api.onBeforeQuit(async (phase) => { if (phase === "prepare") flushed = true; });
  const write = h.api.workspace.write("draft.md", "final text"); await new Promise(setImmediate);
  const prepare = h.listeners.get("app:quitting")({}, { id: "quit", phase: "prepare" });
  await new Promise(setImmediate); assert.equal(flushed, true); assert.equal(h.sent.length, 0);
  h.finishWrite(); await Promise.all([write, prepare]);
  assert.equal(h.sent[0][0], "app:quit-ready"); assert.equal(h.sent[0][1].id, "quit");
});
