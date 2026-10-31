const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync, spawn } = require("node:child_process");
const { once } = require("node:events");
const { createMacAppUpdateService, bundleFromExecutable, findAppBundle, validateMacPayload, buildMacUpdaterScript, removeAppleDoubleSidecars } = require("../electron/mac-app-update");
const macTest = (name, fn) => test(name, { skip: process.platform !== "darwin" }, fn);
let compilerRoot, binary;

test.before(() => {
  if (process.platform !== "darwin") return;
  compilerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dm-mac-native-test-"));
  const source = path.join(compilerRoot, "main.c");
  binary = path.join(compilerRoot, "DanceMonkey");
  fs.writeFileSync(source, '#include <stdlib.h>\n#include <unistd.h>\nint main(){if(getenv("DM_TEST_FAIL_STARTUP"))return 1;sleep(30);return 0;}\n');
  execFileSync("/usr/bin/clang", [source, "-o", binary]);
});
test.after(() => { if (compilerRoot) fs.rmSync(compilerRoot, { recursive: true, force: true }); });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dm mac 更新 'test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function bundle(directory, version, id = "com.dancemonkey.desktop") {
    const app = path.join(root, directory, "DanceMonkey.app");
    fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
    fs.mkdirSync(path.join(app, "Contents", "Resources"));
    fs.copyFileSync(binary, path.join(app, "Contents", "MacOS", "DanceMonkey"));
    fs.writeFileSync(path.join(app, "Contents", "Resources", "app.asar"), version);
    const info = { CFBundleIdentifier: id, CFBundleExecutable: "DanceMonkey", CFBundleName: "DanceMonkey", CFBundlePackageType: "APPL", CFBundleVersion: version, CFBundleShortVersionString: version };
    const file = path.join(app, "Contents", "Info.plist");
    fs.writeFileSync(file, JSON.stringify(info));
    execFileSync("/usr/bin/plutil", ["-convert", "xml1", file]);
    execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", app], { stdio: "pipe" });
    return app;
  }
  const installed = bundle("Applications", "3.5.0");
  const source = bundle("release", "3.6.0");
  const zip = path.join(root, "release.zip");
  execFileSync("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", source, zip]);
  const userData = path.join(root, "user-data");
  fs.mkdirSync(userData);
  const dataFile = path.join(userData, "notes.json");
  fs.writeFileSync(dataFile, "keep my notes");
  let selected;
  const options = { getCurrentVersion: () => "3.5.0", getExecutablePath: () => path.join(installed, "Contents", "MacOS", "DanceMonkey"), getUserDataDirectory: () => userData,
    releaseClient: { checkForUpdateFromGitHub: async (repo, keyword) => {
      selected = { repo, keyword };
      return { isUpdateAvailable: true, latestVersionText: "3.6.0", manifest: { version: "3.6.0", packageUrl: zip, sha256: crypto.createHash("sha256").update(fs.readFileSync(zip)).digest("hex") } };
    } },
  };
  return { root, installed, source, zip, bundle, userData, dataFile, options, selected: () => selected };
}

async function waitFor(check, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Mac update condition timed out");
}
function version(app) {
  return execFileSync("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", path.join(app, "Contents", "Info.plist")], { encoding: "utf8" }).trim();
}

test("Mac install location is the app bundle, never its MacOS subdirectory or a translocated app", () => {
  assert.equal(bundleFromExecutable("/Applications/DM.app/Contents/MacOS/DanceMonkey"), "/Applications/DM.app");
  assert.throws(() => bundleFromExecutable("/usr/bin/node"));
  assert.throws(() => bundleFromExecutable("/private/var/AppTranslocation/token/d/DM.app/Contents/MacOS/DanceMonkey"));
});

macTest("real signed Mac payload passes; mismatched identity, version, architecture and tampering fail", async (t) => {
  const f = fixture(t);
  const validate = (app = f.source, options = {}) => validateMacPayload(app, { version: "3.6.0", arch: process.arch, installedApp: f.installed, ...options });
  assert.equal((await validate()).executable, "DanceMonkey");
  await assert.rejects(validate(f.source, { version: "3.7.0" }), /版本/);
  await assert.rejects(validate(f.source, { arch: process.arch === "arm64" ? "x64" : "arm64" }), /架构/);
  await assert.rejects(validate(f.bundle("other", "3.6.0", "com.other.application")), /不是 DanceMonkey/);
  fs.appendFileSync(path.join(f.source, "Contents", "Resources", "app.asar"), "tampered");
  await assert.rejects(validate(), /codesign/);
});

