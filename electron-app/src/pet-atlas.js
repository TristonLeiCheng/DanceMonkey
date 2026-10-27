// Local atlas skins share the existing simulated pet states.
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports
    ? require('./pet-companion-atlases') : root.DMPetCompanionAtlases);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DMPetAtlas = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, (companions) => {
  const manifest = Object.freeze({
    animal: 'engineer-fox', name: '工程师', fallback: 'fox', source: 'assets/pets/foss/spritesheet-extended.png',
    width: 1536, height: 2288, cellWidth: 192, cellHeight: 208, columns: 8, rows: 11,
    actions: Object.freeze(Object.fromEntries(Object.entries({
      idle: [0, 6, 6], right: [1, 8, 10], left: [2, 8, 10],
      wave: [3, 4, 8, true], jump: [4, 5, 8, true], failed: [5, 8, 8],
      waiting: [6, 6, 6], working: [7, 6, 8], review: [8, 6, 6],
    }).map(([name, [row, frames, fps, once = false]]) => [name, Object.freeze({ row, frames, fps, once })]))),
    // Two static rows, starting up and progressing clockwise in 22.5-degree steps.
    gazes: Object.freeze({ firstRow: 9, frames: 16 }),
  });
  function companion(animal, name, moods = {}) {
    return Object.freeze({ animal, name, fallback: ['cat', 'dog', 'capybara'].includes(animal) ? animal : null,
      source: `assets/pets/${animal}/spritesheet-engineer.png`,
      ...companions[animal], cellWidth: 256, cellHeight: 256, columns: 4, rows: 9,
      moods: Object.freeze(moods),
      actions: Object.freeze(Object.fromEntries(
        ['idle', 'right', 'left', 'wave', 'jump', 'failed', 'waiting', 'working', 'review']
          .map((action, row) => [action, Object.freeze({ row, frames: 4,
            fps: ['right', 'left', 'wave', 'jump'].includes(action) ? 6 : 4,
            once: action === 'wave' || action === 'jump' })]))),
    });
  }
  const manifests = Object.freeze({ 'engineer-fox': manifest,
    'fluffy-rabbit': companion('fluffy-rabbit', '绒绒兔', { relaxing: 'waiting', focused: 'review' }),
    'realistic-cockroach': companion('realistic-cockroach', '仿真蟑螂', { relaxing: 'waiting', focused: 'review', eating: 'working' }),
    'realistic-mosquito': companion('realistic-mosquito', '仿真蚊子', { relaxing: 'waiting', focused: 'review', eating: 'working' }),
    liangzi: companion('liangzi', '大胃袋良子', { eating: 'working', working: 'review', focused: 'review', relaxing: 'waiting' }),
    hamster: companion('hamster', '糯米小仓鼠', { eating: 'working', working: 'review', focused: 'review', relaxing: 'waiting' }),
    seal: companion('seal', '奶团小海豹', { relaxing: 'waiting', focused: 'review' }),
    koala: companion('koala', '绒绒考拉', { eating: 'working', working: 'review', focused: 'review', relaxing: 'waiting' }),
    otter: companion('otter', '抱贝壳的小海獭', { eating: 'working', relaxing: 'waiting' }),
    'red-panda': companion('red-panda', '小熊猫咖啡师', { eating: 'review', relaxing: 'review' }),
    'baby-dragon': companion('baby-dragon', '团子小龙', { relaxing: 'waiting', exercising: 'working' }),
    cat: companion('cat', '猫咪'), dog: companion('dog', '狗狗'),
    capybara: companion('capybara', '卡皮巴拉', { eating: 'working', working: 'review',
      focused: 'review', relaxing: 'waiting', bored: 'idle', taskReminder: 'review' }) });
  const getManifest = animal => Object.hasOwn(manifests, animal) ? manifests[animal] : null;
  function baseAction(mood, animal = 'engineer-fox') {
    return getManifest(animal)?.moods?.[mood] || ({ working: 'working', focused: 'working', reading: 'review', review: 'review',
      failed: 'failed', bored: 'waiting', taskReminder: 'waiting', sleepy: 'waiting',
      sleeping: 'waiting', eating: 'idle', relaxing: 'idle' })[mood] || 'idle';
  }
  function createPlayer() {
    let state = null, action = 'idle', started = 0, current = manifest;
    function update(next, time) {
      const changedAnimal = next.animal !== state?.animal;
      current = getManifest(next.animal) || manifest;
      if (next.control?.active || next.reminder) {
        const inputAction = next.reminder?.action || next.control.action;
        const controlled = ['idle', 'left', 'right', 'jump', 'wave'].includes(inputAction) ? inputAction : 'idle';
        if (!(state?.control?.active || state?.reminder) || changedAnimal || action !== controlled) { action = controlled; started = time; }
        state = next; return;
      }
      if (state?.control?.active || state?.reminder) { action = baseAction(next.mood, next.animal); started = time; state = next; return; }
      const event = changedAnimal || next.serial !== state?.serial;
      const changedMood = next.mood !== state?.mood;
      const trigger = event && next.animation === 'pop' ? 'wave'
        : (event && next.animation === 'jump') || (changedMood && next.mood === 'happy') ? 'jump' : null;
      const base = baseAction(next.mood, next.animal);
      if (changedAnimal || trigger || changedMood || (!current.actions[action].once && action !== base)) {
        action = trigger || base; started = time;
      }
      state = next;
    }
    function sample(time) {
      if (state?.roaming?.active && !state.control?.active && !state.reminder) {
        const roaming = state.roaming, name = Object.hasOwn(current.actions, roaming.action) ? roaming.action : 'idle';
        const spec = current.actions[name];
        return { action: name, row: spec.row, frame: Math.max(0, Math.floor(roaming.frame || 0)) % spec.frames, fps: 30 };
      }
      let spec = current.actions[action];
      let frame = Math.floor(Math.max(0, time - started) * spec.fps / 1000);
      if (state?.control?.active || state?.reminder) return { action, row: spec.row,
        frame: spec.once ? Math.min(frame, spec.frames - 1) : frame % spec.frames, fps: spec.fps };
      if (spec.once && frame >= spec.frames) {
        started += spec.frames * 1000 / spec.fps;
        action = baseAction(state?.mood, state?.animal); spec = current.actions[action];
        frame = Math.floor(Math.max(0, time - started) * spec.fps / 1000);
      }
      return { action, row: spec.row, frame: frame % spec.frames, fps: spec.fps };
    }
    return { update, sample };
  }
  // A rejected load remains cached, so periodic state broadcasts never retry a missing file.
  const cachedImages = new Map();
  function loadImage(animal = 'engineer-fox', ImageType = globalThis.Image) {
    const spec = getManifest(animal);
    if (!spec) return Promise.reject(new Error('未知宠物图集'));
    if (!cachedImages.has(animal)) cachedImages.set(animal, new Promise((resolve, reject) => {
      const image = new ImageType();
      image.onload = () => {
        image.onload = image.onerror = null;
        if (image.naturalWidth !== spec.width || image.naturalHeight !== spec.height) reject(new Error(`${spec.name}图集尺寸必须为 ${spec.width} × ${spec.height}`));
        else resolve(image);
      };
      image.onerror = () => { image.onload = image.onerror = null; reject(new Error(`${spec.name}图集未能加载`)); };
      image.src = spec.source;
    }));
    return cachedImages.get(animal);
  }
  function drawFrame(ctx, image, spec, row, frame, width, height, offsetX = 0, offsetY = 0) {
    const crop = spec.frames?.[row]?.[frame];
    if (!crop) {
      ctx.drawImage(image, frame * spec.cellWidth, row * spec.cellHeight,
        spec.cellWidth, spec.cellHeight, offsetX, offsetY, width, height);
      return;
    }
    const [x, y, w, h, left, top, clips] = crop;
    const sx = width / spec.cellWidth, sy = height / spec.cellHeight;
    if (clips) {
      ctx.save(); ctx.beginPath();
      for (const [cx, cy, cw, ch] of clips) {
        ctx.rect(offsetX + (left + cx) * sx, offsetY + (top + cy) * sy, cw * sx, ch * sy);
      }
      ctx.clip();
    }
    try {
      ctx.drawImage(image, x, y, w, h, offsetX + left * sx, offsetY + top * sy, w * sx, h * sy);
    } finally {
      if (clips) ctx.restore();
    }
  }
  return { manifest, manifests, getManifest, baseAction, createPlayer, loadImage, drawFrame };
});
