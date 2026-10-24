(() => {
  const api = window.desktopPet, atlas = window.DMPetAtlas;
  const pet = document.getElementById('pet'), bubble = document.getElementById('bubble');
  const canvas = pet.querySelector('canvas'), ctx = canvas.getContext('2d'), defaultTitle = pet.title;
  const player = atlas.createPlayer(), motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let state = null, serial = -1, dragging = false, interactive = null;
  let images = new Map(), statuses = new Map(), disposed = false, timer = null;
  let elapsed = 0, lastTime = performance.now();
  const currentManifest = () => atlas.getManifest(state?.animal);
  const isAtlas = () => currentManifest() && images.has(state?.animal);
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
    const manifest = currentManifest(), image = images.get(state.animal);
    pet.dataset.assetStatus = statuses.get(state.animal) || '';
    pet.title = manifest && pet.dataset.assetStatus === 'failed'
      ? `${manifest.name}图集未能加载` : defaultTitle;
    if (image) { bubble.textContent = state.bubble; bubble.hidden = !state.bubble; }
    const time = clock(), smooth = Boolean(isAtlas());
    pet.dataset.renderer = smooth ? 'atlas' : 'pixel';
    pet.classList.toggle('atlas', smooth);
    if (smooth) {
      const { cellWidth, cellHeight } = manifest;
      document.documentElement.style.setProperty('--pet-aspect', cellWidth / cellHeight);
      const ratio = Math.min(4, Math.max(1, window.devicePixelRatio || 1));
      resize(Math.round(state.size * cellWidth / cellHeight * ratio), Math.round(state.size * ratio));
      const sample = player.sample(time);
      pet.dataset.action = sample.action;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      const frame = motion.matches ? 0 : sample.frame;
      const crop = manifest.frames?.[sample.row][frame];
      if (crop) {
        const [x,y,w,h,dx,dy] = crop;
        ctx.drawImage(image,x,y,w,h,dx/cellWidth*canvas.width,dy/cellHeight*canvas.height,
          w/cellWidth*canvas.width,h/cellHeight*canvas.height);
      } else ctx.drawImage(image, frame * cellWidth, sample.row * cellHeight,
        cellWidth, cellHeight, 0, 0, canvas.width, canvas.height);
    } else {
      resize(32, 32); pet.dataset.action = 'pixel';
      if (manifest && !manifest.fallback) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        pet.dataset.renderer = 'unavailable';
        bubble.textContent = statuses.get(state.animal) === 'failed' ? `${manifest.name}图集未能加载` : '正在加载话务员兔子…';
        bubble.hidden = false; return;
      }
      const animal = manifest?.fallback || state.animal;
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
    document.documentElement.style.setProperty('--pet-size', `${state.size}px`);
    bubble.textContent = state.bubble; bubble.hidden = !state.bubble;
    if (serial !== state.serial || changedAnimal) {
      serial = state.serial;
      pet.classList.remove('pop', 'jump', 'shake');
      // The atlas contains its own motion; never add a second CSS jump.
      if (!currentManifest() && state.animation) {
        void pet.offsetWidth; pet.classList.add(state.animation);
      }
    }
    const animal = state.animal;
    if (currentManifest() && !statuses.has(animal)) {
      statuses.set(animal, 'loading');
      void atlas.loadImage(undefined, animal).then((loaded) => {
        if (disposed) return;
        images.set(animal, loaded); statuses.set(animal, 'ready'); refresh();
      }).catch((error) => {
        if (disposed) return;
        statuses.set(animal, 'failed'); console.warn(error.message); refresh();
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
