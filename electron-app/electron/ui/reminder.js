(async () => {
  const payload = await window.reminderPopup.get();
  if (!payload) return;
  const { reminder: item, options, style } = payload;
  document.body.className = `${style} ${options.acrylic ? 'acrylic' : ''}`;
  let geometry = payload.islandBounds;
  const applyLayout = value => {
    const inset = typeof value === 'number' ? value : value.topInset;
    if (value.islandBounds) geometry = value.islandBounds;
    document.documentElement.style.setProperty('--top-inset', `${Math.max(0, Number(inset) || 0)}px`);
    if (geometry) {
      document.documentElement.style.setProperty('--island-expanded-width', `${geometry.expanded.width}px`);
      document.documentElement.style.setProperty('--island-collapsed-height', `${geometry.collapsed.height}px`);
    }
  };
  applyLayout(payload);
  window.reminderPopup.onInset(applyLayout);
  const title = `${options.test ? '测试 · ' : ''}${item.title}`;
  document.querySelector('.icon').textContent = item.icon;
  document.querySelector('h1').textContent = title;
  document.querySelector('.compact-icon').textContent = item.icon;
  document.querySelector('.compact-title').textContent = title;
  document.querySelector('p').textContent = item.message;
  document.querySelector('[data-action="done"]').textContent = options.test ? '关闭测试' : item.doneLabel;
  document.querySelector('[data-action="snooze"]').textContent = `${item.laterLabel} · ${item.snoozeMinutes} 分钟`;
  const card = document.querySelector('.card');
  const compact = document.querySelector('.island-compact');
  const details = [...card.querySelectorAll('.header, p, .actions, .close, .collapse, .error')];
  let transition = 0, animations = [], desiredExpanded = false;
  function accessibility(expanded) {
    for (const node of details) { node.inert = !expanded; node.setAttribute('aria-hidden', String(!expanded)); }
    if (expanded) { card.removeAttribute('role'); card.removeAttribute('tabindex'); card.removeAttribute('aria-label'); }
    else { card.tabIndex = 0; card.setAttribute('role', 'button'); card.setAttribute('aria-label', `${title}，点击展开提醒`); }
  }
  async function setExpanded(expanded) {
    const version = ++transition;
    desiredExpanded = expanded;
    const from = card.getBoundingClientRect();
    const fromRadius = getComputedStyle(card).borderRadius;
    const opacity = node => getComputedStyle(node).opacity;
    const detailOpacity = opacity(details[0]), compactOpacity = opacity(compact);
    // Freeze the currently presented silhouette before cancelling an interrupted morph.
    card.style.width = `${from.width}px`; card.style.height = `${from.height}px`;
    for (const animation of animations) animation.cancel();
    animations = [];
    const target = geometry[expanded ? 'expanded' : 'collapsed'];
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    try {
      if (expanded) await window.reminderPopup.expand(true);
      if (version !== transition) return;
      card.classList.toggle('collapsed', !expanded);
      accessibility(expanded);
      if (!reduced) {
        const duration = expanded ? 460 : 340;
        const shape = card.animate([
          { width: `${from.width}px`, height: `${from.height}px`, borderRadius: fromRadius },
          { width: `${target.width}px`, height: `${target.height}px`, borderRadius: expanded ? '0 0 26px 26px' : '22px' },
        ], { duration, easing: expanded ? 'cubic-bezier(.22,.85,.24,1)' : 'cubic-bezier(.4,0,.2,1)', fill: 'both' });
        animations.push(shape);
        for (const node of details) animations.push(node.animate([
          { opacity: detailOpacity, filter: expanded ? 'blur(4px)' : 'blur(0px)', transform: expanded ? 'translateY(5px)' : 'translateY(0)', visibility: 'visible' },
          { opacity: expanded ? 1 : 0, filter: expanded ? 'blur(0px)' : 'blur(3px)', transform: expanded ? 'translateY(0)' : 'translateY(-3px)', visibility: 'visible' },
        ], { duration: expanded ? 230 : 110, delay: expanded ? 100 : 0, easing: 'ease-out', fill: 'both' }));
        animations.push(compact.animate([
          { opacity: compactOpacity, visibility: 'visible' }, { opacity: expanded ? 0 : 1, visibility: 'visible' },
        ], { duration: expanded ? 80 : 140, delay: expanded ? 0 : 180, easing: 'ease-out', fill: 'both' }));
        await Promise.all(animations.map(animation => animation.finished)).catch(() => {});
        if (version !== transition) return;
      }
      card.style.width = `${target.width}px`; card.style.height = `${target.height}px`;
      if (!expanded) await window.reminderPopup.expand(false);
      if (version !== transition) return;
      for (const animation of animations) animation.cancel();
      animations = [];
      card.setAttribute('aria-expanded', String(expanded));
      if (!expanded) card.focus();
    } catch (error) { if (version === transition) document.querySelector('.error').textContent = error.message; }
  }
  if (style === 'DynamicIsland') {
    details.forEach(node => node.classList.add('island-detail'));
    card.classList.add('collapsed'); accessibility(false); card.setAttribute('aria-expanded', 'false');
    card.addEventListener('click', event => { if (!desiredExpanded && !event.target.closest('button')) void setExpanded(true); });
    card.addEventListener('keydown', event => {
      if (event.target === card && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); void setExpanded(true); }
    });
    document.querySelector('.collapse').onclick = event => { event.stopPropagation(); void setExpanded(false); };
  }
  let busy = false;
  async function act(action) {
    if (busy) return;
    busy = true;
    try { await window.reminderPopup.act(action); }
    catch (error) { document.querySelector('.error').textContent = error.message; busy = false; }
  }
  document.querySelectorAll('[data-action]').forEach(button => button.onclick = event => { event.stopPropagation(); void act(button.dataset.action); });
  document.querySelector('.close').onclick = () => { void act('snooze'); };
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (style === 'DynamicIsland' && desiredExpanded) void setExpanded(false);
    else void act('snooze');
  });
})();
