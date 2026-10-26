const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { normalizeSettings, createMood, buildTaskReminder, clampBounds, ANIMALS } = require('../electron/pet-model');
const { createDesktopPet } = require('../electron/desktop-pet');
const { createAppSettings } = require('../electron/app-settings');
const sprites = require('../src/pet-sprites');

test('legacy pet configuration migrates, bad values normalize and partial settings saves preserve it', async () => {
  let config = { PetModeEnabled: true, PetAnimal: 'fox', PetDisplaySize: 128, PetPreventSleepEnabled: false, apiKey: 'keep-local' };
  const store = { read: () => config, write: (patch) => (config = { ...config, ...patch }) };
  let changed;
  const settings = createAppSettings(store, { onPetChanged: (value) => { changed = value; } });
  assert.equal(settings.get().petModeEnabled, true);
  assert.equal(settings.get().petAnimal, 'fox');
  assert.equal(settings.get().petPreventSleepEnabled, false);
  await settings.save({ globalChatHotkey: 'Ctrl+Alt+Q' });
  assert.equal(changed.petDisplaySize, 128);
  assert.equal(changed.petModeEnabled, true);
  assert.equal(config.apiKey, 'keep-local');
  assert.deepEqual(normalizeSettings({ petAnimal: '__proto__', petDisplaySize: 1000, todoReminderMinutes: Infinity, petModeEnabled: 'false' }), normalizeSettings({ petAnimal: 'cat' }));
  assert.equal(normalizeSettings({ todoReminderMinutes: 1 }).todoReminderMinutes, 45);
  assert.equal(normalizeSettings({ todoReminderMinutes: 999 }).todoReminderMinutes, 240);
});

