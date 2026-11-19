const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createNoteChatStore } = require('../electron/note-ai-history');
const { createWorkspace } = require('../electron/workspace');
function fixture(t) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-chat-move-')));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const userData = path.join(temp, 'data'), store = createNoteChatStore(userData);
  const workspace = createWorkspace(path.join(temp, 'vault'), { noteHistory: store });
  const root = workspace.root;
  function seed(notePath, sourcePath = notePath) {
    if (!fs.existsSync(path.join(root, notePath))) workspace.write(notePath, '原文');
    return store.set(root, notePath, { references: sourcePath === notePath ? [] : [{ path: sourcePath, title: path.posix.basename(sourcePath, '.md') }], messages: [
      { role: 'user', content: '记住这次讨论', createdAt: '2026-11-18' },
      { role: 'assistant', content: '旧结论 [N1]', createdAt: '2026-11-18', snapshot: '原文', incomplete: false,
        sources: [{ id: 'N1', path: sourcePath, title: path.posix.basename(sourcePath, '.md') }] },
    ] }, 0);
  }
  return { temp, userData, store, workspace, root, seed };
}
test('rename and move preserve history and citations, including folders and reusing the old path', t => {
  const { store, workspace: ws, root, seed, userData } = fixture(t);
  ws.createFolder('', '资料'); ws.createFolder('', '归档');
  seed('资料/旧名.md'); seed('旁观.md', '资料/旧名.md');
  const key = store.key(root, '资料/旧名.md');
  assert.equal(ws.rename('资料/旧名.md', { name: '新名', parent: '归档' }), '归档/新名.md');
  assert.equal(store.key(root, '归档/新名.md'), key, 'conversation file keeps its stable identity');
  assert.equal(store.get(root, '归档/新名.md').messages[1].sources[0].path, '归档/新名.md');
  assert.equal(store.get(root, '旁观.md').references[0].path, '归档/新名.md');
  assert.equal(store.get(root, '资料/旧名.md').messages.length, 0);
  seed('资料/旧名.md');
  assert.notEqual(store.key(root, '资料/旧名.md'), key, 'reused paths cannot inherit the moved conversation');
  assert.equal(ws.rename('归档', '年度归档'), '年度归档');
  const restored = createNoteChatStore(userData);
  assert.equal(restored.get(root, '年度归档/新名.md').messages[0].content, '记住这次讨论');
  assert.equal(restored.get(root, '年度归档/新名.md').messages[1].sources[0].title, '新名');
  assert.equal(restored.get(root, '旁观.md').references[0].path, '年度归档/新名.md');
  assert.throws(() => ws.rename('年度归档', { name: 'bad', parent: '年度归档' }), /子文件夹/);
});
test('quick-note title changes keep the same conversation even after an atomic content save', t => {
  const { store, workspace: ws, root, seed } = fixture(t);
  const note = ws.syncQuickNotes([{ id: 'q1', title: '速记', body: '原文' }])[0];
  seed(note.filePath);
  const next = ws.syncQuickNotes([{ ...note, title: '新速记', body: '更新内容' }])[0];
  assert.equal(store.get(root, next.filePath).messages.length, 2);
  const moved = '外部移动.md'; fs.renameSync(path.join(root, next.filePath), path.join(root, moved));
  store.reconcile(ws);
  assert.equal(store.get(root, moved).messages.length, 2);
});
test('external folder moves recover recorded file identities and references, without matching identical content', t => {
  const { store, workspace: ws, root, seed, userData } = fixture(t);
  ws.createFolder('', '资料'); seed('资料/会议.md');
  ws.write('资料/来源.md', '外部资料'); seed('讨论.md', '资料/来源.md');
  ws.write('资料/会议.md', '应用内修改后原子保存');
  fs.renameSync(path.join(root, '资料'), path.join(root, '移动后'));
  ws.createFolder('', '资料'); ws.write('资料/会议.md', '完全不同的新笔记');
  const restored = createNoteChatStore(userData); restored.reconcile(ws);
  assert.equal(restored.get(root, '移动后/会议.md').messages.length, 2);
  assert.equal(restored.get(root, '讨论.md').references[0].path, '移动后/来源.md');
  assert.equal(restored.get(root, '资料/会议.md').messages.length, 0);
  fs.copyFileSync(path.join(root, '移动后/会议.md'), path.join(root, '复制.md'));
  restored.reconcile(ws);
  assert.equal(restored.get(root, '复制.md').messages.length, 0);
});
test('legacy path records are upgraded before moving without discarding their history', t => {
  const { store, workspace: ws, root, seed, userData } = fixture(t);
  const state = seed('旧版.md');
  const file = store.key(root, '旧版.md');
  fs.unlinkSync(path.join(path.dirname(file), 'index.json'));
  fs.writeFileSync(file, JSON.stringify({ version: 1, root, path: '旧版.md', ...state }));
  const restored = createNoteChatStore(userData); restored.reconcile(ws);
  fs.renameSync(path.join(root, '旧版.md'), path.join(root, '已移动.md'));
  restored.reconcile(ws);
  assert.equal(restored.get(root, '已移动.md').messages.length, 2);
});
test('external chained moves keep each conversation with its own file', t => {
  const { store, workspace: ws, root, seed } = fixture(t);
  seed('甲.md'); seed('乙.md');
  const first = store.key(root, '甲.md'), second = store.key(root, '乙.md');
  fs.renameSync(path.join(root, '乙.md'), path.join(root, '丙.md'));
  fs.renameSync(path.join(root, '甲.md'), path.join(root, '乙.md'));
  store.reconcile(ws);
  assert.equal(store.key(root, '乙.md'), first);
  assert.equal(store.key(root, '丙.md'), second);
  assert.equal(store.get(root, '乙.md').messages[1].sources[0].path, '乙.md');
  assert.equal(store.get(root, '丙.md').messages[1].sources[0].path, '丙.md');
});
test('saving a new file at an externally moved note’s old path cannot steal the history', t => {
  const { store, workspace: ws, root, seed } = fixture(t);
  seed('原名.md');
  fs.renameSync(path.join(root, '原名.md'), path.join(root, '新位置.md'));
  fs.writeFileSync(path.join(root, '原名.md'), '新笔记');
  ws.write('原名.md', '新笔记的修改');
  assert.equal(store.get(root, '新位置.md').messages.length, 2);
  assert.equal(store.get(root, '原名.md').messages.length, 0);
});
test('history collisions and active generation leave both note and conversation unmoved', t => {
  const { store, workspace: ws, root, seed } = fixture(t);
  seed('原名.md'); seed('目标.md'); fs.unlinkSync(path.join(root, '目标.md'));
  assert.throws(() => ws.rename('原名.md', '目标.md'), /另一篇笔记/);
  assert.equal(ws.read('原名.md'), '原文'); assert.equal(store.get(root, '原名.md').messages.length, 2);
  const unlock = store.lock(root, ['原名.md']);
  assert.throws(() => ws.rename('原名.md', '新名.md'), /先停止/);
  unlock(); assert.equal(ws.rename('原名.md', '新名.md'), '新名.md');
});
test('failed history commit rolls back the note and appearance; an interrupted move recovers after restart', t => {
  const { store, workspace: ws, root, seed, userData } = fixture(t);
  seed('原名.md'); ws.setAppearance('原名.md', { emoji: '⭐' });
  const rename = fs.renameSync;
  let once = true;
  fs.renameSync = (from, to) => {
    if (once && to.endsWith('index.json') && fs.existsSync(path.join(root, '新名.md'))) { once = false; throw new Error('模拟写盘失败'); }
    return rename(from, to);
  };
  try { assert.throws(() => ws.rename('原名.md', '新名.md'), /模拟写盘失败/); }
  finally { fs.renameSync = rename; }
  assert.equal(ws.read('原名.md'), '原文'); assert.equal(ws.getAppearance('原名.md').emoji, '⭐');
  assert.equal(store.get(root, '原名.md').messages.length, 2);
  store.prepareRelocation(root, '原名.md', '新名.md');
  fs.renameSync(path.join(root, '原名.md'), path.join(root, '新名.md'));
  const restored = createNoteChatStore(userData);
  assert.equal(restored.get(root, '新名.md').messages.length, 2);
  assert.equal(restored.get(root, '原名.md').messages.length, 0);
  restored.prepareRelocation(root, '新名.md', '尚未移动.md'); // crash before filesystem rename
  const again = createNoteChatStore(userData);
  assert.equal(again.get(root, '新名.md').messages.length, 2);
});
