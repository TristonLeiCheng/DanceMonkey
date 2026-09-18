const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolvePayloadRoot, validateElectronPayload } = require("../electron/app-update");

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
