import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  throw new Error("macOS 安装包必须在 macOS 上构建。");
}

const arch = process.argv[2] || process.arch;
if (!["arm64", "x64"].includes(arch)) {
  throw new Error(`不支持的 Mac 架构：${arch}`);
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const forge = path.join(projectRoot, "node_modules", ".bin", "electron-forge");
const appPath = path.join(projectRoot, "out", `DanceMonkey-darwin-${arch}`, "DanceMonkey.app");
const dmgPath = path.join(projectRoot, "out", "make", `DanceMonkey-darwin-${arch}.dmg`);

execFileSync(forge, ["make", "--platform=darwin", `--arch=${arch}`], {
  cwd: projectRoot,
  stdio: "inherit",
});

if (!fs.statSync(appPath).isDirectory()) {
  throw new Error(`未找到打包后的应用：${appPath}`);
}
execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "inherit" });

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dancemonkey-dmg-"));
const mountPath = path.join(tempRoot, "mount");
const writableDmg = path.join(tempRoot, "writable.dmg");
const completedDmg = path.join(tempRoot, "completed.dmg");
let mounted = false;
try {
  const sizeKb = Number(execFileSync("du", ["-sk", appPath], { encoding: "utf8" }).split(/\s+/)[0]);
  const sizeMb = Math.ceil(sizeKb / 1024 * 1.3) + 64;
  fs.mkdirSync(mountPath);
  execFileSync("hdiutil", [
    "create", "-size", `${sizeMb}m`, "-fs", "HFS+", "-volname", "DanceMonkey",
    "-type", "UDIF", writableDmg,
  ], { stdio: "inherit" });
  execFileSync("hdiutil", [
    "attach", "-nobrowse", "-noautoopen", "-mountpoint", mountPath, writableDmg,
  ], { stdio: "inherit" });
  mounted = true;
  fs.cpSync(appPath, path.join(mountPath, "DanceMonkey.app"), { recursive: true });
  fs.symlinkSync("/Applications", path.join(mountPath, "Applications"));
  execFileSync("hdiutil", ["detach", "-force", mountPath], { stdio: "inherit" });
  mounted = false;
  execFileSync("hdiutil", [
    "convert", writableDmg, "-format", "UDZO", "-o", completedDmg,
  ], { stdio: "inherit" });
  fs.renameSync(completedDmg, dmgPath);
  console.log(`DMG: ${dmgPath}`);
} finally {
  if (mounted) {
    try {
      execFileSync("hdiutil", ["detach", "-force", mountPath], { stdio: "ignore" });
    } catch {}
  }
  if (!mounted) fs.rmSync(tempRoot, { recursive: true, force: true });
}