macTest("payload cannot use links outside the application bundle", async (t) => {
  const f = fixture(t);
  fs.symlinkSync(f.userData, path.join(f.source, "Contents", "Resources", "external"));
  await assert.rejects(validateMacPayload(f.source, { version: "3.6.0", arch: process.arch }), /链接/);
});

macTest("Mac staging selects the correct arch ZIP and ignores Windows update settings", async (t) => {
  const f = fixture(t), progress = [];
  for (const arch of ["arm64", "x64"]) {
    // Selection can be tested independently of payload CPU validation.
    const service = createMacAppUpdateService({ ...f.options, arch, releaseClient: { checkForUpdateFromGitHub: async (repo, keyword) => {
      assert.equal(keyword, `darwin-${arch}`); assert.equal(repo, "owner/repo");
      return { isUpdateAvailable: false, latestVersionText: "3.5.0" };
    } } });
    assert.equal((await service.checkAndPrepare({ updateGitHubRepo: "owner/repo", updateManifestUrl: "Windows-only", updateAssetKeyword: "win-x64" })).launchInfo, null);
  }
  const service = createMacAppUpdateService(f.options);
  const result = await service.checkAndPrepare({}, (message) => progress.push(message));
  t.after(() => fs.rmSync(result.launchInfo.stagingRoot, { recursive: true, force: true }));
  assert.equal(f.selected().keyword, `darwin-${process.arch}`);
  assert.equal(version(result.launchInfo.sourceApp), "3.6.0");
  assert.equal(version(f.installed), "3.5.0");
  assert.ok(progress.length > 1);
  assert.equal(fs.readFileSync(f.dataFile, "utf8"), "keep my notes");
});

macTest("invalid hash fails staging before extracting or replacing the installed app", async (t) => {
  const f = fixture(t);
  const service = createMacAppUpdateService({ ...f.options, releaseClient: { checkForUpdateFromGitHub: async () => ({ isUpdateAvailable: true, latestVersionText: "3.6.0", manifest: { packageUrl: f.zip, sha256: "00" } }) } });
  await assert.rejects(service.checkAndPrepare(), /SHA256/);
  const detail = JSON.parse(fs.readFileSync(path.join(f.userData, 'update-logs', 'last-error.json')));
  assert.equal(detail.stage, 'checksum');
  assert.equal(version(f.installed), "3.5.0");
});

macTest('extraction and signature failures keep actionable diagnostics after temporary payload cleanup', async t => {
  for (const stage of ['extract', 'payload']) {
    const f = fixture(t);
    if (stage === 'extract') fs.writeFileSync(f.zip, 'not a ZIP');
    else {
      fs.appendFileSync(path.join(f.source, 'Contents/Resources/app.asar'), 'tampered');
      fs.rmSync(f.zip);
      execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', f.source, f.zip]);
    }
    const { publicUpdateError } = require('../electron/app-update-diagnostics');
    await assert.rejects(createMacAppUpdateService(f.options).checkAndPrepare(), error => {
      assert.equal(error.updateStage, stage);
      assert.match(publicUpdateError(error, 'fallback'), stage === 'extract' ? /解压失败/ : /签名校验失败/);
      return true;
    });
    const log = path.join(f.userData, 'update-logs/last-error.json');
    const detail = JSON.parse(fs.readFileSync(log));
    assert.equal(detail.stage, stage);
    assert.ok(detail.stderr);
    assert.equal(fs.statSync(log).mode & 0o777, 0o600);
    assert.equal(version(f.installed), '3.5.0');
    assert.equal(fs.readFileSync(f.dataFile, 'utf8'), 'keep my notes');
  }
});

