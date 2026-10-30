const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createWorkspace } = require('../electron/workspace');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-quick-save-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, workspace: createWorkspace(root) };
}

test('each keystroke and title change updates one quick note, including after restart', t => {
  const { root, workspace } = fixture(t);
  // The popup creates its ID before there is any file on disk.
  const note = { id: 'popup-draft', title: '', body: '' };
  workspace.syncQuickNotes([note]);
  for (const title of ['今', '今天', '今天记录']) {
    note.title = title;
    workspace.syncQuickNotes([note]);
    assert.equal(workspace.listQuickNotes().length, 1);
    assert.equal(workspace.listQuickNotes()[0].id, note.id);
  }
  for (const character of '连续输入正文') {
    note.body += character;
    workspace.syncQuickNotes([note]);
    assert.equal(workspace.listQuickNotes().length, 1);
  }
  const restarted = createWorkspace(root);
  assert.equal(restarted.listQuickNotes()[0].id, note.id);
  assert.equal(restarted.listQuickNotes()[0].body, note.body);
  restarted.write(restarted.listQuickNotes()[0].filePath, '完整编辑器修改');
  const saved = restarted.listQuickNotes()[0];
  restarted.syncQuickNotes([{ ...saved, body: saved.body + '，弹窗续写' }]);
  assert.equal(restarted.listQuickNotes().length, 1);
  assert.equal(restarted.listQuickNotes()[0].body, '完整编辑器修改，弹窗续写');
  assert.equal(restarted.listQuickNotes()[0].id, note.id);
});

test('legacy notes move into the quick category on edit and retain their ID when renamed', t => {
  const { root, workspace } = fixture(t);
  const file = path.join(root, workspace.quickNotesFolder, '旧便签.md');
  fs.writeFileSync(file, '旧内容');
  const note = workspace.listQuickNotes()[0];
  workspace.syncQuickNotes([{ ...note, body: '修改正文' }]);
  assert.equal(workspace.listQuickNotes()[0].body, '修改正文');
  assert.equal(fs.existsSync(file), false);
  assert.equal(workspace.listQuickNotes()[0].filePath, `${workspace.quickNotesFolder}/随手记/旧便签.md`);
  for (const title of ['新', '新标题']) {
    workspace.syncQuickNotes([{ ...note, title, body: '继续编辑' }]);
    assert.equal(workspace.listQuickNotes().length, 1);
    assert.equal(workspace.listQuickNotes()[0].id, note.id);
    assert.equal(workspace.listQuickNotes()[0].body, '继续编辑');
  }
  assert.equal(createWorkspace(root).listQuickNotes()[0].id, note.id);
});

test('two notes with the same title remain separate without producing extra copies', t => {
  const { workspace } = fixture(t);
  let notes = workspace.syncQuickNotes([
    { id: 'first', title: '记录', body: '一' },
    { id: 'second', title: '记录', body: '二' },
  ]);
  for (let index = 0; index < 4; index++) {
    notes = workspace.syncQuickNotes(notes.map(note => ({ ...note, body: note.body + '字' })));
    assert.equal(workspace.listQuickNotes().length, 2);
  }
  assert.deepEqual(new Set(workspace.listQuickNotes().map(note => note.id)), new Set(['first', 'second']));
});

function popupEditor() {
  const source = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
  const binding = source.slice(source.indexOf('      const title = root.querySelector', source.indexOf('    function bind()')), source.indexOf('      const zenInput = root.querySelector'));
  const title = { dataset: { id: 'note' }, value: '标题' }, body = { value: '' };
  const writes = [];
  const status = { dataset: {} };
  const context = vm.createContext({
    root: { querySelector: selector => ({ '.title-input': title, '.body-input': body, '[data-note-save-state]': status })[selector] || null, querySelectorAll: () => [] },
    api: { setState: partial => new Promise((resolve, reject) => writes.push({ partial, resolve, reject })) },
  });
  vm.runInContext(`let state = { notes: [{ id: 'note', title: '标题', body: '' }] };
    let syncPaused = false, skipRender = false, noteSaveError = null, zenError = '';
    let pendingNoteSave = Promise.resolve(), noteActionBusy = false; function adopt(next) { state = next; }
    ${source.slice(source.indexOf('    function quickIcon('), source.indexOf('    async function openPanel('))}
    ${binding}`, context);
  return { context, title, body, writes, status, read: expression => vm.runInContext(expression, context) };
}

