(() => {
  const api = window.desktopPet, atlas = window.DMPetAtlas;
  const pet = document.getElementById('pet'), bubble = document.getElementById('bubble');
  const canvas = pet.querySelector('canvas'), ctx = canvas.getContext('2d'), defaultTitle = pet.title;
  const player = atlas.createPlayer(), motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let state = null, serial = -1, dragging = false, interactive = null;
  const images = new Map(), assetStatus = new Map();
  let disposed = false, timer = null;
  let elapsed = 0, lastTime = performance.now();
  const isAtlas = () => Boolean(state && images.has(state.animal));
  function clock() {
    const time = performance.now();
    if (!document.hidden) elapsed += time - lastTime;
    lastTime = time;
    return elapsed;
  }
  function resize(width, height) {
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  }
  function draw() {
    if (!state || disposed || document.hidden) return;
    const spec = atlas.getManifest(state.animal);
    if (!spec && !window.DMPetSprites.animals.includes(state.animal)) {
      resize(32, 32); ctx.clearRect(0, 0, 32, 32);
      pet.dataset.renderer = 'unavailable'; pet.dataset.assetStatus = 'unsupported';
      bubble.textContent = `当前版本暂不支持宠物“${state.animal}”，原选择已保留。请更新软件。`;
      bubble.hidden = false; return;
    }
    if (isAtlas()) { bubble.textContent = state.bubble; bubble.hidden = !state.bubble; }
    pet.title = spec && pet.dataset.assetStatus === 'failed'
      ? `${spec.name}图集未能加载${spec.fallback ? '，暂用原像素外形。单击互动 · 双击打开主界面 · 拖动移动 · 右键菜单' : ''}` : defaultTitle;
    const time = clock(), smooth = Boolean(isAtlas());
    pet.dataset.renderer = smooth ? 'atlas' : 'pixel';
    pet.classList.toggle('atlas', smooth);
    if (smooth) {
      const { cellWidth, cellHeight } = spec;
      const ratio = Math.min(4, Math.max(1, window.devicePixelRatio || 1));
      resize(Math.round(state.size * cellWidth / cellHeight * ratio), Math.round(state.size * ratio));
      const sample = player.sample(time);
      pet.dataset.action = sample.action;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      const frame = motion.matches ? 0 : sample.frame;
      // Generated sheets retain their original pixels. Explicit source rectangles avoid
      // clipping poses when the generator's row spacing differs from a uniform grid.
      const crop = spec.frames?.[sample.row]?.[frame];
      if (crop) {
        const [x, y, width, height, left, top] = crop;
        const sx = canvas.width / cellWidth, sy = canvas.height / cellHeight;
        ctx.drawImage(images.get(state.animal), x, y, width, height, left * sx, top * sy, width * sx, height * sy);
      } else {
        ctx.drawImage(images.get(state.animal), frame * cellWidth, sample.row * cellHeight,
          cellWidth, cellHeight, 0, 0, canvas.width, canvas.height);
      }
    } else {
      resize(32, 32); pet.dataset.action = 'pixel';
      if (spec && !spec.fallback) {
        ctx.clearRect(0,0,canvas.width,canvas.height); pet.dataset.renderer='unavailable';
        bubble.textContent=assetStatus.get(state.animal)==='failed' ? `${spec.name}图集未能加载` : `正在加载${spec.name}…`;
        bubble.hidden=false; return;
      }
      const animal = spec?.fallback || state.animal;
      ctx.putImageData(new ImageData(window.DMPetSprites.render(animal, state.mood, motion.matches ? 0 : Math.floor(time / 420) % 4), 32, 32), 0, 0);
    }
  }
  function schedule() {
    clearTimeout(timer); timer = null;
    if (!state || disposed || document.hidden || motion.matches) return;
    timer = setTimeout(() => { draw(); schedule(); }, isAtlas() ? 1000 / player.sample(elapsed).fps : 420);
  }
  function refresh() { draw(); schedule(); }
  function update(next) {
    if (!next || disposed) return;
    const changedAnimal = state?.animal !== next.animal;
    player.update(next, clock()); state = next;
    const spec = atlas.getManifest(state.animal);
    document.documentElement.style.setProperty('--pet-size', `${state.size}px`);
    document.documentElement.style.setProperty('--pet-aspect', spec ? String(spec.cellWidth / spec.cellHeight) : '1');
    pet.dataset.assetStatus = spec ? assetStatus.get(state.animal) || 'loading' : 'none';
    bubble.textContent = state.bubble; bubble.hidden = !state.bubble;
    if (serial !== state.serial || changedAnimal) {
      serial = state.serial;
      pet.classList.remove('pop', 'jump', 'shake');
      // The atlas contains its own motion; never add a second CSS jump.
      if (!spec && state.animation) {
        void pet.offsetWidth; pet.classList.add(state.animation);
      }
    }
    if (spec && !assetStatus.has(state.animal)) {
      const animal = state.animal;
      assetStatus.set(animal, 'loading');
      void atlas.loadImage(animal).then((loaded) => {
        if (disposed) return;
        images.set(animal, loaded); assetStatus.set(animal, 'ready');
        if (state.animal === animal) { pet.dataset.assetStatus = 'ready'; refresh(); }
      }).catch((error) => {
        if (disposed) return;
        assetStatus.set(animal, 'failed');
        console.warn(error.message);
        if (state.animal === animal) { pet.dataset.assetStatus = 'failed'; refresh(); }
      });
    }
    refresh();
  }
  const unsubscribe = api.onState(update);
  void api.get().then(update).catch((error) => console.warn('Pet state unavailable:', error.message));
  const visibility = () => { lastTime = performance.now(); refresh(); };
  document.addEventListener('visibilitychange', visibility);
  motion.addEventListener('change', refresh);
  window.addEventListener('resize', refresh);
  function setInteractive(value) { if (value !== interactive) { interactive = value; api.interactive(value); } }
  document.addEventListener('pointermove', (event) => {
    if (!dragging) setInteractive(Boolean(event.target.closest('button')));
  });
  document.addEventListener('pointerleave', () => { if (!dragging) setInteractive(false); });
  pet.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
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
  window.addEventListener('blur', cancel);
  pet.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); api.press(); api.release(); } });
  document.addEventListener('contextmenu', (event) => { event.preventDefault(); api.menu(); });
  bubble.addEventListener('click', () => api.tasks());
  window.addEventListener('unload', () => {
    disposed = true; clearTimeout(timer); unsubscribe();
    document.removeEventListener('visibilitychange', visibility);
    motion.removeEventListener('change', refresh); window.removeEventListener('resize', refresh);
  });
})();
