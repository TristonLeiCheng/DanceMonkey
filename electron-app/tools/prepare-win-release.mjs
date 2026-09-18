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
  releaseNotes: "标题栏显示版本号；最大化窗口无留白；主题下拉选择增加淡黄、淡绿磨砂等主题与背景不透明度调整；修复更新路径含空格时的复制失败。",
};
fs.writeFileSync(path.join(targetDir, "update-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`Windows update package: ${target}`);
console.log(`SHA-256: ${manifest.sha256}`);
