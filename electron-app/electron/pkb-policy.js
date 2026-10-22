"use strict";
// Safety guard for PKB (v1, _System/pkb.json schemaVersion:1) sensitive directories.
// This module never reads directory "labels" as a security boundary by itself: it
// requires a real, validated manifest before treating any directory as protected,
// and it fails closed (blocks the whole sync) whenever that validation is uncertain
// (bad JSON, symlinked manifest, oversized file, unreadable directory, ...).
//
// Scope: local filesystem roots used by folder-sync.js (master/slave) and
// github-sync.js (local vault root), plus the remote GitHub tree inspected by
// github-sync.js before download/merge. Libraries that never had a PKB manifest
// keep their existing, unguarded sync behaviour.

const fs = require("node:fs");
const path = require("node:path");
const { PROTECTED_DIRECTORIES } = require("./pkb");

// Fixed, conservative protected-directory list (POSIX-style relative paths),
// shared with electron/pkb.js so the two modules never drift apart. Any REAL
// file found inside one of these (at any depth) causes the whole sync
// preview/execute to be rejected instead of silently excluded, so a filtered
// diff can never be mistaken for "safe to delete on the other side".
const PROTECTED_DIRS_POSIX = Object.freeze([...PROTECTED_DIRECTORIES]);

const MANIFEST_RELATIVE_POSIX = "_System/pkb.json";
const MANIFEST_SUFFIX_POSIX = `/${MANIFEST_RELATIVE_POSIX}`;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_WALK_DEPTH = 60;

function isValidManifestObject(parsed) {
  return Boolean(parsed) && typeof parsed === "object" && !Array.isArray(parsed) && parsed.schemaVersion === 1;
}

function withTrailingSep(value) {
  return value.endsWith(path.sep) ? value : `${value}${path.sep}`;
}

// Case-insensitive "is a inside-or-equal to directory b" check, matching the
// comparison style already used elsewhere in folder-sync.js.
function isAtOrUnder(candidate, dir) {
  const a = candidate.toLowerCase();
  const b = dir.toLowerCase();
  return a === b || a.startsWith(withTrailingSep(b));
}

function protectedAbsPath(pkbRoot, relPosix) {
  return path.join(pkbRoot, ...relPosix.split("/"));
}

// Recursively checks whether a directory (or the path itself, if it is a
// file) contains any real file. Symlinks anywhere inside are treated as
// "real content" and block the sync rather than being silently skipped, and
// any I/O error that prevents verifying emptiness fails closed (blocks).
function hasRealFileUnder(targetAbs) {
  let stat;
  try {
    stat = fs.lstatSync(targetAbs);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    return true;
  }
  if (stat.isSymbolicLink()) return true;
  if (!stat.isDirectory()) return stat.isFile();

  const pending = [targetAbs];
  while (pending.length) {
    const dir = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return true;
    }
    for (const entry of entries) {
      if (entry.name === ".DanceMonkeySyncTrash") continue;
      if (entry.isSymbolicLink()) return true;
      if (entry.isDirectory()) {
        pending.push(path.join(dir, entry.name));
        continue;
      }
      if (entry.isFile()) return true;
    }
  }
  return false;
}

