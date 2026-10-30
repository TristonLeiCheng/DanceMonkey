const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const appearance = require('../src/note-appearance');
const home = require('../src/notes-home');
const { createWorkspace } = require('../electron/workspace');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-note-appearance-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, store: createWorkspace(root) };
}
function all(nodes) { return nodes.flatMap(node => [node, ...all(node.children || [])]); }

test('folder and note decorations persist independently without changing Markdown or timestamps', t => {
  const { root, store } = fixture(t);
  store.createFolder('', '工作');
  store.createFile('工作', '计划');
  const file = path.join(root, '工作/计划.md');
  const before = fs.readFileSync(file, 'utf8'), mtime = fs.statSync(file).mtimeMs;
  store.setAppearance('工作', { color: '#639CE0', emoji: '💼' });
  store.setAppearance('工作/计划.md', { color: '#d780b2', backgroundColor: '#EEE8FA', emoji: '👩🏽‍💻' });
  const restarted = createWorkspace(root);
  assert.deepEqual(restarted.getAppearance('工作'), { color: '#639ce0', backgroundColor: '', emoji: '💼' });
  assert.deepEqual(restarted.getAppearance('工作/计划.md'), { color: '#d780b2', backgroundColor: '#eee8fa', emoji: '👩🏽‍💻' });
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.statSync(file).mtimeMs, mtime);
  assert.equal(all(restarted.list()).some(node => node.name === '.dm-note-appearance.json'), false);
  assert.match(home.renderResults({ tree: restarted.list() }), /--note-accent:#d780b2/);
  assert.match(home.renderResults({ tree: restarted.list() }), /--note-bg:#eee8fa/);
  assert.match(home.renderResults({ tree: restarted.list() }), /👩🏽‍💻/);
  restarted.setAppearance('工作/计划.md', { emoji: '👩🏽‍💻' });
  assert.deepEqual(restarted.getAppearance('工作/计划.md'), { color: '', backgroundColor: '', emoji: '👩🏽‍💻' });
  restarted.setAppearance('工作/计划.md', { backgroundColor: '#e6effb' });
  assert.deepEqual(restarted.getAppearance('工作/计划.md'), { color: '', backgroundColor: '#e6effb', emoji: '' });
  restarted.setAppearance('工作/计划.md', {});
  assert.deepEqual(restarted.getAppearance('工作/计划.md'), { color: '', backgroundColor: '', emoji: '' });
  assert.equal(restarted.getAppearance('工作').emoji, '💼');
});

test('folder/file renames remap descendant decorations and deletion clears reused paths', t => {
  const { store } = fixture(t);
  store.createFolder('', '工作'); store.createFolder('工作', '子目录');
  store.createFile('工作/子目录', '计划'); store.createFile('', '另一个');
  for (const file of ['工作', '工作/子目录', '工作/子目录/计划.md', '另一个.md']) store.setAppearance(file, { emoji: '🌱' });
  const renamed = store.rename('工作', '归档');
  assert.equal(renamed, '归档');
  for (const file of ['归档', '归档/子目录', '归档/子目录/计划.md']) assert.equal(store.getAppearance(file).emoji, '🌱');
  assert.equal(store.getAppearance('工作').emoji, '');
  store.rename('归档/子目录/计划.md', '新计划');
  assert.equal(store.getAppearance('归档/子目录/新计划.md').emoji, '🌱');
  store.remove('归档');
  store.createFolder('', '归档'); store.createFolder('归档', '子目录'); store.createFile('归档/子目录', '新计划');
  for (const file of ['归档', '归档/子目录', '归档/子目录/新计划.md']) assert.equal(store.getAppearance(file).emoji, '');
  assert.equal(store.getAppearance('另一个.md').emoji, '🌱');
});

test('quick note title changes retain the decoration and vaults stay isolated', t => {
  const { store } = fixture(t), other = fixture(t).store;
  store.syncQuickNotes([{ id: 'quick', title: '旧标题', body: '正文' }]);
  const note = store.listQuickNotes()[0];
  store.setAppearance(note.filePath, { emoji: '⭐' });
  const renamed = store.syncQuickNotes([{ ...note, title: '新标题' }])[0];
  assert.equal(store.getAppearance(renamed.filePath).emoji, '⭐');
  assert.equal(store.getAppearance(note.filePath).emoji, '');
  other.createFile(other.quickNotesFolder, '新标题');
  assert.equal(other.getAppearance(renamed.filePath).emoji, '');
});

test('validation accepts composite emoji and rejects unsafe styles, text and paths', t => {
  const { root, store } = fixture(t);
  store.createFile('', '计划');
  for (const emoji of ['👨‍👩‍👧‍👦', '🇨🇳', '1️⃣', '❤️', '👍🏽', '🦋']) assert.equal(appearance.normalize({ emoji }).emoji, emoji);
  for (const value of [{ color: 'red' }, { color: '#fff;display:none' }, { backgroundColor: 'url(evil)' }, { backgroundColor: 5 }, { emoji: '<script>' }, { emoji: 'ab' }, { emoji: '😀😀' }, { emoji: 5 }]) {
    assert.throws(() => store.setAppearance('计划.md', value));
  }
  assert.throws(() => store.setAppearance('../outside.md', {}), /非法路径/);
  assert.throws(() => store.setAppearance('', {}), /仅支持/);
  assert.throws(() => store.setAppearance('missing.md', {}));
  fs.writeFileSync(path.join(root, 'data.json'), '{}');
  assert.throws(() => store.setAppearance('data.json', {}), /仅支持/);
  const rendered = home.renderResults({ tree: [{ type: 'file', path: '计划.md', name: '计划.md', appearance: { color: '#fff;" onclick="evil', emoji: '<img>' } }] });
  assert.doesNotMatch(rendered, /onclick|<img|--note-accent/);
  if (process.platform !== 'win32') {
    fs.symlinkSync(path.join(root, '计划.md'), path.join(root, 'link.md'));
    assert.throws(() => store.setAppearance('link.md', { emoji: '⭐' }), /符号链接/);
    fs.symlinkSync(path.join(root, 'data.json'), path.join(root, '.dm-note-appearance.json'));
    assert.throws(() => store.setAppearance('计划.md', { emoji: '⭐' }), /符号链接/);
    assert.equal(fs.readFileSync(path.join(root, 'data.json'), 'utf8'), '{}');
  }
});

test('legacy colors migrate and every appearance template and searchable emoji is valid', t => {
  const { root, store } = fixture(t);
  store.createFile('', '旧笔记');
  fs.writeFileSync(path.join(root, '.dm-note-appearance.json'), JSON.stringify({ '旧笔记.md': { color: '#639ce0', emoji: '⭐' } }));
  assert.deepEqual(store.getAppearance('旧笔记.md'), { color: '#639ce0', backgroundColor: '', emoji: '⭐' });
  for (const template of appearance.templates) {
    store.setAppearance('旧笔记.md', template);
    assert.deepEqual(createWorkspace(root).getAppearance('旧笔记.md'), appearance.normalize(template));
  }
  assert.ok(appearance.emojis.length >= 190);
  for (const emoji of appearance.emojis) assert.equal(appearance.normalize({ emoji }).emoji, emoji);
  assert.deepEqual(appearance.searchEmojis('蝴蝶'), [{ emoji: '🦋', label: '蝴蝶 butterfly' }]);
  assert.equal(appearance.searchEmojis('coffee')[0].emoji, '☕');
  assert.equal(appearance.searchEmojis('', 'animals').length, 24);
  assert.equal(appearance.searchEmojis('不存在的表情').length, 0);
  assert.equal(appearance.style({ appearance: { color: '#639CE0', backgroundColor: '#EEE8FA' } }), '--note-accent:#639ce0;--note-bg:#eee8fa;');
});

test('corrupt settings do not break note listing and are never silently overwritten', t => {
  const { root, store } = fixture(t);
  store.createFile('', '计划');
  const metadata = path.join(root, '.dm-note-appearance.json');
  fs.writeFileSync(metadata, '{broken');
  assert.ok(all(store.list()).some(node => node.path === '计划.md'));
  assert.throws(() => store.setAppearance('计划.md', { emoji: '⭐' }), /无法读取/);
  assert.throws(() => store.rename('计划.md', '重命名'), /无法读取/);
  assert.equal(fs.existsSync(path.join(root, '计划.md')), true);
  assert.equal(fs.readFileSync(metadata, 'utf8'), '{broken');
});