macTest("different signing team cannot replace a Developer ID installation", async (t) => {
  const f = fixture(t);
  const { promisify } = require("node:util");
  const realRun = promisify(require("node:child_process").execFile);
  await assert.rejects(validateMacPayload(f.source, { version: "3.6.0", arch: process.arch, installedApp: f.installed,
    runFile: (command, args) => command === "/usr/bin/codesign" && args[0] === "-d"
      ? Promise.resolve({ stderr: `TeamIdentifier=${args.at(-1) === f.installed ? "ORIGINAL" : "OTHER"}` }) : realRun(command, args),
  }), /签名/);
});

macTest("bundle discovery ignores metadata and rejects ambiguous apps", (t) => {
  const f = fixture(t);
  const metadata = path.join(f.root, "release", "__MACOSX", "fake.app"); fs.mkdirSync(metadata, { recursive: true });
  assert.equal(findAppBundle(path.join(f.root, "release")), f.source);
  fs.mkdirSync(path.join(f.root, "release", "Other.app"));
  assert.throws(() => findAppBundle(path.join(f.root, "release")), /一个 Mac 应用/);
});

test('archive metadata cleanup removes only AppleDouble files and never follows a directory symlink', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-appledouble-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundle = path.join(root, 'app'), outside = path.join(root, 'outside');
  fs.mkdirSync(bundle); fs.mkdirSync(outside);
  const metadata = Buffer.alloc(26); metadata.writeUInt32BE(0x00051607); metadata.writeUInt32BE(0x00020000, 4);
  fs.writeFileSync(path.join(bundle, '._Framework'), metadata);
  fs.writeFileSync(path.join(bundle, '._ordinary'), 'signed ordinary resource');
  fs.writeFileSync(path.join(bundle, 'ordinary'), metadata);
  fs.writeFileSync(path.join(outside, '._keep'), metadata);
  fs.symlinkSync(outside, path.join(bundle, 'linked'), 'dir');
  removeAppleDoubleSidecars(bundle);
  assert.deepEqual(fs.readdirSync(bundle).sort(), ['._ordinary', 'linked', 'ordinary']);
  assert.equal(fs.existsSync(path.join(outside, '._keep')), true);
});

async function installerFixture(t, { failStartup = false, timeout = false, keepCurrentAlive = false } = {}) {
  const f = fixture(t);
  const oldProcess = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
  t.after(() => oldProcess.kill());
  let helper, helperExit;
  const service = createMacAppUpdateService({ ...f.options, spawnUpdater: (command, args, options) => {
    args[4] = String(oldProcess.pid); // disposable stand-in for the old Electron main process
    helper = spawn(command, args, { ...options, env: { ...process.env, DM_UPDATE_NO_ALERT: "1", ...(failStartup ? { DM_TEST_FAIL_STARTUP: "1" } : {}) } });
    helperExit = once(helper, "exit");
    t.after(() => { try { process.kill(-helper.pid, "SIGKILL"); } catch {} });
    return helper;
  } });
  const result = await service.checkAndPrepare();
  t.after(() => fs.rmSync(result.launchInfo.stagingRoot, { recursive: true, force: true }));
  if (timeout || keepCurrentAlive) fs.writeFileSync(result.launchInfo.scriptPath, buildMacUpdaterScript({ startupTimeoutSeconds: 1, exitTimeoutSeconds: 1 }));
  await service.launchUpdaterAndRestart(result.launchInfo);
  assert.equal(version(f.installed), "3.5.0", "never swap while the old app is still running");
  if (!keepCurrentAlive) oldProcess.kill();
  return { ...f, service, helperExit, staged: result.launchInfo };
}

macTest("real installer waits for exit, swaps bundles, confirms startup and preserves user data", async (t) => {
  const f = await installerFixture(t);
  await waitFor(() => version(f.installed) === "3.6.0");
  const pending = JSON.parse(fs.readFileSync(path.join(f.userData, "mac-update-pending.json")));
  assert.equal(version(path.join(pending.work, "previous.app")), "3.5.0");
  createMacAppUpdateService({ ...f.options, getCurrentVersion: () => "3.6.0" }).confirmStartup();
  const [code] = await f.helperExit;
  assert.equal(code, 0);
  assert.equal(version(f.installed), "3.6.0");
  assert.equal(fs.existsSync(pending.work), false);
  assert.equal(fs.existsSync(f.staged.stagingRoot), false);
  assert.equal(fs.readFileSync(f.dataFile, "utf8"), "keep my notes");
});

