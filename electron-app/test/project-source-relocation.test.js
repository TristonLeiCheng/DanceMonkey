const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWorkspace } = require('../electron/workspace');
const { createNoteChatStore } = require('../electron/note-ai-history');
const { createProjectChatStore, modelMessages } = require('../electron/project-ai');

function fixture(t) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-project-source-move-')));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const data = path.join(temp, 'data'), notes = createNoteChatStore(data);
  const ws = createWorkspace(path.join(temp, 'vault'), { noteHistory: notes });
  const chats = createProjectChatStore(data, { noteHistory: notes });
  ws.createFolder('', '资料'); ws.createFolder('', '归档');
  ws.write('资料/方案.md', '原方案正文');
  const messages = [{ role: 'user', content: '请看方案', references: [{ title: '方案', path: '资料/方案.md' }] },
    { role: 'assistant', content: '原结论 [N2]', sources: [{ id: 'N2', title: '方案', path: '资料/方案.md' }],
      actions: [{ id: 'a1', type: 'update_task', state: 'applied', summary: '修改日期', undo: { type: 'update_task', changes: { dueDate: '2026-11-01' } } }] }];
  chats.set(ws.root, 'p1', messages);
  return { temp, data, ws, notes, chats, messages, root: ws.root };
}

test('project and portfolio references follow file/folder renames and moves after reopening, isolated by vault', t => {
  const { temp, data, ws, notes, chats, messages, root } = fixture(t);
  chats.set(root, '__portfolio__', messages);
  chats.set(root, 'p2', messages.map(message => ({ ...message,
    ...(message.sources ? { sources: message.sources.map(source => ({ ...source, title: '自定义资料标题' })) } : {}) })));
  const other = createWorkspace(path.join(temp, 'other'), { noteHistory: notes });
  other.createFolder('', '资料'); other.write('资料/方案.md', '另一笔记库的正文');
  chats.set(other.root, 'p1', messages);
  const original = chats.get(root, 'p1');
  ws.rename('资料/方案.md', '新方案');
  ws.rename('资料/新方案.md', { name: '新方案', parent: '归档' });
  ws.rename('归档', '年度归档');
  const reopened = createProjectChatStore(data);
  for (const id of ['p1', 'p2', '__portfolio__']) {
    const history = reopened.get(root, id);
    assert.equal(history[0].references[0].path, '年度归档/新方案.md');
    assert.equal(history[1].sources[0].path, '年度归档/新方案.md');
    assert.equal(history[1].sources[0].id, 'N2');
    assert.equal(history[1].sources[0].title, id === 'p2' ? '自定义资料标题' : '新方案');
    assert.equal(ws.read(history[1].sources[0].path), '原方案正文');
    assert.equal(history[1].content, original[1].content);
    assert.deepEqual(history[1].actions, original[1].actions);
    assert.match(modelMessages(history)[1].content, /年度归档\/新方案.md/);
  }
  assert.equal(reopened.get(other.root, 'p1')[1].sources[0].path, '资料/方案.md');
  const persisted = JSON.parse(fs.readFileSync(chats.file, 'utf8')).chats[`${root}\np1`].messages;
  assert.equal(persisted[1].sources[0].path, '年度归档/新方案.md');
});

test('cached histories cannot restore old paths, while a newly selected note at a reused path stays independent', t => {
  const { ws, chats, root, data, notes } = fixture(t);
  const cached = chats.get(root, 'p1');
  ws.rename('资料/方案.md', { name: '已移动', parent: '归档' });
  ws.write('资料/方案.md', '旧位置的新笔记');
  const fresh = chats.resolveReferences(root, [{ title: '方案', path: '资料/方案.md', moveVersion: notes.moveVersion(root) }])[0];
  const saved = chats.set(root, 'p1', [...cached, { role: 'user', content: '新笔记问题', references: [fresh] }]);
  assert.equal(saved[0].references[0].path, '归档/已移动.md');
  assert.equal(saved[1].sources[0].path, '归档/已移动.md');
  assert.equal(saved[2].references[0].path, '资料/方案.md');
  ws.rename('归档', '最终');
  const oldFrame = chats.set(root, 'p1', [...cached, { role: 'user', content: '继续旧问题', references: cached[0].references }]);
  assert.equal(oldFrame[2].references[0].path, '最终/已移动.md');
  assert.equal(createProjectChatStore(data).get(root, 'p1')[1].sources[0].path, '最终/已移动.md');
  assert.equal(ws.read(chats.resolveReferences(root, [fresh])[0].path), '旧位置的新笔记');
});

