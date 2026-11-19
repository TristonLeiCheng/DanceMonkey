const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const MAX_BYTES = 32 * 1024 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
function identity(root, notePath) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || typeof notePath !== 'string' || !notePath || path.isAbsolute(notePath)) throw new Error('无效的对话所属笔记。');
  const base = path.resolve(root), absolute = path.resolve(base, notePath.replaceAll('\\', '/'));
  if (!absolute.startsWith(base + path.sep) || !/\.md$/i.test(absolute)) throw new Error('无效的对话所属笔记。');
  const relative = path.relative(base, absolute).replaceAll('\\', '/');
  return process.platform === 'win32' ? { root: base.toLowerCase(), path: relative.toLowerCase() } : { root: base, path: relative };
}
function clean(data) {
  const string = (value, max) => {
    if (typeof value !== 'string' || value.length > max) throw new Error('对话记录格式有误。');
    return value;
  };
  const ref = source => ({ path: string(source.path, 4096), title: string(source.title, 40000) });
  if (!data || !Array.isArray(data.messages) || !Array.isArray(data.references) || data.references.length > 8) throw new Error('对话记录格式有误。');
  return {
    references: data.references.map(ref),
    messages: data.messages.map(message => {
      if (!message || !['user', 'assistant'].includes(message.role)) throw new Error('对话记录格式有误。');
      const result = { role: message.role, content: string(message.content, 128000), createdAt: string(message.createdAt, 40) };
      if (message.role === 'assistant') {
        if (!Array.isArray(message.sources) || message.sources.length > 9) throw new Error('对话来源格式有误。');
        result.sources = message.sources.map(source => ({ ...ref(source), id: string(source.id, 12) }));
        result.snapshot = string(message.snapshot, 40000);
        if (message.selection != null) {
          const { from, to } = message.selection;
          if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > result.snapshot.length) throw new Error('对话选区格式有误。');
          result.selection = { from, to };
        }
        result.incomplete = Boolean(message.incomplete);
      }
      return result;
    }),
  };
}
function createNoteChatStore(userDataPath) {
  const directory = path.join(userDataPath, 'note-ai-chats'), locks = new Set();
  const emptyIndex = () => ({ version: 1, entries: {}, files: {}, moves: [] });
  const canonical = value => process.platform === 'win32' ? value.toLowerCase() : value;
  function relative(root, value) {
    if (typeof value !== 'string' || !value || path.isAbsolute(value)) throw new Error('无效的笔记路径。');
    const base = path.resolve(root), target = path.resolve(base, value.replaceAll('\\', '/'));
    if (!target.startsWith(base + path.sep)) throw new Error('笔记路径不能越出当前库。');
    return canonical(path.relative(base, target).replaceAll('\\', '/'));
  }
  const within = (value, prefix) => value === prefix || value.startsWith(prefix + '/');
  const remap = (value, moves) => moves.reduce((result, move) => within(canonical(result.replaceAll('\\', '/')), move.from) ? move.to + result.slice(move.from.length) : result, value);
  function location(root) {
    const normalized = identity(root, 'placeholder.md').root;
    const folder = path.join(directory, hash(normalized));
    return { root: normalized, folder, index: path.join(folder, 'index.json'), journal: path.join(folder, 'relocation.json') };
  }
  function readJson(file) {
    if (fs.statSync(file).size > MAX_BYTES) throw new Error('对话记录超过容量限制。');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  function atomic(file, value) {
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized) > MAX_BYTES) throw new Error('笔记 AI 对话已达到 32 MB，请开始新对话后继续。');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = file + '.' + randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temp, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      fs.renameSync(temp, file);
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }
  function stamp(root, notePath) {
    const normalized = relative(root, notePath);
    let target = root;
    try {
      for (const segment of normalized.split('/')) {
        target = path.join(target, segment);
        if (fs.lstatSync(target).isSymbolicLink()) return null;
      }
      const stat = fs.statSync(target, { bigint: true });
      return stat.isFile() && stat.ino > 0n && stat.birthtimeNs > 0n ? `${stat.dev}:${stat.ino}:${stat.birthtimeNs}` : null;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  function validateIndex(index, root) {
    if (index?.version !== 1 || !index.entries || !index.files || !Array.isArray(index.moves)) throw new Error('对话路径索引格式有误。');
    for (const [notePath, file] of Object.entries(index.entries)) {
      if (relative(root, notePath) !== notePath || !/^[a-f0-9]{64}\.json$/.test(file)) throw new Error('对话路径索引格式有误。');
    }
    for (const notePath of Object.keys(index.files)) relative(root, notePath);
    for (const move of index.moves) { relative(root, move.from); relative(root, move.to); }
    return index;
  }
  function readIndex(root) {
    const loc = location(root);
    if (fs.existsSync(loc.journal)) {
      const journal = readJson(loc.journal);
      const from = relative(loc.root, journal.from), to = relative(loc.root, journal.to);
      const before = validateIndex(journal.before, loc.root), after = validateIndex(journal.after, loc.root);
      const oldExists = fs.existsSync(path.join(loc.root, from)), newExists = fs.existsSync(path.join(loc.root, to));
      if (oldExists === newExists) throw new Error('笔记移动的恢复状态不明确，原对话已保留，请先检查文件位置。');
      atomic(loc.index, newExists ? after : before); fs.unlinkSync(loc.journal);
    }
    if (fs.existsSync(loc.index)) return validateIndex(readJson(loc.index), loc.root);
    const index = emptyIndex();
    if (!fs.existsSync(loc.folder)) return index;
    // Upgrade existing path-keyed records without changing their contents.
    for (const file of fs.readdirSync(loc.folder).filter(file => /^[a-f0-9]{64}\.json$/.test(file))) {
      const stored = readJson(path.join(loc.folder, file));
      if (![1, 2].includes(stored.version) || stored.root !== loc.root) throw new Error('对话记录格式有误。');
      const notePath = identity(loc.root, stored.path).path;
      if (index.entries[notePath]) throw new Error('检测到同一笔记的重复对话，原记录已保留。');
      index.entries[notePath] = file;
      for (const tracked of [notePath, ...clean(stored).references.map(item => item.path), ...stored.messages.flatMap(item => (item.sources || []).map(source => source.path))]) {
        const key = relative(loc.root, tracked), signature = stamp(loc.root, key);
        if (signature) index.files[key] = signature;
      }
    }
    atomic(loc.index, index);
    return index;
  }
  function readRecord(loc, file) {
    const stored = readJson(path.join(loc.folder, file));
    if (![1, 2].includes(stored.version) || stored.root !== loc.root || !Number.isSafeInteger(stored.revision) || stored.revision < 1) throw new Error('对话记录格式有误。');
    identity(loc.root, stored.path);
    return { ...stored, ...clean(stored) };
  }
  function get(root, notePath) {
    const id = identity(root, notePath), loc = location(id.root);
    try {
      const index = readIndex(id.root), file = index.entries[id.path];
      if (!file || !fs.existsSync(path.join(loc.folder, file))) return { revision: 0, messages: [], references: [] };
      const stored = readRecord(loc, file), version = stored.moveVersion || 0;
      if (!Number.isInteger(version) || version < 0 || version > index.moves.length) throw new Error('对话移动记录格式有误。');
      const moves = index.moves.slice(version);
      const source = item => {
        const nextPath = remap(item.path, moves);
        return { ...item, path: nextPath, title: nextPath !== item.path && item.title === path.posix.basename(item.path, '.md') ? path.posix.basename(nextPath, '.md') : item.title };
      };
      if (remap(stored.path, moves) !== id.path) throw new Error('对话与笔记路径不匹配，原记录已保留。');
      const data = { references: stored.references.map(source), messages: stored.messages.map(message => message.role === 'assistant' ? { ...message, sources: message.sources.map(source) } : message) };
      const changed = stored.path !== id.path || JSON.stringify(data) !== JSON.stringify(clean(stored));
      const revision = stored.revision + (changed ? 1 : 0);
      if (stored.version !== 2 || version !== index.moves.length || changed) atomic(path.join(loc.folder, file), { version: 2, root: id.root, path: id.path, moveVersion: index.moves.length, revision, ...data });
      return { revision, ...data };
    } catch (error) { throw new Error(`无法读取笔记 AI 对话，原文件已保留：${error.message}`); }
  }
  function set(root, notePath, data, expectedRevision) {
    const id = identity(root, notePath), loc = location(id.root), current = get(id.root, id.path);
    if (current.revision !== expectedRevision) throw new Error('笔记 AI 对话已在其他窗口更新，请重新载入后继续。');
    const next = { revision: current.revision + 1, ...clean(data) }, index = readIndex(id.root);
    if (!index.entries[id.path]) {
      let file = hash(id.path) + '.json';
      if (fs.existsSync(path.join(loc.folder, file))) file = hash(randomUUID()) + '.json';
      index.entries[id.path] = file;
    }
    for (const tracked of [id.path, ...next.references.map(item => item.path), ...next.messages.flatMap(item => (item.sources || []).map(source => source.path))]) {
      const key = relative(id.root, tracked), signature = stamp(id.root, key);
      if (signature) index.files[key] = signature;
    }
    atomic(loc.index, index);
    atomic(path.join(loc.folder, index.entries[id.path]), { version: 2, root: id.root, path: id.path, moveVersion: index.moves.length, ...next });
    return next;
  }
  function plan(root, index, moves) {
    const next = { version: 1, entries: {}, files: {}, moves: [...index.moves, ...moves] };
    for (const [key, file] of Object.entries(index.entries)) {
      const target = remap(key, moves);
      if (next.entries[target] && next.entries[target] !== file) throw new Error('目标位置已有另一篇笔记的 AI 对话，移动已取消，原记录保留。');
      next.entries[target] = file;
    }
    for (const [key, signature] of Object.entries(index.files)) if (remap(key, moves) === key) next.files[key] = signature;
    for (const [key, signature] of Object.entries(index.files)) if (remap(key, moves) !== key) next.files[remap(key, moves)] = signature;
    return next;
  }
  function assertUnlocked(root, moves) {
    for (const lock of locks) if (lock.root === root && lock.paths.some(notePath => moves.some(move => within(notePath, move.from) || within(notePath, move.to)))) {
      throw new Error('相关笔记正在生成 AI 回答，请先停止生成再移动或重命名。');
    }
  }
  function prepareRelocation(root, from, to) {
    const loc = location(root); from = relative(loc.root, from); to = relative(loc.root, to);
    if (from === to) throw new Error('源路径和目标路径相同。');
    const moves = [{ from, to }]; assertUnlocked(loc.root, moves);
    const before = readIndex(loc.root), after = plan(loc.root, before, moves);
    // The small routing journal leaves all conversation files intact. Recovery
    // chooses the old/new routing from the actual filesystem rename outcome.
    atomic(loc.journal, { from, to, before, after });
    return {
      commit() { atomic(loc.index, after); fs.unlinkSync(loc.journal); },
      rollback() { atomic(loc.index, before); fs.unlinkSync(loc.journal); },
    };
  }
  function track(root, notePath) {
    const id = identity(root, notePath), loc = location(id.root), index = readIndex(id.root);
    if (!Object.hasOwn(index.files, id.path) && !index.entries[id.path]) return;
    const signature = stamp(id.root, id.path);
    if (signature && index.files[id.path] !== signature) { index.files[id.path] = signature; atomic(loc.index, index); }
  }
  function reconcile(workspace) {
    const loc = location(workspace.root), index = readIndex(loc.root);
    const displaced = [];
    for (const [notePath, signature] of Object.entries(index.files)) {
      const current = stamp(loc.root, notePath);
      if (current !== signature) displaced.push({ path: notePath, signature, current });
    }
    const moves = [];
    if (displaced.length) {
      const candidates = new Map(), wanted = new Set(displaced.map(item => item.signature));
      const visit = nodes => { for (const node of nodes) {
        if (node.children) visit(node.children);
        else if (node.type === 'file') {
          const signature = stamp(loc.root, node.path);
          if (wanted.has(signature)) candidates.set(signature, [...(candidates.get(signature) || []), relative(loc.root, node.path)]);
        }
      } };
      visit(workspace.list());
      for (const item of displaced) {
        const found = candidates.get(item.signature) || [];
        if (found.length === 1 && displaced.filter(other => other.signature === item.signature).length === 1) moves.push({ from: item.path, to: found[0] });
      }
    }
    // External moves are observed as a batch. Move destinations out of the way
    // first so A→B and B→C do not accidentally turn A into C.
    const ordered = [], pending = moves.slice();
    while (pending.length) {
      const at = pending.findIndex(move => !pending.some(other => other !== move && within(move.to, other.from)));
      if (at < 0) throw new Error('检测到笔记路径相互交换，无法自动确认归属，原对话已保留。');
      ordered.push(...pending.splice(at, 1));
    }
    assertUnlocked(loc.root, ordered);
    const next = ordered.length ? plan(loc.root, index, ordered) : index;
    for (const item of displaced) if (item.current && !ordered.some(move => move.to === item.path)) next.files[item.path] = item.current;
    if (moves.length || displaced.some(item => item.current)) atomic(loc.index, next);
  }

  function lock(root, paths) {
    const loc = location(root), record = { root: loc.root, paths: paths.map(notePath => relative(loc.root, notePath)) };
    locks.add(record); return () => locks.delete(record);
  }
  function beforeWrite(workspace, notePath) {
    const id = identity(workspace.root, notePath), index = readIndex(id.root);
    if (index.files[id.path] && stamp(id.root, id.path) !== index.files[id.path]) reconcile(workspace);
  }
  // Project conversations consume the same committed move journal. Each
  // reference carries its own cursor so old paths reused by new notes remain
  // distinct, including when a renderer sends an older cached conversation.
  function resolveReferences(root, items, defaultVersion = 0) {
    if (!Array.isArray(items) || items.length > 1000) throw new Error('无效的笔记引用记录。');
    const loc = location(root), index = readIndex(loc.root);
    let changed = false;
    const result = items.map(item => {
      identity(loc.root, item?.path);
      if (typeof item.title !== 'string') throw new Error('无效的笔记引用标题。');
      const version = Object.hasOwn(item, 'moveVersion') ? item.moveVersion : defaultVersion;
      if (!Number.isSafeInteger(version) || version < 0 || version > index.moves.length) throw new Error('笔记引用的移动记录不匹配，请重新载入对话。');
      const nextPath = remap(item.path, index.moves.slice(version));
      const key = relative(loc.root, nextPath);
      if (!Object.hasOwn(index.files, key)) {
        const signature = stamp(loc.root, key);
        if (signature) { index.files[key] = signature; changed = true; }
      }
      return { ...item, path: nextPath, moveVersion: index.moves.length,
        title: nextPath !== item.path && item.title === path.posix.basename(item.path, '.md') ? path.posix.basename(nextPath, '.md') : item.title };
    });
    if (changed) atomic(loc.index, index);
    return result;
  }
  return { get, set, prepareRelocation, reconcile, track, lock, beforeWrite, resolveReferences,
    moveVersion: root => readIndex(location(root).root).moves.length,
    key: (root, notePath) => { const id = identity(root, notePath), loc = location(id.root); return path.join(loc.folder, readIndex(id.root).entries[id.path] || hash(id.path) + '.json'); } };
}
module.exports = { createNoteChatStore };
