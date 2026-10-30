const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const model = require('../src/note-details-model');
const { createWorkspace } = require('../electron/workspace');

test('metadata edits preserve BOM, CRLF, comments, unknown fields and every body byte', () => {
  const body = '\r\n# 正文\r\n\r\n```yaml\r\na: b\r\n```\r\n';
  const source = '\uFEFF---\r\ntitle: "旧标题"\r\n# 注释\r\ncustom:\r\n  owner: 团队\r\n---\r\n' + body;
  const parts = model.splitMetadata(source);
  assert.equal(parts.body, body);
  const changed = model.replaceMetadata(source, parts.yaml.replace('旧标题', '新标题') + '\r\ntags: [学习, 工作]');
  assert.equal(model.splitMetadata(changed).body, body);
  assert.ok(changed.startsWith('\uFEFF---\r\n'));
  assert.match(changed, /# 注释\r\ncustom:\r\n  owner: 团队/);
  assert.equal(model.validateMetadata(model.splitMetadata(changed).yaml).custom.owner, '团队');
  assert.equal(model.replaceMetadata(changed, ''), '\uFEFF' + body);
  assert.equal(model.replaceMetadata('# 没有元数据\n正文', 'title: 新建'), '---\ntitle: 新建\n---\n# 没有元数据\n正文');
  assert.equal(model.splitMetadata('---\n---\n正文').body, '正文');
});

test('invalid or ambiguous YAML is rejected before touching the document', () => {
  for (const yaml of ['tags: [unfinished', 'key: 1\nkey: 2', '- list', 'scalar', 'a: b\n---\nx: y', 'a'.repeat(65537)]) assert.throws(() => model.replaceMetadata('# original', yaml));
  assert.throws(() => model.replaceMetadata('---\ntitle: missing end\n# body', 'title: fix'), /缺少结束/);
  assert.deepEqual(model.validateMetadata('aliases: [别名]\ncustom: {owner: 团队}'), { aliases: ['别名'], custom: { owner: '团队' } });
});

test('link extraction skips metadata, code, images, comments and external URLs but includes lists and tables', () => {
  const source = '---\nrelated: "[[metadata]]"\n---\n[[Next|名字]] [普通链接](Other.md#section) `[[inline]]` ![[image.png]] ![photo](photo.md)\n' +
    '\n```md\n[[code]]\n[code](code.md)\n```\n\n<!-- [[comment]] -->\n\n- [[List]]\n\n| 标题 |\n| --- |\n| [[Table]] |\n\n[web](https://example.com/a.md) [anchor](#heading) \\[[escaped]]';
  const links = model.extractLinks(source).filter(link => link.target !== '#heading');
  assert.deepEqual(links.map(link => link.target), ['Next', 'Other.md#section', 'List', 'Table']);
});

test('relations resolve relative paths, encoded paths and aliases, deduplicate counts and flag ambiguous names', () => {
  const files = [
    { path: 'Work/Current.md', content: '[[Next|下一篇]]\n[next](Next.md)\n[[别名]]\n[space](../My%20Note.md#x)\n[[Dup]]\n[[Missing]]\n[bad](../../escape.md)' },
    { path: 'Work/Next.md', content: '[[Current]]\n[再次](Current.md#section)' },
    { path: 'Archive/Other.md', content: '---\ntitle: 其他\naliases: [别名]\n---\n[[Work/Current]]' },
    { path: 'My Note.md', content: '# Space' },
    { path: 'A/Dup.md', content: '' }, { path: 'B/Dup.md', content: '' },
  ];
  const result = model.buildRelations(files, 'Work/Current.md');
  assert.equal(result.outgoing.find(link => link.path === 'Work/Next.md').count, 2);
  assert.equal(result.outgoing.find(link => link.path === 'Archive/Other.md').title, '其他');
  assert.ok(result.outgoing.some(link => link.path === 'My Note.md'));
  assert.equal(result.outgoing.find(link => link.target === 'Dup').status, 'ambiguous');
  assert.equal(result.outgoing.find(link => link.target === 'Missing').status, 'missing');
  assert.equal(result.outgoing.find(link => link.target === '../../escape.md').status, 'missing');
  assert.deepEqual(result.incoming.map(link => [link.path, link.count]), [['Work/Next.md', 2], ['Archive/Other.md', 1]]);
});

test('inspector reads real files, uses current unsaved text, notices disk changes and excludes system fixtures', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-note-details-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = createWorkspace(root);
  workspace.write('Current.md', '# 原文'); workspace.write('Other.md', '[[Current]]');
  workspace.createFolder('', 'Templates'); workspace.write('Templates/example.md', '[[Current]]');
  let result = await workspace.inspect('Current.md', '[[Other]]\n[[未创建]]');
  assert.equal(result.root, workspace.root);
  assert.equal(result.incoming.length, 1);
  assert.equal(result.outgoing.find(link => link.path === 'Other.md').status, 'resolved');
  assert.equal(workspace.read('Current.md'), '# 原文');
  workspace.write('Other.md', '# removed link, different size');
  result = await workspace.inspect('Current.md');
  assert.equal(result.incoming.length, 0);
  await assert.rejects(workspace.inspect('../escape.md'), /非法路径/);
  await assert.rejects(workspace.inspect('Current.md', 42), /2 MB/);
  if (process.platform !== 'win32') {
    fs.symlinkSync(path.join(root, 'Other.md'), path.join(root, 'link.md'));
    await assert.rejects(workspace.inspect('link.md'), /符号链接/);
  }
});
