const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createVaultRegistry, registerVaultIpc } = require("../electron/vaults");
const { createLegacyConfig } = require("../electron/legacy-config");
const { createSyncDirectories } = require("../electron/github-vaults");
const { createGitHubSync } = require("../electron/github-sync");

function fixture(t) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dm-vaults-")));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const a = path.join(temp, "A"), b = path.join(temp, "B"), data = path.join(temp, "data");
  for (const directory of [a, b, data]) fs.mkdirSync(directory);
  const config = createLegacyConfig(data);
  const registry = createVaultRegistry({ config, root: a, protectedRoots: [data] });
  return { temp, a, b, data, config, registry };
}

test("registry persists A to B to A with independent roots and names", (t) => {
  const { a, b, config, registry } = fixture(t);
  assert.throws(() => registry.prepare(b, true), /尚未登记/);
  registry.activate(registry.prepare(b));
  assert.equal(registry.list().activeRoot, b);
  registry.activate(registry.prepare(a, true));
  assert.equal(config.read().notesRootPath, a);
  const restored = createVaultRegistry({ config, root: a });
  assert.deepEqual(restored.list().vaults.map((item) => item.root), [a, b]);
});

test("missing, nested and application-data directories cannot become new vaults", (t) => {
  const { a, b, data, temp, registry } = fixture(t);
  const child = path.join(a, "nested"); fs.mkdirSync(child);
  assert.throws(() => registry.prepare(child), /嵌套/);
  assert.throws(() => registry.prepare(data), /应用数据/);
  assert.throws(() => registry.prepare(temp), /应用数据/);
  assert.throws(() => registry.prepare(path.join(temp, "missing")), /不存在/);
  registry.activate(registry.prepare(b));
  fs.renameSync(a, path.join(temp, "moved-a"));
  assert.throws(() => registry.prepare(a, true), /不存在/);
  assert.equal(fs.existsSync(a), false);
});

test("picker cancellation and failed switching never register or activate a vault", async (t) => {
  const { a, b, registry } = fixture(t);
  const handlers = new Map();
  let result = { canceled: true, filePaths: [] };
  let switching = false;
  registerVaultIpc({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, registry,
    trusted: (event) => event.trusted, busy: () => switching,
    dialog: { showOpenDialog: async () => result }, BrowserWindow: { fromWebContents: () => null },
    switchVault: async () => { throw new Error("保存失败"); },
  });
  const event = { trusted: true };
  assert.equal((await handlers.get("vaults:open")(event)).canceled, true);
  result = { canceled: false, filePaths: [b] };
  assert.equal((await handlers.get("vaults:open")(event)).success, false);
  assert.equal(registry.list().activeRoot, a);
  assert.equal(registry.list().vaults.length, 1);
  assert.equal((await handlers.get("vaults:list")({ trusted: false })).success, false);
  switching = true;
  assert.equal((await handlers.get("vaults:select")(event, a)).success, false);
});

test("legacy sync directory stays with its original vault after restarting on B", async (t) => {
  const { a, b, data } = fixture(t);
  const directory = path.join(data, "github-notes");
  const locate = createSyncDirectories(directory, a);
  const first = createGitHubSync({ root: a, directory: locate(a) });
  await first.configure({ owner: "test", repo: "notes-a", branch: "main" });
  const stateFile = path.join(locate(a), "state.json");
  const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  saved.base = { "same.md": "old-base" };
  fs.writeFileSync(stateFile, JSON.stringify(saved));
  fs.writeFileSync(path.join(locate(a), "pending.json"), JSON.stringify({ test: true }));
  const second = createGitHubSync({ root: b, directory: locate(b) });
  assert.equal(second.status().binding, null);
  await second.configure({ owner: "test", repo: "notes-b", branch: "main" });
  const afterRestart = createSyncDirectories(directory, b);
  assert.equal(afterRestart(a), locate(a));
  assert.equal(afterRestart(b), locate(b));
  assert.notEqual(afterRestart(a), afterRestart(b));
  assert.equal(createGitHubSync({ root: a, directory: afterRestart(a) }).status().binding.repo, "notes-a");
  assert.equal(createGitHubSync({ root: a, directory: afterRestart(a) }).status().pending, true);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).base["same.md"], "old-base");
});

test("existing legacy state determines its owner rather than the active root", (t) => {
  const { a, b, data } = fixture(t);
  const directory = path.join(data, "github-notes");
  fs.mkdirSync(path.join(directory, "sync"), { recursive: true });
  fs.writeFileSync(path.join(directory, "sync", "state.json"), JSON.stringify({ root: a }));
  const locate = createSyncDirectories(directory, b);
  assert.equal(locate(a), path.join(directory, "sync"));
  assert.notEqual(locate(b), locate(a));
});

test("failed store writes leave the in-memory quick-note projection unchanged", (t) => {
  const { data } = fixture(t);
  const { createStore } = require("../electron/store");
  const store = createStore(data);
  const before = store.get();
  fs.mkdirSync(path.join(data, "lumen-store.json.tmp"));
  assert.throws(() => store.set({ notes: [], activeNoteId: null }));
  assert.equal(store.get(), before);
});