test('the popup adopts a collision suffix so editing the body does not rename the file again', async () => {
  const { title, body, writes, read } = popupEditor();
  body.value = '正文'; body.oninput();
  await new Promise(setImmediate);
  writes[0].resolve({ notes: [{ id: 'note', title: '标题 2', body: '正文' }] });
  await read('pendingNoteSave');
  assert.equal(title.value, '标题 2');
  body.value = '正文续写'; body.oninput();
  await new Promise(setImmediate);
  assert.equal(writes[1].partial.notes[0].title, '标题 2');
  writes[1].resolve(writes[1].partial);
  await read('pendingNoteSave');
});

test('delayed save responses do not erase newer input and pending writes finish in order', async () => {
  const { body, writes, read } = popupEditor();
  body.value = '第'; body.oninput();
  await new Promise(setImmediate);
  body.value = '第二'; body.oninput();
  assert.equal(writes.length, 1);
  writes[0].resolve({ ...writes[0].partial, revision: 1 });
  await new Promise(setImmediate);
  assert.equal(read('state.notes[0].body'), '第二');
  assert.equal(read('skipRender'), true);
  body.value = '第二篇'; body.oninput();
  writes[1].resolve({ ...writes[1].partial, revision: 2 });
  await new Promise(setImmediate);
  assert.equal(read('state.notes[0].body'), '第二篇');
  assert.equal(writes[2].partial.notes[0].body, '第二篇');
  writes[2].resolve({ ...writes[2].partial, revision: 3 });
  await read('pendingNoteSave');
  assert.equal(read('state.notes[0].body'), '第二篇');
  assert.equal(read('skipRender'), false);
});

test('a failed save allows the next input to retry the latest draft', async () => {
  const { body, writes, read } = popupEditor();
  body.value = '草稿'; body.oninput();
  await new Promise(setImmediate);
  writes[0].reject(new Error('磁盘暂时不可写'));
  await assert.rejects(read('pendingNoteSave'), /磁盘/);
  assert.equal(read('state.notes[0].body'), '草稿');
  body.value = '草稿继续'; body.oninput();
  await new Promise(setImmediate);
  writes[1].resolve(writes[1].partial);
  await read('pendingNoteSave');
  assert.equal(read('state.notes[0].body'), '草稿继续');
  assert.equal(read('noteSaveError'), null);
});


test('complete and note switching wait for the pending draft before running', async () => {
  const { body, writes, read, context, status } = popupEditor();
  body.value = '切换前最后输入'; body.oninput();
  let performed = false;
  context.performAction = () => { performed = true; };
  const action = read('runNoteAction(performAction)');
  await new Promise(setImmediate);
  assert.equal(performed, false);
  assert.equal(status.textContent, '保存中…');
  writes[0].resolve(writes[0].partial);
  await action;
  assert.equal(performed, true);
  assert.equal(status.textContent, '已保存');
});

test('a save failure and failed retry keep the note visible and show a retry action', async () => {
  const { body, writes, read, context, status } = popupEditor();
  body.value = '不能丢失'; body.oninput();
  await new Promise(setImmediate);
  writes[0].reject(new Error('磁盘不可写'));
  await assert.rejects(read('pendingNoteSave'));
  let performed = false;
  context.performAction = () => { performed = true; };
  const action = read('runNoteAction(performAction)');
  await new Promise(setImmediate);
  writes[1].reject(new Error('仍然不可写'));
  await action;
  assert.equal(performed, false);
  assert.equal(read('state.notes[0].body'), '不能丢失');
  assert.equal(status.dataset.state, 'error');
  assert.equal(status.disabled, false);
});


