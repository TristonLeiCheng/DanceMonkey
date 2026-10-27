const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const atlas = require('../src/pet-atlas');

const state = (patch = {}) => ({ animal: 'engineer-fox', size: 68, mood: 'normal', serial: 0, animation: '', bubble: '', ...patch });
test('工程师 manifest addresses 73 valid cells and maps only existing local states', () => {
  const m = atlas.manifest;
  assert.equal(m.columns * m.cellWidth, m.width);
  assert.equal(m.rows * m.cellHeight, m.height);
  assert.equal(Object.values(m.actions).reduce((sum, action) => sum + action.frames, 0) + m.gazes.frames, 73);
  for (const action of Object.values(m.actions)) {
    assert.ok(action.row < 9 && action.frames <= 8 && action.fps > 0);
  }
  for (const mood of ['normal', 'eating', 'relaxing']) assert.equal(atlas.baseAction(mood), 'idle');
  for (const mood of ['sleepy', 'sleeping', 'bored', 'taskReminder']) assert.equal(atlas.baseAction(mood), 'waiting');
  assert.equal(atlas.baseAction('working'), 'working');
  assert.equal(atlas.baseAction('reading'), 'review');
  assert.equal(atlas.baseAction('failed'), 'failed');
});
test('periodic broadcasts do not restart loops or replay completed gestures; serial events do', () => {
  const player = atlas.createPlayer();
  player.update(state({ mood: 'working' }), 0);
  player.update(state({ mood: 'working' }), 375);
  assert.equal(player.sample(375).frame, 3);
  player.update(state({ serial: 1, animation: 'pop' }), 400);
  assert.equal(player.sample(400).action, 'wave');
  player.update(state({ serial: 1, animation: 'pop' }), 700);
  assert.equal(player.sample(700).frame, 2);
  assert.equal(player.sample(901).action, 'idle');
  player.update(state({ serial: 1, animation: 'pop' }), 1200);
  assert.equal(player.sample(1200).action, 'idle');
  player.update(state({ serial: 2, animation: 'pop' }), 1300);
  assert.equal(player.sample(1300).action, 'wave');
  player.update(state({ mood: 'happy', serial: 3, animation: 'jump' }), 1400);
  assert.equal(player.sample(1400).action, 'jump');
  assert.equal(player.sample(2025).action, 'idle');
  player.update(state({ mood: 'reading', serial: 3 }), 2100);
  assert.equal(player.sample(2100).action, 'review');
});
function freshAtlas() {
  const context = { module: { exports: {} }, require: name => require('../src/' + name) };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/pet-atlas'), 'utf8'), context);
  return context.module.exports;
}
test('atlas load success, failure and incorrect dimensions are cached without repeated file requests', async () => {
  for (const mode of ['success', 'error', 'dimensions']) {
    const api = freshAtlas(); let requests = 0;
    class Image {
      set src(value) {
        requests++; assert.equal(value, api.manifest.source);
        queueMicrotask(() => {
          this.naturalWidth = mode === 'dimensions' ? 32 : 1536; this.naturalHeight = 2288;
          if (mode === 'error') this.onerror(); else this.onload();
        });
      }
    }
    const first = api.loadImage('engineer-fox', Image);
    assert.equal(api.loadImage('engineer-fox', Image), first);
    if (mode === 'success') assert.equal((await first).naturalWidth, 1536);
    else await assert.rejects(first, /工程师图集/);
    assert.equal(api.loadImage('engineer-fox', Image), first); assert.equal(requests, 1);
  }
});

