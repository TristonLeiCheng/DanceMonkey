const { PROTECTED_DIRECTORIES } = require('./pkb');
const { isPersonal } = require('../src/notes-home');
const { splitMetadata, validateMetadata } = require('../src/note-details-model');

const MAX_REFERENCES = 8, MAX_CONTEXT = 60000, MAX_NOTE = 40000;
function allowedPath(value) {
  return typeof value === 'string' && !value.split(/[\\/]/).some(part => part === '..' || part.startsWith('.')) &&
    !PROTECTED_DIRECTORIES.some(dir => value.toLowerCase().replaceAll('\\', '/').startsWith(dir.toLowerCase() + '/'));
}
function assertReadable(file, text) {
  if (!allowedPath(file)) throw new Error('受保护目录中的笔记不能发送给 AI。');
  const parts = splitMetadata(text);
  if (parts.malformed) throw new Error(`${file} 的元数据格式有误，请先修复。`);
  const metadata = validateMetadata(parts.yaml);
  if (metadata.sensitivity === 'sensitive') throw new Error(`${file} 标记为敏感笔记，不能发送给 AI。`);
  if (text.length > MAX_NOTE) throw new Error(`${file} 超过 40,000 字符，请缩短笔记或选择较短的参考资料。`);
  return typeof metadata.title === 'string' ? metadata.title : file.split('/').at(-1).replace(/\.md$/i, '');
}
function listNotes(workspace, { query = '', path: current } = {}) {
  const q = String(query).trim().toLocaleLowerCase();
  const result = [];
  const visit = nodes => { for (const node of nodes) {
    if (node.children) visit(node.children);
    else if (node.path !== current && isPersonal(node) && allowedPath(node.path) &&
      (!q || `${node.title || ''} ${node.path}`.toLocaleLowerCase().includes(q))) {
      result.push({ path: node.path, title: node.title || node.name?.replace(/\.md$/i, '') || node.path });
    }
  } };
  visit(workspace.list());
  return result.sort((a, b) => a.path.localeCompare(b.path, 'zh-CN')).slice(0, 50);
}
function readReferences(workspace, references = [], initialSources = []) {
  if (!Array.isArray(references) || references.length > MAX_REFERENCES || references.some(item => typeof item !== 'string')) throw new Error('最多引用 8 篇笔记。');
  const sources = [...initialSources];
  for (const file of new Set(references)) {
    if (sources.some(item => item.path === file)) continue;
    const text = workspace.read(file);
    sources.push({ id: `N${sources.length + 1}`, path: file, title: assertReadable(file, text), text });
  }
  if (sources.reduce((sum, item) => sum + item.text.length, 0) > MAX_CONTEXT) throw new Error('引用内容合计超过 60,000 字符，请移除部分参考笔记。');
  return sources;
}
module.exports = { listNotes, assertReadable, readReferences };
