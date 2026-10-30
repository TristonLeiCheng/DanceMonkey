import model from './note-details-model.js';
export { model };

const drafts = new Map(), tabs = new Map();
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const canonical = text => text.replace(/\r\n/g, '\n');
const icons = {
  metadata: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  links: '<path d="m10 13 4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M16 8l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"/>',
};
export function markup() {
  return `<aside class="note-details-panel" id="note-details-panel" aria-label="文档详情" hidden></aside>
    <nav class="note-details-rail" aria-label="文档侧栏">${[['metadata', '信息', '文档信息与元数据'], ['links', '双链', '双链信息']].map(([tab, label, title]) =>
      `<button type="button" data-details-tab="${tab}" aria-label="${title}" title="${title}" aria-controls="note-details-panel" aria-expanded="false"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[tab]}</svg><span>${label}</span></button>`).join('')}</nav>`;
}

export function create({ host, path, root, getText, replaceText, inspect, save, openNote, onDraft = () => {} }) {
  const panel = host.querySelector('.note-details-panel'), rail = host.querySelector('.note-details-rail');
  const id = `${root}\0${path}`;
  const initial = model.splitMetadata(getText());
  let draft = drafts.get(id);
  if (!draft?.dirty) draft = { base: canonical(initial.yaml), yaml: canonical(initial.yaml), dirty: false };
  drafts.set(id, draft);
  let tab = tabs.get(id) || '', data, disposed = false, request = 0, saving = false, stale = false;
  const message = text => { const element = panel.querySelector('.note-details-message'); if (element) element.textContent = text; };
  const date = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未知';
  function renderMetadata() {
    panel.querySelector('.note-details-content').innerHTML = `<dl class="note-details-facts">
      <div><dt>文件</dt><dd title="${esc(path)}">${esc(path)}</dd></div><div><dt>创建</dt><dd>${date(data?.createdAt)}</dd></div><div><dt>更新</dt><dd>${date(data?.updatedAt)}</dd></div>
      <div><dt>字数</dt><dd data-details-count>${getText().length.toLocaleString()} 字符</dd></div></dl>
      <form class="note-metadata-form"><label for="note-metadata-yaml">文档元数据 <small>YAML</small></label>
        <p>字段保存在 Markdown 文件头部，格式正确时自动保存。可填写标题、标签、别名或自定义属性。</p>
        <textarea id="note-metadata-yaml" data-details-yaml aria-label="文档元数据 YAML" spellcheck="false" placeholder='title: "笔记标题"&#10;tags: []&#10;aliases: []'>${esc(draft.yaml)}</textarea>
        <div class="note-details-form-tools"><button type="button" data-details-template>插入常用字段</button><button type="button" data-details-reload>重新载入</button></div>
        <button type="submit" class="note-details-save" ${saving ? 'disabled' : ''}>${saving ? '保存中…' : '保存元数据'}</button><span class="note-details-draft-state">${draft.dirty ? '待保存' : '已与正文同步'}</span></form>`;
    const form = panel.querySelector('form'), input = form.querySelector('textarea');
    input.oninput = () => {
      draft.yaml = input.value; draft.dirty = canonical(draft.yaml) !== draft.base;
      form.querySelector('.note-details-draft-state').textContent = draft.dirty ? '待保存' : '已与正文同步';
      message(''); onDraft();
    };
    form.onsubmit = async event => {
      event.preventDefault();
      if (saving) return;
      saving = true; form.querySelector('[type="submit"]').disabled = true;
      try { flush(); await save(); if (!disposed) { await refresh(); message('元数据已保存'); } }
      catch (error) { if (!disposed) message(error.message || '元数据保存失败'); }
      finally {
        saving = false;
        const button = panel.querySelector('[type="submit"]'); if (button) { button.disabled = false; button.textContent = '保存元数据'; }
      }
    };
  }
  const linkRows = (items, incoming = false) => items.length ? items.map(item => {
    const resolved = incoming || item.status === 'resolved';
    return `<button type="button" class="note-details-link" ${resolved ? `data-details-path="${esc(item.path)}"` : 'disabled'}><strong>${esc(item.title || item.label || item.target)}</strong><small>${esc(item.path || item.target)}</small><span>${resolved ? (item.count > 1 ? `${item.count} 处引用` : '打开笔记 ↗') : item.status === 'ambiguous' ? '存在同名笔记，请使用完整路径' : '目标笔记尚未创建'}</span></button>`;
  }).join('') : '<p class="note-details-empty">暂无关联笔记</p>';
  function renderLinks() {
    panel.querySelector('.note-details-content').innerHTML = `<p class="note-details-help">支持 [[笔记名]]、[[路径|显示名]] 和 Markdown 笔记链接。</p>
      <section><h3>引用当前笔记 <span>${data?.incoming.length ?? '…'}</span></h3>${data ? linkRows(data.incoming, true) : '<p class="note-details-empty">正在查找引用…</p>'}</section>
      <section><h3>当前笔记引用 <span>${data?.outgoing.length ?? '…'}</span></h3>${data ? linkRows(data.outgoing) : ''}</section>
      ${data?.omitted || data?.unreadable ? `<p class="note-details-help">${data.omitted} 篇笔记超出扫描范围，${data.unreadable} 篇暂时无法读取；上方为当前可读取的结果。</p>` : ''}`;
  }
  function render() {
    panel.hidden = !tab;
    rail.querySelectorAll('[data-details-tab]').forEach(button => button.setAttribute('aria-expanded', String(button.dataset.detailsTab === tab)));
    if (!tab) return;
    panel.setAttribute('aria-label', tab === 'metadata' ? '文档信息与元数据' : '双链信息');
    panel.innerHTML = `<header><h2>${tab === 'metadata' ? '文档信息' : '双链信息'}</h2><button type="button" data-details-refresh aria-label="刷新文档信息" title="刷新">↻</button><button type="button" data-details-close aria-label="收起文档详情" title="收起">×</button></header><div class="note-details-message" role="status"></div><div class="note-details-content"></div>`;
    if (tab === 'metadata') renderMetadata(); else renderLinks();
  }
  function setTab(next) { tab = next; tabs.set(id, tab); render(); }
  async function refresh() {
    const current = ++request;
    try {
      const result = await inspect(getText());
      if (disposed || request !== current) return;
      data = result; stale = false;
      if (tab === 'links') renderLinks();
      else if (tab === 'metadata') {
        const values = panel.querySelectorAll('.note-details-facts dd');
        if (values.length) { values[1].textContent = date(data.createdAt); values[2].textContent = date(data.updatedAt); }
      }
      message('');
    } catch (error) { if (!disposed && request === current) message(error.message || '文档信息暂时无法读取，请刷新重试'); }
  }
  function flush() {
    if (!draft.dirty) return;
    try {
      const current = getText(), parts = model.splitMetadata(current);
      if (canonical(parts.yaml) !== draft.base) throw new Error('元数据已在正文中更改。请重新载入元数据后编辑，以免覆盖新的字段。');
      const next = model.replaceMetadata(current, draft.yaml);
      draft.base = canonical(model.splitMetadata(next).yaml); draft.yaml = draft.base; draft.dirty = false;
      replaceText(next); onDraft();
      const state = panel.querySelector('.note-details-draft-state'); if (state) state.textContent = '已与正文同步';
    } catch (error) { if (!disposed) { if (tab !== 'metadata') setTab('metadata'); message(error.message); } throw error; }
  }
  rail.onclick = event => {
    const button = event.target.closest('[data-details-tab]'); if (!button) return;
    event.stopPropagation(); setTab(tab === button.dataset.detailsTab ? '' : button.dataset.detailsTab);
    if (tab) { panel.querySelector('header button')?.focus(); void refresh(); }
  };
  panel.onclick = async event => {
    event.stopPropagation();
    if (event.target.closest('[data-details-close]')) { const previous = tab; setTab(''); rail.querySelector(`[data-details-tab="${previous}"]`)?.focus(); return; }
    if (event.target.closest('[data-details-refresh]')) { void refresh(); return; }
    if (event.target.closest('[data-details-reload]')) {
      const parts = model.splitMetadata(getText()); draft.base = canonical(parts.yaml); draft.yaml = draft.base; draft.dirty = false;
      renderMetadata(); message('已重新载入当前正文的元数据'); onDraft(); return;
    }
    if (event.target.closest('[data-details-template]')) {
      if (draft.yaml.trim()) { message('已有元数据，请直接编辑字段；常用字段只插入到空白区域。'); return; }
      const input = panel.querySelector('textarea'); input.value = `title: ${JSON.stringify(path.split('/').at(-1).replace(/\.md$/i, ''))}\ntags: []\naliases: []`;
      input.dispatchEvent(new Event('input')); input.focus(); return;
    }
    const link = event.target.closest('[data-details-path]');
    if (link) { try { await save(); if (!disposed) await openNote(link.dataset.detailsPath); } catch (error) { if (!disposed) message(error.message); } }
  };
  panel.onkeydown = event => {
    if (event.key === 'Escape') { event.stopPropagation(); const previous = tab; setTab(''); rail.querySelector(`[data-details-tab="${previous}"]`)?.focus(); }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault(); event.stopPropagation(); void save().then(() => message('已保存'), error => message(error.message));
    }
  };
  render(); if (tab) void refresh();
  return { flush, refresh, hasDraft: () => draft.dirty,
    onTextChanged() {
      if (disposed) return;
      const parts = model.splitMetadata(getText());
      if (!draft.dirty && canonical(parts.yaml) !== draft.base) {
        draft.base = canonical(parts.yaml); draft.yaml = draft.base;
        const input = panel.querySelector('textarea'); if (input) input.value = draft.yaml;
      }
      const count = panel.querySelector('[data-details-count]'); if (count) count.textContent = `${getText().length.toLocaleString()} 字符`;
      if (tab === 'links' && !stale) { stale = true; message('正文已变化，点击刷新更新双链'); }
    },
    destroy() { disposed = true; request++; rail.onclick = null; panel.onclick = null; panel.onkeydown = null; if (!draft.dirty) drafts.delete(id); },
  };
}
