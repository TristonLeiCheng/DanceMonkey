const { withLinks } = require('./note-references');
const { splitMetadata } = require('./note-details-model');

function createEdit(base, answer, mode, selection) {
  if (typeof base !== 'string' || typeof answer !== 'string' || !answer.trim()) throw new Error('没有可写入的回答。');
  const eol = base.includes('\r\n') ? '\r\n' : '\n';
  const text = answer.replace(/\r?\n/g, eol).trim();
  let from, to, insert = text;
  if (mode === 'append') {
    from = to = base.length;
    insert = (base ? (base.endsWith(eol + eol) ? '' : base.endsWith(eol) ? eol : eol + eol) : '') + text + eol;
  } else if (mode === 'body') {
    const parts = splitMetadata(base);
    if (parts.malformed) throw new Error('元数据格式有误，请修复后再替换正文。');
    from = base.length - parts.body.length; to = base.length; insert += eol;
  } else if (mode === 'selection') {
    if (!selection || !Number.isInteger(selection.from) || !Number.isInteger(selection.to) || selection.from < 0 || selection.to <= selection.from || selection.to > base.length) throw new Error('请先选中正文，再向 AI 提问。');
    const parts = splitMetadata(base);
    if (parts.malformed || selection.from < base.length - parts.body.length) throw new Error('选区包含元数据，请只选择正文。');
    from = selection.from; to = selection.to;
  } else throw new Error('未知的写入方式。');
  return { base, next: base.slice(0, from) + insert + base.slice(to), from, to, insert, removed: base.slice(from, to) };
}
function assertFresh(edit, current) {
  if (current !== edit.base) throw new Error('笔记在预览后已变化，请重新生成修改预览。');
}
function conversationHistory(messages, path) {
  // Source numbers belong to one answer; old citations must retain their paths.
  return messages.filter(item => item.content).slice(-12).map(item => ({ role: item.role,
    content: item.role === 'assistant' ? withLinks(item.content, item.sources || [], path) : item.content }));
}
module.exports = { createEdit, assertFresh, withLinks, conversationHistory };
