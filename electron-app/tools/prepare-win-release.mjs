import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
const source = path.join(projectRoot, "out", "make", "zip", "win32", "x64", `DanceMonkey-win32-x64-${version}.zip`);
if (!fs.existsSync(source)) throw new Error(`请先运行 npm run package:win：${source}`);

const targetDir = path.join(projectRoot, "out", "make", "release");
const zipName = `DanceMonkey-win-x64-${version}.zip`;
const target = path.join(targetDir, zipName);
fs.mkdirSync(targetDir, { recursive: true });
fs.copyFileSync(source, target);

const hash = crypto.createHash("sha256");
for await (const chunk of fs.createReadStream(target)) hash.update(chunk);
const manifest = {
  version,
  packageUrl: zipName,
  entryExe: "DanceMonkey.exe",
  sha256: hash.digest("hex").toUpperCase(),
  releaseNotes: "全新 DM 粒子轨道图标；笔记文件夹展开状态会在重启后保留，展开按钮更清晰；更新器拒绝非 Electron 程序包。",
};
fs.writeFileSync(path.join(targetDir, "update-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`Windows update package: ${target}`);
console.log(`SHA-256: ${manifest.sha256}`);
