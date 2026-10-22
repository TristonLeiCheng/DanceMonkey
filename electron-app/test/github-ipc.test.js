const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createGitHubCoordinator } = require("../electron/github-coordinator");

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dm-github-ipc-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const handlers = new Map();
  const events = new Map();
  const effects = [];
  const confirmations = [];
  const current = { private: true, response: 1, binding: null, busy: false, connected: true, failPrepare: false };
  const externalUrls = [];
  const copied = [];
  const sender = { isDestroyed: () => false, mainFrame: { url: "http://127.0.0.1:5173/#workspace/settings" }, send: (channel, payload) => {
    if (channel === "githubSync:editor") queueMicrotask(() => events.get("githubSync:editor-ready")({ sender }, { id: payload.id, error: payload.phase === "prepare" && current.failPrepare }));
  } };
  const window = { isDestroyed: () => false, webContents: sender };
  const event = { sender, senderFrame: sender.mainFrame };
  const auth = {
    status: () => ({ connected: current.connected, login: "test", clientId: "client", appSlug: "notes" }),
    configure: () => {}, start: () => ({ userCode: "ABCD-1234", expiresAt: Date.now() + 60000 }),
    poll: () => ({}), cancel: () => {}, disconnect: () => {}, getToken: () => "SECRET",
    repositories: async () => [{ owner: "test", repo: "notes", fullName: "test/notes", defaultBranch: "trunk" }],
    repository: async ({ owner, repo }) => ({ owner, repo, private: current.private, defaultBranch: "main" }),
  };
  const preview = { id: "preview-id", uploads: ["test.md"], downloads: [], deletions: [], conflicts: [] };
  const sync = {
    status: () => ({ binding: current.binding }),
    configure: (binding) => { current.binding = binding; effects.push("bind"); },
    preview: async () => { effects.push("preview"); return preview; },
    sync: async () => { effects.push("sync"); return { changed: true }; },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../electron/github-ipc.js"), "utf8"), {
    module, process: { env: {} }, URL,
    require: (name) => {
      if (name === "./github-app.json") return { clientId: "", appSlug: "" };
      if (name === "./github-auth") return { createGitHubAuth: () => auth };
      if (name === "./github-sync") return { createGitHubSync: () => sync };
      if (name === "./github-transport") return { createGitHubTransport: () => ({}) };
      if (name === "./github-coordinator") return { createGitHubCoordinator };
      if (name === "./github-vaults") return require("../electron/github-vaults");
      return require(name);
    },
  });
  const service = module.exports.registerGitHubSync({
    app: { getPath: () => directory, getAppPath: () => directory, isPackaged: false },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => events.set(name, fn) },
    shell: { openExternal: async (url) => { externalUrls.push(url); }, openPath: async () => "" }, safeStorage: {},
    clipboard: { writeText: (text) => copied.push(text) },
    dialog: { showMessageBox: async (_window, options) => { confirmations.push(options); effects.push("confirm"); return { response: current.response }; } },
    BrowserWindow: { fromWebContents: () => window }, fetch: async () => {}, root: path.join(directory, "notes"),
    getWindows: () => [window], isFolderSyncBusy: () => current.busy, refreshNotes: () => {},
  });
  return { service, directory, effects, confirmations, current, preview, event, handlers, externalUrls, copied,
    call: (name, input, source = event) => handlers.get(`githubSync:${name}`)(source, input) };
}

test("creation and authorization buttons only open fixed GitHub pages and never create or push", async (t) => {
  const { call, effects, externalUrls, current, copied } = setup(t);
  current.connected = false;
  assert.equal((await call("openCreateRepository")).success, false);
  assert.deepEqual(externalUrls, []);
  current.connected = true;
  await call("openCreateRepository", { url: "https://example.invalid/" });
  await call("openInstallation");
  assert.equal((await call("copyCode")).success, false);
  await call("startAuth");
  await call("copyCode", { userCode: "attacker-code" });
  await call("openVerification");
  assert.deepEqual(externalUrls, ["https://github.com/new", "https://github.com/apps/notes/installations/new", "https://github.com/login/device"]);
  assert.deepEqual(copied, ["ABCD-1234"]);
  await call("cancelAuth");
  assert.equal((await call("copyCode")).success, false);
  assert.deepEqual(effects, []);
  const listed = await call("repositories");
  assert.equal(listed.repositories[0].defaultBranch, "trunk");
  assert.equal(JSON.stringify(listed).includes("SECRET"), false);
});

test("GitHub IPC rejects other windows, subframes and foreign navigation", async (t) => {
  const { call, event } = setup(t);
  assert.equal((await call("status", null, { sender: {}, senderFrame: {} })).success, false);
  assert.equal((await call("status", null, { ...event, senderFrame: { url: event.senderFrame.url } })).success, false);
  event.senderFrame.url = "https://example.com/";
  assert.equal((await call("status")).success, false);
});

