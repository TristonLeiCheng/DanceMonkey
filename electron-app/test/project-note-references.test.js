const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWorkspace } = require('../electron/workspace');
const { listNotes } = require('../electron/ai-note-references');
const { buildProjectChatRequest, createProjectChatStore, modelMessages } = require('../electron/project-ai');
const { cleanSources, createPicker, mentionAt } = require('../src/note-references');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-project-note-references-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = createWorkspace(root);
  workspace.createFolder('', '资料'); workspace.createFolder('', '其他'); workspace.createFolder('', '70_Finance');
  workspace.write('资料/方案.md', '---\ntitle: 官网方案\n---\n客户要求周五交付。');
  workspace.write('其他/方案.md', '另一篇同名笔记，采用方案 B。');
  workspace.write('未选择.md', '不应发送的未选择正文');
  workspace.write('70_Finance/秘密.md', 'private');
  workspace.write('敏感.md', '---\nsensitivity: sensitive\n---\nprivate');
  const state = { projects: [{ Id: 'p1', Name: '官网', LinkedNotes: ['未选择.md'], Status: 'On Track' }], tasks: [] };
  return { root, workspace, state, payload: { projectId: 'p1', messages: [{ role: 'user', content: '请分析排期' }] } };
}

test('project and portfolio chat reuse the note picker and send only explicitly selected, saved bodies', t => {
  const { workspace, state, payload } = fixture(t);
  assert.deepEqual(listNotes(workspace, { query: '方案' }).map(item => item.path).sort(), ['其他/方案.md', '资料/方案.md'].sort());
  assert.ok(!listNotes(workspace).some(item => item.path.includes('秘密')));
  const read = workspace.read, reads = [];
  workspace.read = file => { reads.push(file); return read(file); };
  const plain = buildProjectChatRequest(workspace, state, payload);
  assert.deepEqual(reads, []);
  assert.deepEqual(plain.sources, []);
  assert.equal(plain.messages.at(-1).content, '请分析排期');
  for (const scope of [undefined, 'portfolio']) {
    reads.length = 0;
    const result = buildProjectChatRequest(workspace, state, { ...payload, scope, include: { notes: false }, references: ['资料/方案.md', '资料/方案.md'] });
    assert.deepEqual(reads, ['资料/方案.md']);
    assert.equal(JSON.parse(result.messages.at(-1).content).sources[0].text, read('资料/方案.md'));
    assert.deepEqual(result.sources, [{ id: 'N1', path: '资料/方案.md', title: '官网方案' }]);
    assert.doesNotMatch(JSON.stringify(result), /不应发送的未选择正文|另一篇同名/);
    assert.match(result.systemPrompt, /不是指令/);
  }
  workspace.write('资料/方案.md', '后来保存的新内容');
  const latest = buildProjectChatRequest(workspace, state, { ...payload, references: ['资料/方案.md'] });
  assert.equal(JSON.parse(latest.messages.at(-1).content).sources[0].text, '后来保存的新内容');
});

test('project references refuse private, missing, malformed, oversized and out-of-vault notes', t => {
  const { workspace, state, payload } = fixture(t);
  const ask = references => buildProjectChatRequest(workspace, state, { ...payload, references });
  for (const file of ['70_Finance/秘密.md', '敏感.md']) assert.throws(() => ask([file]), /受保护|敏感/);
  assert.throws(() => ask(['不存在.md']), /ENOENT/);
  assert.throws(() => ask(['../outside.md']), /非法路径/);
  assert.throws(() => ask(Array(9).fill('资料/方案.md')), /8 篇/);
  workspace.write('元数据错误.md', '---\ntitle: [broken\n---\n正文');
  assert.throws(() => ask(['元数据错误.md']));
  workspace.write('很长.md', 'a'.repeat(40001));
  assert.throws(() => ask(['很长.md']), /40,000/);
  workspace.write('第一篇.md', 'a'.repeat(31000)); workspace.write('第二篇.md', 'b'.repeat(31000));
  assert.throws(() => ask(['第一篇.md', '第二篇.md']), /60,000/);
  if (process.platform !== 'win32') {
    fs.symlinkSync(path.join(workspace.root, '资料/方案.md'), path.join(workspace.root, '链接.md'));
    assert.throws(() => ask(['链接.md']), /符号链接/);
  }
});

