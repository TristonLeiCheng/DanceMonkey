(function (host) {
  const themes = [
    ['system', '跟随系统', '#f4f3ef', '#24262c'], ['dark', '石墨黑', '#1a1b20', '#bea16f'],
    ['light', '暖白', '#f6f5f2', '#806239'], ['slate', '雾蓝', '#1e2a36', '#8fb8d8'],
    ['frost-yellow', '奶油黄', '#fff8cf', '#8a681c'], ['frost-green', '薄荷绿', '#e0f6e0', '#39794a'],
    ['lavender', '淡紫', '#f1ebf8', '#765590'], ['rose', '浅玫瑰', '#faecec', '#a15168'],
  ];
  const colors = [['#8b6b42', '琥珀'], ['#4778c7', '湖蓝'], ['#438064', '森林'], ['#7960b6', '鸢尾'],
    ['#b65d75', '玫瑰'], ['#b76a3d', '陶土'], ['#47858b', '青瓷'], ['#777b87', '岩灰']];
  const defaults = { theme: 'dark', effect: 'glass', opacity: 82, accent: '', fontSize: 15 };
  const keys = { theme: 'lumen-workspace-theme', effect: 'lumen-workspace-effect', opacity: 'lumen-workspace-opacity',
    accent: 'lumen-workspace-accent', fontSize: 'lumen-workspace-font-size' };
  function normalize(value = {}) {
    const number = (key, min, max) => value[key] == null || !Number.isFinite(Number(value[key])) ? defaults[key] : Math.max(min, Math.min(max, Math.round(Number(value[key]))));
    return { theme: themes.some(([id]) => id === value.theme) ? value.theme : defaults.theme,
      effect: ['glass', 'solid', 'paper'].includes(value.effect) ? value.effect : defaults.effect,
      opacity: number('opacity', 35, 100), fontSize: number('fontSize', 13, 20),
      accent: /^#[0-9a-f]{6}$/i.test(value.accent || '') ? value.accent.toLowerCase() : '' };
  }
  function create({ root, storage = localStorage, media = matchMedia('(prefers-color-scheme: dark)') }) {
    const read = () => normalize(Object.fromEntries(Object.entries(keys).map(([name, key]) => [name, storage.getItem(key)])));
    let state = read(), refreshControls = () => {};
    function apply() {
      const theme = state.theme === 'system' ? media.matches ? 'dark' : 'light' : state.theme;
      for (const name of [...root.classList]) if (name.startsWith('theme-') || name.startsWith('effect-')) root.classList.remove(name);
      root.classList.add(`theme-${theme}`, `effect-${state.effect}`);
      root.classList.toggle('light', ['light', 'frost-yellow', 'frost-green', 'lavender', 'rose'].includes(theme));
      root.classList.toggle('has-custom-accent', Boolean(state.accent));
      root.style.setProperty('--ws-opacity', String(state.opacity / 100));
      root.style.setProperty('--ws-reading-size', `${state.fontSize}px`);
      root.style.setProperty('--ws-custom-accent', state.accent || 'var(--ws-accent)');
    }
    function set(patch) {
      state = normalize({ ...state, ...patch });
      for (const [name, key] of Object.entries(keys)) storage.setItem(key, String(state[name]));
      apply();
    }
    function render() {
      return `<div class="ws-personalize" data-workspace-appearance>
        <div class="ws-personalize-heading"><div><h2>让工作区更像你</h2><p class="ws-settings-desc">调整即时生效，自动保存在本机。</p></div><button type="button" data-appearance-reset>恢复默认</button></div>
        <fieldset><legend>主题配色</legend><div class="ws-theme-grid">${themes.map(([id, label, bg, accent]) => `<button type="button" data-appearance-theme="${id}" aria-pressed="${state.theme === id}" style="--sample-bg:${bg};--sample-accent:${accent}"><span class="ws-theme-mini" aria-hidden="true"><i></i><b></b><b></b><b></b></span><span>${label}</span><span class="ws-theme-check" aria-hidden="true">✓</span></button>`).join('')}</div></fieldset>
        <fieldset><legend>强调色 <span>用于选中项、按钮与焦点</span></legend><div class="ws-accent-colors"><button type="button" data-appearance-accent="" aria-label="使用主题默认强调色" aria-pressed="${!state.accent}" title="随主题">↺</button>${colors.map(([color, label]) => `<button type="button" data-appearance-accent="${color}" aria-label="${label}" title="${label}" aria-pressed="${state.accent === color}" style="--swatch:${color}"></button>`).join('')}<label class="ws-accent-custom" title="自定义强调色"><input type="color" aria-label="自定义强调色" value="${state.accent || '#8b6b42'}"><span>自定义</span></label></div></fieldset>
        <div class="ws-personalize-columns"><fieldset><legend>背景材质</legend><div class="ws-material-options">${[['glass','磨砂玻璃','通透、轻盈'],['solid','纯色','清晰、专注'],['paper','纸张','温润、柔和']].map(([id,label,detail])=>`<button type="button" data-appearance-effect="${id}" aria-pressed="${state.effect===id}"><strong>${label}</strong><small>${detail}</small></button>`).join('')}</div></fieldset>
        <fieldset><legend>阅读字号</legend><label class="ws-reading-size">笔记正文<select aria-label="笔记正文字号">${[13,14,15,16,17,18,19,20].map(size=>`<option value="${size}" ${state.fontSize===size?'selected':''}>${size} px</option>`).join('')}</select></label><p class="ws-settings-desc">调整工作区内笔记正文的阅读大小。</p></fieldset></div>
        <fieldset><legend>背景不透明度 <output data-appearance-opacity-value>${state.opacity}%</output></legend><input class="ws-opacity" type="range" min="35" max="100" step="1" value="${state.opacity}" aria-label="工作区背景不透明度" aria-valuetext="${state.opacity}%"><div class="ws-range-caption"><span>轻透</span><span>实色</span></div></fieldset>
        <div class="ws-visual-preview" aria-label="外观预览"><div><span class="ws-preview-dot"></span>灵感收集 <small>今天</small></div><h3>把想法，留在这里。</h3><p style="font-size:var(--ws-reading-size)">一张简单的卡片，一段专注的时光。</p><span class="ws-preview-tag">正在使用的外观</span></div>
      </div>`;
    }
    function bind(scope) {
      const panel = scope.querySelector('[data-workspace-appearance]');
      if (!panel) return;
      const refresh = () => {
        for (const [field, data] of [['theme', 'appearanceTheme'], ['accent','appearanceAccent'], ['effect','appearanceEffect']]) {
          for (const button of panel.querySelectorAll(`[data-${data.replace(/[A-Z]/g, value => '-' + value.toLowerCase())}]`)) button.setAttribute('aria-pressed', String(button.dataset[data] === state[field]));
        }
        panel.querySelector('input[type="color"]').value = state.accent || '#8b6b42';
        panel.querySelector('select').value = String(state.fontSize);
        const slider = panel.querySelector('.ws-opacity'); slider.value = state.opacity; slider.setAttribute('aria-valuetext', `${state.opacity}%`);
        panel.querySelector('[data-appearance-opacity-value]').textContent = `${state.opacity}%`;
      };
      refreshControls = refresh;
      panel.onclick = event => {
        const button = event.target.closest('button'); if (!button) return;
        event.preventDefault(); event.stopPropagation();
        if (button.hasAttribute('data-appearance-theme')) set({ theme: button.dataset.appearanceTheme });
        if (button.hasAttribute('data-appearance-effect')) set({ effect: button.dataset.appearanceEffect });
        if (button.hasAttribute('data-appearance-accent')) set({ accent: button.dataset.appearanceAccent });
        if (button.hasAttribute('data-appearance-reset')) set(defaults);
        refresh();
      };
      panel.querySelector('input[type="color"]').oninput = event => { set({ accent: event.target.value }); refresh(); };
      panel.querySelector('select').onchange = event => set({ fontSize: event.target.value });
      panel.querySelector('.ws-opacity').oninput = event => { set({ opacity: event.target.value }); refresh(); };
    }
    media.addEventListener?.('change', () => { if (state.theme === 'system') apply(); });
    host.addEventListener?.('storage', event => {
      if ((event.storageArea && event.storageArea !== storage) || (event.key && !Object.values(keys).includes(event.key))) return;
      state = read(); apply();
      refreshControls();
    });
    apply();
    return { apply, render, bind, get: () => ({ ...state }) };
  }
  const api = { create, normalize, defaults, themes };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else host.DMWorkspaceAppearance = api;
})(typeof window === 'object' ? window : globalThis);
