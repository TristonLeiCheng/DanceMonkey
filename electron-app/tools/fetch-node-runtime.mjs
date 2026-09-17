/**
 * 下载官方 Node.js Windows x64 便携包到 vendor/
 * 用法: node tools/fetch-node-runtime.mjs [version]
 * 例: node tools/fetch-node-runtime.mjs 22.23.2
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";
import http from "node:http";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const version = process.argv[2] || "22.23.2";
const fileName = `node-v${version}-win-x64.zip`;
const vendor = path.join(root, "vendor");
const dest = path.join(vendor, fileName);

const mirrors = [
  `https://nodejs.org/dist/v${version}/${fileName}`,
  `https://npmmirror.com/mirrors/node/v${version}/${fileName}`,
];

fs.mkdirSync(vendor, { recursive: true });

function fetchToFile(url, outPath) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, { headers: { "User-Agent": "DanceMonkey-fetch-node" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        fetchToFile(res.headers.location, outPath).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const tmp = `${outPath}.part`;
      const stream = fs.createWriteStream(tmp);
      res.pipe(stream);
      stream.on("finish", () => {
        stream.close(() => {
          fs.renameSync(tmp, outPath);
          resolve(outPath);
        });
      });
      stream.on("error", reject);
    });
    req.on("error", reject);
  });
}

let lastErr;
for (const url of mirrors) {
  try {
    process.stdout.write(`Downloading ${url}\n`);
    await fetchToFile(url, dest);
    const size = fs.statSync(dest).size;
    console.log(`OK ${fileName} (${(size / 1024 / 1024).toFixed(1)} MB)`);
    process.exit(0);
  } catch (err) {
    lastErr = err;
    console.warn(`failed: ${err.message}`);
  }
}
console.error(lastErr?.message || "download failed");
process.exit(1);