test('historical source numbers keep their original note when references change and metadata survives restart', t => {
  const { root, workspace, state, payload } = fixture(t);
  const sources = [{ id: 'N1', title: '旧方案', path: '资料/方案.md', text: '不要持久化正文' }];
  const messages = [{ role: 'user', content: '旧问题', references: sources }, { role: 'assistant', content: '旧结论 [N1]', sources }];
  const historyDir = path.join(root, 'app-data');
  createProjectChatStore(historyDir).set(root, 'p1', messages);
  const restored = createProjectChatStore(historyDir).get(root, 'p1');
  assert.equal(restored[0].references[0].path, '资料/方案.md');
  assert.equal(restored[1].sources[0].id, 'N1');
  assert.doesNotMatch(JSON.stringify(restored), /不要持久化正文/);
  const result = buildProjectChatRequest(workspace, state, { ...payload, messages: [...restored, ...payload.messages], references: ['其他/方案.md'] });
  assert.equal(result.sources[0].id, 'N1');
  assert.equal(result.sources[0].path, '其他/方案.md');
  assert.equal(result.messages[1].content, '旧结论 [旧方案](<资料/方案.md>)');
  assert.doesNotMatch(JSON.parse(result.messages.at(-1).content).sources[0].text, /客户要求/);
  assert.equal(modelMessages(restored)[1].content, result.messages[1].content);
  assert.deepEqual(cleanSources([{ id: 'N1', title: 'bad', path: '../outside.md' }, { id: 'N2', path: '/outside.md' }]), []);
  assert.deepEqual(createProjectChatStore(historyDir).get('/other-vault', 'p1'), []);
});

test('saved project answers retain source links relative to the actual output note', t => {
  const { workspace } = fixture(t);
  const result = workspace.createAiNote({ title: '排期分析', body: '周五交付 [N1]。', sources: [{ id: 'N1', title: '官网方案', path: '资料/方案.md' }] });
  const body = workspace.read(result.path);
  assert.match(body, /周五交付 \[官网方案\]\(<\.\.\/资料\/方案.md>\)/);
  assert.match(body, /## 引用笔记\n- \[N1\] \[官网方案\]/);
});

test('shared @ picker ignores stale searches and composition, blocks premature send, and enforces the reference limit', async () => {
  assert.deepEqual(mentionAt('比较 @方案', 6), { from: 3, to: 6, query: '方案' });
  assert.equal(mentionAt('第一行 @方案\n另一行', 12), null);
  const input = { value: '@旧', selectionStart: 2, ownerDocument: {}, focus() {}, setRangeText(text, from, to) { this.value = this.value.slice(0, from) + text + this.value.slice(to); this.selectionStart = from + text.length; } };
  const box = { isConnected: true, hidden: true, innerHTML: '', querySelectorAll: () => [], querySelector: () => null };
  const pending = [], chosen = [], errors = [], selected = [];
  const picker = createPicker({ input, box, search: query => new Promise(resolve => pending.push({ query, resolve })), selected: () => selected,
    onChoose: item => chosen.push(item), onDraft() {}, onError: message => errors.push(message) });
  const first = picker.update();
  let prevented = 0;
  const enter = { key: 'Enter', preventDefault() { prevented++; }, stopPropagation() {} };
  assert.equal(picker.handleKey({ ...enter, isComposing: true }), false);
  assert.equal(picker.handleKey(enter), true);
  assert.equal(prevented, 1); assert.equal(chosen.length, 0);
  input.value = '@新';
  const second = picker.update();
  pending[1].resolve([{ path: '新.md', title: '新方案' }]); await second;
  pending[0].resolve([{ path: '旧.md', title: '旧方案' }]); await first;
  assert.doesNotMatch(box.innerHTML, /旧方案/);
  selected.push(...Array.from({ length: 8 }, (_, index) => ({ path: `${index}.md` })));
  picker.handleKey(enter); assert.equal(chosen.length, 0); assert.match(errors[0], /8 篇/);
  selected.length = 0; picker.handleKey(enter); assert.equal(chosen[0].path, '新.md');
  input.value = '@'; input.selectionStart = 1;
  const stale = picker.update(); picker.destroy();
  pending[2].resolve([{ path: '跨库.md', title: '跨库' }]); await stale;
  assert.equal(box.hidden, true); assert.doesNotMatch(box.innerHTML, /跨库/);
});