// Deterministic renderer tests use an Image test double, never a replacement visual asset.
function renderer({ fail = false, reduced = false, deferred = false } = {}) {
  let time = 0, received, unsubscribed = 0, nextId = 0, requests = 0;
  const pending = new Map(), calls = [], listeners = new Map(), loads = new Map();
  const events = (target) => ({
    addEventListener(name, fn) { listeners.set(`${target}:${name}`, fn); },
    removeEventListener(name) { listeners.delete(`${target}:${name}`); },
  });
  const classes = new Set();
  const ctx = { clearRect: (...args) => calls.push(['clear', ...args]), drawImage: (...args) => calls.push(['atlas', ...args]), putImageData: (...args) => calls.push(['pixel', ...args]),
    getImageData: (_x, _y, width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }) };
  for (const name of ['save','beginPath','rect','clip','restore','translate','rotate','scale']) ctx[name]=(...args)=>calls.push([name,...args]);
  const canvas = { width: 32, height: 32, getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 100, top: 150, width: 68, height: 68 }) };
  const pet = { ...events('pet'), dataset: {}, title: '', querySelector: () => canvas,
    classList: { toggle: (name, value) => value ? classes.add(name) : classes.delete(name), add: name => classes.add(name), remove: (...names) => names.forEach(name => classes.delete(name)) },
  };
  const bubble = { ...events('bubble'), hidden: true, dataset: {}, style: {}, offsetWidth: 180, offsetHeight: 60 };
  const cargo = { hidden: true, style: { setProperty() {} } }, cargoImage = { ...events('cargoImage'), dataset: {}, src: '' };
  const document = { ...events('document'), hidden: false, documentElement: { style: { setProperty() {} } }, getElementById: id => ({ pet, bubble, 'pet-cargo': cargo, 'pet-cargo-image': cargoImage })[id] };
  const motion = { ...events('motion'), matches: reduced };
  const api = freshAtlas();
  const pixelCalls = [];
  const context = { document, performance: { now: () => time }, console: { warn: (...args) => calls.push(['warning', ...args]) },
    ImageData: class { constructor(pixels) { this.data = pixels; } },
    setTimeout: (fn, ms) => { pending.set(++nextId, { fn, ms }); return nextId; }, clearTimeout: id => pending.delete(id),
  };
  context.window = { ...events('window'), devicePixelRatio: 2, innerWidth: 240, innerHeight: 264, DMPetAtlas: api,
    DMPetSprites: { frameAt: require('../src/pet-sprites').frameAt, animals: require('../src/pet-sprites').animals, render: (...args) => { pixelCalls.push(args); return new Uint8ClampedArray(4096); } },
    matchMedia: () => motion,
    desktopPet: { onState: fn => { received = fn; return () => unsubscribed++; }, get: async () => null },
  };
  class Image { set src(value) {
    requests++; this.source = value;
    const m = Object.values(api.manifests).find(m => m.source === value);
    const finish = () => { if (fail) this.onerror(); else { this.naturalWidth = m.width; this.naturalHeight = m.height; this.onload(); } };
    if (deferred) loads.set(m.animal, finish); else queueMicrotask(finish);
  } }
  const loadImage = api.loadImage; api.loadImage = animal => loadImage(animal, Image);
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/pet'), 'utf8'), context);
  return { context, pet, bubble, cargo, cargoImage, canvas, pending, calls, classes, pixelCalls,
    update: received, time: value => time = value, complete: animal => loads.get(animal)(),
    event: (target, event) => listeners.get(`${target}:${event}`)?.(),
    get requests() { return requests; }, get unsubscribed() { return unsubscribed; },
    tick: () => { const [id, task] = pending.entries().next().value; pending.delete(id); time += task.ms; task.fn(); },
  };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
