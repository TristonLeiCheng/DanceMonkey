const svg = paths => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const icons = {
  quote: svg('<path d="M10 7H4v6h6V7Zm10 0h-6v6h6V7ZM10 13c0 4-3 5-5 5m15-5c0 4-3 5-5 5"/>'),
  list: svg('<path d="M9 6h12M9 12h12M9 18h12"/><circle cx="3" cy="6" r=".7"/><circle cx="3" cy="12" r=".7"/><circle cx="3" cy="18" r=".7"/>'),
  task: svg('<rect x="3" y="4" width="17" height="17" rx="3"/><path d="m7 12 3 3 7-7"/>'),
  link: svg('<path d="m10 13 4-4m-5 6-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 2 2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"/>'),
  image: svg('<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 5-5 4 4 4-7 5 8"/>'),
  table: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M3 14h18M9 4v16M15 4v16"/>'),
  undo: svg('<path d="m8 4-5 5 5 5M3 9h11a6 6 0 0 1 0 12"/>'),
  redo: svg('<path d="m16 4 5 5-5 5m5-5H10a6 6 0 0 0 0 12"/>'),
};
const groups = [
  [['undo', '撤销', icons.undo], ['redo', '重做', icons.redo]],
  [['h1', '一级标题', 'H₁'], ['h2', '二级标题', 'H₂'], ['bold', '加粗', '<b>B</b>'], ['italic', '斜体', '<i>I</i>'], ['strike', '删除线', '<s>S</s>']],
  [['quote', '引用', icons.quote], ['list', '无序列表', icons.list], ['task', '任务列表', icons.task], ['code', '代码块', '&lt;/&gt;']],
  [['link', '插入链接', icons.link], ['image', '插入图片', icons.image], ['table', '插入表格', icons.table]],
];
export function toolbar(disabled = false) {
  return `<div class="md-formatbar" role="group" aria-label="Markdown 编辑工具">${groups.map(group => `<div class="md-tool-group">${group.map(([action, label, icon]) => `<button type="button" class="md-format-button" data-md-command="${action}" aria-label="${label}" title="${label}" ${disabled ? 'disabled' : ''}>${icon}</button>`).join('')}</div>`).join('')}</div>`;
}
// Return one reversible replacement and its new selection, shared by both editors.
export function formatEdit(text, from, to, command, options = {}) {
  const selected = text.slice(from, to), eol = text.includes('\r\n') ? '\r\n' : '\n';
  const edit = (start, end, insert, anchor = start, head = start + insert.length) => ({ from: start, to: end, insert, anchor, head });
  const wrappers = { bold: '**', italic: '*', strike: '~~' };
  if (wrappers[command]) {
    const mark = wrappers[command];
    if (from >= mark.length && text.slice(from - mark.length, from) === mark && text.slice(to, to + mark.length) === mark) return edit(from - mark.length, to + mark.length, selected);
    const value = selected || '文字';
    return edit(from, to, mark + value + mark, from + mark.length, from + mark.length + value.length);
  }
  if (['h1', 'h2', 'quote', 'list', 'task'].includes(command)) {
    const start = from === 0 ? 0 : text.lastIndexOf('\n', from - 1) + 1;
    const last = to > from && text[to - 1] === '\n' ? to - 1 : to;
    const next = text.indexOf('\n', last), end = next < 0 ? text.length : next;
    const lines = text.slice(start, end).split(eol);
    const prefix = { h1: '# ', h2: '## ', quote: '> ', list: '- ', task: '- [ ] ' }[command];
    const remove = lines.every(line => line.startsWith(prefix));
    const result = lines.map(line => remove ? line.slice(prefix.length) : prefix + line.replace(command.startsWith('h') ? /^#{1,6}\s+/ : /^(?!)/, '')).join(eol);
    return edit(start, end, result);
  }
  if (command === 'link' || command === 'image') {
    const label = (options.label || selected || (command === 'image' ? '图片说明' : '链接文字')).replace(/\r?\n/g, ' ');
    const url = options.url ? `<${options.url}>` : command === 'image' ? '图片路径' : 'https://';
    const pre = `${command === 'image' ? '!' : ''}[${label.replace(/\]/g, '\\]')}](`;
    return edit(from, to, pre + url + ')', from + pre.length, from + pre.length + url.length);
  }
  if (command === 'table' || command === 'code') {
    const before = from && text[from - 1] !== '\n' ? eol + eol : '';
    const after = to < text.length && text[to] !== '\n' ? eol + eol : eol;
    const body = command === 'table' ? ['| 列一 | 列二 |', '| --- | --- |', '| 内容 | 内容 |'].join(eol) : '```' + eol + (selected || '代码') + eol + '```';
    const anchor = from + before.length + (command === 'code' ? 3 + eol.length : 0);
    return edit(from, to, before + body + after, anchor, command === 'code' ? anchor + (selected || '代码').length : anchor);
  }
  return null;
}
export function applyTextarea(editor, command, options) {
  editor.focus();
  if (command === 'undo' || command === 'redo') { document.execCommand(command); return; }
  const change = formatEdit(editor.value, editor.selectionStart, editor.selectionEnd, command, options);
  if (!change) return;
  editor.setSelectionRange(change.from, change.to);
  if (!document.execCommand('insertText', false, change.insert)) {
    editor.setRangeText(change.insert, change.from, change.to, 'end'); editor.dispatchEvent(new Event('input', { bubbles: true }));
  }
  editor.setSelectionRange(change.anchor, change.head);
}
export function askDestination(root, image, label = '') {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog'); dialog.className = 'md-insert-dialog';
    dialog.innerHTML = `<form><h2>${image ? '插入图片' : '插入链接'}</h2><label>${image ? '图片说明' : '链接文字'}<input name="label" autocomplete="off"></label><label>${image ? '图片路径或网址' : '链接网址'}<input name="url" required autocomplete="off" placeholder="${image ? 'images/photo.png 或 https://…' : 'https://…'}"></label>${image ? '<p>本地图片使用相对于当前文档的路径。</p>' : ''}<div><button type="button" data-cancel>取消</button><button type="submit">插入</button></div></form>`;
    dialog.querySelector('[name="label"]').value = label;
    let result = null;
    dialog.querySelector('form').onsubmit = event => {
      event.preventDefault();
      const input = dialog.querySelector('[name="url"]'), url = input.value.trim();
      if (!url || /[<>\r\n]/.test(url)) { input.setCustomValidity('请输入有效的路径或网址，不包含换行或尖括号'); input.reportValidity(); return; }
      result = { url, label: dialog.querySelector('[name="label"]').value }; dialog.close();
    };
    dialog.querySelector('[name="url"]').oninput = event => event.target.setCustomValidity('');
    dialog.querySelector('[data-cancel]').onclick = () => dialog.close();
    dialog.onclose = () => { dialog.remove(); resolve(result); };
    root.append(dialog); dialog.showModal(); dialog.querySelector('[name="url"]').focus();
  });
}
