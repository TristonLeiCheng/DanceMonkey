import model from './note-ai-model.js';
import noteReferences from './note-references.js';

const sessions = new Map();
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const markdown = text => window.DOMPurify.sanitize(window.marked.parse(text, { gfm: true }));
const { withLinks } = model;
export const conversationHistory = model.conversationHistory;
export function create({ api, root, path, getText, getSavedText, getSelection, applyEdit, canEdit, save, openNote, flush = () => {} }) {
  const key = `${root}\0${path}`;
  let state = sessions.get(key);
  if (!state) {
    state = { messages: [], draft: '', references: [], revision: 0 }; sessions.set(key, state);
    if (sessions.size > 40) sessions.delete(sessions.keys().next().value);
  }
  let host, disposed = false, busy = false, requestId = '', partial = '', pending = '', notice = '', referencePicker, dialog, lastEdit = state.lastEdit, streamedSources = [];
  const available = Boolean(api?.noteAi?.chat);
  let loading = false, historyError = false;
  const unsubscribe = api?.noteAi?.onChunk(({ requestId: id, chunk, sources }) => {
    if (disposed || id !== requestId) return;
    if (sources) streamedSources = sources;
    if (typeof chunk !== 'string') return;
    partial += chunk;
    const body = host?.querySelector('[data-nai-stream]');
    if (body) { body.innerHTML = markdown(partial); body.closest('.nai-messages').scrollTop = body.closest('.nai-messages').scrollHeight; }
  });
  const status = text => { notice = text; const el = host?.querySelector('[data-nai-status]'); if (el) el.textContent = text; };
  function adoptHistory(history) {
    state.messages = history.messages; state.references = history.references; state.revision = history.revision;
  }
  async function loadHistory() {
    if (!api?.noteAi?.history || disposed) return;
    loading = true; historyError = false; render();
    try {
      const history = await api.noteAi.history({ root, path });
      if (!disposed) { adoptHistory(history); notice = ''; }
    } catch (error) { if (!disposed) { historyError = true; status(error.message); } }
    finally { loading = false; if (!disposed) render(); }
  }
  async function newConversation() {
    if (busy || loading || historyError) return;
    loading = true; render();
    try {
      if (api?.noteAi?.clear) {
        const history = await api.noteAi.clear({ root, path, revision: state.revision });
        if (disposed) return;
        adoptHistory(history);
      } else { state.messages = []; state.references = []; }
      status('已开始新对话，当前笔记的旧记录已清空。');
    } catch (error) { if (!disposed) status(error.message); }
    finally { loading = false; if (!disposed) render(); }
  }
  function render() {
    if (!host?.isConnected || disposed) return;
    referencePicker?.destroy();
    host.innerHTML = `<div class="nai-context"><strong>当前笔记 · ${esc(path.split('/').at(-1))}</strong><p>发送时包含当前编辑内容和你用 @ 选中的笔记，提交到已配置的 AI 服务。参考笔记读取已保存版本。</p></div>
      <div class="nai-heading"><span>笔记助手</span><button type="button" data-nai="reload" ${busy || loading ? 'disabled' : ''}>重新载入</button><button type="button" data-nai="clear" ${busy || loading || historyError ? 'disabled' : ''}>新对话</button></div>
      <div class="nai-messages" role="log" aria-label="笔记 AI 对话" tabindex="0">${state.messages.map((item, index) => `<article class="nai-message ${item.role}"><strong>${item.role === 'user' ? '你' : 'AI'}</strong><div class="nai-markdown">${item.role === 'user' ? esc(item.content) : markdown(item.content)}</div>${item.role === 'assistant' ? `<div class="nai-sources">${item.sources.map(source => `<button type="button" data-nai="source" data-message="${index}" data-source="${esc(source.id)}" title="${esc(source.path)}">[${esc(source.id)}] ${esc(source.title)}</button>`).join('')}</div>${item.incomplete ? '<p>未完整生成 · 部分回答</p>' : ''}${item.content ? `<button type="button" data-nai="preview" data-message="${index}">预览写入…</button>` : '<p>回答未完成，可以重新提问。</p>'}` : ''}</article>`).join('')}
        ${busy ? `<article class="nai-message user"><strong>你</strong><div>${esc(pending)}</div></article><article class="nai-message assistant"><strong>AI</strong><div class="nai-markdown" data-nai-stream>${partial ? markdown(partial) : '正在阅读笔记…'}</div></article>` : ''}
        ${!state.messages.length && !busy ? '<div class="nai-empty">围绕当前笔记提问，或输入 @ 引用其他笔记。<div><button type="button" data-nai="prompt">总结当前笔记的要点</button></div></div>' : ''}</div>
      <div class="nai-references" aria-label="已选参考笔记">${state.references.map((item, index) => `<button type="button" data-nai="remove" data-index="${index}" title="移除 ${esc(item.path)}" ${busy ? 'disabled' : ''}>@ ${esc(item.title)} ×</button>`).join('')}</div>
      <form class="nai-composer"><label class="visually-hidden" for="nai-question">向当前笔记提问</label><textarea id="nai-question" rows="3" maxlength="8000" placeholder="问当前笔记… 输入 @ 引用其他笔记" ${!available || busy || loading || historyError ? 'disabled' : ''}>${esc(state.draft)}</textarea><div class="nai-picker" role="listbox" aria-label="选择引用笔记" hidden></div><div class="nai-composer-tools"><button type="button" data-nai="mention" ${!available || busy || loading || historyError ? 'disabled' : ''}>@ 引用笔记</button><button type="${busy ? 'button' : 'submit'}" ${busy ? 'data-nai="stop"' : ''} ${!available || loading || historyError ? 'disabled' : ''}>${busy ? '停止' : '发送'}</button></div></form>
      <div class="nai-status" role="status" data-nai-status>${esc(!available ? '请在桌面版中配置 AI 后使用。' : loading ? '正在读取历史对话…' : notice)}</div>${lastEdit ? '<button type="button" data-nai="undo">撤销上次 AI 写入</button>' : ''}`;
    host.querySelector('form').onsubmit = event => { event.preventDefault(); void send(); };
    const input = host.querySelector('textarea');
    referencePicker = noteReferences.createPicker({ input, box: host.querySelector('.nai-picker'),
      search: query => api.noteAi.list({ root, path, query }), selected: () => state.references,
      disabled: () => busy || loading || historyError || !available || disposed,
      onDraft: value => { state.draft = value; }, onError: status, optionAttribute: 'data-nai',
      onChoose: (item, value, cursor) => { state.draft = value; state.references.push(item); render(); const next = host.querySelector('textarea'); next.focus(); next.setSelectionRange(cursor, cursor); } });
    input.oninput = () => { state.draft = input.value; void referencePicker.update(); };
    input.onkeydown = event => {
      if (event.isComposing) return;
      if (referencePicker.handleKey(event)) return;
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault(); event.stopPropagation();
        void send();
      }
    };
    host.onclick = event => {
      const button = event.target.closest('[data-nai]');
      if (event.target.closest('a')) event.preventDefault();
      if (!button) return;
      const action = button.dataset.nai;
      if (action === 'clear') void newConversation();
      if (action === 'reload' && !busy && !loading) void loadHistory();
      if (action === 'prompt') { state.draft = button.textContent; render(); host.querySelector('textarea').focus(); }
      if (action === 'stop') { status('正在停止…'); void api.noteAi.cancel(requestId).catch(error => status(error.message)); }
      if (action === 'mention') referencePicker.trigger();
      if (action === 'remove' && !busy) { state.references.splice(Number(button.dataset.index), 1); render(); }
      if (action === 'preview') showPreview(state.messages[Number(button.dataset.message)]);
      if (action === 'source') {
        const source = state.messages[Number(button.dataset.message)].sources.find(item => item.id === button.dataset.source);
        if (source.path === path) { status('来源为当前笔记。'); return; }
        void save().then(() => { if (!disposed) return openNote(source.path); }).catch(error => status(error.message));
      }
      if (action === 'undo') void undoWrite();
    };
    const messages = host.querySelector('.nai-messages');
    messages.scrollTop = messages.scrollHeight;
  }
  function hidePicker() { referencePicker?.hide(); }
  async function send() {
    if (!available || busy || loading || historyError || !state.draft.trim() || disposed) return;
    let snapshot, selection;
    try { flush(); snapshot = getText(); selection = getSelection(); } catch (error) { status(error.message); return; }
    const question = state.draft.trim(); pending = question; busy = true; partial = ''; streamedSources = []; notice = ''; hidePicker();
    requestId = `note-ai-${crypto.randomUUID()}`;
    const references = state.references.map(item => item.path);
    const history = conversationHistory(state.messages, path);
    render();
    try {
      const result = await api.noteAi.chat({ root, path, content: snapshot, selection, question, references, history, requestId, revision: state.revision });
      if (disposed) return;
      if (result.history) adoptHistory(result.history);
      else state.messages.push({ role: 'user', content: question }, { role: 'assistant', content: result.text, sources: result.sources, snapshot, selection });
      state.draft = '';
    } catch (error) {
      if (!disposed) {
        let recovered = false;
        if (api.noteAi.history) {
          try {
            const history = await api.noteAi.history({ root, path });
            if (disposed) return;
            adoptHistory(history); recovered = true;
          } catch { historyError = true; }
        }
        if (partial.trim() && !recovered) {
          state.messages.push({ role: 'user', content: question }, { role: 'assistant', content: partial, sources: streamedSources, snapshot, selection, incomplete: true });
          state.draft = '';
        }
        if (partial.trim()) state.draft = '';
        status(error.message || '生成失败，请重试。');
      }
    } finally {
      busy = false; requestId = ''; pending = ''; partial = '';
      if (!disposed) render();
    }
  }
  function showPreview(message) {
    try {
      if (!canEdit()) throw new Error('当前无法写入，请切回编辑模式或等待保存操作完成。');
      flush();
      const base = getText(); let mode = 'append', edit;
      dialog?.remove(); dialog = document.createElement('dialog'); dialog.className = 'nai-preview';
      dialog.innerHTML = `<form><h2>预览 AI 写入</h2><p>${esc(path)} · 确认后写入，可撤销</p><label>写入方式<select aria-label="AI 写入方式"><option value="append">追加到笔记末尾</option><option value="selection" ${!message.selection || message.selection.from === message.selection.to ? 'disabled' : ''}>替换提问时的选区</option><option value="body">替换正文（保留元数据）</option></select></label><label>待写入内容<textarea aria-label="待写入的 AI 回答" spellcheck="false"></textarea></label><div class="nai-diff"><section><h3>删除的内容</h3><pre data-nai-before></pre></section><section><h3>新增的内容</h3><pre data-nai-after></pre></section></div><p role="alert" data-nai-error></p><footer><button type="button" data-nai-cancel>取消</button><button type="submit">确认写入</button></footer></form>`;
      const modal = dialog, input = modal.querySelector('textarea'), form = modal.querySelector('form'), errorBox = modal.querySelector('[data-nai-error]');
      input.value = withLinks(message.content, message.sources, path);
      const update = () => {
        try {
          if (mode !== 'append' && base !== message.snapshot) throw new Error('笔记在提问后已变化。请重新提问后替换，或选择追加到末尾。');
          edit = model.createEdit(base, input.value, mode, message.selection);
          modal.querySelector('[data-nai-before]').textContent = edit.removed || '（无删除）';
          modal.querySelector('[data-nai-after]').textContent = edit.insert;
          errorBox.textContent = ''; form.querySelector('[type="submit"]').disabled = false;
        } catch (error) { edit = null; errorBox.textContent = error.message; form.querySelector('[type="submit"]').disabled = true; }
      };
      modal.querySelector('select').onchange = event => { mode = event.target.value; update(); }; input.oninput = update;
      modal.querySelector('[data-nai-cancel]').onclick = () => modal.close();
      modal.onclose = () => { modal.remove(); if (dialog === modal) dialog = null; };
      form.onsubmit = async event => {
        event.preventDefault(); if (!edit) return;
        try {
          if (disposed || !canEdit()) throw new Error('当前文档不可写，请重新打开预览。');
          flush(); model.assertFresh(edit, getText());
          form.querySelector('[type="submit"]').disabled = true;
          await save(); // Flush pending editor saves before comparing the disk snapshot.
          await api.noteAi.validate({ root, path, expected: getSavedText() });
          if (disposed || !canEdit()) throw new Error('文档已变化，请重新打开预览。');
          model.assertFresh(edit, getText());
          applyEdit(edit); lastEdit = state.lastEdit = edit; modal.close(); render();
          await save(); if (!disposed) status('已写入并保存，可撤销上次 AI 写入，或在编辑器中使用 ⌘/Ctrl+Z。');
        } catch (error) { if (modal.isConnected) { errorBox.textContent = error.message; form.querySelector('[type="submit"]').disabled = false; } else if (!disposed) status(`内容已保留在编辑器中：${error.message}`); }
      };
      (document.getElementById('root') || document.body).append(modal); update(); modal.showModal();
    } catch (error) { status(error.message); }
  }
  async function undoWrite() {
    try {
      if (!lastEdit || !canEdit()) return;
      flush();
      if (getText() !== lastEdit.next) throw new Error('写入后已有其他编辑，请在编辑器中使用 ⌘/Ctrl+Z 逐步撤销。');
      applyEdit({ base: lastEdit.next, next: lastEdit.base, from: lastEdit.from, to: lastEdit.from + lastEdit.insert.length, insert: lastEdit.removed });
      lastEdit = state.lastEdit = null; render(); await save(); if (!disposed) status('已撤销 AI 写入并保存。');
    } catch (error) { if (!disposed) status(error.message); }
  }
  void loadHistory();
  return {
    mount(element) { host = element; render(); },
    unmount() { host = null; hidePicker(); },
    destroy() { disposed = true; referencePicker?.destroy(); unsubscribe?.(); dialog?.remove(); if (requestId) void api.noteAi.cancel(requestId).catch(() => {}); host = null; },
  };
}