function createPkbPolicy() {
  // Caches manifest *discovery/validity* only (structural, cheap to reuse
  // across preview()+run() of the same operation). File-presence checks
  // inside protected directories are never cached, since that must reflect
  // the current state of the disk every time.
  const manifestCache = new Map();
  const nestedCache = new Map();

  function readManifestAt(dirAbs) {
    if (manifestCache.has(dirAbs)) return manifestCache.get(dirAbs);
    const systemDir = path.join(dirAbs, "_System");
    const manifestPath = path.join(systemDir, "pkb.json");
    let result;
    try {
      const systemStat = fs.lstatSync(systemDir);
      if (systemStat.isSymbolicLink()) {
        result = { exists: true, valid: false, reason: "_System 是符号链接" };
      } else if (!systemStat.isDirectory()) {
        result = { exists: false };
      } else {
        const manifestStat = fs.lstatSync(manifestPath);
        if (manifestStat.isSymbolicLink()) {
          result = { exists: true, valid: false, reason: "pkb.json 是符号链接" };
        } else if (!manifestStat.isFile()) {
          result = { exists: true, valid: false, reason: "pkb.json 不是普通文件" };
        } else if (manifestStat.size > MAX_MANIFEST_BYTES) {
          result = { exists: true, valid: false, reason: "pkb.json 超出大小限制" };
        } else {
          try {
            const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
            result = isValidManifestObject(parsed)
              ? { exists: true, valid: true }
              : { exists: true, valid: false, reason: "pkb.json schemaVersion 不是 1" };
          } catch {
            result = { exists: true, valid: false, reason: "pkb.json 无法解析" };
          }
        }
      }
    } catch (error) {
      result = error.code === "ENOENT" ? { exists: false } : { exists: true, valid: false, reason: "pkb.json 无法读取" };
    }
    manifestCache.set(dirAbs, result);
    return result;
  }

  // Ancestor walk: covers the case where rootAbs *is* a PKB root, or sits
  // inside one (e.g. syncing just "90_AI" of an already-initialized vault).
  function findAncestorGovernor(startAbs) {
    let current = startAbs;
    let previous = null;
    let depth = 0;
    while (current && current !== previous && depth <= MAX_WALK_DEPTH) {
      const found = readManifestAt(current);
      if (found.exists) return { pkbRoot: current, ...found };
      previous = current;
      current = path.dirname(current);
      depth += 1;
    }
    return null;
  }

  // Descendant walk: covers the case where rootAbs is an ancestor of a PKB
  // vault (e.g. syncing a parent "Documents" folder that contains a vault
  // as a subdirectory). Symlinked directories are never followed, so a
  // symlink cannot be used to hide or spoof a manifest from this scan.
  function findNestedGovernors(rootAbs) {
    if (nestedCache.has(rootAbs)) return nestedCache.get(rootAbs);
    const found = [];
    const pending = [{ dir: rootAbs, depth: 0 }];
    while (pending.length) {
      const { dir, depth } = pending.pop();
      if (depth > MAX_WALK_DEPTH) throw new Error("目录层级过深，无法完整检查 PKB 保护策略，已停止同步。");
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw new Error("无法完整读取目录检查 PKB 保护策略，已停止同步。");
      }
      let sawSystemEntry = false;
      for (const entry of entries) {
        if (entry.name !== "_System") continue;
        sawSystemEntry = true;
        if (!entry.isDirectory()) {
          // A symlinked or non-directory "_System" entry is suspicious:
          // fail closed instead of silently ignoring it.
          found.push({ pkbRoot: dir, exists: true, valid: false, reason: "_System 不是普通目录" });
        }
      }
      if (sawSystemEntry) {
        const manifest = readManifestAt(dir);
        if (manifest.exists) found.push({ pkbRoot: dir, ...manifest });
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        if (entry.name === ".DanceMonkeySyncTrash") continue;
        pending.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
      }
    }
    nestedCache.set(rootAbs, found);
    return found;
  }

  function locateGovernors(rootAbs) {
    const ancestor = findAncestorGovernor(rootAbs);
    const nested = findNestedGovernors(rootAbs);
    const governors = [];
    if (ancestor) governors.push(ancestor);
    for (const governor of nested) {
      if (!ancestor || governor.pkbRoot !== ancestor.pkbRoot) governors.push(governor);
    }
    return governors;
  }

  function assessProtectedOverlap(rootAbs, pkbRoot) {
    const blocked = [];
    for (const rel of PROTECTED_DIRS_POSIX) {
      let protectedAbs = pkbRoot;
      for (const part of rel.split("/")) {
        let actual = part;
        try { actual = fs.readdirSync(protectedAbs).find((name) => name.toLowerCase() === part.toLowerCase()) || part; } catch {}
        protectedAbs = path.join(protectedAbs, actual);
      }
      let overlapAbs = null;
      if (isAtOrUnder(protectedAbs, rootAbs)) overlapAbs = protectedAbs;
      else if (isAtOrUnder(rootAbs, protectedAbs)) overlapAbs = rootAbs;
      if (!overlapAbs) continue;
      if (hasRealFileUnder(overlapAbs)) blocked.push({ relative: rel, absolute: protectedAbs });
    }
    return blocked;
  }

  // Throws (fail closed) when rootAbs is governed by an untrustworthy
  // manifest, or when a governed protected directory actually contains a
  // real file. Does nothing for legacy libraries with no manifest anywhere
  // in the ancestor chain or nested tree, preserving existing behaviour.
  function assertLocalRootAllowed(rootAbs, { label } = {}) {
    const tag = label ? `${label}（${rootAbs}）` : rootAbs;
    for (const governor of locateGovernors(rootAbs)) {
      if (!governor.valid) {
        throw new Error(
          `${tag} 附近的 PKB 标记（${path.join(governor.pkbRoot, "_System", "pkb.json")}）无法安全确认（${governor.reason || "原因未知"}），已停止同步以避免误判保护目录；标记不是加密，损坏时按不安全处理，请修复该标记后重试，不要删除标记绕过保护。`,
        );
      }
      const blocked = assessProtectedOverlap(rootAbs, governor.pkbRoot);
      if (blocked.length) {
        const names = blocked.map((item) => item.relative).join("、");
        throw new Error(
          `${tag} 命中 PKB 保护目录（${names}）中存在真实文件，已拒绝本次整体同步，不会静默排除后把这些文件当成应删除的内容。请先把敏感资料迁至同步范围外的独立加密存储，再重新预览；不要改放同一同步库的其他目录绕过保护。`,
        );
      }
    }
  }

  return { assertLocalRootAllowed, locateGovernors, assessProtectedOverlap, hasRealFileUnder };
}

