const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MODES = { masterToSlave: "masterToSlave", twoWay: "twoWay" };
const POLICIES = {
  keepConflictCopy: "keepConflictCopy",
  preferMaster: "preferMaster",
  preferSlave: "preferSlave",
  skip: "skip",
};

function defaultProfile(partial = {}) {
  const next = {
    id: crypto.randomUUID().replaceAll("-", ""),
    name: "",
    masterPath: "",
    slavePath: "",
    mode: MODES.masterToSlave,
    enabled: true,
    deleteExtraFiles: false,
    trashRetentionDays: 30,
    conflictPolicy: POLICIES.keepConflictCopy,
    autoSyncEnabled: false,
    autoSyncIntervalMinutes: 30,
    excludePatterns: "*.tmp;~$*;.DS_Store;Thumbs.db",
    lastRunAt: null,
    lastStatus: "",
    ...partial,
  };
  if (!String(next.id || "").trim()) {
    next.id = crypto.randomUUID().replaceAll("-", "");
  }
  return next;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function createFolderSyncService(appDataPath) {
  const stateRoot = path.join(appDataPath, "DanceMonkey", "sync-state");
  const logRoot = path.join(appDataPath, "DanceMonkey", "sync-logs");
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.mkdirSync(logRoot, { recursive: true });

  function safeId(id) {
    return String(id || "default").replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  function statePath(profile) {
    return path.join(stateRoot, `${safeId(profile.id)}.json`);
  }

  function logPath(profile) {
    return path.join(logRoot, `${safeId(profile.id)}.log`);
  }

  function normalizeRoot(value) {
    return path
      .resolve(String(value || "").trim().replace(/%([^%]+)%/g, (_, key) => process.env[key] || `%${key}%`))
      .replace(/[\\/]+$/, "");
  }

  function parseExcludePatterns(value) {
    return String(value || "")
      .split(/[;,\r\n]+/)
      .map((item) => item.trim())
      .filter(Boolean)
      .concat([".DanceMonkeySyncTrash", ".DanceMonkeySyncTrash\\*"]);
  }

  function wildcardMatch(value, pattern) {
    const regex = new RegExp(
      `^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`,
      "i",
    );
    return regex.test(value.replace(/\//g, "\\"));
  }

  function isExcluded(relativePath, patterns) {
    const normalized = relativePath.replace(/\//g, "\\");
    const fileName = path.basename(normalized);
    return patterns.some(
      (pattern) => wildcardMatch(normalized, pattern) || wildcardMatch(fileName, pattern),
    );
  }

  function snapshotDirectory(root, excludePatterns) {
    const result = new Map();
    if (!fs.existsSync(root)) return result;
    const pending = [root];
    while (pending.length) {
      const dir = pending.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        const relative = path.relative(root, full);
        if (entry.isDirectory()) {
          if (entry.name.toLowerCase() === ".dancemonkeysynctrash") continue;
          if (isExcluded(relative, excludePatterns)) continue;
          pending.push(full);
          continue;
        }
        if (!entry.isFile() || isExcluded(relative, excludePatterns)) continue;
        try {
          const stat = fs.statSync(full);
          result.set(relative.replace(/\//g, "\\"), {
            relativePath: relative.replace(/\//g, "\\"),
            fullPath: full,
            length: stat.size,
            lastWriteUtc: stat.mtimeMs,
          });
        } catch {}
      }
    }
    return result;
  }

  function filesMatch(left, right) {
    return left.length === right.length && Math.abs(left.lastWriteUtc - right.lastWriteUtc) < 2000;
  }

  function sameAsSnapshot(current, previous) {
    return (
      previous &&
      current.length === previous.length &&
      Math.abs(current.lastWriteUtc - previous.lastWriteUtcTicks) < 1
    );
  }

  function loadState(profile) {
    try {
      return JSON.parse(fs.readFileSync(statePath(profile), "utf8"));
    } catch {
      return { files: {} };
    }
  }

  function saveState(profile, masterRoot, slaveRoot, excludePatterns) {
    const masterFiles = snapshotDirectory(masterRoot, excludePatterns);
    const slaveFiles = snapshotDirectory(slaveRoot, excludePatterns);
    const files = {};
    const keys = new Set([...masterFiles.keys(), ...slaveFiles.keys()]);
    for (const key of keys) {
      const master = masterFiles.get(key);
      const slave = slaveFiles.get(key);
      files[key] = {
        master: master
          ? { length: master.length, lastWriteUtcTicks: master.lastWriteUtc }
          : null,
        slave: slave ? { length: slave.length, lastWriteUtcTicks: slave.lastWriteUtc } : null,
      };
    }
    fs.writeFileSync(statePath(profile), JSON.stringify({ files }, null, 2), "utf8");
  }

  function unavailableMessage(label, target) {
    if (String(target).startsWith("\\\\")) {
      return `${label}不可访问：${target}。请确认局域网共享盘在线、VPN/网络连接正常，并且当前账号有访问权限。`;
    }
    return `${label}不存在或不可访问：${target}`;
  }

  function validateProfile(profile) {
    if (!String(profile.masterPath || "").trim()) throw new Error("主文件夹不能为空。");
    if (!String(profile.slavePath || "").trim()) throw new Error("从文件夹不能为空。");
    const master = normalizeRoot(profile.masterPath);
    const slave = normalizeRoot(profile.slavePath);
    if (!fs.existsSync(master)) throw new Error(unavailableMessage("主文件夹", master));
    const slaveRoot = path.parse(slave).root;
    if (!fs.existsSync(slave) && slaveRoot && !fs.existsSync(slaveRoot)) {
      throw new Error(unavailableMessage("从文件夹", slave));
    }
    if (master.toLowerCase() === slave.toLowerCase()) {
      throw new Error("主文件夹和从文件夹不能相同。");
    }
    const masterPrefix = `${master}${path.sep}`.toLowerCase();
    const slavePrefix = `${slave}${path.sep}`.toLowerCase();
    if (
      slave.toLowerCase().startsWith(masterPrefix) ||
      master.toLowerCase().startsWith(slavePrefix)
    ) {
      throw new Error("主文件夹和从文件夹不能互为父子目录，避免递归同步。");
    }
    return { master, slave };
  }

  function sleep(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* brief retry backoff */
    }
  }

  function copyFileWithRetry(sourcePath, targetPath) {
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        const tempPath = `${targetPath}.dancemonkey.tmp`;
        fs.copyFileSync(sourcePath, tempPath);
        const mtime = fs.statSync(sourcePath).mtime;
        fs.utimesSync(tempPath, mtime, mtime);
        fs.renameSync(tempPath, targetPath);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < 3) sleep(200 * attempt);
      }
    }
    throw lastError;
  }

  function moveToTrash(slaveRoot, targetPath, retentionDays) {
    if (!fs.existsSync(targetPath)) return;
    const relative = path.relative(slaveRoot, targetPath);
    const stamp = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const folder = `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`;
    const trashPath = path.join(slaveRoot, ".DanceMonkeySyncTrash", folder, relative);
    fs.mkdirSync(path.dirname(trashPath), { recursive: true });
    fs.renameSync(targetPath, trashPath);
    cleanupOldTrash(slaveRoot, retentionDays);
  }

  function cleanupOldTrash(slaveRoot, retentionDays) {
    const trashRoot = path.join(slaveRoot, ".DanceMonkeySyncTrash");
    if (!fs.existsSync(trashRoot)) return;
    const days = Math.min(3650, Math.max(1, Number(retentionDays) || 30));
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(trashRoot)) {
      const full = path.join(trashRoot, name);
      try {
        const matched = /^(\d{8})-(\d{6})$/.exec(name);
        let time = fs.statSync(full).ctimeMs;
        if (matched) {
          const d = matched[1];
          const t = matched[2];
          time = new Date(
            `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}`,
          ).getTime();
        }
        if (time < cutoff) fs.rmSync(full, { recursive: true, force: true });
      } catch {}
    }
  }

  function buildConflictPath(originalPath) {
    const dir = path.dirname(originalPath);
    const ext = path.extname(originalPath);
    const base = path.basename(originalPath, ext);
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 15);
    return path.join(dir, `${base}.conflict-${os.hostname()}-${stamp}${ext}`);
  }

  function buildPlan(profile) {
    const { master: masterRoot, slave: slaveRoot } = validateProfile(profile);
    const excludePatterns = parseExcludePatterns(profile.excludePatterns);
    const masterFiles = snapshotDirectory(masterRoot, excludePatterns);
    const slaveFiles = snapshotDirectory(slaveRoot, excludePatterns);
    const previous = loadState(profile);
    const operations = [];
    const keys = [...new Set([...masterFiles.keys(), ...slaveFiles.keys()])].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" }),
    );

    const addCopy = (kind, source, targetPath, reason = "", isConflict = false) => {
      operations.push({
        kind,
        relativePath: source.relativePath,
        sourcePath: source.fullPath,
        targetPath,
        bytes: source.length,
        reason,
        isConflict,
      });
    };

    for (const relativePath of keys) {
      const master = masterFiles.get(relativePath);
      const slave = slaveFiles.get(relativePath);
      const previousFile = previous.files?.[relativePath];

      if (master && !slave) {
        addCopy("copyToSlave", master, path.join(slaveRoot, relativePath));
        continue;
      }
      if (!master && slave) {
        if (profile.mode === MODES.twoWay) {
          addCopy("copyToMaster", slave, path.join(masterRoot, relativePath));
        } else if (profile.deleteExtraFiles) {
          operations.push({
            kind: "deleteFromSlave",
            relativePath: slave.relativePath,
            sourcePath: "",
            targetPath: slave.fullPath,
            bytes: slave.length,
            reason: "从端多余文件",
            isConflict: false,
          });
        } else {
          operations.push({
            kind: "skip",
            relativePath: slave.relativePath,
            sourcePath: slave.fullPath,
            targetPath: "",
            bytes: slave.length,
            reason: "从文件夹存在额外文件，未启用删除。",
            isConflict: false,
          });
        }
        continue;
      }
      if (!master || !slave || filesMatch(master, slave)) continue;

      if (profile.mode === MODES.masterToSlave) {
        addCopy("copyToSlave", master, slave.fullPath);
        continue;
      }

      const masterChanged = !previousFile || !sameAsSnapshot(master, previousFile.master);
      const slaveChanged = !previousFile || !sameAsSnapshot(slave, previousFile.slave);

      if (previousFile && masterChanged && slaveChanged) {
        const policy = profile.conflictPolicy || POLICIES.keepConflictCopy;
        if (policy === POLICIES.preferMaster) addCopy("copyToSlave", master, slave.fullPath, "冲突：主覆盖从", true);
        else if (policy === POLICIES.preferSlave) addCopy("copyToMaster", slave, master.fullPath, "冲突：从覆盖主", true);
        else if (policy === POLICIES.skip) {
          operations.push({
            kind: "skip",
            relativePath,
            sourcePath: master.fullPath,
            targetPath: slave.fullPath,
            bytes: master.length,
            reason: "冲突：跳过",
            isConflict: true,
          });
        } else {
          operations.push({
            kind: "preserveSlaveConflictThenCopyMaster",
            relativePath,
            sourcePath: master.fullPath,
            targetPath: slave.fullPath,
            bytes: master.length + slave.length,
            reason: "冲突：保留从端副本后主覆盖",
            isConflict: true,
          });
        }
      } else if (previousFile && slaveChanged && !masterChanged) {
        addCopy("copyToMaster", slave, master.fullPath);
      } else if (previousFile && masterChanged && !slaveChanged) {
        addCopy("copyToSlave", master, slave.fullPath);
      } else if (master.lastWriteUtc >= slave.lastWriteUtc) {
        addCopy("copyToSlave", master, slave.fullPath);
      } else {
        addCopy("copyToMaster", slave, master.fullPath);
      }
    }

    return { masterRoot, slaveRoot, excludePatterns, operations };
  }

  function toPreview(plan) {
    const items = plan.operations.map((op) => ({
      operation:
        op.kind === "copyToSlave"
          ? "主→从"
          : op.kind === "copyToMaster"
            ? "从→主"
            : op.kind === "deleteFromSlave"
              ? "删除从端"
              : op.kind === "preserveSlaveConflictThenCopyMaster"
                ? "冲突保留"
                : "跳过",
      relativePath: op.relativePath,
      sourcePath: op.sourcePath,
      targetPath: op.targetPath,
      bytes: op.bytes,
      reason: op.reason,
      isConflict: Boolean(op.isConflict),
      sizeDisplay: formatBytes(op.bytes || 0),
    }));
    const preview = {
      copyToSlaveCount: plan.operations.filter((op) => op.kind === "copyToSlave" || op.kind === "preserveSlaveConflictThenCopyMaster").length,
      copyToMasterCount: plan.operations.filter((op) => op.kind === "copyToMaster").length,
      deleteFromSlaveCount: plan.operations.filter((op) => op.kind === "deleteFromSlave").length,
      conflictCount: plan.operations.filter((op) => op.isConflict).length,
      totalBytes: plan.operations.reduce((sum, op) => sum + (op.bytes || 0), 0),
      items,
    };
    preview.summary = `主→从 ${preview.copyToSlaveCount}，从→主 ${preview.copyToMasterCount}，删除从端 ${preview.deleteFromSlaveCount}，冲突 ${preview.conflictCount}，约 ${formatBytes(preview.totalBytes)}`;
    return preview;
  }

  function preview(profile) {
    return toPreview(buildPlan(profile));
  }

  async function run(profile, { onProgress, signal } = {}) {
    const plan = buildPlan(profile);
    const result = {
      preview: toPreview(plan),
      copiedCount: 0,
      deletedCount: 0,
      skippedCount: 0,
      errorCount: 0,
      cancelled: false,
      errors: [],
    };
    fs.mkdirSync(plan.masterRoot, { recursive: true });
    fs.mkdirSync(plan.slaveRoot, { recursive: true });
    cleanupOldTrash(plan.slaveRoot, profile.trashRetentionDays);

    let completed = 0;
    onProgress?.({
      totalOperations: plan.operations.length,
      completedOperations: 0,
      statusText: "准备同步...",
    });

    for (const operation of plan.operations) {
      if (signal?.aborted) {
        result.cancelled = true;
        break;
      }
      onProgress?.({
        totalOperations: plan.operations.length,
        completedOperations: completed,
        currentPath: operation.relativePath,
        statusText: `${operation.kind}：${operation.relativePath}`,
      });
      try {
        if (operation.kind === "copyToSlave" || operation.kind === "copyToMaster") {
          copyFileWithRetry(operation.sourcePath, operation.targetPath);
          result.copiedCount += 1;
        } else if (operation.kind === "deleteFromSlave") {
          moveToTrash(plan.slaveRoot, operation.targetPath, profile.trashRetentionDays);
          result.deletedCount += 1;
        } else if (operation.kind === "preserveSlaveConflictThenCopyMaster") {
          copyFileWithRetry(operation.targetPath, buildConflictPath(operation.targetPath));
          copyFileWithRetry(operation.sourcePath, operation.targetPath);
          result.copiedCount += 2;
        } else {
          result.skippedCount += 1;
        }
      } catch (error) {
        result.errorCount += 1;
        result.errors.push(`${operation.relativePath}: ${error.message}`);
      }
      completed += 1;
      if (completed % 8 === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    if (result.errorCount === 0 && !result.cancelled) {
      saveState(profile, plan.masterRoot, plan.slaveRoot, plan.excludePatterns);
    }
    const summary = `${result.cancelled ? "已取消" : "完成"}：复制 ${result.copiedCount}，删除 ${result.deletedCount}，跳过 ${result.skippedCount}，错误 ${result.errorCount}`;
    result.summary = summary;
    fs.appendFileSync(
      logPath(profile),
      [
        `[${new Date().toISOString()}] ${profile.name}`,
        `Mode=${profile.mode}; Conflict=${profile.conflictPolicy}; Master=${profile.masterPath}; Slave=${profile.slavePath}`,
        result.preview.summary,
        summary,
        ...result.errors.map((item) => `ERROR ${item}`),
        "",
      ].join("\n"),
      "utf8",
    );
    onProgress?.({
      totalOperations: plan.operations.length,
      completedOperations: completed,
      statusText: summary,
      isCompleted: true,
      isCancelled: result.cancelled,
    });
    return result;
  }

  function readRecentLog(profile, maxLines = 160) {
    try {
      const lines = fs.readFileSync(logPath(profile), "utf8").split(/\r?\n/);
      return lines.slice(-Math.min(1000, Math.max(20, maxLines))).join("\n");
    } catch {
      return "";
    }
  }

  return { preview, run, readRecentLog, defaultProfile, MODES, POLICIES, formatBytes };
}

module.exports = { createFolderSyncService, defaultProfile, MODES, POLICIES, formatBytes };
