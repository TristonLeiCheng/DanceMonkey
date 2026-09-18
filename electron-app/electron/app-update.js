const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { fetchWithSystemProxy } = require("./system-proxy");

const USER_AGENT = "DanceMonkey-Updater/1.0";

function parseVersion(text) {
  const raw = String(text || "")
    .trim()
    .replace(/^[vV]/, "");
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(raw);
  if (!match) return null;
  return {
    major: Number(match[1]) || 0,
    minor: Number(match[2]) || 0,
    patch: Number(match[3]) || 0,
    text: raw,
  };
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function isHttpUrl(value) {
  try {
    const uri = new URL(String(value || ""));
    return uri.protocol === "http:" || uri.protocol === "https:";
  } catch {
    return false;
  }
}

function resolveFilePath(source) {
  try {
    const uri = new URL(String(source || ""));
    if (uri.protocol === "file:") return uri.pathname.replace(/^\/([A-Za-z]:)/, "$1");
  } catch {}
  return path.resolve(String(source || ""));
}

function resolvePackageSource(manifestSource, packageSource) {
  const pkg = String(packageSource || "").trim();
  if (!pkg) throw new Error("升级清单缺少 packageUrl 字段。");
  if (isHttpUrl(pkg)) return pkg;
  if (path.isAbsolute(pkg) || pkg.startsWith("\\\\")) return pkg;
  if (isHttpUrl(manifestSource)) return new URL(pkg, manifestSource).toString();
  const manifestPath = resolveFilePath(manifestSource);
  return path.resolve(path.dirname(manifestPath), pkg);
}

function sanitizeFileName(value) {
  return String(value || "update").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
}

async function readText(source) {
  if (isHttpUrl(source)) {
    const response = await fetchWithSystemProxy(source, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json,text/plain,*/*" },
    });
    if (!response.ok) {
      throw new Error(`无法读取升级清单（HTTP ${response.status}）。`);
    }
    return await response.text();
  }
  const filePath = resolveFilePath(source);
  if (!fs.existsSync(filePath)) throw new Error(`未找到升级清单文件：${filePath}`);
  return fs.readFileSync(filePath, "utf8");
}

async function copySourceToFile(source, destinationPath, onProgress) {
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  if (isHttpUrl(source)) {
    const response = await fetchWithSystemProxy(source, {
      headers: { "User-Agent": USER_AGENT },
    });
    if (!response.ok) throw new Error(`下载升级包失败（HTTP ${response.status}）。`);
    const total = Number(response.headers.get("content-length") || 0);
    const arrayBuffer = await response.arrayBuffer();
    fs.writeFileSync(destinationPath, Buffer.from(arrayBuffer));
    onProgress?.(total ? `已下载 ${(arrayBuffer.byteLength / 1024 / 1024).toFixed(1)} MB` : "升级包下载完成");
    return;
  }
  const filePath = resolveFilePath(source);
  if (!fs.existsSync(filePath)) throw new Error(`未找到升级包文件：${filePath}`);
  fs.copyFileSync(filePath, destinationPath);
  onProgress?.("升级包已复制到临时目录");
}

function validateSha256(filePath, expectedHash) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  const actual = hash.digest("hex").toUpperCase();
  const expected = String(expectedHash || "")
    .replace(/-/g, "")
    .trim()
    .toUpperCase();
  if (actual !== expected) throw new Error("升级包校验失败：SHA256 不匹配。");
}

function walkFiles(root) {
  const results = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) results.push(full);
    }
  }
  return results;
}

function resolvePayloadRoot(extractRoot, entryExe) {
  const entryName = path.basename(entryExe || "DanceMonkey.exe");
  const direct = path.join(extractRoot, entryName);
  if (fs.existsSync(direct)) return extractRoot;
  const nested = walkFiles(extractRoot).find(
    (file) => path.basename(file).toLowerCase() === entryName.toLowerCase(),
  );
  if (nested) return path.dirname(nested);

  // Electron 便携包：有 package.json / electron/main.js 也可作为根
  if (fs.existsSync(path.join(extractRoot, "package.json"))) return extractRoot;
  const packageJson = walkFiles(extractRoot).find((file) => path.basename(file) === "package.json");
  if (packageJson) return path.dirname(packageJson);

  throw new Error(`升级包中未找到入口文件 ${entryName}。`);
}

function detectEntryName(payloadRoot, preferred) {
  const preferredName = path.basename(String(preferred || "").trim() || "DanceMonkey.exe");
  const candidates = [
    preferredName,
    "DanceMonkey.exe",
    "DM.exe",
    "desktop.mjs",
    "启动 DanceMonkey.bat",
    "启动DM.bat",
  ];
  for (const name of candidates) {
    if (fs.existsSync(path.join(payloadRoot, name))) return name;
  }
  if (fs.existsSync(path.join(payloadRoot, "package.json"))) return "desktop.mjs";
  return preferredName;
}

function validateElectronPayload(payloadRoot, exeName) {
  const entry = path.join(payloadRoot, exeName);
  if (!/\.exe$/i.test(exeName) || !fs.existsSync(entry)) {
    throw new Error("升级包不是可识别的 Windows DM 应用：缺少 .exe 入口。");
  }
  const asar = path.join(payloadRoot, "resources", "app.asar");
  const unpackedMain = path.join(payloadRoot, "resources", "app", "electron", "main.js");
  if (!fs.existsSync(asar) && !fs.existsSync(unpackedMain)) {
    throw new Error("升级包不是 Electron 版 DM（缺少 resources/app.asar），已拒绝替换当前程序。");
  }
}

function extractZip(packagePath, extractRoot) {
  fs.mkdirSync(extractRoot, { recursive: true });
  const { execFileSync } = require("node:child_process");
  try {
    execFileSync("tar", ["-xf", packagePath, "-C", extractRoot], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  } catch {}
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Expand-Archive -LiteralPath '${packagePath.replace(/'/g, "''")}' -DestinationPath '${extractRoot.replace(/'/g, "''")}' -Force`,
    ],
    { windowsHide: true, stdio: "ignore" },
  );
}

function buildUpdaterScript() {
  return `param(
    [string]$SourceDir,
    [string]$InstallDir,
    [string]$UpdateStartup,
    [string]$ExeName,
    [int]$CurrentPid
)
$ErrorActionPreference = 'Stop'
function Normalize-Dir([string]$p) {
    if ([string]::IsNullOrWhiteSpace($p)) { return '' }
    return [System.IO.Path]::GetFullPath($p).TrimEnd('\\','/')
}
try {
    if ($CurrentPid -gt 0) {
        Wait-Process -Id $CurrentPid -ErrorAction SilentlyContinue
    }
    $install = Normalize-Dir $InstallDir
    New-Item -ItemType Directory -Force -Path $install | Out-Null
    # Invoke directly so PowerShell preserves paths containing spaces as single arguments.
    & robocopy.exe $SourceDir $install /E /R:2 /W:1 /NFL /NDL /NJH /NJS /NP
    if ($LASTEXITCODE -gt 7) {
        throw "robocopy failed with exit code $LASTEXITCODE."
    }
    $entry = Join-Path $install $ExeName
    if ($UpdateStartup -eq '1') {
        $runKey = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
        if (Get-ItemProperty -Path $runKey -Name 'DanceMonkey' -ErrorAction SilentlyContinue) {
            if (Test-Path (Join-Path $install 'DanceMonkey.exe')) {
                Set-ItemProperty -Path $runKey -Name 'DanceMonkey' -Value ('"' + (Join-Path $install 'DanceMonkey.exe') + '"')
            } elseif (Test-Path $entry) {
                Set-ItemProperty -Path $runKey -Name 'DanceMonkey' -Value ('"' + $entry + '"')
            }
        }
    }
    if ($ExeName -like '*.exe') {
        if (-not (Test-Path $entry)) { throw "Updated executable not found: $entry" }
        Start-Process -FilePath $entry -WorkingDirectory $install | Out-Null
    } elseif ($ExeName -like '*.bat' -or $ExeName -like '*.cmd') {
        if (-not (Test-Path $entry)) { throw "Updated launcher not found: $entry" }
        Start-Process -FilePath $entry -WorkingDirectory $install | Out-Null
    } elseif ($ExeName -like '*.mjs' -or $ExeName -like '*.js') {
        $node = (Get-Command node -ErrorAction SilentlyContinue).Source
        if (-not $node) { throw '未找到 node，无法重启 Electron 版 DM。' }
        if (-not (Test-Path $entry)) {
            $electron = Join-Path $install 'node_modules\\.bin\\electron.cmd'
            if (Test-Path $electron) {
                Start-Process -FilePath $electron -ArgumentList '.' -WorkingDirectory $install | Out-Null
                return
            }
            throw "Updated entry not found: $entry"
        }
        Start-Process -FilePath $node -ArgumentList @($ExeName) -WorkingDirectory $install | Out-Null
    } else {
        $electron = Join-Path $install 'node_modules\\.bin\\electron.cmd'
        if (Test-Path $electron) {
            Start-Process -FilePath $electron -ArgumentList '.' -WorkingDirectory $install | Out-Null
        } elseif (Test-Path $entry) {
            Start-Process -FilePath $entry -WorkingDirectory $install | Out-Null
        } else {
            throw "Updated entry not found: $entry"
        }
    }
}
catch {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show("升级失败：$($_.Exception.Message)", 'DM 更新') | Out-Null
}
`;
}

function parseRepository(repository) {
  const value = String(repository || "").trim();
  try {
    const uri = new URL(value);
    if (uri.hostname.toLowerCase().includes("github.com")) {
      const segments = uri.pathname.replace(/^\/+|\/+$/g, "").split("/");
      if (segments.length >= 2) return `${segments[0]}/${segments[1]}`;
    }
  } catch {}
  return value.replace(/^\/+|\/+$/g, "");
}

function createAppUpdateService({ getInstallDirectory, getCurrentVersion, isStartupEnabled }) {
  function buildCheckResult(manifest) {
    const currentVersionText = String(getCurrentVersion() || "0.0.0");
    const latestVersionText = String(manifest.version || "").trim();
    const compared = compareVersions(latestVersionText, currentVersionText);
    const isUpdateAvailable =
      compared == null
        ? currentVersionText.toLowerCase() !== latestVersionText.toLowerCase()
        : compared > 0;
    return {
      isUpdateAvailable,
      currentVersionText,
      latestVersionText,
      message: isUpdateAvailable
        ? `发现新版本 v${latestVersionText}。`
        : `当前已是最新版本 v${currentVersionText}。`,
      manifest,
    };
  }

  async function checkForUpdate(manifestSource) {
    if (!String(manifestSource || "").trim()) {
      throw new Error("在线升级清单 URL 不能为空。");
    }
    const json = await readText(manifestSource);
    let manifest;
    try {
      manifest = JSON.parse(json);
    } catch {
      throw new Error("升级清单格式无效。");
    }
    if (!String(manifest.version || "").trim()) throw new Error("升级清单缺少 version 字段。");
    if (!String(manifest.packageUrl || "").trim()) throw new Error("升级清单缺少 packageUrl 字段。");
    manifest.packageUrl = resolvePackageSource(manifestSource, manifest.packageUrl);
    manifest.entryExe = String(manifest.entryExe || "DanceMonkey.exe").trim() || "DanceMonkey.exe";
    return buildCheckResult(manifest);
  }

  async function checkForUpdateFromGitHub(repository, assetKeyword = "win-x64") {
    if (!String(repository || "").trim()) {
      throw new Error("GitHub 仓库不能为空，请使用 owner/repo 格式。");
    }
    const ownerRepo = parseRepository(repository);
    const apiUrl = `https://api.github.com/repos/${ownerRepo}/releases/latest`;
    const response = await fetchWithSystemProxy(apiUrl, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/vnd.github+json",
      },
    });
    if (!response.ok) {
      throw new Error(`无法获取 GitHub 最新发行版（HTTP ${response.status}）。请检查网络或仓库地址。`);
    }
    const release = await response.json();
    const tag = String(release.tag_name || "").trim();
    if (!tag) throw new Error("GitHub 发行版缺少 tag_name 字段。");
    const version = tag.replace(/^[vV]/, "").trim();
    const zipAssets = (Array.isArray(release.assets) ? release.assets : [])
      .map((asset) => ({
        name: String(asset.name || ""),
        url: String(asset.browser_download_url || ""),
      }))
      .filter((asset) => asset.name && asset.url && /\.zip$/i.test(asset.name));
    if (!zipAssets.length) {
      throw new Error("GitHub 最新发行版中未找到可用的 .zip 升级包。");
    }
    let packageUrl = zipAssets[0].url;
    const keyword = String(assetKeyword || "").trim();
    if (keyword) {
      const matched = zipAssets.find((asset) =>
        asset.name.toLowerCase().includes(keyword.toLowerCase()),
      );
      if (!matched) {
        throw new Error(`GitHub 最新发行版中未找到文件名包含 '${keyword}' 的 .zip 升级包。`);
      }
      packageUrl = matched.url;
    }
    return buildCheckResult({
      version,
      packageUrl,
      entryExe: "DanceMonkey.exe",
      releaseNotes: release.body || "",
    });
  }

  async function downloadAndStage(manifest, onProgress) {
    const updateRoot = path.join(
      os.tmpdir(),
      "DanceMonkey",
      "updates",
      `${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}-${sanitizeFileName(manifest.version)}`,
    );
    fs.mkdirSync(updateRoot, { recursive: true });
    const packagePath = path.join(updateRoot, "package.zip");
    const extractRoot = path.join(updateRoot, "payload");
    const scriptPath = path.join(updateRoot, "apply-update.ps1");

    onProgress?.("正在下载更新包...");
    await copySourceToFile(manifest.packageUrl, packagePath, onProgress);
    if (manifest.sha256) {
      onProgress?.("正在校验 SHA256...");
      validateSha256(packagePath, manifest.sha256);
    }
    onProgress?.("正在解压更新包...");
    extractZip(packagePath, extractRoot);
    const payloadRoot = resolvePayloadRoot(extractRoot, manifest.entryExe);
    const exeName = detectEntryName(payloadRoot, manifest.entryExe);
    validateElectronPayload(payloadRoot, exeName);
    fs.writeFileSync(scriptPath, buildUpdaterScript(), { encoding: "utf8" });

    return {
      scriptPath,
      sourceDirectory: payloadRoot,
      installDirectory: getInstallDirectory(),
      exeName,
      updateStartupEntry: Boolean(isStartupEnabled?.()),
    };
  }

  function launchUpdaterAndRestart(launchInfo) {
    const args = [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-WindowStyle",
      "Hidden",
      "-File",
      launchInfo.scriptPath,
      "-SourceDir",
      launchInfo.sourceDirectory,
      "-InstallDir",
      launchInfo.installDirectory,
      "-UpdateStartup",
      launchInfo.updateStartupEntry ? "1" : "0",
      "-ExeName",
      launchInfo.exeName,
      "-CurrentPid",
      String(process.pid),
    ];
    const child = spawn("powershell.exe", args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      cwd: path.dirname(launchInfo.scriptPath),
    });
    child.unref();
  }

  async function checkAndPrepare(options = {}, onProgress) {
    const manifestUrl = String(options.updateManifestUrl || "").trim();
    const repository = String(options.updateGitHubRepo || "TristonLeiCheng/DanceMonkey").trim();
    const assetKeyword = String(options.updateAssetKeyword || "win-x64").trim();
    onProgress?.(
      manifestUrl ? "正在检查最新版本..." : "正在检查 GitHub 最新 Release...",
    );
    const check = manifestUrl
      ? await checkForUpdate(manifestUrl)
      : await checkForUpdateFromGitHub(repository, assetKeyword);
    if (!check.isUpdateAvailable || !check.manifest) {
      return { ...check, launchInfo: null };
    }
    const launchInfo = await downloadAndStage(check.manifest, onProgress);
    return { ...check, launchInfo };
  }

  return {
    checkForUpdate,
    checkForUpdateFromGitHub,
    downloadAndStage,
    launchUpdaterAndRestart,
    checkAndPrepare,
    getCurrentVersion: () => String(getCurrentVersion() || "0.0.0"),
    getInstallDirectory,
  };
}

module.exports = {
  createAppUpdateService,
  parseVersion,
  compareVersions,
  resolvePayloadRoot,
  validateElectronPayload,
};
