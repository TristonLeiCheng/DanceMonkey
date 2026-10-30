const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const home = require('../src/notes-home');
const { createWorkspace } = require('../electron/workspace');
const { createPkb } = require('../electron/pkb');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-notes-home-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, store: createWorkspace(root) };
}
test('home counts personal notes in the local seven-day window and excludes system/template files', () => {
  const now = new Date(2026, 9, 26, 12), today = now.getTime(), start = new Date(2026, 9, 20).getTime();
  const note = (file, createdAt = today, updatedAt = today) => ({ type: 'file', name: file.split('/').at(-1), path: file, createdAt, updatedAt, size: 100 });
  const tree = [note('one.md', start), note('two.md', start - 1), note('future.md', today + 1, today + 1),
    { type: 'folder', path: 'notes', children: [note('notes/nested.md')] },
    note('Templates/template.md'), note('_System/index.md'), note('notes/模板/会议.md'), note('.history/old.md'), note('notes/.trash/deleted.md'), note('image.png')];
  const result = home.summarize(tree, now);
  assert.equal(result.total, 4); assert.equal(result.created, 2); assert.equal(result.updated, 3); assert.equal(result.bytes, 400);
});
test('search/sort uses titles and paths without mutating input and escapes HTML', () => {
  const files = [{ type: 'file', path: 'Notes/renamed.md', name: 'renamed.md', title: 'Meeting Decisions', createdAt: 1, updatedAt: 4 },
    { type: 'file', path: 'Journal/diary.md', name: 'diary.md', createdAt: 3, updatedAt: 2 }];
  assert.equal(home.select(files, '', 'createdAt')[0].path, 'Journal/diary.md');
  assert.equal(home.select(files, '', 'updatedAt')[0].path, 'Notes/renamed.md');
  assert.equal(home.select(files, 'meeting NOTES')[0].path, 'Notes/renamed.md');
  assert.equal(home.select(files, 'missing').length, 0); assert.equal(files[0].path, 'Notes/renamed.md');
  const html = home.render({ tree: [{ ...files[0], title: '<script>alert(1)</script>' }], vaultRoot: '/Vault/<name>', query: '" onfocus="evil' });
  assert.doesNotMatch(html, /<script>|value="" onfocus/); assert.match(html, /&lt;name&gt;/);
  assert.match(home.render({ tree: [], vaultRoot: '/empty' }), /从第一篇笔记开始/);
});
test('six quick types create Markdown, stable creation metadata, unique names, without initializing PKB', t => {
  const { root, store } = fixture(t);
  for (const item of home.kinds) {
    const created = store.createNote({ type: item.type, title: `测试${item.label}` });
    const raw = store.read(created.path);
    assert.match(raw, /^---\nid:/); assert.match(raw, /created: "/); assert.ok(raw.includes(`# 测试${item.label}`));
    for (const heading of item.sections) assert.ok(raw.includes(`## ${heading}`));
    const first = home.filesFromTree(store.list()).find(file => file.path === created.path);
    assert.equal(first.createdAtSource, 'metadata');
    store.write(created.path, raw + '\n补充记录');
    const edited = home.filesFromTree(store.list()).find(file => file.path === created.path);
    assert.equal(edited.createdAt, first.createdAt); assert.ok(edited.size > first.size);
    const second = store.createNote({ type: item.type, title: `测试${item.label}` });
    assert.notEqual(second.path, created.path); assert.ok(store.read(created.path).includes('补充记录'));
  }
  assert.equal(fs.existsSync(path.join(root, '_System/pkb.json')), false);
  assert.equal(home.summarize(store.list()).total, 12);
  assert.throws(() => store.createNote({ type: '../escape' }), /不支持/);
  const safe = store.createNote({ type: 'note', title: '../escape\nheading' });
  assert.ok(!safe.path.includes('../')); assert.ok(safe.path.startsWith('Notes/'));
});
test('quick creation honors existing PKB templates/routing and rejects invalid manifests and symlinks', t => {
  const { root, store } = fixture(t);
  createPkb(root).initialize();
  fs.writeFileSync(path.join(root, '_System/templates/meeting.md'), '# {{title}}\n\n## 团队自定义议程\n');
  const note = store.createNote({ type: 'meeting', title: '评审会议' });
  assert.match(note.path, /^20_Work\/24_Meetings\//); assert.match(store.read(note.path), /团队自定义议程/);
  assert.equal(home.summarize(store.list()).total, 1);
  assert.equal(store.createNote({ type: 'blank', title: '空白' }).path, '空白.md');
  fs.writeFileSync(path.join(root, '_System/pkb.json'), '{broken');
  assert.throws(() => store.createNote({ type: 'daily' }), /PKB 配置无效/);
  fs.unlinkSync(path.join(root, '_System/pkb.json'));
  if (process.platform !== 'win32') {
    fs.symlinkSync(os.tmpdir(), path.join(root, 'Meetings'));
    assert.throws(() => store.createNote({ type: 'meeting' }), /符号链接/);
  }
});
test('bounded metadata parsing falls back for legacy/invalid headers and reads real creation dates', t => {
  const { root, store } = fixture(t);
  fs.writeFileSync(path.join(root, 'legacy.md'), '# legacy\n');
  fs.writeFileSync(path.join(root, 'invalid.md'), '---\ncreated: "invalid"\ntitle: "Test"\n---\n');
  fs.writeFileSync(path.join(root, 'dated.md'), '---\ncreated: "2020-01-01T12:00:00Z"\n---\n');
  fs.writeFileSync(path.join(root, 'large-header.md'), '---\nother: ' + 'x'.repeat(20000) + '\ncreated: "2020-01-01"\n---\n');
  const files = home.filesFromTree(store.list());
  for (const name of ['legacy.md', 'invalid.md', 'large-header.md']) assert.equal(files.find(file => file.name === name).createdAtSource, 'filesystem');
  assert.equal(files.find(file => file.name === 'dated.md').createdAt, Date.parse('2020-01-01T12:00:00Z'));
});

test('returning home flushes typing during navigation before clearing the editor; failed saves retain the draft', async () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../src/workspace-app.js'), 'utf8');
  const save = source.slice(source.indexOf('  function saveActive() {'), source.indexOf('  async function reloadSyncedNotes()'));
  const navigate = source.slice(source.indexOf('  async function setSection('), source.indexOf('  async function openNoteTaskDialog()'));
  const writes = [];
  let context, fail = false, renders = 0;
  context = vm.createContext({ clearTimeout, Promise, root: { querySelector: () => null },
    api: { workspace: {
      write: async (file, text) => { if (fail) throw new Error('disk full'); writes.push({ file, text }); },
      list: async () => { vm.runInContext("content='typed during navigation'", context); return { root: '/vault', tree: [] }; },
    } }, applyTree: () => {}, renderShell: () => { renders++; },
    location: { hash: '#workspace' }, history: { replaceState() {} },
  });
  vm.runInContext(`let noteDetails=null,markdownEditor=null,noteImageTransfer=null,syncPaused=false,vaultSwitching=false,noteNavigation=0,vaultRoot='/vault',activePath='draft.md',content='first draft',savedContent='old',selectedPath='draft.md',homeQuery='',section='notes',modulesInstance=null,modulesReady=false,saveTimer=null,saveInFlight=Promise.resolve(); ${save} ${navigate}`, context);
  await vm.runInContext("setSection('notes')", context);
  assert.deepEqual(writes, [{ file: 'draft.md', text: 'first draft' }, { file: 'draft.md', text: 'typed during navigation' }]);
  assert.equal(vm.runInContext('activePath', context), null); assert.equal(renders, 1);
  fail = true;
  vm.runInContext("activePath='draft.md';content='unsaved';savedContent='old'", context);
  await assert.rejects(vm.runInContext("setSection('notes')", context), /disk full/);
  assert.equal(vm.runInContext('activePath', context), 'draft.md'); assert.equal(vm.runInContext('content', context), 'unsaved');
});

test('late file reads cannot reopen a note after a newer navigation request', async () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../src/workspace-app.js'), 'utf8');
  const open = source.slice(source.indexOf('  async function openFile('), source.indexOf('  function saveActive()'));
  let finish, rendered = false;
  const context = vm.createContext({ api: { workspace: { read: () => new Promise(resolve => { finish = resolve; }) } },
    saveActive: async () => {}, renderShell: () => { rendered = true; }, expandAncestors() {} });
  vm.runInContext(`let syncPaused=false,vaultSwitching=false,noteNavigation=0,vaultRoot='/vault',activePath=null,selectedPath='',content='',savedContent=''; ${open}`, context);
  const opening = vm.runInContext("openFile('old.md')", context);
  await new Promise(setImmediate);
  vm.runInContext('noteNavigation++', context); finish('late content'); await opening;
  assert.equal(vm.runInContext('activePath', context), null); assert.equal(rendered, false);
});
