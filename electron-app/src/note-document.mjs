import * as noteImages from './note-image-import.mjs';
window.DMNoteImages = noteImages;
import * as markdownTools from './markdown-tools.mjs';
window.DMMarkdownTools = markdownTools;
import { createMarkdownEditor } from './markdown-editor.mjs';
import * as noteDetails from './note-details.mjs';
window.DMNoteDetails = noteDetails;
window.DMMarkdownEditor = createMarkdownEditor;
if (location.hash === '#document') void start();
async function start() {
  const api = window.lumen, root = document.getElementById('root');
  const esc = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  let imageImport, editor, details, note, saved = '', saveTimer, previewTimer, queue = Promise.resolve(), paused = false, frozen = false, loading = false, closing = false;
  let mode = localStorage.getItem('dm-document-mode') || 'live';
  if (!['live', 'source', 'split', 'preview'].includes(mode)) mode = 'live';
  const status = text => { root.querySelector('[data-save-state]').textContent = text; };
  function error(message = '') {
    const banner = root.querySelector('.note-error'); banner.hidden = !message;
    banner.querySelector('span').textContent = message;
  }
  function renderPreview() {
    const text = editor.text().replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
    root.querySelector('.note-preview').innerHTML = window.DOMPurify.sanitize(window.marked.parse(text, { gfm: true }));
    noteImages.hydrateImages(root.querySelector('.note-preview'), src => api.note.image(src));
  }
  function refreshStatus() {
    const text = editor.text(), line = editor.view.state.doc.lineAt(editor.view.state.selection.main.head);
    root.querySelector('[data-count]').textContent = `${text.length.toLocaleString()} 字符 · ${editor.view.state.doc.lines} 行`;
    root.querySelector('[data-cursor]').textContent = `行 ${line.number}，列 ${editor.view.state.selection.main.head - line.from + 1}`;
    document.title = `${text === saved && !details?.hasDraft() ? '' : '● '}${note.path.split(/[\\/]/).pop()} — DM`;
    status(details?.hasDraft() ? '元数据待保存' : text === saved ? '已保存' : '待保存');
  }
  function save() {
    clearTimeout(saveTimer);
    queue = queue.catch(() => {}).then(async () => {
      await imageImport?.flush();
      try {
        details?.flush();
        const text = editor.text(); if (text === saved) return;
        status('保存中…');
        await api.note.write(text); saved = text; error(); refreshStatus();
      }
      catch (reason) { status('保存失败'); error(reason.message || '保存失败，请重试或另存为。'); throw reason; }
    });
    return queue;
  }
  const saveQuietly = () => { void save().catch(() => {}); };
  function onChange() {
    if (loading) return;
    refreshStatus(); details?.onTextChanged(); clearTimeout(previewTimer); previewTimer = setTimeout(renderPreview, 100);
    clearTimeout(saveTimer); if (!paused && !frozen) saveTimer = setTimeout(saveQuietly, 650);
  }
  function setMode(next) {
    mode = next; localStorage.setItem('dm-document-mode', next);
    root.querySelector('.note-body').dataset.mode = next;
    editor.setMode(next === 'live' ? 'live' : 'source');
    for (const button of root.querySelectorAll('[data-mode]')) button.setAttribute('aria-pressed', String(button.dataset.mode === next));
    root.querySelector('[data-mode-hint]').textContent = next === 'live' ? '输入 # 或 ## 即可设置标题 · Markdown 标记自动隐藏' : '源码保留所有 Markdown 标记';
    for (const button of root.querySelectorAll('[data-md-command]')) button.disabled = next === 'preview';
    renderPreview(); if (next !== 'preview') editor.focus();
  }
  async function reload() {
    if (paused || frozen) return;
    if (editor.text() !== saved && !confirm('重新读取会丢弃当前未保存内容。建议先另存一份。继续读取磁盘版本？')) return;
    root.inert = true; clearTimeout(saveTimer); await queue.catch(() => {}); loading = true;
    try {
      const fresh = await api.note.read(); saved = fresh.content; editor.replace(fresh.content);
      error(); setMode(mode); refreshStatus();
    } catch (reason) { error(reason.message); }
    finally { loading = false; root.inert = paused || frozen; }
  }
  try {
    note = await api.note.read(); saved = note.content;
    const theme = localStorage.getItem('lumen-workspace-theme') || 'light';
    const light = ['light', 'frost-yellow', 'frost-green', 'lavender'].includes(theme);
    root.className = `workspace-root note-document theme-${esc(theme)} ${light ? 'light' : ''}`;
    root.innerHTML = `<main class="note-frame">
      <header class="note-toolbar"><div class="note-identity" style="${window.DMNoteAppearance.style(note)}"><span class="note-mark" aria-hidden="true">${esc(window.DMNoteAppearance.get(note).emoji) || 'MD'}</span><div><h1>${esc(note.path.split(/[\\/]/).pop())}</h1></div></div>
        <nav class="note-modes" aria-label="编辑模式">${[['live', '实时预览'], ['source', '源码'], ['split', '分栏'], ['preview', '阅读']].map(([key, label]) => `<button type="button" data-mode="${key}" aria-pressed="${mode === key}">${label}</button>`).join('')}</nav>
        <button type="button" class="note-button" data-tasks>生成任务</button><button type="button" class="note-button" data-save title="⌘/Ctrl+S">保存</button><button type="button" class="note-button" data-copy>另存一份</button>
      </header>
      ${markdownTools.toolbar(mode === 'preview')}
      <div class="note-error" role="alert" hidden><span></span><button type="button" data-reload>重新读取磁盘版本</button><button type="button" data-copy>另存一份</button></div>
      <div class="note-workarea"><div class="note-body" data-mode="${mode}" style="${window.DMNoteAppearance.style(note)}"><div class="note-editor"></div><article class="ws-preview note-preview" aria-label="Markdown 阅读预览"></article></div>${noteDetails.markup()}</div>
      <footer class="note-footer"><span class="note-file-path" title="${esc(note.root + '/' + note.path)}" aria-label="文档路径">${esc(note.root + '/' + note.path)}</span><span class="note-save-state" data-save-state role="status">已保存</span><span data-count></span><span data-cursor></span><span class="note-mode-hint" data-mode-hint></span><button type="button" data-workspace>返回笔记库 ↗</button></footer>
    </main>`;
    editor = createMarkdownEditor(root.querySelector('.note-editor'), { content: saved, mode: mode === 'live' ? 'live' : 'source', onChange, onSave: saveQuietly, resolveImage: src => api.note.image(src) });
    details = noteDetails.create({ host: root.querySelector('.note-workarea'), path: note.path, root: note.root,
      getText: () => editor.text(), replaceText: text => { editor.replace(text); renderPreview(); },
      inspect: text => api.note.inspect(text), save, openNote: path => api.note.openLinked(path), onDraft: () => {
        refreshStatus(); clearTimeout(saveTimer);
        if (!paused && !frozen && details?.hasDraft()) saveTimer = setTimeout(saveQuietly, 650);
      } });
    imageImport = noteImages.attachImageImport(root.querySelector('.note-editor'), {
      canImport: () => !paused && !frozen && !closing && mode !== 'preview',
      getSelection: event => {
        const cursor = event.type === 'drop' ? editor.view.posAtCoords({ x: event.clientX, y: event.clientY }) : null;
        return cursor === null ? editor.view.state.selection.main : { from: cursor, to: cursor };
      },
      importImages: images => api.note.importImages(images),
      insert: (markdown, selection) => editor.insertImageMarkdown(markdown, selection),
      onBusy: busy => { root.inert = busy || paused || frozen || closing; if (busy) status('正在导入图片…'); },
      onError: message => { error(message); status('图片导入失败'); },
    });
    editor.view.dom.addEventListener('md-source-request', () => setMode('source'));
    editor.view.dom.addEventListener('keyup', refreshStatus); editor.view.dom.addEventListener('mouseup', refreshStatus);
    root.querySelector('.md-formatbar').onmousedown = event => { if (event.target.closest('button')) event.preventDefault(); };
    root.onclick = async event => {
      const button = event.target.closest('button'); if (!button || paused || frozen) return;
      if (button.dataset.mdCommand) {
        const action = button.dataset.mdCommand;
        let options;
        if (action === 'link' || action === 'image') {
          const selection = editor.view.state.selection.main;
          options = await markdownTools.askDestination(root, action === 'image', editor.view.state.sliceDoc(selection.from, selection.to));
          if (!options || paused || frozen) return;
        }
        editor.command(action, options); refreshStatus(); return;
      }
      if (button.dataset.mode) setMode(button.dataset.mode);
      if (button.hasAttribute('data-save')) saveQuietly();
      if (button.hasAttribute('data-tasks')) {
        try {
          const selection = editor.view.state.selection.main;
          const text = selection.empty ? editor.text() : editor.view.state.sliceDoc(selection.from, selection.to);
          await save();
          await window.DMNoteTasks.open({ root, text, sourcePath: note.path, selected: !selection.empty,
            api: api.note.tasks, esc, onProjects: async id => {
              const current = await api.workspace.list();
              if (current.root !== note.root) { error('任务已保存到原笔记库，请在主界面切回该笔记库查看项目。'); return; }
              await api.openProject(id);
            } });
        } catch (reason) { error(reason.message); }
      }
      if (button.hasAttribute('data-reload')) await reload();
      if (button.hasAttribute('data-workspace')) await api.openWorkspace('notes');
      if (button.hasAttribute('data-copy')) {
        try { const result = await api.note.saveCopy(editor.text()); if (result) status(`副本已保存：${result.path}`); }
        catch (reason) { error(reason.message); }
      }
    };
    root.querySelector('.note-preview').onclick = event => { if (event.target.closest('a')) event.preventDefault(); };
    api.note.onDiskChanged(() => error('源文件已在其他位置修改、移动或删除。可重新读取磁盘版本，或先另存当前内容。'));
    api.note.onClose(async () => {
      closing = true; root.inert = true;
      try { await save(); await save(); } catch (reason) { closing = false; root.inert = paused || frozen; throw reason; }
    });
    api.onBeforeQuit(async phase => {
      if (phase === 'resume') { frozen = false; root.inert = paused; return; }
      frozen = true; root.inert = true;
      if (phase === 'prepare') { await save(); await save(); }
    });
    api.githubSync.onEditor(async ({ phase }) => {
      if (phase === 'prepare') {
        paused = true; root.inert = true;
        if (root.querySelector('.ws-note-task-dialog [data-candidate]')) throw new Error('请先完成或关闭任务预览。');
        await save();
      }
      else {
        try {
          if (editor.text() === saved) {
            const fresh = await api.note.read();
            loading = true; saved = fresh.content; editor.replace(saved); loading = false;
            setMode(mode); refreshStatus();
          }
        } catch (reason) { error(reason.message); }
        finally { paused = false; root.inert = frozen; }
      }
    });
    setMode(mode); refreshStatus();
  } catch (reason) { root.innerHTML = `<div class="note-start-error" role="alert">无法打开文档：${esc(reason.message)}</div>`; }
}
