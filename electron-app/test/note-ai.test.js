const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createWorkspace } = require('../electron/workspace');
const { listNotes, buildNoteRequest, registerNoteAi } = require('../electron/note-ai');
const { createEdit, assertFresh } = require('../src/note-ai-model');

test('follow-up history keeps old citations bound to their original paths after reference changes', async () => {
  const { conversationHistory } = await import('../src/note-ai.mjs');
  const history = conversationHistory([{ role: 'user', content: '比较方案' }, { role: 'assistant', content: '参考 [N2]',
    snapshot: 'private editor snapshot', sources: [{ id: 'N2', title: '旧方案', path: '资料/旧方案.md' }] }], '工作/当前.md');
  assert.equal(history[1].content, '参考 [旧方案](<../资料/旧方案.md>)');
  assert.equal(history[1].snapshot, undefined);
  assert.doesNotMatch(history[1].content, /\[N2\]/);
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-note-ai-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = createWorkspace(root);
  workspace.write('当前.md', '# 已保存'); workspace.write('参考.md', '# 参考资料\n预算是三万元。');
  workspace.write('未选中.md', '不得发送的无关资料');
  return workspace;
}
test('note context uses unsaved content and only explicit references, with stable citations and selection', t => {
  const workspace = fixture(t);
  const payload = { path: '当前.md', content: '# 未保存内容', question: '比较两篇笔记', references: ['参考.md', '参考.md'], selection: { from: 2, to: 7 }, history: [{ role: 'assistant', content: '上文' }] };
  const result = buildNoteRequest(workspace, payload);
  const data = JSON.parse(result.messages.at(-1).content);
  assert.equal(data.sources.length, 2); assert.equal(data.sources[0].text, '# 未保存内容');
  assert.equal(data.sources[1].text, workspace.read('参考.md'));
  assert.equal(data.selectedText, '未保存内容'); assert.equal(result.sources[1].id, 'N2');
  assert.equal(result.messages[0].content, '上文');
  assert.doesNotMatch(JSON.stringify(result), /不得发送/);
  assert.equal(workspace.read('当前.md'), '# 已保存');
  assert.throws(() => buildNoteRequest(workspace, { ...payload, references: ['../outside.md'] }), /非法路径/);
  assert.throws(() => buildNoteRequest(workspace, { ...payload, references: ['missing.md'] }));
  assert.throws(() => buildNoteRequest(workspace, { ...payload, content: 'a'.repeat(40001) }), /40,000/);
  assert.throws(() => buildNoteRequest(workspace, { ...payload, references: Array(9).fill('参考.md') }), /8 篇/);
});
test('picker disambiguates paths and excludes protected and system files; sensitive references fail before calling AI', t => {
  const workspace = fixture(t);
  workspace.createFolder('', '70_Finance'); workspace.write('70_Finance/财务.md', 'private');
  workspace.createFolder('', 'Templates'); workspace.write('Templates/参考.md', 'template');
  workspace.createFolder('', '工作'); workspace.write('工作/参考.md', 'second');
  workspace.write('敏感.md', '---\nsensitivity: sensitive\n---\nprivate');
  const files = listNotes(workspace, { path: '当前.md', query: '参考' });
  assert.deepEqual(files.map(item => item.path).sort(), ['参考.md', '工作/参考.md'].sort());
  const base = { path: '当前.md', content: 'ok', question: '总结' };
  for (const file of ['敏感.md', '70_Finance/财务.md']) assert.throws(() => buildNoteRequest(workspace, { ...base, references: [file] }), /敏感|受保护/);
  if (process.platform !== 'win32') {
    fs.symlinkSync(path.join(workspace.root, '参考.md'), path.join(workspace.root, '链接.md'));
    assert.throws(() => buildNoteRequest(workspace, { ...base, references: ['链接.md'] }), /符号链接/);
  }
});
test('write plans preserve frontmatter, BOM and CRLF, isolate selections and reject stale previews', () => {
  const base = '\uFEFF---\r\ntitle: 保留\r\n# comment\r\n---\r\n旧正文\r\n';
  const edit = createEdit(base, '新正文\n第二行', 'body');
  assert.equal(edit.next, base.slice(0, base.indexOf('旧正文')) + '新正文\r\n第二行\r\n');
  assert.equal(edit.removed, '旧正文\r\n');
  assertFresh(edit, base); assert.throws(() => assertFresh(edit, base + '修改'), /预览后已变化/);
  const selected = createEdit('前面选中后面', '替换', 'selection', { from: 2, to: 4 });
  assert.equal(selected.next, '前面替换后面');
  assert.equal(createEdit('正文', '补充', 'append').next, '正文\n\n补充\n');
  assert.throws(() => createEdit(base, 'bad', 'selection', { from: 1, to: 4 }), /包含元数据/);
  assert.throws(() => createEdit('---\ntitle: broken', 'bad', 'body'), /元数据格式/);
});
test('IPC binds references to the originating vault and document and verifies disk before write', async t => {
  const workspace = fixture(t), handlers = new Map();
  const sender = Object.assign(new EventEmitter(), { id: 1, mainFrame: {}, isDestroyed: () => false, send: () => {} });
  const event = { sender, senderFrame: sender.mainFrame };
  let calls = 0;
  registerNoteAi({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, trusted: () => true,
    getContext: () => ({ workspace, path: '当前.md' }),
    aiService: { chat: async payload => { calls++; return JSON.parse(payload.messages.at(-1).content).sources[0].text; }, cancel: () => true } });
  const payload = { root: workspace.root, path: '当前.md', content: '草稿', question: '总结', requestId: 'note-ai-test' };
  assert.equal((await handlers.get('noteAi:chat')(event, payload)).text, '草稿');
  await assert.rejects(handlers.get('noteAi:chat')(event, { ...payload, root: '/other' }), /笔记库或文档/);
  await assert.rejects(handlers.get('noteAi:chat')(event, { ...payload, path: '参考.md' }), /笔记库或文档/);
  assert.equal(calls, 1);
  const validate = handlers.get('noteAi:validate');
  assert.equal(validate(event, { ...payload, expected: '# 已保存' }), true);
  workspace.write('当前.md', '外部修改');
  assert.throws(() => validate(event, { ...payload, expected: '# 已保存' }), /其他位置修改/);
});
