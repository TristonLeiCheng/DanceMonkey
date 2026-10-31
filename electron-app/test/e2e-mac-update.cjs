// Run with: node_modules/.bin/electron test/e2e-mac-update.cjs
// Exercises a real signed packaged app, never the application's installed copy or user vault.
const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const { createMacAppUpdateService } = require('../electron/mac-app-update');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-packaged-update-'));
const applications = path.join(root, 'Applications');
const userData = path.join(root, 'user-data');
fs.mkdirSync(applications);
fs.mkdirSync(userData);
app.setPath('userData', path.join(root, 'test-runner'));
const payload = path.resolve(process.env.DM_UPDATE_TEST_APP || `out/DanceMonkey-darwin-${process.arch}/DanceMonkey.app`);
const bundleVersion = bundle => execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(bundle, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
let helper, oldProcess, staging;

app.whenReady().then(async () => {
  try {
    // Use an alias intentionally: Electron canonicalizes process.execPath after restart.
    const alias = path.join(root, 'Applications-alias');
    fs.symlinkSync(applications, alias);
    const installed = path.join(alias, 'DanceMonkey.app');
    execFileSync('/usr/bin/ditto', [payload, installed]);
    const marker = path.join(userData, 'notes-preservation-marker.md');
    fs.writeFileSync(marker, '# Keep this note\n');
    const zip = path.join(root, 'release.zip');
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', payload, zip]);
    const version = bundleVersion(payload);
    oldProcess = spawn('/bin/sleep', ['120'], { stdio: 'ignore' });
    let exited;
    const service = createMacAppUpdateService({
      getCurrentVersion: () => '0.0.0',
      getExecutablePath: () => path.join(installed, 'Contents/MacOS/DanceMonkey'),
      getUserDataDirectory: () => userData,
      getPetSettings: () => ({ petAnimal: 'engineer-fox' }),
      releaseClient: { checkForUpdateFromGitHub: async () => ({ isUpdateAvailable: true, latestVersionText: version, manifest: { packageUrl: zip } }) },
      spawnUpdater: (command, args, options) => {
        args[4] = String(oldProcess.pid);
        helper = spawn(command, args, { ...options,
          env: { ...process.env, DM_E2E_ROOT: root, DM_E2E_PORT: '0', DM_UPDATE_NO_ALERT: '1' } });
        exited = once(helper, 'exit');
        return helper;
      },
    });
    const result = await service.checkAndPrepare({}, console.log);
    staging = result.launchInfo.stagingRoot;
    await service.launchUpdaterAndRestart(result.launchInfo);
    assert.ok(fs.existsSync(path.join(userData, 'mac-update-pending.json')));
    oldProcess.kill();
    const [code] = await exited;
    assert.equal(code, 0, fs.readFileSync(path.join(userData, 'update-logs/apply-update.log'), 'utf8'));
    assert.equal(bundleVersion(installed), version);
    assert.equal(fs.existsSync(path.join(userData, 'mac-update-pending.json')), false);
    assert.equal(fs.existsSync(staging), false);
    assert.equal(fs.readdirSync(applications).some(name => name.startsWith('.DanceMonkey-update-')), false);
    assert.equal(fs.readFileSync(marker, 'utf8'), '# Keep this note\n');
    assert.match(fs.readFileSync(path.join(userData, 'update-logs/apply-update.log'), 'utf8'), /Update startup confirmed/);
    console.log('PASS: packaged update, real Electron restart, path alias acknowledgement and note preservation');
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally {
    oldProcess?.kill();
    if (helper?.pid) { try { process.kill(-helper.pid, 'SIGKILL'); } catch {} }
    if (staging) fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
    app.exit(process.exitCode || 0);
  }
});