test('capybara uses natural behavior for eating, resting and curiosity after gestures', () => {
  assert.equal(atlas.baseAction('eating', 'capybara'), 'working');
  assert.equal(atlas.baseAction('working', 'capybara'), 'review');
  assert.equal(atlas.baseAction('taskReminder', 'capybara'), 'review');
  assert.equal(atlas.baseAction('sleepy', 'capybara'), 'waiting');
  assert.equal(atlas.baseAction('relaxing', 'capybara'), 'waiting');
  assert.equal(atlas.baseAction('bored', 'capybara'), 'idle');
  const p = atlas.createPlayer();
  p.update(state({animal:'capybara', mood:'eating'}), 0);
  assert.equal(p.sample(300).action, 'working');
  p.update(state({animal:'capybara', mood:'eating', animation:'pop', serial:1}), 400);
  assert.equal(p.sample(400).action, 'wave');
  assert.equal(p.sample(1100).action, 'working');
  p.update(state({animal:'dog', mood:'working', serial:2}), 1200);
  assert.equal(p.sample(1200).action, 'working', 'species-specific behavior never leaks into other pets');
});
test('generated companion atlases contain 36 bounded poses with verified original PNGs', () => {
  const { createHash } = require('node:crypto');
  for (const animal of ['cat', 'dog', 'capybara', 'otter', 'red-panda', 'baby-dragon', 'fluffy-rabbit', 'koala', 'hamster', 'seal', 'liangzi', 'realistic-cockroach', 'realistic-mosquito']) {
    const m = atlas.getManifest(animal);
    const png = fs.readFileSync(require('node:path').join(__dirname, '..', m.source));
    assert.equal(createHash('sha256').update(png).digest('hex'), m.sha256);
    assert.equal(png.readUInt32BE(16), m.width); assert.equal(png.readUInt32BE(20), m.height);
    assert.equal(png[25], 6, 'PNG contains RGBA pixels');
    assert.equal(m.frames.length, 9);
    for (const frames of m.frames) {
      assert.equal(frames.length, 4);
      for (const [x,y,w,h,left,top] of frames) {
        assert.ok(x >= 0 && y >= 0 && x+w <= m.width && y+h <= m.height);
        assert.ok(left >= 0 && top >= 0 && left+w <= m.cellWidth && top+h <= m.cellHeight);
      }
    }
    const p = atlas.createPlayer(); p.update(state({animal, animation:'pop'}), 0);
    assert.equal(p.sample(0).action, 'wave'); assert.equal(p.sample(700).action, 'idle');
  }
  assert.equal(atlas.getManifest('__proto__'), null);
});
test('switching skins while images load cannot show the previous animal; each atlas is cached separately', async () => {
  const r = renderer({deferred:true});
  r.update(state({animal:'cat'})); r.update(state({animal:'dog'}));
  r.complete('cat'); await settle();
  assert.equal(r.pet.dataset.renderer, 'pixel'); assert.equal(r.pet.dataset.assetStatus, 'loading');
  assert.equal(r.pixelCalls.at(-1)[0], 'dog');
  r.complete('dog'); await settle();
  assert.equal(r.pet.dataset.assetStatus, 'ready');
  assert.equal(r.calls.filter(c=>c[0]==='atlas').at(-1)[1].source, atlas.manifests.dog.source);
  for (const animal of ['cat','dog','cat']) {
    r.update(state({animal, mood:'reading', serial:1}));
    assert.equal(r.pet.dataset.renderer, 'atlas'); assert.equal(r.pet.dataset.action, 'review');
    const draw = r.calls.filter(c=>c[0]==='atlas').at(-1);
    assert.deepEqual(draw.slice(2,6), Array.from(atlas.manifests[animal].frames[8][0].slice(0,4)));
    assert.equal(draw[1].source, atlas.manifests[animal].source);
    assert.equal(r.canvas.width, 136); assert.equal(r.canvas.height, 136);
    assert.equal(r.classes.has('pop'), false);
  }
  assert.equal(r.requests, 2); r.event('window','unload');
});
test('companion failures keep their own pixel fallback and are not retried on broadcasts', async () => {
  const r = renderer({fail:true});
  for (const animal of ['cat','dog','capybara','cat']) {
    r.update(state({animal})); await settle();
    assert.equal(r.pet.dataset.assetStatus, 'failed'); assert.equal(r.pet.dataset.renderer, 'pixel');
    assert.equal(r.pixelCalls.at(-1)[0], animal);
  }
  assert.equal(r.requests, 3); r.event('window','unload');
});
test('smooth renderer uses atlas crop, Retina backing size and no CSS double jump at every size', async () => {
  const r = renderer(); r.update(state()); await settle();
  assert.equal(r.requests, 1); assert.equal(r.pet.dataset.assetStatus, 'ready');
  for (const size of [48, 68, 96, 128]) {
    r.update(state({ size, mood: 'working', serial: 1 }));
    assert.equal(r.canvas.height, size * 2);
    assert.equal(r.canvas.width, Math.round(size * 192 / 208 * 2));
    const draw = r.calls.filter(call => call[0] === 'atlas').at(-1);
    assert.equal(draw[3], 7 * 208); assert.equal(draw[4], 192); assert.equal(draw[5], 208);
    assert.equal(r.pending.size, 1);
  }
  r.update(state({ serial: 2, animation: 'jump', mood: 'happy' }));
  assert.equal(r.pet.dataset.action, 'jump'); assert.equal(r.classes.has('jump'), false);
  r.time(700); r.update(state({ serial: 2, animation: 'jump', mood: 'happy' }));
  assert.equal(r.pet.dataset.action, 'idle');
  r.update(state({ animal: 'penguin', serial: 3, animation: 'pop' }));
  assert.equal(r.canvas.width, 32); assert.equal(r.pet.dataset.renderer, 'pixel'); assert.ok(r.classes.has('pop'));
  assert.equal(r.pixelCalls.at(-1)[0], 'penguin');
  r.update(state({ serial: 3 }));
  assert.equal(r.classes.has('pop'), false, 'changing skins clears old CSS gestures even with the same serial');
});
test('load failure falls back to existing fox; timers pause hidden, resume and clean up', async () => {
  const r = renderer({ fail: true }); r.update(state()); await settle();
  assert.equal(r.pet.dataset.assetStatus, 'failed'); assert.equal(r.pet.dataset.renderer, 'pixel');
  assert.equal(r.pixelCalls.at(-1)[0], 'fox'); assert.equal(r.pending.size, 1);
  assert.match(r.pet.title, /工程师/);
  r.update(state({ animal: 'penguin' })); assert.equal(r.pet.title, '');
  r.update(state());
  r.context.document.hidden = true; r.event('document', 'visibilitychange');
  assert.equal(r.pending.size, 0);
  r.time(20000); r.update(state({ serial: 1, bubble: 'hello' }));
  assert.equal(r.pending.size, 0); assert.equal(r.bubble.hidden, false);
  r.context.document.hidden = false; r.event('document', 'visibilitychange');
  assert.equal(r.pending.size, 1); assert.equal(r.requests, 1);
  r.event('window', 'unload'); assert.equal(r.pending.size, 0); assert.equal(r.unsubscribed, 1);
  r.update(state()); assert.equal(r.pending.size, 0);
});
test('hidden time does not advance atlas animation and reduced motion schedules no animation timer', async () => {
  const r = renderer(); r.update(state({ mood: 'working' })); await settle();
  r.time(250); r.update(state({ mood: 'working' }));
  const before = r.calls.filter(call => call[0] === 'atlas').at(-1)[2];
  r.context.document.hidden = true; r.event('document', 'visibilitychange');
  r.time(9000); r.context.document.hidden = false; r.event('document', 'visibilitychange');
  assert.equal(r.calls.filter(call => call[0] === 'atlas').at(-1)[2], before);
  r.event('window', 'unload');
  const still = renderer({ reduced: true }); still.update(state({ animation: 'jump', serial: 2 })); await settle();
  assert.equal(still.pending.size, 0); assert.equal(still.calls.filter(call => call[0] === 'atlas').at(-1)[2], 0);
  still.event('window', 'unload');
});

