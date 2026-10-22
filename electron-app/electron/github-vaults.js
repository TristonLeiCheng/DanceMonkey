const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { writeAtomic } = require("./workspace");

function createSyncDirectories(directory, initialRoot) {
  fs.mkdirSync(directory, { recursive: true });
  const ownerFile = path.join(directory, "legacy-root.json");
  const legacyDirectory = path.join(directory, "sync");
  let owner;
  if (fs.existsSync(ownerFile)) {
    owner = JSON.parse(fs.readFileSync(ownerFile, "utf8")).root;
  } else {
    const stateFile = path.join(legacyDirectory, "state.json");
    if (fs.existsSync(stateFile)) {
      try { owner = JSON.parse(fs.readFileSync(stateFile, "utf8")).root; }
      catch { throw new Error("旧同步记录无法读取，请先检查备份目录。"); }
    } else owner = initialRoot;
    if (typeof owner !== "string" || !path.isAbsolute(owner)) throw new Error("旧同步记录的笔记库归属无效。");
    writeAtomic(ownerFile, JSON.stringify({ root: owner }));
  }
  if (typeof owner !== "string" || !path.isAbsolute(owner)) throw new Error("同步目录归属记录无效。");
  return (root) => root === owner ? legacyDirectory : path.join(directory, "vaults", crypto.createHash("sha256").update(root).digest("hex"));
}

module.exports = { createSyncDirectories };
