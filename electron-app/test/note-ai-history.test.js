const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createNoteChatStore } = require('../electron/note-ai-history');
const { registerNoteAi } = require('../electron/note-ai');
const { createWorkspace } = require('../electron/workspace');

const createdAt = '2026-11-18T08:00:00.000Z';
const messages = [
  { role: 'user', content: '原来的问题', createdAt },
  { role: 'assistant', content: '原来的回答 [N2]', createdAt, sources: [{ id: 'N2', path: '资料/参考.md', title: '参考' }],
    snapshot: '---\r\ntitle: 原文\r\n---\r\n选中正文', selection: { from: 21, to: 25 }, incomplete: false },
];
function setup(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-note-history-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, store: createNoteChatStore(path.join(directory, 'userData')), a: path.join(directory, 'A'), b: path.join(directory, 'B') };
}
test('history survives store recreation, preserves source snapshots, and isolates vaults and note paths', t => {
  const { directory, store, a, b } = setup(t);
  const state = store.set(a, '当前.md', { messages, references: [{ path: '资料/参考.md', title: '参考' }] }, 0);
  const restored = createNoteChatStore(path.join(directory, 'userData'));
  assert.deepEqual(restored.get(a, '当前.md'), state);
  assert.equal(restored.get(b, '当前.md').messages.length, 0);
  assert.equal(restored.get(a, '另一个/当前.md').messages.length, 0);
  assert.deepEqual(restored.get(a, '当前.md').messages[1], messages[1]);
  assert.equal(fs.readdirSync(path.dirname(store.key(a, '当前.md'))).filter(file => /^[a-f0-9]{64}\.json$/.test(file)).length, 1);
  assert.throws(() => store.get(a, '../outside.md'), /无效/);
});
test('clear is persistent and revision checks reject stale windows without deleting other note histories', t => {
  const { directory, store, a, b } = setup(t);
  const first = store.set(a, '当前.md', { messages, references: [] }, 0);
  store.set(b, '当前.md', { messages, references: [] }, 0);
  store.set(a, '其他.md', { messages, references: [] }, 0);
  store.set(a, '当前.md', { messages: [], references: [] }, first.revision);
  assert.throws(() => store.set(a, '当前.md', first, first.revision), /其他窗口更新/);
  const restored = createNoteChatStore(path.join(directory, 'userData'));
  assert.equal(restored.get(a, '当前.md').messages.length, 0);
  assert.equal(restored.get(a, '其他.md').messages.length, 2);
  assert.equal(restored.get(b, '当前.md').messages.length, 2);
});
test('storage retains conversations beyond the old 24-message in-memory limit', t => {
  const { store, a } = setup(t);
  const long = Array.from({ length: 20 }, () => messages).flat();
  store.set(a, '当前.md', { messages: long, references: [] }, 0);
  assert.equal(store.get(a, '当前.md').messages.length, 40);
});
test('corrupt history is reported and never silently replaced', t => {
  const { store, a } = setup(t);
  store.set(a, '当前.md', { messages, references: [] }, 0);
  const file = store.key(a, '当前.md'); fs.writeFileSync(file, '{broken');
  assert.throws(() => store.get(a, '当前.md'), /原文件已保留/);
  assert.throws(() => store.set(a, '当前.md', { messages: [], references: [] }, 0), /原文件已保留/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});
test('failed atomic replacement leaves the previous conversation intact', t => {
  const { store, a } = setup(t);
  const state = store.set(a, '当前.md', { messages, references: [] }, 0);
  const rename = fs.renameSync;
  fs.renameSync = () => { throw new Error('simulated disk failure'); };
  try { assert.throws(() => store.set(a, '当前.md', { messages: [], references: [] }, state.revision), /disk failure/); }
  finally { fs.renameSync = rename; }
  assert.deepEqual(store.get(a, '当前.md'), state);
  assert.equal(fs.readdirSync(path.dirname(store.key(a, '当前.md'))).filter(file => /^[a-f0-9]{64}\.json$/.test(file)).length, 1);
});
test('main process saves turns and stopped partial output to the originating vault and uses durable history', async t => {
  const { store, a, b } = setup(t), handlers = new Map();
  const workspace = createWorkspace(a), other = createWorkspace(b);
  workspace.write('当前.md', '原文'); other.write('当前.md', '另一个库');
  let current = workspace, release, lastRequest;
  const sender = Object.assign(new EventEmitter(), { id: 1, mainFrame: {}, isDestroyed: () => false, send: () => {} });
  const event = { sender, senderFrame: sender.mainFrame };
  const aiService = { chat: (payload, chunk) => {
    lastRequest = payload;
    assert.equal(store.get(a, '当前.md').messages.at(-2).content, '第一次');
    chunk('已有的部分回答');
    return new Promise((resolve, reject) => { release = { resolve, reject }; });
  }, cancel: () => { release.reject(new Error('已停止')); return true; } };
  registerNoteAi({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, aiService, getContext: () => ({ workspace: current }), trusted: () => true, chatStore: store });
  const payload = { root: a, path: '当前.md', content: '未保存内容', question: '第一次', references: [], history: [{ role: 'assistant', content: '伪造历史' }], requestId: 'note-ai-first', revision: 0 };
  const pending = handlers.get('noteAi:chat')(event, payload);
  const partial = store.get(a, '当前.md');
  assert.equal(partial.messages.at(-1).content, '已有的部分回答');
  assert.equal(partial.messages.at(-1).incomplete, true);
  assert.doesNotMatch(JSON.stringify(lastRequest), /伪造历史/);
  assert.throws(() => handlers.get('noteAi:clear')(event, { ...payload, revision: partial.revision }), /先停止/);
  current = other;
  handlers.get('noteAi:cancel')(event, payload.requestId);
  await assert.rejects(pending, /已停止/);
  assert.equal(store.get(a, '当前.md').messages.at(-1).content, '已有的部分回答');
  assert.equal(store.get(b, '当前.md').messages.length, 0);
  current = workspace;
  aiService.chat = async payload => { lastRequest = payload; return '继续回答'; };
  const result = await handlers.get('noteAi:chat')(event, { ...payload, question: '接着说', requestId: 'note-ai-next', revision: store.get(a, '当前.md').revision });
  assert.equal(result.history.messages.length, 4);
  assert.equal(result.history.messages.at(-1).incomplete, false);
  assert.match(JSON.stringify(lastRequest), /第一次.*已有的部分回答/s);
  const before = store.get(a, '当前.md');
  await assert.rejects(handlers.get('noteAi:chat')(event, { ...payload, requestId: 'note-ai-stale' }), /其他窗口更新/);
  assert.deepEqual(store.get(a, '当前.md'), before);
});