test('new companions use their own cached images and names during loading, success and failure', async () => {
  const animals=['otter','red-panda','baby-dragon','fluffy-rabbit','koala','hamster','seal','liangzi','realistic-cockroach','realistic-mosquito'];
  const r=renderer({deferred:true});
  for (const animal of animals) {
    r.update(state({animal,mood:'reading'}));
    assert.equal(r.bubble.textContent,`正在加载${atlas.getManifest(animal).name}…`);
  }
  for (const animal of animals.slice(0,-1)) { r.complete(animal); await settle(); }
  assert.equal(r.pet.dataset.renderer,'unavailable');
  r.complete(animals.at(-1)); await settle();
  for (const animal of animals) {
    for (const size of [48,68,96,128]) {
      r.update(state({animal,size,mood:'reading'}));
      assert.equal(r.pet.dataset.renderer,'atlas'); assert.equal(r.canvas.width,size*2);
      const draw=r.calls.filter(c=>c[0]==='atlas').at(-1);
      assert.equal(draw[1].source,atlas.getManifest(animal).source);
      assert.deepEqual(draw.slice(2,6),Array.from(atlas.getManifest(animal).frames[8][0].slice(0,4)));
    }
  }
  assert.equal(r.requests,animals.length); r.event('window','unload');
  const f=renderer({fail:true});
  for (const animal of animals) {
    f.update(state({animal})); await settle();
    assert.equal(f.pet.dataset.renderer,'unavailable'); assert.equal(f.pixelCalls.length,0);
    assert.equal(f.bubble.textContent,`${atlas.getManifest(animal).name}图集未能加载`);
    f.update(state({animal}));
  }
  assert.equal(f.requests,animals.length); f.event('window','unload');
});

