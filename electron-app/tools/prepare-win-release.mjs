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
  releaseNotes:
    "新增人物分身：导入文章、笔记、聊天记录和 Outlook 来信，独立聊天、纠正与更新；支持出生年月、星座、简历、事件及 MBTI 观察测算。新增多笔记库与 PKB 基础功能，改进 AI 界面及任务/项目同步。",
};
fs.writeFileSync(path.join(targetDir, "update-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`Windows update package: ${target}`);
console.log(`SHA-256: ${manifest.sha256}`);
