const model = require('../src/note-details-model');
const home = require('../src/notes-home');

const caches = new WeakMap();
async function inspectWorkspace(workspace, relativePath, currentText) {
  const disk = workspace.read(relativePath); // Validate existence, extension and containment even for unsaved text.
  if (currentText === undefined && Buffer.byteLength(disk) > 2 * 1024 * 1024) throw new Error('文档信息支持查看 2 MB 以内的笔记');
  if (currentText !== undefined && (typeof currentText !== 'string' || Buffer.byteLength(currentText) > 2 * 1024 * 1024)) {
    throw new Error('文档信息支持查看 2 MB 以内的笔记');
  }
  const flatten = nodes => nodes.flatMap(node => [node, ...flatten(node.children || [])]);
  const all = flatten(workspace.list()).filter(node => node.type === 'file');
  const current = all.find(node => node.path === relativePath);
  if (!current) throw new Error('笔记已移动，请重新打开');
  const cache = caches.get(workspace) || new Map();
  caches.set(workspace, cache);
  const notes = [model.parseNote({ ...current, content: currentText ?? disk })];
  let bytes = 0, scanned = 0, omitted = 0, unreadable = 0;
  for (const file of all) {
    if (file.path === relativePath || !home.isPersonal(file)) continue;
    if (scanned >= 2000 || file.size > 2 * 1024 * 1024 || bytes + file.size > 20 * 1024 * 1024) { omitted++; continue; }
    scanned++; bytes += file.size;
    try {
      const stamp = `${file.updatedAt}:${file.size}`;
      let entry = cache.get(file.path);
      if (entry?.stamp !== stamp) {
        entry = { stamp, note: model.parseNote({ ...file, content: workspace.read(file.path) }) };
        cache.set(file.path, entry);
      }
      notes.push(entry.note);
    } catch { unreadable++; }
    if (scanned % 50 === 0) await new Promise(setImmediate);
  }
  const existing = new Set(all.map(file => file.path));
  for (const file of cache.keys()) if (!existing.has(file)) cache.delete(file);
  return { path: relativePath, root: workspace.root, size: current.size, createdAt: current.createdAt, updatedAt: current.updatedAt,
    ...model.buildRelations(notes, relativePath), omitted, unreadable };
}

module.exports = { inspectWorkspace };
