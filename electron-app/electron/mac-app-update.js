const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const { createAppUpdateService: createReleaseClient, compareVersions, copySourceToFile, validateSha256 } = require("./app-update");
const execute = promisify(execFile);
const BUNDLE_ID = "com.dancemonkey.desktop";
const { assertPetUpdateCompatible } = require('./pet-package');

function bundleFromExecutable(executable) {
  const match = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(path.resolve(executable));
  if (!match || match[1].includes("/AppTranslocation/")) {
    throw Object.assign(new Error("请先将应用安装到应用程序文件夹，再检查更新。"), { code: "DM_MAC_UPDATE_INSTALL_LOCATION" });
  }
  return match[1];
}

function assertWritableInstall(appPath) {
  if (!fs.lstatSync(appPath).isDirectory()) throw new Error("更新目标必须是已安装的应用。");
  try {
    fs.accessSync(path.dirname(appPath), fs.constants.W_OK | fs.constants.X_OK);
  } catch (error) {
    if (["EACCES", "EPERM", "EROFS"].includes(error.code)) {
      throw Object.assign(new Error("应用安装位置不可写。"), { code: "DM_MAC_UPDATE_INSTALL_LOCATION" });
    }
    throw error;
  }
}

function assertBundleLinks(appPath) {
  const root = fs.realpathSync(appPath);
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = fs.realpathSync(file);
        if (target !== root && !target.startsWith(root + path.sep)) throw new Error("更新包包含无效的应用链接。");
      } else if (entry.isDirectory()) visit(file);
      else if (!entry.isFile()) throw new Error("更新包包含无效的文件类型。");
    }
  }
  visit(appPath);
}

function findAppBundle(root) {
  const apps = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "__MACOSX") continue;
      const full = path.join(directory, entry.name);
      if (entry.name.endsWith(".app")) apps.push(full);
      else visit(full);
    }
  }
  visit(root);
  if (apps.length !== 1) throw new Error("更新包必须包含一个 Mac 应用。");
  return apps[0];
}

async function readBundleInfo(appPath, runFile = execute) {
  const { stdout } = await runFile("/usr/bin/plutil", ["-convert", "json", "-o", "-", path.join(appPath, "Contents", "Info.plist")]);
  return JSON.parse(stdout);
}

async function signingTeam(appPath, runFile = execute) {
  const { stderr = "" } = await runFile("/usr/bin/codesign", ["-d", "--verbose=4", appPath]);
  const team = /^TeamIdentifier=(.+)$/m.exec(stderr)?.[1]?.trim();
  return team && team !== "not set" ? team : "";
}