test('a flush also waits for text entered while an earlier save was pending', async () => {
  const { body, writes, read, context } = popupEditor();
  body.value = '先输入'; body.oninput();
  let completed = false;
  context.performAction = () => { completed = true; };
  const action = read('runNoteAction(performAction)');
  await new Promise(setImmediate);
  body.value = '先输入，再补充'; body.oninput();
  writes[0].resolve(writes[0].partial);
  await new Promise(setImmediate);
  assert.equal(completed, false);
  writes[1].resolve(writes[1].partial);
  await action;
  assert.equal(completed, true);
  assert.equal(read('state.notes[0].body'), '先输入，再补充');
});


test('three quick-note types persist in separate folders and keep their type through rename and restart', t => {
  const { root, workspace } = fixture(t);
  const types = require('../src/quick-note-types');
  const input = types.types.map(type => ({ id: type.id, noteType: type.id, title: '相同标题', body: type.label }));
  let saved = workspace.syncQuickNotes(input);
  for (const type of types.types) {
    const note = saved.find(note => note.id === type.id);
    assert.equal(note.filePath, `${workspace.quickNotesFolder}/${type.folder}/相同标题.md`);
    assert.equal(workspace.read(note.filePath), type.label);
  }
  saved = workspace.syncQuickNotes(saved.map(note => note.id === 'meeting' ? { ...note, title: '改了标题的会议笔记', body: '新的会议内容' } : note));
  assert.equal(saved.find(note => note.id === 'meeting').filePath, `${workspace.quickNotesFolder}/会议要点/改了标题的会议笔记.md`);
  const reloaded = createWorkspace(root).listQuickNotes();
  assert.equal(reloaded.length, 3);
  for (const note of reloaded) assert.equal(note.noteType, note.id);
  assert.equal(reloaded.find(note => note.id === 'meeting').body, '新的会议内容');
});

test('classified notes follow a custom PKB route, and initializing a legacy categorized vault retains its route', t => {
  const { root, workspace } = fixture(t);
  const { createPkb } = require('../electron/pkb');
  workspace.syncQuickNotes([{ id: 'meeting', noteType: 'meeting', title: '会后安排', body: '要点' }]);
  const pkb = createPkb(root);
  assert.equal(pkb.initialize().paths.quickNotes, 'Journal/Stickies');
  assert.equal(workspace.listQuickNotes()[0].noteType, 'meeting');
  const manifestPath = path.join(root, '_System/pkb.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.paths.quickNotes = '工作/快捷记录';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const [note] = workspace.syncQuickNotes([{ id: 'idea', noteType: 'idea', title: '新点子', body: '灵感' }]);
  assert.equal(note.filePath, '工作/快捷记录/临时想法/新点子.md');
  assert.equal(createWorkspace(root).listQuickNotes()[0].noteType, 'idea');
});

test('untouched legacy notes are not moved by editing another category', t => {
  const { root, workspace } = fixture(t);
  const legacy = path.join(root, workspace.quickNotesFolder, '保留的旧文件.md');
  fs.writeFileSync(legacy, '保留旧内容');
  const before = workspace.listQuickNotes()[0];
  workspace.syncQuickNotes([before, { id: 'idea', noteType: 'idea', title: '想法', body: '新内容' }]);
  assert.equal(fs.readFileSync(legacy, 'utf8'), '保留旧内容');
  assert.equal(workspace.listQuickNotes().find(note => note.id === before.id).filePath, before.filePath);
  assert.throws(() => workspace.syncQuickNotes([{ id: 'bad', noteType: '../../bad', title: '错误', body: '' }]), /无效/);
});


test('legacy category-label files retain their intended type, while folder membership takes precedence after rename', t => {
  const { root, workspace } = fixture(t);
  fs.writeFileSync(path.join(root, workspace.quickNotesFolder, '会议要点.md'), '旧会议内容');
  const legacy = workspace.listQuickNotes()[0];
  assert.equal(legacy.noteType, 'meeting');
  const [moved] = workspace.syncQuickNotes([{ ...legacy, title: '临时想法', body: '仍然属于会议' }]);
  assert.equal(moved.filePath, `${workspace.quickNotesFolder}/会议要点/临时想法.md`);
  const reloaded = createWorkspace(root).listQuickNotes()[0];
  assert.equal(reloaded.noteType, 'meeting');
  assert.equal(reloaded.id, legacy.id);
});
