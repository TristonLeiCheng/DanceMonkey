(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DMNoteReferences = api;
})(globalThis, () => {
  const MAX_REFERENCES = 8;
  const version = item => Number.isSafeInteger(item.moveVersion) && item.moveVersion >= 0 ? { moveVersion: item.moveVersion } : {};
  const safePath = path => typeof path === 'string' && /\.md$/i.test(path) && !/[\\:\u0000-\u001f]/.test(path)
    && path.split('/').every(part => part && part !== '..' && !part.startsWith('.'));
  function cleanReferences(items) {
    if (!Array.isArray(items)) return [];
    const seen = new Set();
    return items.filter(item => item && safePath(item.path) && !seen.has(item.path) && seen.add(item.path))
      .slice(0, MAX_REFERENCES).map(item => ({ path: item.path, title: String(item.title || item.path).slice(0, 300), ...version(item) }));
  }
  function cleanSources(items) {
    if (!Array.isArray(items)) return [];
    const seen = new Set();
    return items.filter(item => item && safePath(item.path) && /^N[1-9]\d?$/.test(item.id) && !seen.has(item.id) && seen.add(item.id))
      .slice(0, MAX_REFERENCES + 1).map(item => ({ id: item.id, path: item.path, title: String(item.title || item.path).slice(0, 300), ...version(item) }));
  }
  function withLinks(text, sources = [], currentPath = '') {
    return text.replace(/\[N(\d+)\]/g, (match, number) => {
      const source = sources.find(item => item.id === `N${number}`);
      if (!source) return match;
      const from = currentPath.split('/').slice(0, -1), to = source.path.split('/');
      while (from.length && to.length && from[0] === to[0]) { from.shift(); to.shift(); }
      const relative = [...from.map(() => '..'), ...to].join('/');
      return `[${source.title.replace(/[\r\n]/g, ' ').replace(/[\[\]\\]/g, '\\$&')}](<${relative.replace(/[\u0000-\u0020%<>#?]/g, encodeURIComponent)}>)`;
    });
  }
  function mentionAt(text, cursor) {
    const match = /@([^@\n]{0,100})$/.exec(text.slice(0, cursor));
    return match ? { from: cursor - match[0].length, to: cursor, query: match[1] } : null;
  }
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  // Shared by the Markdown editor and project chat. Each DOM binding owns its
  // request sequence so stale searches cannot select notes in another view.
  function createPicker({ input, box, search, selected, onChoose, onDraft, onError, disabled = () => false, optionAttribute = 'data-note-reference' }) {
    let serial = 0, disposed = false, mention = null, items = [];
    function hide() { serial++; mention = null; items = []; box.hidden = true; }
    function choose(item) {
      if (!item || !mention || disposed || disabled()) return;
      if (selected().some(ref => ref.path === item.path)) return;
      if (selected().length >= MAX_REFERENCES) { onError('最多引用 8 篇笔记。'); return; }
      input.setRangeText(`《${item.title}》`, mention.from, mention.to, 'end');
      const value = input.value, cursor = input.selectionStart;
      hide(); onChoose(item, value, cursor);
    }
    async function update() {
      if (disposed || disabled()) { hide(); return; }
      mention = mentionAt(input.value, input.selectionStart);
      if (!mention) { hide(); return; }
      const own = ++serial;
      items = []; box.hidden = false; box.textContent = '正在查找笔记…';
      try {
        const matches = await search(mention.query);
        if (disposed || own !== serial || !box.isConnected) return;
        items = matches.filter(item => !selected().some(ref => ref.path === item.path));
        box.innerHTML = items.length ? items.map((item, index) => `<button type="button" role="option" aria-selected="false" ${optionAttribute}="pick" data-index="${index}"><strong>${esc(item.title)}</strong><small>${esc(item.path)}</small></button>`).join('') : '<p>没有匹配的笔记</p>';
        box.querySelectorAll('button').forEach((button, index) => { button.onclick = event => { event.preventDefault(); event.stopPropagation(); choose(items[index]); }; });
      } catch (error) { if (!disposed && own === serial) box.textContent = error.message; }
    }
    box.onkeydown = event => {
      const options = [...box.querySelectorAll('button')], index = options.indexOf(input.ownerDocument.activeElement);
      if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); options[(index + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length]?.focus(); }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); hide(); input.focus(); }
    };
    function handleKey(event) {
      if (event.isComposing || event.keyCode === 229 || box.hidden) return false;
      if (!['Escape', 'ArrowDown', 'Enter'].includes(event.key) || (event.key === 'Enter' && event.shiftKey)) return false;
      event.preventDefault(); event.stopPropagation();
      if (event.key === 'Escape') hide();
      else if (event.key === 'ArrowDown') box.querySelector('button')?.focus();
      else choose(items[0]);
      return true;
    }
    return { update, handleKey, hide, destroy() { disposed = true; hide(); },
      trigger() { if (disposed || disabled()) return; input.focus(); input.setRangeText('@', input.selectionStart, input.selectionEnd, 'end'); onDraft(input.value); void update(); } };
  }
  return { MAX_REFERENCES, cleanReferences, cleanSources, withLinks, mentionAt, createPicker };
});
