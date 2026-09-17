/**
 * 打包 Electron 版 DM 为旧版升级器可识别的 ZIP：
 * DanceMonkey-win-x64-{version}.zip + update-manifest.json
 * ZIP 根目录含 DanceMonkey.exe（由 electron.exe 重命名）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";

const root = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(root, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
const version = String(pkg.version || "3.0.0");
const electronDist = path.join(projectRoot, "node_modules", "electron", "dist");
const outRoot = path.join(projectRoot, "publish", "win-x64");
const stageDir = path.join(outRoot, `DanceMonkey-${version}`);
const artifactsDir = path.join(outRoot, "artifacts");
const zipName = `DanceMonkey-win-x64-${version}.zip`;
const zipPath = path.join(artifactsDir, zipName);
const manifestPath = path.join(artifactsDir, "update-manifest.json");

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function mkdirp(target) {
  fs.mkdirSync(target, { recursive: true });
}

function copyFile(src, dest) {
  mkdirp(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function copyDir(src, dest, filter) {
  mkdirp(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (filter && !filter(entry, src)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to, filter);
    else copyFile(from, to);
  }
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex").toUpperCase();
}

if (!fs.existsSync(path.join(electronDist, "electron.exe"))) {
  console.error("[ERROR] 未找到 electron.exe，请先在项目根目录 npm install");
  process.exit(1);
}

console.log(`[INFO] version=${version}`);
console.log(`[INFO] stage=${stageDir}`);
rmrf(stageDir);
mkdirp(stageDir);
mkdirp(artifactsDir);

// 1) Electron 运行时
copyDir(electronDist, stageDir, (entry) => entry.name !== "LICENSE" && entry.name !== "version");
fs.renameSync(path.join(stageDir, "electron.exe"), path.join(stageDir, "DanceMonkey.exe"));
const defaultAsar = path.join(stageDir, "resources", "default_app.asar");
if (fs.existsSync(defaultAsar)) fs.rmSync(defaultAsar, { force: true });
if (fs.existsSync(path.join(projectRoot, "assets", "logo.ico"))) {
  copyFile(path.join(projectRoot, "assets", "logo.ico"), path.join(stageDir, "DanceMonkey.ico"));
}

// 2) 应用文件 -> resources/app
const appDir = path.join(stageDir, "resources", "app");
mkdirp(appDir);

const appFiles = [
  "package.json",
  "index.html",
  "desktop.mjs",
  "server.mjs",
  "start-dm.bat",
  "start-dm.ps1",
];
for (const name of appFiles) {
  const src = path.join(projectRoot, name);
  if (fs.existsSync(src)) copyFile(src, path.join(appDir, name));
}

for (const dir of ["electron", "src", "assets", "tools"]) {
  const src = path.join(projectRoot, dir);
  if (fs.existsSync(src)) {
    copyDir(src, path.join(appDir, dir), (entry, parent) => {
      if (entry.name === "node_modules" || entry.name === "publish") return false;
      if (entry.name === ".git") return false;
      return true;
    });
  }
}

// 3) 生产依赖（不含 electron）
const prodDeps = ["marked", "dompurify", "undici"];
for (const dep of prodDeps) {
  const src = path.join(projectRoot, "node_modules", dep);
  if (!fs.existsSync(src)) {
    console.warn(`[WARN] missing dependency: ${dep}`);
    continue;
  }
  copyDir(src, path.join(appDir, "node_modules", dep), (entry) => {
    return !["test", "tests", ".github", "docs"].includes(entry.name);
  });
}

// undici 可能需要部分传递依赖，尽量复制已安装树中的相关包
for (const dep of ["boolbase", "css-what", "css-select", "domhandler", "domelementtype", "domutils", "entities", "nth-check", "escape-string-regexp"]) {
  const src = path.join(projectRoot, "node_modules", dep);
  if (fs.existsSync(src)) {
    copyDir(src, path.join(appDir, "node_modules", dep), () => true);
  }
}

// 4) 启动辅助：若有人双击目录内 bat，仍可启动
fs.writeFileSync(
  path.join(stageDir, "启动 DanceMonkey.bat"),
  `@echo off\r\ncd /d "%~dp0"\r\nstart "" "%~dp0DanceMonkey.exe"\r\n`,
  "utf8",
);

// 5) 打 ZIP（PowerShell Compress-Archive 对大目录较慢，优先 tar）
rmrf(zipPath);
const zipStagingParent = outRoot;
const zipFolderName = path.basename(stageDir);
try {
  execFileSync(
    "tar",
    ["-a", "-cf", zipPath, "-C", zipStagingParent, zipFolderName],
    { stdio: "inherit", windowsHide: true },
  );
} catch {
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Compress-Archive -Path '${stageDir.replace(/'/g, "''")}' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`,
    ],
    { stdio: "inherit", windowsHide: true },
  );
}

const hash = sha256File(zipPath);
const manifest = {
  version,
  packageUrl: zipName,
  entryExe: "DanceMonkey.exe",
  sha256: hash,
  releaseNotes:
    "DanceMonkey 3.0（Electron）：磨砂快捷轨、工作区、Zen Task、快速访问、文件夹同步、在线升级。旧版一键升级后将切换到新界面。",
};
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

console.log(`[OK] zip=${zipPath}`);
console.log(`[OK] manifest=${manifestPath}`);
console.log(`[OK] sha256=${hash}`);
console.log(`[OK] size=${(fs.statSync(zipPath).size / 1024 / 1024).toFixed(1)} MB`);
