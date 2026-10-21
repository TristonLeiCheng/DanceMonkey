const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const defaultGit = require("isomorphic-git");

const EXTENSIONS = new Set([".md", ".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const LIMITS = { fileBytes: 10 * 1024 * 1024, totalBytes: 200 * 1024 * 1024, files: 5000 };
const oidOf = (data) => crypto.createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
const inside = (parent, child) => child === parent || child.startsWith(`${parent}${path.sep}`);

function allowed(file) {
  return !file.split("/").some((part) => part.startsWith(".")) && EXTENSIONS.has(path.posix.extname(file).toLowerCase());
}

function validatePath(file) {
  const parts = file.split("/");
  if (!file || file.normalize("NFC") !== file || parts.some((part) => !part || part === "." || part === ".." ||
      /[<>:"\\|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error(`笔记路径无法安全跨平台同步：${file}`);
  }
}

function validatePaths(files) {
  const names = new Map();
  for (const file of files) {
    validatePath(file);
    const parts = file.split("/");
    for (let i = 1; i <= parts.length; i += 1) {
      const name = parts.slice(0, i).join("/");
      const key = name.toLowerCase();
      if (names.has(key) && names.get(key) !== name) throw new Error(`存在大小写冲突路径：${name}`);
      names.set(key, name);
    }
  }
  const set = new Set(files);
  for (const file of files) {
    const parts = file.split("/");
    for (let i = 1; i < parts.length; i += 1) {
      if (set.has(parts.slice(0, i).join("/"))) throw new Error(`文件与目录发生冲突：${file}`);
    }
  }
}

function planChanges(base, local, remote) {
  const uploads = [], downloads = [], deletions = [], conflicts = [];
  for (const file of [...new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])].sort()) {
    const b = Object.hasOwn(base, file) ? base[file] : null;
    const l = Object.hasOwn(local, file) ? local[file] : null;
    const r = Object.hasOwn(remote, file) ? remote[file] : null;
    if (l === r) continue;
    if (l === b) {
      if (r) downloads.push(file); else deletions.push({ path: file, side: "local" });
    } else if (r === b) {
      if (l) uploads.push(file); else deletions.push({ path: file, side: "remote" });
    } else conflicts.push(file);
  }
  return { uploads, downloads, deletions, conflicts };
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function createGitHubSync({ root, directory, git = defaultGit, http, getToken }) {
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(directory, { recursive: true });
  root = fs.realpathSync(root);
  directory = fs.realpathSync(directory);
  const stateFile = path.join(directory, "state.json");
  const pendingFile = path.join(directory, "pending.json");
  const gitdir = path.join(directory, "objects.git");
  const options = { fs, dir: directory, gitdir };
  let state = { version: 1, root, binding: null, base: {}, lastSync: null };
  let error = "";
  let busy = false;
  let prepared = null;
  if (inside(root, directory) || inside(directory, root)) error = "笔记库与同步数据目录不能相互包含。";
  try {
    if (fs.existsSync(stateFile)) {
      const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      if (saved.version !== 1 || saved.root !== root || !saved.base || typeof saved.base !== "object") {
        throw new Error("invalid-state");
      }
      state = saved;
    }
  } catch { error = "同步状态损坏或笔记目录已变化，请先备份并检查同步数据目录，不会覆盖笔记。"; }

  function status() {
    return { binding: state.binding && { ...state.binding }, lastSync: state.lastSync, busy, error,
      pending: fs.existsSync(pendingFile), backupDirectory: path.join(directory, "backups"),
      conflictDirectory: path.join(directory, "conflicts"), limits: LIMITS, extensions: [...EXTENSIONS] };
  }

  async function exclusive(operation) {
    if (busy) throw new Error("已有 Git 同步操作正在进行。");
    if (error) throw new Error(error);
    busy = true;
    try { return await operation(); } finally { busy = false; }
  }

  function safeTarget(file) {
    validatePath(file);
    let current = root;
    if (fs.realpathSync(root) !== root) throw new Error("笔记库目录发生变化，已停止同步。");
    const parts = file.split("/");
    for (let index = 0; index < parts.length; index += 1) {
      current = path.join(current, parts[index]);
      try {
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory()) ||
            (index === parts.length - 1 && !stat.isFile())) throw new Error(`不安全的笔记路径：${file}`);
      } catch (cause) { if (cause.code !== "ENOENT") throw cause; }
    }
    return current;
  }

  function scanLocal() {
    const files = Object.create(null), data = Object.create(null);
    let bytes = 0, visited = 0;
    function walk(folder, prefix = "", depth = 0) {
      if (depth > 60) throw new Error("本地笔记目录层级过深。");
      for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
        if (++visited > 20000) throw new Error("笔记目录条目过多，请使用专用笔记库。");
        if (item.name.startsWith(".")) continue;
        const file = prefix ? `${prefix}/${item.name}` : item.name;
        const target = path.join(folder, item.name);
        if (item.isSymbolicLink()) throw new Error(`不支持同步符号链接：${file}`);
        if (item.isDirectory()) { walk(target, file, depth + 1); continue; }
        if (!item.isFile() || !allowed(file)) continue;
        safeTarget(file);
        const stat = fs.statSync(target);
        if (stat.size > LIMITS.fileBytes) throw new Error(`单文件超过 10 MiB：${file}`);
        const content = fs.readFileSync(target);
        bytes += content.length;
        if (bytes > LIMITS.totalBytes || Object.keys(files).length >= LIMITS.files) throw new Error("笔记库超过 5000 个文件或 200 MiB，请缩小同步范围。");
        data[file] = content;
        files[file] = oidOf(content);
      }
    }
    walk(root);
    validatePaths(Object.keys(files));
    return { files, data };
  }

  async function init() {
    if (!fs.existsSync(path.join(gitdir, "HEAD"))) await git.init({ ...options, defaultBranch: "main" });
    await git.setConfig({ ...options, path: "remote.origin.fetch", value: "+refs/heads/*:refs/remotes/origin/*" });
  }

  async function connection() {
    if (!state.binding) throw new Error("请先绑定笔记仓库。");
    const token = await getToken();
    const { owner, repo } = state.binding;
    return { ...options, http, url: `https://github.com/${owner}/${repo}.git`,
      onAuth: () => ({ username: "x-access-token", password: token }),
      onAuthFailure: () => { throw new Error("GitHub 仓库认证失败，请重新连接并检查安装授权。"); } };
  }

  async function readRemote() {
    await init();
    const conn = await connection();
    let refs;
    try { refs = await git.listServerRefs(conn); }
    catch { throw new Error("读取 GitHub 分支失败，请检查网络和仓库授权。"); }
    const ref = `refs/heads/${state.binding.branch}`;
    const target = refs.find((item) => item.ref === ref);
    if (!target) {
      if (refs.some((item) => item.ref.startsWith("refs/heads/"))) throw new Error("远端分支不存在，请检查分支名称；首版不自动新建非空仓库的分支。");
      if (Object.keys(state.base).length) throw new Error("远端仓库历史已清空，已停止同步以避免误删笔记。");
      return { head: null, files: {}, entries: {}, data: {} };
    }
    try {
      await git.fetch({ ...conn, remote: "origin", ref: state.binding.branch, singleBranch: true, depth: 1, tags: false });
    } catch { throw new Error("下载 GitHub 仓库失败，请检查网络、分支和访问权限。"); }
    let head;
    try { head = await git.resolveRef({ ...options, ref: `refs/remotes/origin/${state.binding.branch}` }); }
    catch { throw new Error("无法读取下载后的分支，请重新预览。"); }
    const { commit } = await git.readCommit({ ...options, oid: head });
    const entries = Object.create(null), files = Object.create(null), data = Object.create(null);
    let bytes = 0, visited = 0;
    async function walk(oid, prefix = "", depth = 0) {
      if (depth > 60) throw new Error("仓库目录层级过深。");
      const { tree } = await git.readTree({ ...options, oid });
      for (const item of tree) {
        if (++visited > 20000) throw new Error("仓库条目过多，请使用专用笔记仓库。");
        if (/[\/\\\x00]/.test(item.path) || item.path === "." || item.path === "..") throw new Error("远端包含不安全路径，已停止同步。");
        const file = prefix ? `${prefix}/${item.path}` : item.path;
        if (item.type === "tree") { await walk(item.oid, file, depth + 1); continue; }
        entries[file] = { oid: item.oid, mode: item.mode, type: item.type };
        if (!allowed(file)) continue;
        validatePath(file);
        if (item.type !== "blob" || !["100644", "100755"].includes(String(item.mode))) throw new Error(`远端文件不是普通文件：${file}`);
        const { blob } = await git.readBlob({ ...options, oid: item.oid });
        if (blob.length > LIMITS.fileBytes) throw new Error(`远端文件超过 10 MiB：${file}`);
        bytes += blob.length;
        if (bytes > LIMITS.totalBytes || Object.keys(files).length >= LIMITS.files) throw new Error("远端笔记超过 5000 个文件或 200 MiB。");
        files[file] = item.oid;
        data[file] = Buffer.from(blob);
      }
    }
    await walk(commit.tree);
    validatePaths(Object.keys(files));
    return { head, entries, files, data };
  }

  function same(left, right) {
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
  }

  function exportConflicts(conflicts, local, remote) {
    if (!conflicts.length) return null;
    const folder = path.join(directory, "conflicts", crypto.randomUUID());
    for (const file of conflicts) {
      for (const [side, snapshot] of [["local", local], ["remote", remote]]) {
        if (!snapshot.data[file]) continue;
        const target = path.join(folder, side, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, snapshot.data[file], { flag: "wx", mode: 0o600 });
      }
    }
    atomicJson(path.join(folder, "conflicts.json"), conflicts.map((file) => ({ path: file, localDeleted: !local.files[file], remoteDeleted: !remote.files[file] })));
    return folder;
  }

  function readPending() {
    if (!fs.existsSync(pendingFile)) return null;
    try {
      const pending = JSON.parse(fs.readFileSync(pendingFile, "utf8"));
      if (!pending.base || !pending.target || !Array.isArray(pending.changes) || !Array.isArray(pending.uploads) ||
          !pending.backup || typeof pending.backup !== "string" ||
          !inside(path.join(directory, "backups"), path.resolve(pending.backup))) throw new Error("invalid");
      validatePaths(Object.keys(pending.base));
      validatePaths(Object.keys(pending.target));
      for (const file of pending.changes) validatePath(file);
      return pending;
    } catch { throw new Error("未完成同步的恢复记录损坏，请先检查同步备份，未修改笔记。"); }
  }

  // 上传成功但本地落盘中断时，只认领已经成功上传且本地仍相同的内容；
  // 未下载的文件仍用旧基准，避免下次把旧内容当成新修改上传。
  function effectiveBase(local, remote) {
    const pending = readPending();
    if (!pending) return state.base;
    const base = { ...pending.base };
    for (const file of new Set([...pending.uploads, ...pending.changes])) {
      const target = pending.target[file] || null;
      if ((remote.files[file] || null) === target && (local.files[file] || null) === target) {
        if (target) base[file] = target; else delete base[file];
      }
    }
    return base;
  }

  function validateMerged(local, remote, plan) {
    // Case-only renames are ambiguous on Windows/macOS; do not write one path
    // and then accidentally delete its alias in the same synchronization.
    validatePaths([...new Set([...Object.keys(local.files), ...Object.keys(remote.files)])]);
    const merged = { ...remote.entries };
    for (const file of plan.uploads) merged[file] = { oid: local.files[file], mode: "100644", type: "blob" };
    for (const item of plan.deletions) if (item.side === "remote") delete merged[item.path];
    // 非笔记文件在远端保持原样，但也不能与新笔记路径产生文件/目录冲突。
    validatePaths(Object.keys(merged));
    for (const file of plan.downloads) safeTarget(file);
    for (const item of plan.deletions) if (item.side === "local") safeTarget(item.path);
    return merged;
  }

  async function preview() {
    return exclusive(async () => {
      prepared = null;
      const remote = await readRemote();
      const local = scanLocal();
      const base = effectiveBase(local, remote);
      const plan = planChanges(base, local.files, remote.files);
      validateMerged(local, remote, plan);
      const conflictDirectory = exportConflicts(plan.conflicts, local, remote);
      prepared = { id: crypto.randomUUID(), ...plan, local, remote, base, conflictDirectory };
      return { id: prepared.id, ...plan, conflictDirectory, counts: {
        uploads: plan.uploads.length, downloads: plan.downloads.length, deletions: plan.deletions.length, conflicts: plan.conflicts.length,
      } };
    });
  }

  async function writeTree(entries) {
    const tree = new Map();
    for (const [file, entry] of Object.entries(entries)) {
      const parts = file.split("/");
      let cursor = tree;
      for (const part of parts.slice(0, -1)) {
        if (!cursor.has(part)) cursor.set(part, new Map());
        cursor = cursor.get(part);
      }
      cursor.set(parts.at(-1), entry);
    }
    async function write(node) {
      const rows = [];
      for (const [name, entry] of node) rows.push(entry instanceof Map
        ? { path: name, mode: "040000", type: "tree", oid: await write(entry) }
        : { path: name, ...entry });
      return git.writeTree({ ...options, tree: rows });
    }
    return write(tree);
  }

  function applyFiles(pending, data, expected) {
    if (!same(scanLocal().files, expected)) throw new Error("本地笔记在同步期间发生变化，请重新预览；已保留本地内容及同步备份。");
    for (const file of pending.changes) safeTarget(file);
    try {
      // 不跨 await，避免应用自己的保存插入一批文件更新之间。
      for (const file of pending.changes) {
        const target = safeTarget(file);
        if (!pending.target[file]) { if (fs.existsSync(target)) fs.unlinkSync(target); continue; }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const temporary = path.join(path.dirname(target), `.dm-sync-${crypto.randomUUID()}.tmp`);
        try {
          fs.writeFileSync(temporary, data[file], { mode: 0o600, flag: "wx" });
          fs.renameSync(temporary, target);
        } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
      }
    } catch {
      throw new Error("远端可能已更新，但本地写入未完成。已保留备份和恢复记录，请修复目录权限后重新预览。");
    }
  }

  async function sync({ previewId } = {}) {
    return exclusive(async () => {
      const p = prepared;
      if (!p || p.id !== previewId) throw new Error("预览已失效，请重新预览差异。");
      prepared = null;
      if (p.conflicts.length) throw new Error("存在冲突，双方内容已导出，请处理后重新预览。");
      if (!same(scanLocal().files, p.local.files)) throw new Error("本地笔记已变化，请重新预览。");
      const remote = await readRemote();
      if (remote.head !== p.remote.head) throw new Error("远端已变化，请重新预览，不会覆盖其他电脑的提交。");
      const merged = validateMerged(p.local, remote, p);
      const target = Object.create(null);
      for (const [file, entry] of Object.entries(merged)) if (allowed(file)) target[file] = entry.oid;
      const changes = [...p.downloads, ...p.deletions.filter((item) => item.side === "local").map((item) => item.path)];
      const outgoing = [...p.uploads, ...p.deletions.filter((item) => item.side === "remote").map((item) => item.path)];
      if (!changes.length && !outgoing.length) {
        if (!same(scanLocal().files, target)) throw new Error("本地笔记已变化，请重新预览。");
        const next = { ...state, base: target, lastSync: new Date().toISOString(), commit: remote.head };
        atomicJson(stateFile, next);
        state = next;
        if (fs.existsSync(pendingFile)) fs.unlinkSync(pendingFile);
        return { lastSync: state.lastSync, uploaded: 0, downloaded: 0, deleted: 0 };
      }
      const backup = path.join(directory, "backups", crypto.randomUUID());
      // 保存整份同步范围快照，包括即将上传和删除的笔记。
      for (const [file, data] of Object.entries(p.local.data)) {
        const dest = path.join(backup, "local", file);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, data, { flag: "wx", mode: 0o600 });
      }
      const pending = { base: p.base, target, changes, uploads: outgoing, backup, remoteHead: remote.head };
      atomicJson(path.join(backup, "manifest.json"), pending);
      atomicJson(pendingFile, pending);
      let head = remote.head;
      if (outgoing.length) {
        for (const file of p.uploads) await git.writeBlob({ ...options, blob: p.local.data[file] });
        const tree = await writeTree(merged);
        const timestamp = Math.floor(Date.now() / 1000);
        const author = { name: "DanceMonkey Notes", email: "notes@dancemonkey.local", timestamp, timezoneOffset: 0 };
        head = await git.writeCommit({ ...options, commit: { tree, parent: remote.head ? [remote.head] : [],
          author, committer: author, message: "Sync notes with DanceMonkey\n" } });
        await git.writeRef({ ...options, ref: `refs/heads/${state.binding.branch}`, value: head, force: true });
        if (!same(scanLocal().files, p.local.files)) throw new Error("本地笔记已变化，未上传，请重新预览。");
        try {
          const result = await git.push({ ...await connection(), remote: "origin", ref: state.binding.branch, remoteRef: state.binding.branch, force: false });
          if (result.error || result.ok === false) throw new Error("push-rejected");
        } catch { throw new Error("上传未确认成功（可能是远端并发更新、分支保护或网络中断）。本地笔记未被覆盖，请重新预览。"); }
      }
      applyFiles(pending, remote.data, p.local.files);
      if (!same(scanLocal().files, target)) throw new Error("同步落盘后检测到外部修改，已保留恢复记录，请重新预览。");
      const next = { ...state, base: target, lastSync: new Date().toISOString(), commit: head };
      atomicJson(stateFile, next);
      state = next;
      fs.unlinkSync(pendingFile);
      return { lastSync: state.lastSync, backupDirectory: backup, uploaded: p.uploads.length,
        downloaded: p.downloads.length, deleted: p.deletions.length };
    });
  }

  function configure({ owner, repo, branch = "main" } = {}) {
    if (busy) throw new Error("同步期间不能更改仓库。");
    if (error) throw new Error(error);
    owner = String(owner || "").trim(); repo = String(repo || "").trim(); branch = String(branch || "").trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(owner) || !/^[a-zA-Z0-9_.-]{1,100}$/.test(repo) || [".", ".."].includes(repo)) throw new Error("仓库 owner 或名称无效。");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(branch) || /\.\.|\/\/|@\{|\.lock(?:\/|$)|[/.]$/.test(branch) || branch.split("/").some((part) => part.startsWith("."))) throw new Error("分支名称无效。");
    const binding = { owner, repo, branch };
    if (state.binding && JSON.stringify(state.binding) !== JSON.stringify(binding)) {
      throw new Error("首版不支持直接更换已绑定仓库或分支，以免把现有笔记意外上传到另一个仓库。");
    }
    const next = { ...state, binding };
    atomicJson(stateFile, next);
    state = next;
    prepared = null;
    return status();
  }

  return { status, configure, preview, sync };
}

module.exports = { createGitHubSync, planChanges, validatePath, validatePaths, LIMITS };