test('unknown saved skin survives unrelated settings saves and a fresh service after restart', async () => {
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dm-pet-persistence-'));
  try {
    const {createLegacyConfig}=require('../electron/legacy-config');
    const store=createLegacyConfig(root);
    store.write({PetAnimal:'future-fluffy-pet',PetModeEnabled:true,PetDisplaySize:128});
    const settings=createAppSettings(store);
    assert.equal(settings.get().petAnimal,'future-fluffy-pet');
    await settings.save({globalChatHotkey:'Ctrl+Alt+Q'});
    const restarted=createAppSettings(createLegacyConfig(root));
    assert.equal(restarted.get().petAnimal,'future-fluffy-pet');
    assert.equal(restarted.get().petModeEnabled,true);assert.equal(restarted.get().petDisplaySize,128);
    await restarted.save({todoReminderEnabled:true});
    assert.equal(store.read().petAnimal,'future-fluffy-pet');
    await restarted.save({petAnimal:'otter'});
    assert.equal(createAppSettings(createLegacyConfig(root)).get().petAnimal,'otter');
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('pet menu saves only explicit edits, preserving a newer disk choice', () => {
  const h=harness({petModeEnabled:true,petAnimal:'fluffy-rabbit'});h.pet.sync();
  h.config.petAnimal='otter'; // Another settings window saved since this menu snapshot.
  h.emit('pet:menu');h.menu.find(item=>item.label==='宠物大小').submenu.find(item=>item.label==='96 px').click();
  assert.equal(h.config.petAnimal,'otter');assert.equal(h.pet.window.state.animal,'otter');h.pet.dispose();
});

test('all original species render with expressions and life accessories at all four frames', () => {
  assert.deepEqual(new Set(sprites.animals), new Set(Object.keys(ANIMALS).filter(id => !['engineer-fox', 'operator-rabbit', 'otter', 'red-panda', 'baby-dragon', 'fluffy-rabbit'].includes(id))));
  const appearances = new Set();
  for (const animal of sprites.animals) {
    appearances.add(Buffer.from(sprites.render(animal)).toString('base64'));
    for (const mood of ['normal', 'happy', 'bored', 'sleepy', 'eating', 'working', 'reading', 'exercising', 'relaxing']) {
      for (let frame = 0; frame < 4; frame++) {
        const pixels = sprites.render(animal, mood, frame);
        assert.equal(pixels.length, 4096);
        const opaque = pixels.filter((_, index) => index % 4 === 3 && pixels[index] > 0).length;
        assert.ok(opaque > 50 && opaque < 700, `${animal}/${mood} has sprite pixels and transparency`);
      }
    }
    assert.notDeepEqual(sprites.render(animal, 'normal'), sprites.render(animal, 'working'));
  }
  assert.equal(appearances.size, 13);
  assert.notDeepEqual(sprites.render('cat', 'normal', 0), sprites.render('cat', 'normal', 1));
  for (const animal of sprites.animals) {
    assert.notDeepEqual(sprites.render(animal, 'normal', 0), sprites.render(animal, 'normal', 3), `${animal} has a visible blink`);
    const pixels = sprites.render(animal);
    for (const corner of [0, 31, 31 * 32, 32 * 32 - 1]) assert.equal(pixels[corner * 4 + 3], 0, 'desktop corners stay transparent');
  }
});

test('pixel idle timing keeps a short blink and a longer resting pose, including after pause', () => {
  assert.deepEqual([0, 1399, 1400, 1959, 1960, 2659, 2660, 2799, 2800].map(sprites.frameAt), [0, 0, 1, 1, 2, 2, 3, 3, 0]);
  assert.equal(sprites.frameAt(2800 * 20 + 2660), 3);
  assert.equal(sprites.frameAt(NaN), 0);
});

test('pet responds to affection, boredom, sleep and respects disabled mood decay and temporary activities', () => {
  let time = 0;
  const mood = createMood({ now: () => time, random: () => 0 });
  for (let count = 0; count < 5; count++) mood.tap('cat');
  assert.equal(mood.mood, 'happy');
  time = 9 * 60000; mood.decay(true); assert.equal(mood.mood, 'bored');
  time = 16 * 60000; mood.decay(true); assert.equal(mood.mood, 'sleepy');
  assert.equal(mood.tap('dog').text, '汪汪！'); assert.equal(mood.mood, 'normal');
  time += 20 * 60000; mood.decay(false); assert.equal(mood.mood, 'normal');
  mood.set('focused', 120000); mood.decay(true); assert.equal(mood.mood, 'working');
  time += 180000; mood.decay(false); assert.equal(mood.mood, 'normal');
  mood.auto(); assert.equal(mood.mood, 'eating');
});

test('task reminders filter terminal/deferred tasks, rank deadlines and rotate without modifying the task list', () => {
  const tasks = [
    { Id: 'done', Title: '完成了', WorkflowStatus: 'Completed', DueDate: '2026-01-01' },
    { Id: 'deferred', Title: '推迟', WorkflowStatus: 'Deferred', DueDate: '2026-01-01' },
    { id: 'urgent', title: '重要', impact: 5, urgency: 5 },
    { Id: 'today', Title: '今日', DueDate: '2026-10-23' },
    { Id: 'overdue', Title: '逾期', DueDate: '2026-10-22' },
    { Id: 'blank', Title: '  ' },
  ];
  const snapshot = JSON.stringify(tasks);
  const date = new Date(2026, 9, 23, 9);
  const reminder = buildTaskReminder(tasks, null, date);
  assert.equal(reminder.id, 'overdue'); assert.match(reminder.text, /1 项逾期任务.*逾期/);
  assert.equal(buildTaskReminder(tasks, 'overdue', date).id, 'today');
  assert.equal(buildTaskReminder(tasks.slice(0, 2), null, date), null);
  assert.equal(JSON.stringify(tasks), snapshot);
});

test('removed monitors and negative display coordinates keep pet bounds inside the nearest working area', () => {
  const displays = [{ workArea: { x: -1600, y: 20, width: 1600, height: 900 } }, { workArea: { x: 0, y: 20, width: 1920, height: 1000 } }];
  assert.deepEqual(clampBounds({ x: -1700, y: 1000, width: 240, height: 204 }, displays), { x: -1600, y: 716, width: 240, height: 204 });
  assert.equal(clampBounds({ x: -1600, y: 900, width: 240, height: 204 }, displays.slice(1)).x, 0);
});

function harness(initial = {}) {
  let config = { ...initial }, time = 1000, cursor = { x: 500, y: 500 };
  const windows = [], intervals = new Map(), handlers = new Map(), blockers = new Set(), opens = [];
  let menu, id = 0;
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super(); windows.push(this); this.options = options; this.bounds = { ...options }; this.dead = false;
      this.webContents = Object.assign(new EventEmitter(), { send: (_channel, state) => { this.state = state; }, setWindowOpenHandler: () => {} });
    }
    isDestroyed() { return this.dead; }
    destroy() { this.dead = true; this.emit('closed'); }
    getBounds() { return this.bounds; }
    setBounds(bounds) { this.bounds = bounds; }
    setAlwaysOnTop() {} setVisibleOnAllWorkspaces() {} setIgnoreMouseEvents(value) { this.ignoring = value; }
    loadFile() {} showInactive() { this.shown = true; }
  }
  const area = { x: 0, y: 0, width: 1400, height: 900 };
  const screen = Object.assign(new EventEmitter(), { getPrimaryDisplay: () => ({ workArea: area }), getAllDisplays: () => [{ workArea: area }], getCursorScreenPoint: () => cursor });
  const ipc = { handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => handlers.set(name, fn) };
  const configStore = { read: () => config, write: (patch) => (config = { ...config, ...patch }) };
  const pet = createDesktopPet({ BrowserWindow: FakeWindow, screen, Menu: { buildFromTemplate: (items) => ({ popup() { menu = items; } }) },
    powerSaveBlocker: { start: () => { blockers.add(++id); return id; }, stop: (value) => blockers.delete(value) }, configStore,
    getTasks: () => [], openWorkspace: (section) => opens.push(section), now: () => time, random: () => 0,
    timers: { setInterval: (fn, ms) => { const key = ++id; intervals.set(key, { fn, ms }); return key; }, clearInterval: (key) => intervals.delete(key) },
  });
  pet.registerIpc(ipc);
  return { pet, screen, windows, blockers, intervals, opens, get menu() { return menu; }, get config() { return config; },
    time: (next) => { time = next; }, cursor: (next) => { cursor = next; },
    emit: (name, sender = pet.window?.webContents, value) => handlers.get(name)({ sender }, value),
  };
}

test('enable/disable releases native power blockers, windows and every timer; settings apply without duplicates', () => {
  const h = harness(); h.pet.sync(); assert.equal(h.windows.length, 0);
  h.pet.toggle(); const win = h.pet.window; win.emit('ready-to-show');
  assert.equal(win.shown, true); assert.equal(h.blockers.size, 1); assert.equal(h.intervals.size, 1);
  assert.equal(win.options.webPreferences.sandbox, true);
  h.pet.sync({ ...h.config, petAnimal: 'rabbit', petDisplaySize: 128, petPreventSleepEnabled: false });
  assert.equal(h.windows.length, 1); assert.equal(h.blockers.size, 0); assert.equal(win.state.animal, 'rabbit');
  h.pet.toggle(); assert.equal(win.isDestroyed(), true); assert.equal(h.pet.window, null); assert.equal(h.intervals.size, 0);
  h.pet.toggle(); assert.equal(h.windows.length, 2); assert.equal(h.intervals.size, 1);
  h.pet.dispose(); h.pet.dispose(); assert.equal(h.intervals.size, 0); assert.equal(h.blockers.size, 0);
  assert.equal(h.screen.listenerCount('display-removed'), 0);
});

test('pet IPC rejects other renderers, recognizes taps/double taps and saves clamped native drags', () => {
  const h = harness({ petModeEnabled: true }); h.pet.sync(); const win = h.pet.window;
  h.emit('pet:press', {}); assert.equal(h.intervals.size, 1);
  assert.equal(h.emit('pet:get', {}), null);
  h.emit('pet:press'); h.emit('pet:release'); assert.ok(win.state.bubble);
  h.time(1200); h.emit('pet:press'); h.emit('pet:release'); assert.deepEqual(h.opens, ['notes']);
  h.emit('pet:press'); h.cursor({ x: 800, y: 600 });
  [...h.intervals.values()].find((item) => item.ms === 16).fn(); h.emit('pet:release');
  assert.equal(h.config.petWindowX, win.getBounds().x); assert.equal(h.config.petWindowY, win.getBounds().y);
  const restored = { x: h.config.petWindowX, y: h.config.petWindowY };
  h.pet.toggle(); h.pet.toggle(); assert.equal(h.pet.window.getBounds().x, restored.x); assert.equal(h.pet.window.getBounds().y, restored.y);
  h.emit('pet:menu');
  assert.equal(h.menu.some((item) => item.label === '宠物外形'), false);
  assert.ok(h.menu.find((item) => item.label === '宠物大小').submenu.length);
  h.menu.find((item) => item.label === '宠物设置').click();
  assert.equal(h.opens.at(-1), 'settings');
  h.menu.find((item) => item.label === '关闭桌面宠物').click();
  assert.equal(h.config.petModeEnabled, false); h.pet.dispose();
});

test('task reminder timers honor enable and interval changes instead of resetting on unrelated settings saves', () => {
  const h = harness({ petModeEnabled: true, todoReminderEnabled: true, todoReminderMinutes: 45 }); h.pet.sync();
  const tick = () => [...h.intervals.values()].find((item) => item.ms === 1000).fn();
  h.time(44 * 60000); h.pet.sync({ ...h.config, petAnimal: 'cat' });
  h.time(46 * 60000); tick(); assert.match(h.pet.window.state.bubble, /任务都处理完/);
  h.pet.sync({ ...h.config, todoReminderEnabled: false });
  h.time(120 * 60000); tick(); assert.doesNotMatch(h.pet.window.state.bubble, /任务都处理完/);
  h.pet.dispose();
});


test('工程师 is additive, normalizes and applies from settings at every legacy size', () => {
  assert.equal(Object.keys(ANIMALS).length, 19);
  assert.equal(normalizeSettings({ petAnimal: 'engineer-fox' }).petAnimal, 'engineer-fox');
  const h = harness({ petModeEnabled: true }); h.pet.sync();
  h.config.petAnimal = 'engineer-fox';
  h.pet.sync();
  assert.equal(h.pet.window.state.animal, 'engineer-fox');
  for (const size of [48, 68, 96, 128]) {
    h.pet.sync({ ...h.config, petDisplaySize: size });
    assert.equal(h.pet.window.state.size, size);
    assert.equal(h.pet.window.getBounds().height, size + 136);
  }
  h.emit('pet:press'); h.emit('pet:release');
  assert.match(h.pet.window.state.bubble, /工程师/);
  assert.equal(h.pet.window.state.animation, 'pop');
  h.time(1200); h.emit('pet:press'); h.emit('pet:release');
  assert.deepEqual(h.opens, ['notes']);
  h.emit('pet:interactive', undefined, true); assert.equal(h.pet.window.ignoring, false);
  h.emit('pet:interactive', undefined, false); assert.equal(h.pet.window.ignoring, true);
  h.pet.dispose(); assert.equal(h.intervals.size, 0);
});

test('new companion species apply from settings and expose their own dialogue', () => {
  for (const animal of ['otter', 'red-panda', 'baby-dragon', 'fluffy-rabbit']) {
    assert.equal(normalizeSettings({petAnimal:animal}).petAnimal,animal);
    const h=harness({petModeEnabled:true,petAnimal:'cat'}); h.pet.sync();
    h.config.petAnimal=animal; h.pet.sync();
    assert.equal(h.config.petAnimal,animal); assert.equal(h.pet.window.state.animal,animal);
    h.emit('pet:press'); h.emit('pet:release');
    assert.ok(require('../src/pet-dialogue').taps[animal].includes(h.pet.window.state.bubble));
    h.pet.dispose();
  }
});

test('operator rabbit settings selection is explicit and keeps legacy rabbit untouched', () => {
  const h=harness({petModeEnabled:true,petAnimal:'rabbit'}); h.pet.sync();
  assert.equal(h.config.petAnimal,'rabbit');
  h.config.petAnimal='operator-rabbit'; h.pet.sync();
  assert.equal(h.config.petAnimal,'operator-rabbit');
  h.emit('pet:press'); h.emit('pet:release'); assert.match(h.pet.window.state.bubble,/服务|听|记下|小事/);
  h.pet.dispose();
});
