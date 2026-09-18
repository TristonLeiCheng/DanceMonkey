const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const {
  buildUpdaterScript,
  createAppUpdateService,
  resolvePayloadRoot,
  validateElectronPayload,
} = require("../electron/app-update");

function temporaryTree() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dm-update-test-"));
}

test("Electron update payload requires both DanceMonkey.exe and app resources", (t) => {
  const root = temporaryTree();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "DanceMonkey.exe"), "MZ");
  fs.mkdirSync(path.join(root, "resources"));
  fs.writeFileSync(path.join(root, "resources", "app.asar"), "asar");
  assert.doesNotThrow(() => validateElectronPayload(root, "DanceMonkey.exe"));
});

test("legacy or unrelated executable-only archives are rejected before replacement", (t) => {
  const root = temporaryTree();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "DanceMonkey.exe"), "not Electron");
  assert.throws(() => validateElectronPayload(root, "DanceMonkey.exe"), /不是 Electron 版 DM/);
  assert.throws(() => validateElectronPayload(root, "desktop.mjs"), /缺少 \.exe 入口/);
});

test("nested Forge zip resolves to the directory containing the requested executable", (t) => {
  const root = temporaryTree();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const payload = path.join(root, "DanceMonkey-win32-x64");
  fs.mkdirSync(payload);
  fs.writeFileSync(path.join(payload, "DanceMonkey.exe"), "MZ");
  assert.equal(resolvePayloadRoot(root, "DanceMonkey.exe"), payload);
});

test("updater waits for every process using the target executable and logs copy failures", () => {
  const script = buildUpdaterScript();
  assert.match(script, /Get-CimInstance Win32_Process/);
  assert.match(script, /ExecutablePath/);
  assert.match(script, /\$exeProcesses\.Count -eq 0/);
  assert.match(script, /\/R:10 \/W:2/);
  assert.match(script, /apply-update\.log/);
  assert.match(script, /exit 1/);
});

test("updater launch reports spawn failures instead of closing the app", async () => {
  const child = new EventEmitter();
  child.unref = () => {};
  const service = createAppUpdateService({
    getInstallDirectory: () => "C:\\DanceMonkey",
    getCurrentVersion: () => "3.3.0",
    spawnUpdater: () => {
      queueMicrotask(() => child.emit("error", new Error("powershell unavailable")));
      return child;
    },
  });
  await assert.rejects(
    service.launchUpdaterAndRestart({ scriptPath: "C:\\Temp\\apply-update.ps1" }),
    /powershell unavailable/,
  );
});

test("updater launch waits until detached process has spawned", async () => {
  const child = new EventEmitter();
  let unrefCalled = false;
  child.unref = () => { unrefCalled = true; };
  const service = createAppUpdateService({
    getInstallDirectory: () => "C:\\DanceMonkey",
    getCurrentVersion: () => "3.3.0",
    spawnUpdater: () => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
  });
  await service.launchUpdaterAndRestart({ scriptPath: "C:\\Temp\\apply-update.ps1" });
  assert.equal(unrefCalled, true);
});