test('reference-only notes follow external moves and atomic saves without inheriting an identical copy', t => {
  const { ws, root, notes, data } = fixture(t);
  ws.write('资料/方案.md', '保存后的原方案');
  fs.renameSync(path.join(root, '资料'), path.join(root, '外部移动'));
  fs.mkdirSync(path.join(root, '资料'));
  fs.writeFileSync(path.join(root, '资料/方案.md'), '旧路径新笔记');
  fs.copyFileSync(path.join(root, '外部移动/方案.md'), path.join(root, '复制.md'));
  const reopenedNotes = createNoteChatStore(data);
  reopenedNotes.reconcile(ws);
  const reopened = createProjectChatStore(data, { noteHistory: reopenedNotes });
  const history = reopened.get(root, 'p1');
  assert.equal(history[1].sources[0].path, '外部移动/方案.md');
  assert.equal(ws.read(history[1].sources[0].path), '保存后的原方案');
  assert.equal(notes.get(root, '外部移动/方案.md').messages.length, 0, 'a note does not need its own AI conversation to be tracked');
});

test('project sources consume only committed moves and recover an interrupted filesystem rename', t => {
  const { ws, root, notes, data, chats } = fixture(t);
  const rename = fs.renameSync;
  let once = true;
  fs.renameSync = (from, to) => {
    if (once && to.endsWith('index.json') && fs.existsSync(path.join(root, '资料/新名.md'))) { once = false; throw new Error('迁移写盘失败'); }
    return rename(from, to);
  };
  try { assert.throws(() => ws.rename('资料/方案.md', '新名'), /迁移写盘失败/); }
  finally { fs.renameSync = rename; }
  assert.equal(chats.get(root, 'p1')[1].sources[0].path, '资料/方案.md');
  assert.equal(ws.read('资料/方案.md'), '原方案正文');
  notes.prepareRelocation(root, '资料/方案.md', '资料/新名.md');
  fs.renameSync(path.join(root, '资料/方案.md'), path.join(root, '资料/新名.md'));
  assert.equal(createProjectChatStore(data).get(root, 'p1')[1].sources[0].path, '资料/新名.md');
});

test('damaged project history and failed migration saves retain original bytes and can be retried', t => {
  const { ws, root, chats, data } = fixture(t);
  const original = fs.readFileSync(chats.file, 'utf8');
  ws.rename('资料/方案.md', '新名');
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (to === chats.file) throw new Error('对话写盘失败'); return rename(from, to); };
  try { assert.throws(() => chats.get(root, 'p1'), /对话写盘失败/); }
  finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(chats.file, 'utf8'), original);
  const broken = original.slice(0, -6); fs.writeFileSync(chats.file, broken);
  assert.throws(() => chats.get(root, 'p1'), /原文件已保留/);
  assert.throws(() => chats.set(root, 'p1', []), /原文件已保留/);
  assert.equal(fs.readFileSync(chats.file, 'utf8'), broken);
  fs.writeFileSync(chats.file, original);
  assert.equal(createProjectChatStore(data).get(root, 'p1')[1].sources[0].path, '资料/新名.md');
});

test('legacy project references gain migration cursors without altering the original answer', t => {
  const { root, ws, chats, data } = fixture(t);
  const raw = JSON.parse(fs.readFileSync(chats.file, 'utf8'));
  for (const message of raw.chats[`${root}\np1`].messages) for (const item of [...(message.sources || []), ...(message.references || [])]) delete item.moveVersion;
  fs.writeFileSync(chats.file, JSON.stringify(raw));
  ws.rename('资料', '项目资料');
  const migrated = createProjectChatStore(data).get(root, 'p1');
  assert.equal(migrated[1].sources[0].path, '项目资料/方案.md');
  assert.equal(migrated[1].content, '原结论 [N2]');
  assert.equal(migrated[1].sources[0].moveVersion, 1);
});