test("binding is read-only remotely and only accepts private repositories", async (t) => {
  const { call, current, effects } = setup(t);
  current.private = false;
  assert.equal((await call("bind", { owner: "test", repo: "notes" })).success, false);
  assert.deepEqual(effects, []);
  current.private = true;
  const bound = await call("bind", { owner: "test", repo: "notes" });
  assert.equal(bound.success, true);
  assert.equal(bound.sync.busy, false);
  assert.deepEqual(effects, ["bind"]);
  assert.equal(JSON.stringify(bound).includes("SECRET"), false);
});

test("sync requires fresh preview and native confirmation, cancellation never pushes", async (t) => {
  const { call, current, effects, confirmations } = setup(t);
  await call("bind", { owner: "test", repo: "notes" });
  assert.equal((await call("sync", { previewId: "guess" })).success, false);
  await call("preview");
  current.response = 0;
  const cancelled = await call("sync", { previewId: "preview-id" });
  assert.equal(cancelled.cancelled, true);
  assert.equal(effects.includes("sync"), false);
  assert.match(confirmations[0].detail, /笔记、图片、任务和项目数据会上传/);
  assert.match(confirmations[0].detail, /Journal\/task-module\.json/);
  assert.match(confirmations[0].detail, /Journal\/zentask-projects\.json/);
  assert.match(confirmations[0].detail, /API Key 和其他 JSON 不会上传/);
  current.response = 1;
  const synced = await call("sync", { previewId: "preview-id" });
  assert.equal(synced.success, true);
  assert.equal(effects.filter((name) => name === "sync").length, 1);
  assert.equal((await call("sync", { previewId: "preview-id" })).success, false);
});

test("vault switching waits for editor saves, keeps generation monotonic and clears preview", async (t) => {
  const { call, service, current, directory, handlers } = setup(t);
  const nextRoot = path.join(directory, "second");
  fs.mkdirSync(nextRoot);
  const canonical = fs.realpathSync(nextRoot);
  await call("bind", { owner: "test", repo: "notes" });
  await call("preview");
  const oldGeneration = handlers.get("githubSync:generation")();
  current.failPrepare = true;
  let commits = 0;
  await assert.rejects(service.switchRoot(canonical, () => { commits += 1; }), /保存或刷新/);
  assert.equal(commits, 0);
  assert.notEqual((await call("status")).root, canonical);
  current.failPrepare = false;
  await service.switchRoot(canonical, () => { commits += 1; });
  assert.equal(commits, 1);
  assert.equal((await call("status")).root, canonical);
  assert.ok(handlers.get("githubSync:generation")() > oldGeneration);
  assert.throws(() => service.assertWritable(oldGeneration), /版本已更新/);
  assert.equal((await call("sync", { previewId: "preview-id" })).success, false);
});

test("local PKB operations flush editors, invalidate previews and obey busy state", async (t) => {
  const { call, service, current, effects, handlers } = setup(t);
  await call("bind", { owner: "test", repo: "notes" });
  await call("preview");
  const generation = handlers.get("githubSync:generation")();
  let writes = 0;
  current.failPrepare = true;
  await assert.rejects(service.runLocalOperation(() => writes++), /保存或刷新/);
  assert.equal(writes, 0);
  current.failPrepare = false;
  current.busy = true;
  await assert.rejects(service.runLocalOperation(() => writes++), /截图或文件夹同步/);
  assert.equal(writes, 0);
  current.busy = false;
  await service.runLocalOperation(() => {
    assert.throws(() => service.assertWritable(generation), /同步/);
    writes++;
  });
  assert.equal(writes, 1);
  assert.equal(service.busy, false);
  assert.ok(handlers.get("githubSync:generation")() > generation);
  assert.equal((await call("sync", { previewId: "preview-id" })).success, false);
  assert.equal(effects.includes("sync"), false);
});

test("sync stops on conflicts, public visibility changes or overlapping folder sync", async (t) => {
  const { call, current, effects, preview } = setup(t);
  await call("bind", { owner: "test", repo: "notes" });
  preview.conflicts = ["note.md"];
  await call("preview");
  assert.equal((await call("sync", { previewId: preview.id })).success, false);
  preview.conflicts = [];
  await call("preview");
  current.private = false;
  assert.equal((await call("sync", { previewId: preview.id })).success, false);
  current.busy = true;
  assert.equal((await call("preview")).success, false);
  assert.equal(effects.includes("sync"), false);
  assert.equal(effects.includes("confirm"), false);
});
