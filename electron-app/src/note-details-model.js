const { parseDocument, isMap } = require('yaml');
const { Lexer } = require('marked');

function splitMetadata(text) {
  const source = String(text);
  const opening = /^\uFEFF?---[ \t]*(\r?\n)/.exec(source);
  const bom = source.startsWith('\uFEFF') ? '\uFEFF' : '';
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  if (!opening) return { yaml: '', body: source.slice(bom.length), bom, newline, exists: false };
  const rest = source.slice(opening[0].length);
  const closing = /^---[ \t]*(?:\r?\n|$)/m.exec(rest);
  if (!closing) return { yaml: '', body: source.slice(bom.length), bom, newline, exists: false, malformed: true };
  return { yaml: rest.slice(0, closing.index).replace(/\r?\n$/, ''),
    body: rest.slice(closing.index + closing[0].length), bom, newline, exists: true };
}

function validateMetadata(yaml) {
  if (yaml.length > 64 * 1024) throw new Error('元数据最多支持 64 KB');
  if (/^(?:---|\.\.\.)[ \t]*$/m.test(yaml)) throw new Error('请只填写 YAML 字段，不包含 --- 或 ... 分隔线');
  const document = parseDocument(yaml, { stringKeys: true, uniqueKeys: true, prettyErrors: false });
  if (document.errors.length) throw new Error(`YAML 格式有误：${document.errors[0].message}`);
  if (document.contents && !isMap(document.contents)) throw new Error('元数据应为“字段: 值”形式');
  return document.toJS({ maxAliasCount: 100 }) || {};
}

function replaceMetadata(text, yaml) {
  const parts = splitMetadata(text);
  if (parts.malformed) throw new Error('文档头部缺少结束的 ---，请先在源码中修复');
  validateMetadata(yaml);
  if (!yaml.trim()) return parts.exists ? parts.bom + parts.body : text;
  return parts.bom + '---' + parts.newline + yaml.replace(/\r?\n/g, parts.newline).replace(/(?:\r?\n)+$/, '') +
    parts.newline + '---' + parts.newline + parts.body;
}

function localTarget(value) {
  return value && !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value);
}

function extractLinks(text) {
  const links = [];
  const visit = tokens => {
    for (const token of tokens || []) {
      if (['code', 'codespan', 'html', 'image', 'escape'].includes(token.type)) continue;
      if (token.type === 'link') {
        if (localTarget(token.href)) links.push({ target: token.href, label: token.text, kind: 'markdown' });
        continue;
      }
      if (token.tokens) visit(token.tokens);
      else if (token.type === 'text') {
        for (const match of (token.raw || '').matchAll(/(?<!!)\[\[([^\]\r\n]+)\]\]/g)) {
          const [target, label] = match[1].split('|');
          if (localTarget(target.trim())) links.push({ target: target.trim(), label: label?.trim() || target.trim(), kind: 'wiki' });
        }
      }
      if (token.items) visit(token.items);
      if (token.header) for (const cell of token.header) visit(cell.tokens);
      if (token.rows) for (const row of token.rows) for (const cell of row) visit(cell.tokens);
    }
  };
  visit(Lexer.lex(splitMetadata(text).body, { gfm: true }));
  return links;
}

const key = value => String(value).normalize('NFC').toLocaleLowerCase();
const stem = file => file.split('/').at(-1).replace(/\.md$/i, '');
function parseNote(file) {
  const parts = splitMetadata(file.content);
  let metadata = {};
  try { metadata = validateMetadata(parts.yaml); } catch {}
  const aliases = metadata.aliases ?? metadata.alias ?? [];
  return { ...file, title: typeof metadata.title === 'string' ? metadata.title : file.title || stem(file.path),
    aliases: (Array.isArray(aliases) ? aliases : [aliases]).filter(value => typeof value === 'string'), links: extractLinks(file.content) };
}

function resolveRelative(source, target) {
  const parts = target.startsWith('/') ? [] : source.split('/').slice(0, -1);
  for (const part of target.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) return null; parts.pop(); }
    else parts.push(part);
  }
  return parts.join('/');
}

function buildRelations(files, currentPath) {
  const notes = files.map(file => file.links ? file : parseNote(file));
  const byPath = new Map(notes.map(note => [key(note.path), note]));
  const resolve = (source, link) => {
    let target;
    try { target = decodeURIComponent(link.target.split(/[?#]/)[0]).trim(); } catch { target = ''; }
    if (!target) return null;
    if (link.kind === 'markdown' && /\.[^/]+$/.test(target) && !/\.md$/i.test(target)) return null;
    if (!/\.md$/i.test(target)) target += '.md';
    const relative = resolveRelative(source, target);
    if (relative === null) return { ...link, status: 'missing' };
    const exact = byPath.get(key(relative)) || (link.kind === 'wiki' ? byPath.get(key(target.replace(/^\//, ''))) : null);
    if (exact) return { ...link, path: exact.path, title: exact.title, status: 'resolved' };
    const label = key(target.replace(/^\//, '').replace(/\.md$/i, ''));
    const matches = link.kind === 'wiki' && !label.includes('/') ? notes.filter(note =>
      [stem(note.path), note.title, ...note.aliases].some(value => key(value) === label)) : [];
    return matches.length === 1 ? { ...link, path: matches[0].path, title: matches[0].title, status: 'resolved' }
      : { ...link, status: matches.length > 1 ? 'ambiguous' : 'missing' };
  };
  const outgoing = new Map(), incoming = [];
  for (const note of notes) {
    let count = 0;
    for (const link of note.links) {
      const resolved = resolve(note.path, link);
      if (!resolved) continue;
      if (key(note.path) === key(currentPath)) {
        const id = resolved.path || `${resolved.kind}:${resolved.target}`;
        if (outgoing.has(id)) outgoing.get(id).count++;
        else outgoing.set(id, { ...resolved, count: 1 });
      } else if (resolved.path && key(resolved.path) === key(currentPath)) count++;
    }
    if (count) incoming.push({ path: note.path, title: note.title, count });
  }
  return { outgoing: [...outgoing.values()], incoming };
}

module.exports = { splitMetadata, validateMetadata, replaceMetadata, extractLinks, parseNote, buildRelations };