// --- Remote (GitHub tree) checks -------------------------------------------
//
// `entries` is the flat { [posixPath]: { oid, mode, type } } map already
// produced by github-sync.js while walking the remote tree (it includes
// every path, including directories and non-synced extensions such as
// `_System/pkb.json`, even though file *contents* of non-allowed extensions
// are never fetched for normal sync). This lets a brand-new device detect
// an already-initialized PKB vault on the remote side -- before it has any
// local manifest of its own -- without adding `.json` to the general
// sync allow-list: the caller fetches just this one path's blob, on demand,
// purely for this policy decision.

function findRemoteManifestCandidates(entries) {
  const candidates = [];
  for (const file of Object.keys(entries)) {
    if (file === MANIFEST_RELATIVE_POSIX) {
      candidates.push({ pkbRootRel: "", manifestPath: file, entry: entries[file] });
    } else if (file.endsWith(MANIFEST_SUFFIX_POSIX)) {
      candidates.push({ pkbRootRel: file.slice(0, -MANIFEST_SUFFIX_POSIX.length), manifestPath: file, entry: entries[file] });
    }
  }
  return candidates;
}

function remoteHasRealFile(entries, prefixPosix) {
  const prefix = prefixPosix.toLowerCase();
  return Object.keys(entries).some((file) => {
    const normalized = file.toLowerCase();
    return (normalized === prefix || normalized.startsWith(`${prefix}/`)) && entries[file].type !== "tree";
  });
}

// Throws (fail closed) when the remote tree carries an untrustworthy PKB
// manifest, or when a governed protected directory actually contains a
// real file on the remote side. `fetchManifestBlob(oid)` must resolve to a
// Buffer (or throw); it is only ever called for `_System/pkb.json` paths.
async function assertRemoteGovernorsAllowed({ entries, fetchManifestBlob, label = "GitHub 远端", localPkb = false }) {
  if (localPkb) {
    for (const rel of PROTECTED_DIRS_POSIX) {
      if (remoteHasRealFile(entries, rel)) throw new Error(`${label}包含 PKB 保护目录 ${rel} 的文件，已停止整次同步；请将敏感资料迁至独立加密存储并检查历史副本。`);
    }
  }
  for (const candidate of findRemoteManifestCandidates(entries)) {
    const manifestEntry = candidate.entry;
    let valid = false;
    let reason = "manifest 缺失或不是普通文件";
    if (manifestEntry && manifestEntry.type === "blob" && ["100644", "100755"].includes(String(manifestEntry.mode))) {
      try {
        const buffer = await fetchManifestBlob(manifestEntry.oid);
        if (!buffer || buffer.length > MAX_MANIFEST_BYTES) {
          reason = "manifest 超出大小限制";
        } else {
          const parsed = JSON.parse(buffer.toString("utf8"));
          if (isValidManifestObject(parsed)) valid = true;
          else reason = "manifest schemaVersion 不是 1";
        }
      } catch {
        reason = "manifest 无法解析";
      }
    }
    if (!valid) {
      throw new Error(
        `${label}的 PKB 标记（${candidate.manifestPath}）无法安全确认（${reason}），已停止同步以避免误判保护目录；请检查远端仓库后重试。`,
      );
    }
    for (const rel of PROTECTED_DIRS_POSIX) {
      const protectedPath = candidate.pkbRootRel ? `${candidate.pkbRootRel}/${rel}` : rel;
      if (remoteHasRealFile(entries, protectedPath)) {
        throw new Error(
          `${label}的 PKB 保护目录（${protectedPath}）中存在文件，已拒绝下载/合并本次同步，不会静默排除后把这些文件当成应删除的内容。请先在远端把敏感内容迁出保护目录后再重试。`,
        );
      }
    }
  }
}

module.exports = {
  PROTECTED_DIRS_POSIX,
  MANIFEST_RELATIVE_POSIX,
  isValidManifestObject,
  createPkbPolicy,
  assertRemoteGovernorsAllowed,
};