test('atlas loads are cached independently for each animal', async () => {
  const api=freshAtlas(), loads=new Map();
  class Image {set src(value){const m=Object.values(api.manifests).find(m=>m.source===value);
    loads.set(m.animal,()=>{this.naturalWidth=m.width;this.naturalHeight=m.height;this.onload();});}}
  const fox=api.loadImage('engineer-fox',Image), rabbit=api.loadImage('koala',Image);
  assert.notEqual(fox,rabbit); assert.equal(api.loadImage('koala',Image),rabbit);
  loads.get('koala')(); assert.equal((await rabbit).naturalWidth,836);
  loads.get('engineer-fox')(); assert.equal((await fox).naturalWidth,1536);
});

test('switching skins during deferred loads never paints a different animal', async () => {
  const r=renderer({deferred:true});
  r.update(state()); r.update(state({animal:'koala',bubble:'hello'}));
  r.complete('engineer-fox'); await settle();
  assert.equal(r.pet.dataset.renderer,'unavailable'); assert.equal(r.pet.dataset.assetStatus,'loading');
  r.complete('koala'); await settle();
  assert.equal(r.pet.dataset.renderer,'atlas'); assert.equal(r.pet.dataset.assetStatus,'ready');
  assert.equal(r.bubble.textContent,'hello');
  const draw=r.calls.filter(c=>c[0]==='atlas').at(-1);
  assert.equal(draw[1].naturalWidth,836); assert.equal(r.requests,2); r.event('window','unload');
});

test('unsupported saved skin is reported instead of drawing a default cat', async () => {
  const r=renderer();r.update(state({animal:'future-fluffy-pet'}));await settle();
  assert.equal(r.pet.dataset.renderer,'unavailable');assert.equal(r.pet.dataset.assetStatus,'unsupported');
  assert.equal(r.pixelCalls.length,0);assert.match(r.bubble.textContent,/原选择已保留/);
  r.event('window','unload');
});

test('control actions override mood without resetting walking frames and hold jump until landing', () => {
  const p = atlas.createPlayer();
  const controlled = action => state({ mood: 'happy', control: { active: true, action } });
  p.update(controlled('left'), 0); p.update(controlled('left'), 350);
  assert.equal(p.sample(350).action, 'left'); assert.equal(p.sample(350).frame, 3);
  p.update(controlled('jump'), 400); assert.equal(p.sample(2000).action, 'jump');
  assert.equal(p.sample(2000).frame, 4);
  p.update(controlled('idle'), 2010); assert.equal(p.sample(2010).action, 'idle');
  p.update(state({ mood: 'working' }), 2100); assert.equal(p.sample(2100).action, 'working');
});

test('carry visual follows the pet with the item name and image; exiting mode removes it', async () => {
  const r=renderer();
  const carry={id:'file',name:'计划.md',phase:'carrying',progress:1,image:'data:image/png;base64,aGVsbG8=',source:{x:100,y:100,width:60,height:60}};
  r.update(state({control:{active:true,action:'left',facing:'left',left:20,top:100,carry}}));await settle();
  assert.equal(r.cargo.hidden,false);assert.equal(r.cargoImage.src,carry.image);
  assert.equal(r.pet.dataset.carryPhase,'carrying');assert.match(r.bubble.textContent,/抱着「计划.md」.*E 放下/);
  const left=r.cargo.style.transform;
  r.update(state({control:{active:true,action:'right',facing:'right',left:20,top:100,carry}}));
  assert.notEqual(r.cargo.style.transform,left,'cargo switches hands when turning');
  r.update(state({control:{active:false}}));assert.equal(r.cargo.hidden,true);assert.equal(r.pet.dataset.carryPhase,'');
  assert.equal(r.cargoImage.src,'assets/pets/carry-file.svg');r.event('window','unload');
});