async function validateMacPayload(appPath, { version, arch, installedApp, runFile = execute }) {
  assertBundleLinks(appPath);
  const info = await readBundleInfo(appPath, runFile);
  if (info.CFBundleIdentifier !== BUNDLE_ID) throw new Error("更新包不是 DanceMonkey 应用。");
  if (compareVersions(info.CFBundleShortVersionString, version) !== 0) throw new Error("更新包版本与发行版不一致。");
  const executable = String(info.CFBundleExecutable || "");
  if (!executable || path.basename(executable) !== executable || executable === "." || executable === "..") throw new Error("更新包缺少有效入口。");
  const executablePath = path.join(appPath, "Contents", "MacOS", executable);
  fs.accessSync(executablePath, fs.constants.X_OK);
  const resources = path.join(appPath, "Contents", "Resources");
  if (!fs.existsSync(path.join(resources, "app.asar")) && !fs.existsSync(path.join(resources, "app", "electron", "main.js"))) {
    throw new Error("更新包缺少 Electron 应用资源。");
  }
  const { stdout } = await runFile("/usr/bin/lipo", ["-archs", executablePath]);
  if (!String(stdout).trim().split(/\s+/).includes(arch === "x64" ? "x86_64" : "arm64")) throw new Error("更新包不支持当前 Mac 架构。");
  await runFile("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath]);
  if (installedApp) {
    const installedInfo = await readBundleInfo(installedApp, runFile);
    if (installedInfo.CFBundleExecutable !== executable) throw new Error("更新包入口与已安装应用不一致。");
    const team = await signingTeam(installedApp, runFile);
    if (team && await signingTeam(appPath, runFile) !== team) throw new Error("更新包签名与已安装应用不一致。");
  }
  return { executable, version: info.CFBundleShortVersionString };
}

function buildMacUpdaterScript({ exitTimeoutSeconds = 120, startupTimeoutSeconds = 60 } = {}) {
  return `#!/bin/sh
set -eu
install=$1
work=$2
executable=$3
current_pid=$4
pending=$5
staging=$6
new_pid=''
moved_old=0
installed_new=0
exec >> "$staging/apply-update.log" 2>&1
rollback() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$status" -eq 0 ]; then status=1; fi
  if [ -n "$new_pid" ]; then
    kill "$new_pid" 2>/dev/null || true
    count=0
    while kill -0 "$new_pid" 2>/dev/null && [ "$count" -lt 10 ]; do sleep 1; count=$((count + 1)); done
    kill -KILL "$new_pid" 2>/dev/null || true
    wait "$new_pid" 2>/dev/null || true
  fi
  restored=0
  if [ "$installed_new" -eq 1 ]; then /bin/mv "$install" "$work/failed.app" || true; fi
  if [ "$moved_old" -eq 1 ]; then
    if [ ! -e "$install" ] && [ ! -L "$install" ] && /bin/mv "$work/previous.app" "$install"; then
      restored=1
      "$install/Contents/MacOS/$executable" >/dev/null 2>&1 &
    fi
  fi
  if [ "$moved_old" -eq 0 ] || [ "$restored" -eq 1 ]; then
    /bin/rm -f "$pending"
    /bin/rm -rf "$work"
  fi
  if [ "\${DM_UPDATE_NO_ALERT:-0}" != 1 ]; then
    /usr/bin/osascript -e 'display alert "更新未完成" message "请重新打开应用并重试。原有资料已保留。"' || true
  fi
  exit "$status"
}
trap rollback EXIT HUP INT TERM
count=0
while kill -0 "$current_pid" 2>/dev/null; do
  if [ "$count" -ge ${exitTimeoutSeconds} ]; then exit 1; fi
  sleep 1
  count=$((count + 1))
done
/bin/mv "$install" "$work/previous.app"
moved_old=1
if [ -e "$install" ] || [ -L "$install" ]; then exit 1; fi
/bin/mv "$work/next.app" "$install"
installed_new=1
# Launch the bundle's executable so we can stop it and restore the old app if startup fails.
cd "$(/usr/bin/dirname "$install")"
"$install/Contents/MacOS/$executable" >/dev/null 2>&1 &
new_pid=$!
count=0
while [ ! -f "$work/ready" ]; do
  if ! kill -0 "$new_pid" 2>/dev/null || [ "$count" -ge ${startupTimeoutSeconds} ]; then exit 1; fi
  sleep 1
  count=$((count + 1))
done
trap - EXIT HUP INT TERM
/bin/rm -f "$pending"
/bin/rm -rf "$work"
/bin/rm -rf "$staging"
exit 0
`;
}

function createMacAppUpdateService({ getCurrentVersion, getExecutablePath = () => process.execPath,
  getUserDataDirectory = () => path.join(os.homedir(), "Library", "Application Support", "DM"),
  arch = process.arch, runFile = execute, spawnUpdater = spawn, getPetSettings = () => null,
  releaseClient = createReleaseClient({ getCurrentVersion, getInstallDirectory: () => "" }),
}) {
  if (!["arm64", "x64"].includes(arch)) throw new Error("不支持当前 Mac 架构。");
  const installApp = () => bundleFromExecutable(getExecutablePath());
  const pendingFile = () => path.join(getUserDataDirectory(), "mac-update-pending.json");
  let prepared = null;

  async function checkAndPrepare(options = {}, onProgress) {
    const installedApp = installApp();
    assertWritableInstall(installedApp);
    if ((await readBundleInfo(installedApp, runFile)).CFBundleIdentifier !== BUNDLE_ID) throw new Error("开发模式不支持安装更新。");
    onProgress?.("正在检查更新…");
    // Mac always selects its own ZIP; legacy Windows manifest and keyword settings do not apply.
    const check = await releaseClient.checkForUpdateFromGitHub(options.updateGitHubRepo || "TristonLeiCheng/DanceMonkey", `darwin-${arch}`);
    if (!check.isUpdateAvailable) return { ...check, launchInfo: null };
    const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dm-mac-update-"));
    fs.chmodSync(stagingRoot, 0o700);
    try {
      const packagePath = path.join(stagingRoot, "package.zip");
      onProgress?.("正在下载更新包…");
      await copySourceToFile(check.manifest.packageUrl, packagePath, onProgress);
      if (check.manifest.sha256) validateSha256(packagePath, check.manifest.sha256);
      onProgress?.("正在解压并校验更新…");
      const extractRoot = path.join(stagingRoot, "payload");
      fs.mkdirSync(extractRoot);
      // bsdtar refuses .. and symlink-directory traversal without the unsafe -P option.
      await runFile("/usr/bin/tar", ["-xf", packagePath, "-C", extractRoot, "--no-same-owner", "--no-same-permissions"]);
      const sourceApp = findAppBundle(extractRoot);
      const payload = await validateMacPayload(sourceApp, { version: check.latestVersionText, arch, installedApp, runFile });
      assertPetUpdateCompatible(sourceApp, (getPetSettings() || options).petAnimal);
      const scriptPath = path.join(stagingRoot, "apply-update.sh");
      fs.writeFileSync(scriptPath, buildMacUpdaterScript(), { mode: 0o700 });
      prepared = { sourceApp, installedApp, stagingRoot, scriptPath, executable: payload.executable, version: check.latestVersionText };
      return { ...check, launchInfo: prepared };
    } catch (error) {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
      throw error;
    }
  }

  async function launchUpdaterAndRestart(launchInfo) {
    if (!prepared || launchInfo !== prepared || installApp() !== prepared.installedApp) throw new Error("请重新检查更新。");
    assertWritableInstall(prepared.installedApp);
    const work = fs.mkdtempSync(path.join(path.dirname(prepared.installedApp), ".DanceMonkey-update-"));
    fs.chmodSync(work, 0o700);
    try {
      const next = path.join(work, "next.app");
      await runFile("/usr/bin/ditto", [prepared.sourceApp, next]);
      await validateMacPayload(next, { version: prepared.version, arch, installedApp: prepared.installedApp, runFile });
      assertPetUpdateCompatible(next, getPetSettings()?.petAnimal);
      fs.mkdirSync(getUserDataDirectory(), { recursive: true });
      fs.writeFileSync(pendingFile(), JSON.stringify({ installedApp: prepared.installedApp, version: prepared.version, work }), { mode: 0o600 });
      await new Promise((resolve, reject) => {
        const child = spawnUpdater("/bin/sh", [prepared.scriptPath, prepared.installedApp, work, prepared.executable, String(process.pid), pendingFile(), prepared.stagingRoot], {
          detached: true, stdio: "ignore", cwd: prepared.stagingRoot,
        });
        child.once("error", reject);
        child.once("spawn", () => { child.unref(); resolve(); });
      });
    } catch (error) {
      fs.rmSync(work, { recursive: true, force: true });
      fs.rmSync(pendingFile(), { force: true });
      throw error;
    }
  }

  function confirmStartup() {
    const file = pendingFile();
    if (!fs.existsSync(file)) return;
    try {
      const pending = JSON.parse(fs.readFileSync(file, "utf8"));
      const appPath = installApp();
      if (pending.installedApp !== appPath || pending.version !== getCurrentVersion()) return;
      const work = path.resolve(pending.work);
      if (path.dirname(work) !== path.dirname(appPath) || !path.basename(work).startsWith(".DanceMonkey-update-") || fs.lstatSync(work).isSymbolicLink()) return;
      fs.writeFileSync(path.join(work, "ready"), "ready", { flag: "wx", mode: 0o600 });
    } catch (error) { console.warn("Unable to confirm Mac update startup", error); }
  }

  return { checkAndPrepare, launchUpdaterAndRestart, confirmStartup, getCurrentVersion,
    getInstallDirectory: () => path.dirname(installApp()) };
}

module.exports = { createMacAppUpdateService, bundleFromExecutable, findAppBundle, validateMacPayload, buildMacUpdaterScript };