macTest("crashed replacement and startup timeout both restore the old version", async (t) => {
  for (const options of [{ failStartup: true }, { timeout: true }]) {
    const f = await installerFixture(t, options);
    const [code] = await f.helperExit;
    assert.notEqual(code, 0);
    assert.equal(version(f.installed), "3.5.0");
    assert.equal(fs.existsSync(path.join(f.userData, "mac-update-pending.json")), false);
    assert.equal(fs.readFileSync(f.dataFile, "utf8"), "keep my notes");
  }
});

macTest("exit timeout leaves a running application's bundle untouched", async (t) => {
  const f = await installerFixture(t, { keepCurrentAlive: true });
  assert.notEqual((await f.helperExit)[0], 0);
  assert.equal(version(f.installed), "3.5.0");
});

macTest("spawn failure keeps the app running and permits retry", async (t) => {
  const f = fixture(t);
  const { EventEmitter } = require("node:events");
  const service = createMacAppUpdateService({ ...f.options, spawnUpdater: () => {
    const child = new EventEmitter(); queueMicrotask(() => child.emit("error", new Error("spawn denied"))); return child;
  } });
  const result = await service.checkAndPrepare();
  t.after(() => fs.rmSync(result.launchInfo.stagingRoot, { recursive: true, force: true }));
  await assert.rejects(service.launchUpdaterAndRestart(result.launchInfo), /spawn denied/);
  assert.equal(version(f.installed), "3.5.0");
  assert.equal(fs.readdirSync(path.dirname(f.installed)).filter((file) => file.startsWith(".DanceMonkey-update-")).length, 0);
});

macTest("startup acknowledgement requires the expected version and a sibling update directory", (t) => {
  const f = fixture(t);
  const pending = path.join(f.userData, "mac-update-pending.json");
  const work = fs.mkdtempSync(path.join(path.dirname(f.installed), ".DanceMonkey-update-"));
  fs.writeFileSync(pending, JSON.stringify({ installedApp: f.installed, version: "3.6.0", work }));
  createMacAppUpdateService(f.options).confirmStartup();
  assert.equal(fs.existsSync(path.join(work, "ready")), false);
  const outside = fs.mkdtempSync(path.join(f.root, ".DanceMonkey-update-"));
  fs.writeFileSync(pending, JSON.stringify({ installedApp: f.installed, version: "3.5.0", work: outside }));
  createMacAppUpdateService(f.options).confirmStartup();
  assert.equal(fs.existsSync(path.join(outside, "ready")), false);
});

macTest('startup confirms the same physical application reached through a macOS path alias', t => {
  const f = fixture(t);
  const alias = path.join(f.root, 'Applications-alias');
  fs.symlinkSync(path.dirname(f.installed), alias);
  const work = fs.mkdtempSync(path.join(alias, '.DanceMonkey-update-'));
  fs.writeFileSync(path.join(f.userData, 'mac-update-pending.json'), JSON.stringify({
    installedApp: path.join(alias, 'DanceMonkey.app'), version: '3.5.0', work,
  }));
  createMacAppUpdateService(f.options).confirmStartup();
  assert.equal(fs.readFileSync(path.join(work, 'ready'), 'utf8'), 'ready');
});

macTest('signed update missing the saved pet is rejected without touching application or preferences', async t=>{
  const f=fixture(t);let animal='otter';
  const service=createMacAppUpdateService({...f.options,getPetSettings:()=>({petAnimal:animal})});
  await assert.rejects(service.checkAndPrepare(),{code:'DM_PET_UPDATE_UNAVAILABLE'});
  assert.equal(version(f.installed),'3.5.0');assert.equal(fs.readFileSync(f.dataFile,'utf8'),'keep my notes');
  animal=null;
  const ready=await service.checkAndPrepare();
  t.after(()=>fs.rmSync(ready.launchInfo.stagingRoot,{recursive:true,force:true}));
  animal='fluffy-rabbit';
  await assert.rejects(service.launchUpdaterAndRestart(ready.launchInfo),{code:'DM_PET_UPDATE_UNAVAILABLE'});
  assert.equal(version(f.installed),'3.5.0');assert.equal(fs.existsSync(path.join(f.userData,'mac-update-pending.json')),false);
});