test('koala eats eucalyptus, naps and stays curious during work without changing other companions', () => {
  assert.equal(atlas.baseAction('eating', 'koala'), 'working');
  assert.equal(atlas.baseAction('working', 'koala'), 'review');
  assert.equal(atlas.baseAction('focused', 'koala'), 'review');
  assert.equal(atlas.baseAction('relaxing', 'koala'), 'waiting');
  assert.equal(atlas.baseAction('sleeping', 'koala'), 'waiting');
  assert.equal(atlas.baseAction('working', 'dog'), 'working');
  const p=atlas.createPlayer();
  p.update(state({animal:'koala',mood:'eating',animation:'pop',serial:1}),0);
  assert.equal(p.sample(0).action,'wave');
  assert.equal(p.sample(700).action,'working');
  assert.equal(atlas.getManifest('koala').fallback,null);
});

test('pet reminder actions animate independently of keyboard control and hold the raised-paw pose', () => {
  const player = atlas.createPlayer();
  player.update(state({ reminder: { action: 'left' } }), 0);
  assert.equal(player.sample(300).action, 'left');
  player.update(state({ reminder: { action: 'wave' } }), 400);
  assert.equal(player.sample(400).action, 'wave');
  assert.equal(player.sample(4000).frame, atlas.manifest.actions.wave.frames - 1);
  player.update(state({ reminder: null }), 4100);
  assert.equal(player.sample(4100).action, 'idle');
});


test('hamster and seal keep natural activities and finish gestures in their own current mood', () => {
  for (const animal of ['hamster','seal']) {
    assert.equal(atlas.getManifest(animal).fallback,null);
    assert.equal(atlas.baseAction('relaxing',animal),'waiting');
    assert.equal(atlas.baseAction('sleeping',animal),'waiting');
    const p=atlas.createPlayer();
    p.update(state({animal,mood:'eating',animation:'pop',serial:1}),0);
    assert.equal(p.sample(0).action,'wave');
    assert.equal(p.sample(700).action,animal==='hamster'?'working':'idle');
    p.update(state({animal,mood:'working',animation:'jump',serial:2}),1000);
    assert.equal(p.sample(1000).action,'jump');
    assert.equal(p.sample(1700).action,animal==='hamster'?'review':'working');
  }
  assert.equal(atlas.baseAction('working','dog'),'working');
});


test('liangzi uses eating, resting and thumbs-up while keeping the original pets intact', () => {
  assert.equal(atlas.getManifest('liangzi').name,'大胃袋良子');
  assert.equal(atlas.getManifest('liangzi').fallback,null);
  assert.equal(atlas.baseAction('eating','liangzi'),'working');
  assert.equal(atlas.baseAction('working','liangzi'),'review');
  assert.equal(atlas.baseAction('focused','liangzi'),'review');
  assert.equal(atlas.baseAction('relaxing','liangzi'),'waiting');
  assert.equal(atlas.baseAction('sleeping','liangzi'),'waiting');
  assert.equal(atlas.baseAction('working','seal'),'working');
  const p=atlas.createPlayer();
  p.update(state({animal:'liangzi',mood:'eating',animation:'pop',serial:1}),0);
  assert.equal(p.sample(0).action,'wave');assert.equal(p.sample(700).action,'working');
  p.update(state({animal:'liangzi',mood:'working',animation:'jump',serial:2}),1000);
  assert.equal(p.sample(1000).action,'jump');assert.equal(p.sample(1700).action,'review');
});


test('isolated realistic frames clip neighboring poses and restore the canvas for later pets', async () => {
  const m=atlas.getManifest('liangzi');
  let clipped=0;
  for(const row of m.frames)for(const [x,y,w,h,left,top,clips] of row){
    if(!clips)continue;clipped++;
    assert.ok(clips.length>0);
    for(const [cx,cy,cw,ch] of clips)assert.ok(cx>=0&&cy>=0&&cw>0&&ch>0&&cx+cw<=w&&cy+ch<=h);
  }
  assert.ok(clipped>0,'the source contains closely spaced poses');
  const r=renderer();r.update(state({animal:'liangzi',mood:'eating'}));await settle();
  assert.ok(r.calls.some(c=>c[0]==='clip'));
  assert.equal(r.calls.filter(c=>c[0]==='save').length,r.calls.filter(c=>c[0]==='restore').length);
  r.update(state({animal:'cat'}));await settle();assert.equal(r.pet.dataset.renderer,'atlas');
  r.event('window','unload');
});


