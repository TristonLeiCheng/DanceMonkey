const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function preload() {
  let api;
  const listeners = new Map();
  const calls = [];
  const sent = [];
  let finishWrite;
  const ipcRenderer = {
    invoke: async (channel, ...args) => {
      calls.push([channel, ...args]);
      if (channel === "githubSync:generation") return 4;
      if (channel === "workspace:write") return new Promise((resolve) => { finishWrite = resolve; });
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
