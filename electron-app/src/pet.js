(() => {
  const api = window.desktopPet, atlas = window.DMPetAtlas;
  const pet = document.getElementById('pet'), bubble = document.getElementById('bubble');
  // Silhouette measurement reads pixels for each new frame. Keep rasterization
  // stable instead of switching GPU/CPU sampling after repeated readbacks.
  const canvas = pet.querySelector('canvas'), ctx = canvas.getContext('2d', { willReadFrequently: true }), defaultTitle = pet.title;
  const cargo = document.getElementById('pet-cargo'), cargoImage = document.getElementById('pet-cargo-image');
  const player = atlas.createPlayer(), motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const reminderView = window.DMPetReminderView?.create({ api });
  let state = null, serial = -1, dragging = false, interactive = null;
  const images = new Map(), assetStatus = new Map();
  const silhouetteBounds = new Map();
  let disposed = false, timer = null, readyAnimal = null;
  function reportReady() { if (readyAnimal !== state?.animal) { readyAnimal = state?.animal; api.ready?.(); } }
  let elapsed = 0, lastTime = performance.now();
  const isAtlas = () => Boolean(state && images.has(state.animal));
  const controlHint = '交互模式 · ← → 行走 · 空格跳跃 · E 抱起/放下 · Esc 退出';
  function updateBubble() {
    if (state.reminder) { bubble.hidden = true; return; }
    const carried = state.control?.carry;
    const interaction = state.control?.iconInteraction;
    const name = interaction?.name || '图标';
    const iconHint = interaction && ({ standing: `站在「${name}」上 · ← → 行走 · 空格跳跃 · Esc 退出`,
      jumping: `正在跳向「${name}」 · ← → 调整方向`,
      target: `上方「${name}」 · 空格跳上 · ← → 行走 · Esc 退出`,
      nearby: `靠近「${name}」 · ← → 行走 · 空格跳跃 · Esc 退出` })[interaction.kind];
    const statusHint = ({ 'permission-required': '图标互动需要允许控制 Finder；授权后请重新开启交互模式。',
      unsupported: '当前系统暂不支持桌面图标互动，可使用行走和跳跃。',
      unavailable: '桌面图标暂时读不到，可继续行走和跳跃。', 'desktop-hidden': '桌面图标已隐藏，可继续行走和跳跃。',
      'layout-unsupported': '请关闭桌面叠放和自动排列，使用手动排列或贴齐网格。' })[state.control?.iconsStatus];
    const carryHint = carried ? ({ 'picking-up': `抱起「${carried.name}」…`,
      carrying: `抱着「${carried.name}」 · E 放下 · ← → 行走 · 空格跳跃 · Esc 退出`,
      'putting-down': `放下「${carried.name}」…` })[carried.phase]
      : state.control?.pickable ? `靠近「${state.control.pickable}」 · E 抱起 · 空格跳跃 · Esc 退出` : '';
    bubble.textContent = state.control?.active ? carryHint || state.control.carryNotice || iconHint || (statusHint ? `${controlHint}\n${statusHint}` : controlHint) : state.bubble;
    bubble.hidden = !bubble.textContent;
    bubble.title = state.control?.active ? '切换到其他应用也会退出交互模式' : '打开待办';
  }
  function positionBubble(frameKey = null) {
    if (bubble.hidden && !state.reminder?.showSign) return;
    const rect = canvas.getBoundingClientRect();
    let shape = { left: 0, top: 0, right: 1, bottom: 1 };
    if (frameKey !== null) {
      if (!silhouetteBounds.has(frameKey)) {
        // Anchor to the painted character, excluding transparent atlas padding.
        // Cache each frame so 60 Hz control updates do not read canvas pixels again.
        const { width, height } = canvas;
        const pixels = ctx.getImageData(0, 0, width, height).data;
        let left = width, top = height, right = 0, bottom = 0;
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          if (pixels[(y * width + x) * 4 + 3] < 20) continue;
          left = Math.min(left, x); top = Math.min(top, y);
          right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1);
        }
        silhouetteBounds.set(frameKey, right > left ? {
          left: left / width, top: top / height, right: right / width, bottom: bottom / height,
        } : shape);
      }
      shape = silhouetteBounds.get(frameKey);
    }
    const flipped = pet.dataset.renderer === 'pixel' && state.control?.facing === 'left';
    const center = rect.left + rect.width * (flipped ? 1 - (shape.left + shape.right) / 2 : (shape.left + shape.right) / 2);
    const top = rect.top + rect.height * shape.top, bottom = rect.top + rect.height * shape.bottom;
    if (state.reminder?.showSign) {
      const left = rect.left + rect.width * (flipped ? 1 - shape.right : shape.left);
      const right = rect.left + rect.width * (flipped ? 1 - shape.left : shape.right);
      reminderView?.position({ left, right, top, bottom }); return;
    }
    const margin = 8, gap = 8;
    const above = Math.max(0, top - gap - margin), below = Math.max(0, window.innerHeight - bottom - gap - margin);
    bubble.style.maxHeight = '112px';
    const placement = above >= bubble.offsetHeight || above >= below ? 'above' : 'below';
    const available = placement === 'above' ? above : below;
    // Long reminders scroll when the character leaves little room at an edge.
    bubble.style.maxHeight = `${Math.min(112, available)}px`;
    bubble.dataset.placement = placement;
    bubble.style.left = `${Math.max(margin, Math.min(center - bubble.offsetWidth / 2, window.innerWidth - margin - bubble.offsetWidth))}px`;
    const bubbleHeight = bubble.getBoundingClientRect?.().height ?? bubble.offsetHeight;
    bubble.style.top = `${placement === 'above' ? top - gap - bubbleHeight : bottom + gap}px`;
  }
  function drawCarry() {
    const held = state.control?.active && state.control.carry;
    cargo.hidden = !held; pet.dataset.carryPhase = held?.phase || '';
    if (!held) { if (cargoImage.dataset.source) { cargoImage.src = 'assets/pets/carry-file.svg'; delete cargoImage.dataset.source; } return; }
    const source = held.image || 'assets/pets/carry-file.svg';
    if (cargoImage.dataset.source !== source) { cargoImage.src = source; cargoImage.dataset.source = source; }
    const spec = atlas.getManifest(state.animal);
    const w = state.size * (isAtlas() && spec ? spec.cellWidth / spec.cellHeight : 1), h = state.size;
    const direction = state.control.facing === 'left' ? -1 : 1;
    const side = Math.min(46, Math.max(20, h * .34));
    const chest = { x: w * (direction < 0 ? .4 : .6), y: h * .63 };
    let x = chest.x, y = chest.y, size = side, opacity = 1, angle = 0, grip = 1;
    const p = motion.matches ? 1 : held.progress, ease = 1 - Math.pow(1 - p, 3);
    const local = point => ({ x: point.x - (window.screenX || 0) - state.control.left,
      y: point.y - (window.screenY || 0) - state.control.top });
    if (held.phase === 'picking-up') {
      const start = local({ x: held.source.x + held.source.width / 2, y: held.source.y + held.source.height / 2 });
      x = start.x + (chest.x - start.x) * ease; y = start.y + (chest.y - start.y) * ease - Math.sin(p * Math.PI) * h * .12;
      size = held.source.width + (side - held.source.width) * ease;
      angle = Math.sin(p * Math.PI) * direction * 12; grip = Math.max(0, (p - .45) / .55);
    } else if (held.phase === 'putting-down') {
      const drop = held.dropAnchor;
      const offset = Math.min(w * .28, w / 2 - side / 2 - 2);
      const end = drop ? local({ x: drop.x + (drop.facing === 'left' ? -offset : offset), y: drop.y - side / 2 - 4 })
        : { x: w / 2 + direction * offset, y: h - side / 2 - 4 };
      x += (end.x - x) * ease; y += (end.y - y) * ease;
      opacity = Math.min(1, (1 - p) / .4); grip = Math.max(0, 1 - p * 3);
    }
    cargo.style.width = `${size}px`; cargo.style.height = `${size}px`; cargo.style.opacity = String(opacity);
    cargo.style.transform = `translate(${x - size / 2}px, ${y - size / 2}px) rotate(${angle}deg)`;
    cargo.style.setProperty('--cargo-grip', String(grip));
    cargo.style.setProperty('--cargo-paw', ({ 'engineer-fox': '#d5965b', 'baby-dragon': '#b9c8a9', otter: '#a47f6b', cat: '#eee0ce', dog: '#dbbd96', 'fluffy-rabbit': '#f3e8d8', hamster: '#e6ccab', seal: '#f2efe8', liangzi: '#d8a489', 'realistic-cockroach': '#814825', 'realistic-mosquito': '#8b816b' })[state.animal] || '#ddc7a9');
  }
  cargoImage.addEventListener('error', () => {
    if (!cargoImage.src.endsWith('assets/pets/carry-file.svg')) cargoImage.src = 'assets/pets/carry-file.svg';
    cargoImage.dataset.source = state?.control?.carry?.image || 'assets/pets/carry-file.svg';
  });
  function clock() {
    const time = performance.now();
    if (!document.hidden) elapsed += time - lastTime;
    lastTime = time;
    return elapsed;
  }
  function resize(width, height) {
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; silhouetteBounds.clear(); }
  }
  function draw() {
    if (!state || disposed || document.hidden) return;
    const spec = atlas.getManifest(state.animal);
    if (!spec && !window.DMPetSprites.animals.includes(state.animal)) {
      resize(32, 32); ctx.clearRect(0, 0, 32, 32);
      pet.dataset.renderer = 'unavailable'; pet.dataset.assetStatus = 'unsupported';
      bubble.textContent = `当前版本暂不支持宠物“${state.animal}”，原选择已保留。请更新软件。`;
      bubble.hidden = false; positionBubble(); return;
    }
    if (isAtlas()) updateBubble();
    pet.title = state.reminder ? '宠物正在展示提醒' : spec && pet.dataset.assetStatus === 'failed'
      ? `${spec.name}图集未能加载${spec.fallback ? '，暂用原像素外形。单击互动 · 双击打开主界面 · 拖动移动 · 右键菜单' : ''}` : state.control?.active ? controlHint : defaultTitle;
    const time = clock(), smooth = Boolean(isAtlas());
    pet.dataset.renderer = smooth ? 'atlas' : 'pixel';
    pet.classList.toggle('atlas', smooth);
    let frameKey;
    if (smooth) {
      const { cellWidth, cellHeight } = spec;
      const ratio = Math.min(4, Math.max(1, window.devicePixelRatio || 1));
      resize(Math.round(state.size * cellWidth / cellHeight * ratio), Math.round(state.size * ratio));
      const sample = player.sample(time);
      pet.dataset.action = sample.action;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      const frame = motion.matches ? 0 : sample.frame;
      const roaming = state.roaming?.active && !state.control?.active && !state.reminder;
      const tilt = roaming && !motion.matches ? Math.max(-42, Math.min(42, state.roaming.tilt || 0)) : 0;
      const mirror = roaming && state.roaming.facing === 'left' && !['left', 'right'].includes(sample.action);
      if (roaming) silhouetteBounds.clear();
      frameKey = `atlas:${sample.row}:${frame}:${tilt}:${mirror}`;
      // Keep tilted antennae and legs inside the transparent canvas. Rotate about
      // the silhouette centre, not the bottom-aligned cell centre.
      if (tilt || mirror) {
        ctx.save();
        const [,,w,h,left,top] = spec.frames[sample.row][frame];
        const sx = canvas.width / spec.cellWidth, sy = canvas.height / spec.cellHeight;
        const cx = (left + w / 2) * sx, cy = (top + h / 2) * sy;
        const angle = tilt * Math.PI / 180, c = Math.abs(Math.cos(angle)), s = Math.abs(Math.sin(angle));
        const rw = w * sx * c + h * sy * s, rh = w * sx * s + h * sy * c;
        const padding = canvas.width * .015;
        const fit = Math.min(1, (canvas.width - 2 * padding) / rw, (canvas.height - 2 * padding) / rh);
        const x = Math.max(padding + rw * fit / 2, Math.min(cx, canvas.width - padding - rw * fit / 2));
        const y = Math.max(padding + rh * fit / 2, Math.min(cy, canvas.height - padding - rh * fit / 2));
        ctx.translate(x, y); ctx.rotate(angle); ctx.scale(mirror ? -fit : fit, fit); ctx.translate(-cx, -cy);
      }
      atlas.drawFrame(ctx, images.get(state.animal), spec, sample.row, frame, canvas.width, canvas.height);
      if (tilt || mirror) ctx.restore();
    } else {
      resize(32, 32); pet.dataset.action = state.reminder?.action || (state.control?.active ? state.control.action : 'pixel');
      if (spec && !spec.fallback) {
        ctx.clearRect(0,0,canvas.width,canvas.height); pet.dataset.renderer='unavailable';
        bubble.textContent=assetStatus.get(state.animal)==='failed' ? `${spec.name}图集未能加载` : `正在加载${spec.name}…`;
        bubble.hidden=false; positionBubble(); return;
      }
      const animal = spec?.fallback || state.animal;
      const frame = motion.matches ? 0 : window.DMPetSprites.frameAt(time);
      ctx.putImageData(new ImageData(window.DMPetSprites.render(animal, state.mood, frame), 32, 32), 0, 0);
      frameKey = `pixel:${animal}:${state.mood}:${frame}`;
    }
    positionBubble(frameKey);
    drawCarry();
  }
  function schedule() {
    clearTimeout(timer); timer = null;
    if (!state || disposed || document.hidden || motion.matches) return;
    timer = setTimeout(() => { draw(); schedule(); }, isAtlas() ? 1000 / player.sample(elapsed).fps : 140);
  }
  function refresh() { draw(); schedule(); }
  function update(next) {
    if (!next || disposed) return;
    const changedAnimal = state?.animal !== next.animal;
    if (Boolean(state?.reminder) !== Boolean(next.reminder)) interactive = null;
    if (changedAnimal) silhouetteBounds.clear();
    const changedControl = Boolean(state?.control?.active) !== Boolean(next.control?.active);
    if (changedControl) held.clear();
    player.update(next, clock()); state = next;
    reminderView?.update(state.reminder, state.animal);
    if (!state.control?.active || !state.control.carry) { cargo.hidden = true; pet.dataset.carryPhase = ''; }
    const spec = atlas.getManifest(state.animal);
    document.documentElement.style.setProperty('--pet-size', `${state.size}px`);
    document.documentElement.style.setProperty('--pet-aspect', spec ? String(spec.cellWidth / spec.cellHeight) : '1');
    pet.dataset.control = state.control?.active ? 'active' : 'off';
    pet.dataset.roaming = state.roaming?.active && !state.control?.active && !state.reminder ? 'active' : 'off';
    pet.dataset.roamingPhase = state.roaming?.phase || '';
    pet.dataset.reminderPhase = state.reminder?.phase || '';
    pet.dataset.facing = state.reminder?.facing || state.control?.facing || 'right';
    document.documentElement.style.setProperty('--carry-direction', state.control?.facing === 'left' ? '-1' : '1');
    document.documentElement.style.setProperty('--pet-left', `${state.reminder?.left ?? (state.control?.active ? state.control.left : state.roaming?.left) ?? 0}px`);
    document.documentElement.style.setProperty('--pet-top', `${state.reminder?.top ?? (state.control?.active ? state.control.top : state.roaming?.top) ?? 0}px`);
    pet.dataset.assetStatus = spec ? assetStatus.get(state.animal) || 'loading' : 'none';
    updateBubble();
    if (serial !== state.serial || changedAnimal || changedControl) {
      serial = state.serial;
      pet.classList.remove('pop', 'jump', 'shake');
      // The atlas contains its own motion; never add a second CSS jump.
      if (!spec && state.animation && !state.control?.active) {
        void pet.offsetWidth; pet.classList.add(state.animation);
      }
    }
    if (spec && !assetStatus.has(state.animal)) {
      const animal = state.animal;
      assetStatus.set(animal, 'loading');
      void atlas.loadImage(animal).then((loaded) => {
        if (disposed) return;
        images.set(animal, loaded); assetStatus.set(animal, 'ready');
        if (state.animal === animal) { pet.dataset.assetStatus = 'ready'; refresh(); reportReady(); }
      }).catch((error) => {
        if (disposed) return;
        assetStatus.set(animal, 'failed');
        console.warn(error.message);
        if (state.animal === animal) { pet.dataset.assetStatus = 'failed'; refresh(); }
      });
    }
    refresh();
    if (isAtlas()) reportReady();
  }
  const unsubscribe = api.onState(update);
  void api.get().then(update).catch((error) => console.warn('Pet state unavailable:', error.message));
  const visibility = () => { lastTime = performance.now(); refresh(); };
  const motionChange = () => { api.reducedMotion?.(motion.matches); refresh(); };
  api.reducedMotion?.(motion.matches);
  document.addEventListener('visibilitychange', visibility);
  motion.addEventListener('change', motionChange);
  window.addEventListener('resize', refresh);
  function setInteractive(value) { if (value !== interactive) { interactive = value; api.interactive(value); } }
  document.addEventListener('pointermove', (event) => {
    if (!dragging) setInteractive(Boolean(event.target.closest('button, .pet-reminder-board')));
  });
  document.addEventListener('pointerleave', () => { if (!dragging) setInteractive(false); });
  pet.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || state?.control?.active || state?.reminder) return;
    dragging = true; pet.setPointerCapture(event.pointerId); api.press();
  });
  pet.addEventListener('pointerup', (event) => {
    if (event.button !== 0 || !dragging) return;
    dragging = false; api.release();
    if (pet.hasPointerCapture(event.pointerId)) pet.releasePointerCapture(event.pointerId);
    setInteractive(Boolean(document.elementFromPoint(event.clientX, event.clientY)?.closest('button')));
  });
  const cancel = () => { if (dragging) { dragging = false; api.cancel(); } setInteractive(false); };
  pet.addEventListener('pointercancel', cancel);
  pet.addEventListener('lostpointercapture', cancel);
  const held = new Set();
  function key(event, down) {
    if (state?.reminder) {
      if (event.code === 'Escape') { event.preventDefault(); if (down && !event.repeat) reminderView?.escape(); }
      return;
    }
    if (!state?.control?.active) return;
    if (event.code === 'Escape') { event.preventDefault(); if (down) { held.clear(); api.exitControl(); } return; }
    if (!['ArrowLeft', 'ArrowRight', 'Space', 'KeyE'].includes(event.code)) return;
    event.preventDefault();
    if (down && (event.repeat || held.has(event.code))) return;
    if (down) held.add(event.code); else held.delete(event.code);
    api.key(event.code, down);
  }
  document.addEventListener('keydown', event => key(event, true));
  document.addEventListener('keyup', event => key(event, false));
  window.addEventListener('blur', () => { held.clear(); cancel(); });
  pet.addEventListener('keydown', (event) => { if (!state?.control?.active && !state?.reminder && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); api.press(); api.release(); } });
  document.addEventListener('contextmenu', (event) => { event.preventDefault(); held.clear(); api.menu(); });
  bubble.addEventListener('click', () => { if (!state?.control?.active) api.tasks(); });
  window.addEventListener('unload', () => {
    disposed = true; clearTimeout(timer); unsubscribe();
    document.removeEventListener('visibilitychange', visibility);
    motion.removeEventListener('change', motionChange); window.removeEventListener('resize', refresh);
  });
})();