test('roaming uses world-paced frames, turns safely and yields to keyboard/reminder actions', async () => {
  const r = renderer();
  const roaming = {active:true,phase:'travel',action:'left',facing:'left',frame:2,tilt:42,left:12,top:136};
  r.update(state({animal:'realistic-cockroach',roaming}));await settle();
  assert.equal(r.pet.dataset.roaming,'active');assert.equal(r.pet.dataset.action,'left');
  const m=atlas.getManifest('realistic-cockroach'),draw=r.calls.filter(c=>c[0]==='atlas').at(-1);
  assert.deepEqual(draw.slice(2,6),Array.from(m.frames[2][2].slice(0,4)));
  assert.ok(r.calls.some(c=>c[0]==='rotate'&&Math.abs(c[1]-42*Math.PI/180)<.001));
  assert.equal(r.calls.at(-1)[0],'restore');
  const p=atlas.createPlayer();
  p.update(state({animal:'realistic-mosquito',roaming}),0);
  assert.equal(p.sample(10000).frame,2,'wall-clock broadcasts cannot restart or speed up physical gait');
  p.update(state({animal:'realistic-mosquito',roaming:{...roaming,frame:3,paused:true}}),10001);
  assert.equal(p.sample(20000).frame,3,'pause holds the physical wingbeat frame');
  p.update(state({animal:'realistic-mosquito',roaming,control:{active:true,action:'right'}}),20001);
  assert.equal(p.sample(20001).action,'right');
  p.update(state({animal:'realistic-mosquito',roaming,reminder:{action:'wave'}}),21001);
  assert.equal(p.sample(21001).action,'wave');
  r.update(state({animal:'realistic-cockroach',roaming:{...roaming,phase:'rest',action:'waiting',tilt:0}}));
  assert.ok(r.calls.some(c=>c[0]==='scale'&&c[1]<0),'left-facing insects keep their heading while resting');
  r.event('window','unload');
});


test('pixel renderer uses shared blink timing and stays still with reduced motion', () => {
  const r = renderer(); r.update(state({animal:'rabbit'}));
  assert.equal(r.pixelCalls.at(-1)[2], 0);
  r.time(2660); r.update(state({animal:'rabbit'}));
  assert.equal(r.pixelCalls.at(-1)[2], 3);
  assert.equal([...r.pending.values()][0].ms, 140);
  r.context.document.hidden = true; r.event('document', 'visibilitychange');
  r.time(10000); r.context.document.hidden = false; r.event('document', 'visibilitychange');
  assert.equal(r.pixelCalls.at(-1)[2], 3, 'hidden time does not skip the current pose');
  r.event('window', 'unload'); assert.equal(r.pending.size, 0);
  const still=renderer({reduced:true}); still.update(state({animal:'rabbit'}));
  still.time(2660); still.update(state({animal:'rabbit'}));
  assert.equal(still.pixelCalls.at(-1)[2], 0); assert.equal(still.pending.size, 0);
  still.event('window', 'unload');
});
test('hidden time does not advance atlas animation and reduced motion schedules no animation timer', async () => {
  const r = renderer(); r.update(state({ mood: 'working' })); await settle();
  r.time(250); r.update(state({ mood: 'working' }));
  const before = r.calls.filter(call => call[0] === 'atlas').at(-1)[2];
  r.context.document.hidden = true; r.event('document', 'visibilitychange');
  r.time(9000); r.context.document.hidden = false; r.event('document', 'visibilitychange');
  assert.equal(r.calls.filter(call => call[0] === 'atlas').at(-1)[2], before);
  r.event('window', 'unload');
  const still = renderer({ reduced: true }); still.update(state({ animation: 'jump', serial: 2 })); await settle();
  assert.equal(still.pending.size, 0); assert.equal(still.calls.filter(call => call[0] === 'atlas').at(-1)[2], 0);
  still.event('window', 'unload');
});
