// Engineer is a local 2D atlas skin. Life states are the existing simulated pet states.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DMPetAtlas = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const manifest = Object.freeze({
    animal: 'engineer-fox', source: 'assets/pets/foss/spritesheet-extended.png',
    width: 1536, height: 2288, cellWidth: 192, cellHeight: 208, columns: 8, rows: 11,
    actions: Object.freeze(Object.fromEntries(Object.entries({
      idle: [0, 6, 6], right: [1, 8, 10], left: [2, 8, 10],
      wave: [3, 4, 8, true], jump: [4, 5, 8, true], failed: [5, 8, 8],
      waiting: [6, 6, 6], working: [7, 6, 8], review: [8, 6, 6],
    }).map(([name, [row, frames, fps, once = false]]) => [name, Object.freeze({ row, frames, fps, once })]))),
    // Two static rows, starting up and progressing clockwise in 22.5-degree steps.
    gazes: Object.freeze({ firstRow: 9, frames: 16 }),
  });
  function baseAction(mood) {
    return ({ working: 'working', focused: 'working', reading: 'review', review: 'review',
      failed: 'failed', bored: 'waiting', taskReminder: 'waiting', sleepy: 'waiting',
      sleeping: 'waiting', eating: 'idle', relaxing: 'idle' })[mood] || 'idle';
  }
  function createPlayer() {
    let state = null, action = 'idle', started = 0;
    function update(next, time) {
      const changedAnimal = next.animal !== state?.animal;
      const event = changedAnimal || next.serial !== state?.serial;
      const changedMood = next.mood !== state?.mood;
      const trigger = event && next.animation === 'pop' ? 'wave'
        : (event && next.animation === 'jump') || (changedMood && next.mood === 'happy') ? 'jump' : null;
      const base = baseAction(next.mood);
      if (changedAnimal || trigger || changedMood || (!manifest.actions[action].once && action !== base)) {
        action = trigger || base; started = time;
      }
      state = next;
    }
    function sample(time) {
      let spec = manifest.actions[action];
      let frame = Math.floor(Math.max(0, time - started) * spec.fps / 1000);
      if (spec.once && frame >= spec.frames) {
        started += spec.frames * 1000 / spec.fps;
        action = baseAction(state?.mood); spec = manifest.actions[action];
        frame = Math.floor(Math.max(0, time - started) * spec.fps / 1000);
      }
      return { action, row: spec.row, frame: frame % spec.frames, fps: spec.fps };
    }
    return { update, sample };
  }
  // A rejected load remains cached, so periodic state broadcasts never retry a missing file.
  let cachedImage;
  function loadImage(ImageType = globalThis.Image) {
    if (!cachedImage) cachedImage = new Promise((resolve, reject) => {
      const image = new ImageType();
      image.onload = () => {
        image.onload = image.onerror = null;
        if (image.naturalWidth !== manifest.width || image.naturalHeight !== manifest.height) reject(new Error('工程师图集尺寸必须为 1536 × 2288'));
        else resolve(image);
      };
      image.onerror = () => { image.onload = image.onerror = null; reject(new Error('工程师图集未能加载')); };
      image.src = manifest.source;
    });
    return cachedImage;
  }
  return { manifest, baseAction, createPlayer, loadImage };
});
