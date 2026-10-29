const test = require('node:test');
const assert = require('node:assert/strict');
const run = async (text, from, to, command, options) => {
  const { formatEdit } = await import('../src/markdown-tools.mjs');
  const change = formatEdit(text, from, to, command, options);
  return { change, text: text.slice(0,change.from) + change.insert + text.slice(change.to) };
};
test('format buttons wrap the selected text and toggle the same format without touching surrounding text', async () => {
  const bold = await run('前 中文 后', 2, 4, 'bold');
  assert.equal(bold.text, '前 **中文** 后');
  assert.equal((await run(bold.text, bold.change.anchor, bold.change.head, 'bold')).text, '前 中文 后');
});
test('line formats respect multiline selection boundaries, empty first line and Windows line endings', async () => {
  assert.equal((await run('甲\n乙\n丙',0,4,'list')).text,'- 甲\n- 乙\n丙');
  assert.equal((await run('\n正文',0,0,'h1')).text,'# \n正文');
  assert.equal((await run('甲\r\n乙\r\n丙',0,4,'quote')).text,'> 甲\r\n> 乙\r\n丙');
  assert.equal((await run('## 标题',3,5,'h1')).text,'# 标题');
});
test('image insertion preserves paths with spaces and escapes label delimiters', async () => {
  const result = await run('',0,0,'image',{label:'图]片',url:'images/my photo.png'});
  assert.equal(result.text,'![图\\]片](<images/my photo.png>)');
});
