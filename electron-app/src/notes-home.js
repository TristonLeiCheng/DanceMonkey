(function (scope) {
  const appearance = typeof module !== 'undefined' && module.exports ? require('./note-appearance') : scope.DMNoteAppearance;
  const kinds = [
    { type: 'blank', label: '空白笔记', hint: '从一个想法开始', folder: 'Inbox', mark: '+', sections: [] },
    { type: 'note', label: '知识笔记', hint: '整理概念与学习心得', folder: 'Notes', mark: '知', sections: ['核心观点', '详细记录', '参考资料'] },
    { type: 'daily', label: '今日日记', hint: '记录日常，回顾收获', folder: 'Journal', mark: '日', sections: ['今日记录', '待办', '复盘'] },
    { type: 'meeting', label: '会议记录', hint: '议程、结论与行动项', folder: 'Meetings', mark: '会', sections: ['参会人', '议程', '讨论与结论', '行动项'] },
    { type: 'project', label: '项目概览', hint: '梳理目标、计划与进展', folder: 'Projects', mark: '项', sections: ['目标', '计划', '进展', '下一步'] },
    { type: 'person', label: '人物档案', hint: '记录关系与交流线索', folder: 'People', mark: '人', sections: ['关系', '联系方式', '交流记录', '备注'] },
  ];
  const localDay = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  function kind(type) {
    const result = kinds.find(item => item.type === type);
    if (!result) throw new Error('不支持的笔记类型');
    return result;
  }
  function compose(type, title, id, now = new Date()) {
    const item = kind(type);
    return ['---', `id: ${JSON.stringify(id)}`, `type: ${JSON.stringify(type === 'blank' ? 'note' : type)}`,
      `title: ${JSON.stringify(title)}`, `created: ${JSON.stringify(now.toISOString())}`,
      `sensitivity: ${JSON.stringify(type === 'person' ? 'sensitive' : 'normal')}`, '---', '', `# ${title}`, '',
      ...item.sections.flatMap(section => [`## ${section}`, '']), ''].join('\n');
  }
  function isPersonal(file) {
    return file.type === 'file' && /\.md$/i.test(file.path) && file.path.toLowerCase() !== '20_work/22_tasks/backlog.md' && !file.path.split('/').some(part =>
      part.startsWith('.') || ['_system', 'templates', 'template', '模板'].includes(part.toLowerCase()));
  }
  function filesFromTree(tree) {
    const result = [];
    for (const node of tree || []) {
      if (isPersonal(node)) result.push(node);
      if (node.children) result.push(...filesFromTree(node.children));
    }
    return result;
  }
  function summarize(tree, now = new Date()) {
    const files = filesFromTree(tree);
    const start = new Date(now); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - 6);
    const inWeek = value => Number.isFinite(value) && value >= start.getTime() && value <= now.getTime();
    return { files, total: files.length, created: files.filter(file => inWeek(file.createdAt)).length,
      updated: files.filter(file => inWeek(file.updatedAt)).length,
      bytes: files.reduce((sum, file) => sum + (Number(file.size) || 0), 0) };
  }
  function select(files, query = '', sort = 'updatedAt') {
    const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return files.filter(file => words.every(word => `${file.title || ''} ${file.path}`.toLocaleLowerCase().includes(word)))
      .sort((a, b) => (b[sort] || 0) - (a[sort] || 0) || a.path.localeCompare(b.path, 'zh-CN'));
  }
  const esc = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
  function formatDate(value) {
    return value ? new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '时间未知';
  }
  function renderResults({ tree, query = '', sort = 'updatedAt' }) {
    const files = select(filesFromTree(tree), query, sort);
    return `<div class="notes-home-result-count" role="status">${query.trim() ? `找到 ${files.length} 篇笔记` : `按${sort === 'createdAt' ? '创建' : '更新时间'}排序`}${files.length > 20 ? ' · 显示前 20 篇，请搜索缩小范围' : ''}</div>
      ${files.length ? `<div class="notes-home-list">${files.slice(0, 20).map(file => `<button type="button" class="notes-home-note" data-action="home-open" data-path="${esc(file.path)}" style="${appearance.style(file)}">
        <span class="notes-home-note-icon" aria-hidden="true">${esc(appearance.get(file).emoji) || '↗'}</span><span class="notes-home-note-info"><strong>${esc(file.title || file.name.replace(/\.md$/i, ''))}</strong><small>${esc(file.path)}</small></span>
        <time datetime="${file[sort] ? new Date(file[sort]).toISOString() : ''}">${formatDate(file[sort])}</time></button>`).join('')}</div>` : `<div class="notes-home-empty"><strong>${query.trim() ? '没有找到相关笔记' : '从第一篇笔记开始'}</strong><p>${query.trim() ? '试试标题或路径中的其他关键词，也可以搜索正文。' : '点击上方卡片创建笔记，你的记录会出现在这里。'}</p></div>`}`;
  }
  function render({ tree, vaultRoot, query = '', sort = 'updatedAt', fullText = false, now = new Date() }) {
    const stats = summarize(tree, now);
    const vaultName = vaultRoot.split(/[\\/]/).pop() || '本地笔记库';
    const size = stats.bytes < 1024 * 1024 ? `${(stats.bytes / 1024).toFixed(1)} KB` : `${(stats.bytes / 1024 / 1024).toFixed(1)} MB`;
    return `<div class="notes-home" aria-label="笔记主页">
      <header class="notes-home-header"><div><p class="notes-home-eyebrow">${esc(vaultName)} <span>／</span> ${esc(now.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }))}</p><h1>让想法有处可放。</h1><p>从这里开始记录，也从这里找回你的思考。</p></div><button type="button" class="ws-btn" data-action="refresh">刷新主页</button></header>
      <section class="notes-home-stats" aria-label="笔记使用统计">${[['个人笔记', stats.total, '篇'], ['近 7 天新建', stats.created, '篇'], ['近 7 天更新', stats.updated, '篇'], ['笔记容量', size, '']].map(([label, value, unit]) => `<div><span>${label}</span><strong>${value}<small>${unit}</small></strong></div>`).join('')}</section>
      <section class="notes-home-create" aria-labelledby="notes-home-create-title"><div class="notes-home-section-title"><h2 id="notes-home-create-title">开始一篇新笔记</h2><span>选一种方式，马上开始</span></div><div class="notes-home-kinds">${kinds.map(item => `<button type="button" class="notes-home-kind" data-action="home-new" data-value="${item.type}"><span class="notes-home-kind-mark" aria-hidden="true">${item.mark}</span><strong>${item.label}</strong><small>${item.hint}</small><span class="notes-home-kind-arrow" aria-hidden="true">↗</span></button>`).join('')}</div></section>
      <section class="notes-home-recent" aria-label="查找与近期笔记"><div class="notes-home-section-title"><h2>回到你的笔记</h2><div class="notes-home-tabs" role="group" aria-label="近期笔记排序"><button type="button" data-action="home-sort" data-value="updatedAt" aria-pressed="${sort === 'updatedAt'}">近期更新</button><button type="button" data-action="home-sort" data-value="createdAt" aria-pressed="${sort === 'createdAt'}">近期创建</button></div></div>
      <div class="notes-home-search"><label><span class="visually-hidden">搜索笔记标题或路径</span><input type="search" data-home-search value="${esc(query)}" placeholder="搜索笔记标题或路径…" autocomplete="off" /></label>${fullText ? '<button type="button" class="ws-btn" data-action="home-fulltext">搜索正文</button>' : ''}</div>
      <div class="notes-home-results">${renderResults({ tree, query, sort })}</div></section>
      <p class="notes-home-footnote">仅统计当前笔记库中的 Markdown 笔记，不含模板、系统说明和隐藏目录。新建时间优先使用笔记元数据，旧笔记使用本机文件创建时间，编辑、导入或同步后可能变化；更新统计包含同步带来的修改。容量不含图片附件。</p>
    </div>`;
  }
  const api = { kinds, kind, compose, localDay, isPersonal, filesFromTree, summarize, select, render, renderResults };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else scope.DMNotesHome = api;
})(typeof window !== 'undefined' ? window : globalThis);
