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
  assert.deepEqual(new Set(sprites.animals), new Set(Object.keys(ANIMALS).filter(id => !['engineer-fox', 'otter', 'red-panda', 'baby-dragon', 'fluffy-rabbit', 'koala', 'hamster', 'seal', 'liangzi', 'realistic-cockroach', 'realistic-mosquito'].includes(id))));
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

function harness(initial = {}, extra = {}) {
  let config = { ...initial }, time = 1000, cursor = { x: 500, y: 500 };
  const windows = [], intervals = new Map(), handlers = new Map(), blockers = new Set(), opens = [];
  let menu, menuClosed, id = 0;
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
    focus() { this.focused = true; } isFocused() { return this.focused; }
    getMediaSourceId() { return 'window:7:0'; }
  }
  const area = { x: 0, y: 0, width: 1400, height: 900 };
  const screen = Object.assign(new EventEmitter(), { getPrimaryDisplay: () => ({ workArea: area }), getAllDisplays: () => [{ workArea: area }], getCursorScreenPoint: () => cursor });
  const ipc = { handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => handlers.set(name, fn) };
  const configStore = { read: () => config, write: (patch) => (config = { ...config, ...patch }) };
  const pet = createDesktopPet({ BrowserWindow: FakeWindow, screen, Menu: { buildFromTemplate: (items) => ({ popup({ callback }) { menu = items; menuClosed = callback; } }) },
    powerSaveBlocker: { start: () => { blockers.add(++id); return id; }, stop: (value) => blockers.delete(value) }, configStore,
    getTasks: () => [], openWorkspace: (section) => opens.push(section), now: () => time, random: () => 0,
    desktopIcons: extra.desktopIcons,
    onReminderAction: extra.onReminderAction, onReminderFallback: extra.onReminderFallback,
    timers: { setInterval: (fn, ms) => { const key = ++id; intervals.set(key, { fn, ms }); return key; }, clearInterval: (key) => intervals.delete(key) },
  });
  pet.registerIpc(ipc);
  return { pet, screen, windows, blockers, intervals, opens, get menu() { return menu; }, get config() { return config; },
    closeMenu: () => menuClosed(),
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
  h.emit('pet:menu'); h.menu.find((item) => item.label === '关闭桌面宠物').click();
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


test('工程师 is additive, normalizes and is selectable in the existing menu at every legacy size', () => {
  assert.equal(Object.keys(ANIMALS).length, 24);
  assert.equal(normalizeSettings({ petAnimal: 'engineer-fox' }).petAnimal, 'engineer-fox');
  const h = harness({ petModeEnabled: true }); h.pet.sync();
  h.emit('pet:menu');
  const skins = h.menu.find(item => item.label === '宠物外形').submenu;
  assert.equal(skins.length, 24);
  skins.find(item => item.label === '工程师').click();
  assert.equal(h.config.petAnimal, 'engineer-fox');
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

test('new companion species persist through settings and expose their own menu and dialogue', () => {
  for (const animal of ['otter', 'red-panda', 'baby-dragon', 'fluffy-rabbit', 'koala', 'hamster', 'seal', 'liangzi', 'realistic-cockroach', 'realistic-mosquito']) {
    assert.equal(normalizeSettings({petAnimal:animal}).petAnimal,animal);
    const h=harness({petModeEnabled:true,petAnimal:'cat'}); h.pet.sync(); h.emit('pet:menu');
    h.menu.find(item=>item.label==='宠物外形').submenu.find(item=>item.label===ANIMALS[animal]).click();
    assert.equal(h.config.petAnimal,animal); assert.equal(h.pet.window.state.animal,animal);
    h.emit('pet:press'); h.emit('pet:release');
    assert.ok(require('../src/pet-dialogue').taps[animal].includes(h.pet.window.state.bubble));
    h.pet.dispose();
  }
});

test('retired operator skin resolves to the default and is absent from the pet menu', async () => {
  let config={petModeEnabled:true,petAnimal:'operator-rabbit',petDisplaySize:128};
  const settings=createAppSettings({read:()=>config,write:patch=>(config={...config,...patch})});
  assert.equal(settings.get().petAnimal,'human');
  assert.equal(normalizeSettings({PetAnimal:'operator-rabbit'}).petAnimal,'human');
  assert.equal(normalizeSettings({petAnimal:'future-pet'}).petAnimal,'future-pet');
  await settings.save({globalChatHotkey:'Ctrl+Alt+Q'});
  assert.equal(config.petAnimal,'human');
  assert.equal(config.petModeEnabled,true);assert.equal(config.petDisplaySize,128);
  assert.equal(Object.hasOwn(ANIMALS,'operator-rabbit'),false);
  assert.equal(require('../src/pet-atlas').getManifest('operator-rabbit'),null);
  const h=harness({petModeEnabled:true,petAnimal:'rabbit'});h.pet.sync();h.emit('pet:menu');
  const skins=h.menu.find(item=>item.label==='宠物外形').submenu;
  assert.equal(skins.some(item=>item.label==='话务员兔子'),false);
  assert.equal(h.config.petAnimal,'rabbit');h.pet.dispose();
});

test('control is off by default and only menu enables it; input is scoped and exit releases timers', () => {
  const h = harness({ petModeEnabled: true, petAnimal: 'engineer-fox' }); h.pet.sync();
  const win = h.pet.window, key = (code, down, sender) => h.emit('pet:key', sender, { code, down });
  assert.equal(win.state.control.active, false);
  key('ArrowLeft', true); assert.equal(h.intervals.size, 1);
  h.emit('pet:menu'); h.menu.find(i => i.id === 'pet-control').click(); h.closeMenu();
  assert.equal(win.state.control.active, true); assert.equal(win.focused, true); assert.equal(h.intervals.size, 2);
  const step = time => { h.time(time); [...h.intervals.values()].find(t => t.ms === 16).fn(); };
  const start = win.getBounds().x;
  key('ArrowLeft', true, {}); step(1016); assert.equal(win.getBounds().x, start);
  key('ArrowLeft', true); step(1032); assert.ok(win.getBounds().x < start);
  win.focused = false; win.emit('blur'); assert.equal(win.state.control.active, false);
  assert.equal(h.intervals.size, 1); assert.equal(win.ignoring, true);
  h.emit('pet:menu'); h.menu.find(i => i.id === 'pet-control').click(); h.closeMenu();
  h.emit('pet:control-exit'); assert.equal(win.state.control.active, false);
  assert.equal(h.config.control, undefined);
  h.pet.toggle(); h.pet.toggle(); assert.equal(h.pet.window.state.control.active, false);
  h.pet.dispose(); assert.equal(h.intervals.size, 0);
});

test('menu pauses motion; choosing another action, display changes and disabling pet clean up control', () => {
  const h = harness({ petModeEnabled: true }); h.pet.sync();
  const enable = () => { h.emit('pet:menu'); h.menu.find(i => i.id === 'pet-control').click(); h.closeMenu(); };
  enable(); h.emit('pet:menu'); h.pet.window.emit('blur');
  assert.equal(h.pet.window.state.control.active, true, 'native menu blur does not accidentally end control');
  h.menu.find(i => i.label === '笔记').click(); h.closeMenu();
  assert.equal(h.pet.window.state.control.active, false); assert.deepEqual(h.opens, ['notes']);
  enable(); h.screen.emit('display-removed'); assert.equal(h.pet.window.state.control.active, false);
  enable(); h.emit('pet:menu'); h.pet.window.focused = false; h.pet.window.emit('blur'); h.closeMenu();
  assert.equal(h.pet.window.state.control.active, false, 'menu dismissal into another app never steals focus');
  enable(); h.pet.toggle(); assert.equal(h.intervals.size, 0);
  h.pet.dispose();
});

const flushScene = () => new Promise(resolve => setImmediate(resolve));
test('desktop reading starts only in explicit control, is throttled, and aborts on exit', async () => {
  const reads = []; let resolveRead;
  const h = harness({ petModeEnabled: true }, { desktopIcons: { read: options => {
    reads.push(options); return new Promise(resolve => { resolveRead = resolve; });
  } } }); h.pet.sync(); await flushScene(); assert.equal(reads.length, 0);
  const frame = time => { h.time(time); [...h.intervals.values()].find(t => t.ms === 16).fn(); };
  h.emit('pet:menu'); h.menu.find(i => i.id === 'pet-control').click(); h.closeMenu();
  frame(1016); await flushScene(); assert.equal(reads.length, 1); assert.equal(reads[0].excludeWindowId, 7);
  frame(1032); await flushScene(); assert.equal(reads.length, 1);
  h.emit('pet:control-exit'); assert.equal(reads[0].signal.aborted, true);
  resolveRead({ status: 'ready', icons: [{ id: 'late', name: 'late.md', x: 100, y: 500, width: 60, height: 60 }] });
  await flushScene(); assert.equal(h.pet.window.state.control.active, false);
  h.pet.dispose();
});
test('supported platforms are cleared when refreshed scene disappears or becomes stale', async () => {
  let reads = 0, pending;
  const h = harness({ petModeEnabled: true }, { desktopIcons: { read: () => {
    reads++; if (reads === 1) return Promise.resolve({ status: 'ready', icons: [{ id: 'file', name: '计划.md', x: 100, y: 500, width: 60, height: 60 }] });
    return new Promise(resolve => { pending = resolve; });
  } } }); h.pet.sync();
  h.emit('pet:menu'); h.menu.find(i => i.id === 'pet-control').click(); h.closeMenu();
  const frame = time => { h.time(time); [...h.intervals.values()].find(t => t.ms === 16).fn(); };
  frame(1016); await flushScene(); assert.equal(h.pet.window.state.control.iconCount, 1);
  frame(2000); await flushScene(); assert.equal(reads, 1);
  frame(2600); await flushScene(); assert.equal(reads, 2);
  frame(5100); assert.equal(h.pet.window.state.control.iconCount, 0);
  pending({ status: 'ready', icons: [] }); await flushScene(); assert.equal(h.pet.window.state.control.iconCount, 0);
  h.pet.dispose();
});
test('denied Finder permission keeps keyboard control available and is not repeatedly requested', async () => {
  let reads = 0;
  const h = harness({ petModeEnabled: true }, { desktopIcons: { read: async () => {
    reads++; throw Object.assign(new Error('Denied'), { sceneStatus: 'permission-required' });
  } } }); h.pet.sync(); h.emit('pet:menu'); h.menu.find(i => i.id === 'pet-control').click(); h.closeMenu();
  const frame = time => { h.time(time); [...h.intervals.values()].find(t => t.ms === 16).fn(); };
  frame(1016); await flushScene(); assert.equal(h.pet.window.state.control.iconsStatus, 'permission-required');
  frame(60000); await flushScene(); assert.equal(reads, 1); assert.equal(h.pet.window.state.control.active, true);
  h.pet.dispose();
});

test('E only picks nearby icons in focused control; repeats do not drop; exit discards pending images', async () => {
  let lookups=0,finishImage,clears=0;
  const p=Object.freeze({id:'file',name:'计划.md',x:590,y:700,width:60,height:60});
  const h=harness({petModeEnabled:true,petAnimal:'engineer-fox',petWindowX:500,petWindowY:500},{desktopIcons:{
    read:async()=>({status:'ready',icons:[p]}),clear:()=>clears++,getIcon:id=>{assert.equal(id,'file');lookups++;return new Promise(resolve=>{finishImage=resolve;});}
  }});h.pet.sync();
  const e=(down,sender)=>h.emit('pet:key',sender,{code:'KeyE',down});
  e(true);assert.equal(lookups,0);
  h.emit('pet:menu');h.menu.find(i=>i.id==='pet-control').click();h.closeMenu();
  const frame=time=>{h.time(time);[...h.intervals.values()].find(t=>t.ms===16).fn();};
  frame(1016);await flushScene();
  e(true,{});await flushScene();assert.equal(lookups,0);
  e(true);await flushScene();assert.equal(lookups,1);assert.equal(h.pet.window.state.control.carry.phase,'picking-up');
  frame(1600);e(true);assert.equal(h.pet.window.state.control.carry.phase,'carrying','held E never toggles twice');
  e(false);e(true);assert.equal(h.pet.window.state.control.carry.phase,'putting-down');
  frame(2000);assert.equal(h.pet.window.state.control.carry,null);
  e(false);e(true);await flushScene();assert.equal(lookups,2);
  h.emit('pet:control-exit');finishImage('data:image/png;base64,aGVsbG8=');await flushScene();
  assert.equal(h.pet.window.state.control.active,false);assert.ok(clears>=2);assert.equal(h.config.carry,undefined);
  assert.deepEqual(p,{id:'file',name:'计划.md',x:590,y:700,width:60,height:60});
  h.pet.dispose();
});

const reminderItem = (id = 'water') => ({ id, title: '该喝水啦', message: '起身喝水', icon: '💧', doneLabel: '已喝水', laterLabel: '稍后提醒', snoozeMinutes: 10 });
const reminderFrame = h => [...h.intervals.values()].find(item => item.ms === 16)?.fn();
test('pet reminder grows at center, validates sender/token, acknowledges once and restores its exact home', () => {
  const actions = [];
  const h = harness({ petModeEnabled: true, petAnimal: 'capybara', petDisplaySize: 96 }, { onReminderAction: (...args) => actions.push(args) });
  h.pet.sync(); const home = h.pet.window.getBounds(), saved = { ...h.config };
  assert.equal(h.pet.notifyReminder(reminderItem(), { test: false }), true);
  assert.equal(h.pet.window.state.reminder.phase, 'walking');
  h.time(20000); reminderFrame(h);
  const current = h.pet.window.state.reminder;
  assert.equal(current.phase, 'presenting'); assert.ok(h.pet.window.state.size > 96);
  assert.equal(h.emit('pet:reminder-act', {}, { token: current.token, action: 'done' }), false);
  assert.equal(h.emit('pet:reminder-act', undefined, { token: current.token - 1, action: 'done' }), false);
  assert.equal(h.emit('pet:reminder-act', undefined, { token: current.token, action: 'delete' }), false);
  assert.equal(h.emit('pet:reminder-act', undefined, { token: current.token, action: 'done' }), true);
  assert.equal(h.emit('pet:reminder-act', undefined, { token: current.token, action: 'done' }), false);
  assert.deepEqual(actions, [['water', 'done']]);
  h.time(60000); reminderFrame(h);
  assert.equal(h.pet.window.state.reminder, null); assert.equal(h.pet.window.state.size, 96);
  assert.deepEqual(h.pet.window.getBounds(), home); assert.deepEqual(h.config, saved);
  assert.equal(h.intervals.size, 1); h.pet.dispose();
});
test('pet reminders queue, preview never acknowledges and external dismissal removes queued/active items', () => {
  const actions = [];
  const h = harness({ petModeEnabled: true }, { onReminderAction: (...args) => actions.push(args) }); h.pet.sync();
  h.pet.notifyReminder(reminderItem('preview'), { test: true });
  h.pet.notifyReminder(reminderItem('next')); h.pet.notifyReminder(reminderItem('removed'));
  h.pet.dismissReminder('removed'); h.time(20000); reminderFrame(h);
  h.emit('pet:reminder-act', undefined, { token: h.pet.window.state.reminder.token, action: 'done' });
  h.time(60000); reminderFrame(h); assert.equal(h.pet.window.state.reminder.id, 'next');
  assert.deepEqual(actions, []);
  h.pet.dismissReminder('next'); h.time(100000); reminderFrame(h);
  assert.equal(h.pet.window.state.reminder, null); assert.equal(h.intervals.size, 1); h.pet.dispose();
});
test('failed acknowledgement stays visible and retry works; snooze is passed through unchanged', () => {
  let fail = true; const actions = [];
  const h = harness({ petModeEnabled: true }, { onReminderAction: (...args) => { if (fail) throw new Error('磁盘暂不可写'); actions.push(args); } }); h.pet.sync();
  h.pet.notifyReminder(reminderItem()); h.time(20000); reminderFrame(h);
  const input = { token: h.pet.window.state.reminder.token, action: 'snooze' };
  assert.equal(h.emit('pet:reminder-act', undefined, input), false);
  assert.equal(h.pet.window.state.reminder.phase, 'presenting'); assert.match(h.pet.window.state.reminder.error, /磁盘/);
  fail = false; assert.equal(h.emit('pet:reminder-act', undefined, input), true);
  assert.deepEqual(actions, [['water', 'snooze']]); h.pet.dispose();
});
test('disable, hide or monitor changes hand unfinished reminders to popup; disposal releases everything quietly', () => {
  for (const reason of ['disable', 'hide', 'display', 'dispose']) {
    const fallback = []; const h = harness({ petModeEnabled: true }, { onReminderFallback: (...args) => fallback.push(args) }); h.pet.sync();
    h.pet.notifyReminder(reminderItem('one'), { test: true }); h.pet.notifyReminder(reminderItem('two'), { defaultPopupStyle: 'Toast' });
    if (reason === 'disable') h.pet.sync({ ...h.config, petModeEnabled: false });
    if (reason === 'hide') h.pet.window.emit('hide');
    if (reason === 'display') h.screen.emit('display-removed');
    if (reason === 'dispose') h.pet.dispose();
    assert.deepEqual(fallback.map(([item]) => item.id), reason === 'dispose' ? [] : ['one', 'two']);
    if (reason !== 'dispose') assert.equal(fallback[0][1].test, true);
    assert.equal([...h.intervals.values()].filter(item => item.ms === 16).length, 0);
    h.pet.dispose(); assert.equal(h.intervals.size, 0);
  }
});
test('reduced motion skips travel; inactive or keyboard-controlled pets decline delivery for popup fallback', () => {
  const h = harness({ petModeEnabled: true }); h.pet.sync();
  h.emit('pet:reduced-motion', undefined, true); h.pet.notifyReminder(reminderItem(), { test: true });
  assert.equal(h.pet.window.state.reminder.phase, 'presenting');
  h.emit('pet:reminder-act', undefined, { token: h.pet.window.state.reminder.token, action: 'done' });
  assert.equal(h.pet.window.state.reminder, null);
  h.emit('pet:menu'); h.menu.find(item => item.id === 'pet-control').click(); h.closeMenu();
  assert.equal(h.pet.notifyReminder(reminderItem()), false); h.pet.dispose();
  assert.equal(h.pet.notifyReminder(reminderItem()), false);
});

test('autonomous insects pause for hover/menu/drag/reminders, never read desktop icons or save random positions', () => {
  let reads = 0;
  const h = harness({petModeEnabled:true,petAnimal:'realistic-cockroach',petDisplaySize:96}, {desktopIcons:{read:()=>{reads++;return Promise.resolve({icons:[]});}}});
  h.pet.sync(); const win=h.pet.window;win.emit('ready-to-show');
  assert.equal([...h.intervals.values()].some(t=>t.ms===32),false,'waits for visible artwork');
  h.emit('pet:ready');
  let time=1000;
  const advance = (count=80) => {for(let i=0;i<count;i++){h.time(time+=32);[...h.intervals.values()].find(t=>t.ms===32)?.fn();}};
  const point = () => ({x:win.bounds.x+win.state.roaming.left,y:win.bounds.y+win.state.roaming.top});
  const initial=point();advance();assert.notDeepEqual(point(),initial);
  assert.equal(win.state.control.active,false);assert.equal(win.focused,undefined);assert.equal(reads,0);
  assert.equal(h.config.petWindowX,undefined);assert.equal(h.config.petWindowY,undefined);
  h.emit('pet:interactive',win.webContents,true);const hover=point();advance();assert.deepEqual(point(),hover);
  h.emit('pet:interactive',win.webContents,false);advance();assert.notDeepEqual(point(),hover);
  h.emit('pet:menu');const menu=point();advance();assert.deepEqual(point(),menu);h.closeMenu();
  h.emit('pet:press');const drag=point();advance();assert.deepEqual(point(),drag);
  h.cursor({x:600,y:520});h.emit('pet:release');assert.ok(Number.isFinite(h.config.petWindowX));
  const persisted={...h.config};advance();assert.deepEqual(h.config,persisted);
  h.pet.notifyReminder(reminderItem(),{test:true});const reminderBounds={...win.bounds};advance();assert.deepEqual(win.bounds,reminderBounds);
  h.pet.dismissReminder('water');h.pet.dispose();assert.equal(h.intervals.size,0);
});

test('roaming respects settings, reduced motion, hidden windows, display changes and manual control', () => {
  const h=harness({petModeEnabled:true,petAnimal:'realistic-mosquito',petDisplaySize:96});
  h.pet.sync();const win=h.pet.window;win.emit('ready-to-show');h.emit('pet:ready');
  const step=()=>{for(let t=1032;t<4000;t+=32){h.time(t);[...h.intervals.values()].find(i=>i.ms===32)?.fn();}};
  h.emit('pet:reduced-motion',win.webContents,true);const still={...win.bounds};step();assert.deepEqual(win.bounds,still);
  h.emit('pet:reduced-motion',win.webContents,false);h.emit('pet:menu');h.menu.find(i=>i.id==='pet-control').click();h.closeMenu();
  assert.equal(win.state.roaming,null);assert.equal(win.state.control.active,true);
  assert.equal([...h.intervals.values()].some(i=>i.ms===32),false);
  h.emit('pet:control-exit');[...h.intervals.values()].find(i=>i.ms===1000).fn();assert.ok(win.state.roaming);
  win.emit('hide');assert.equal([...h.intervals.values()].some(i=>i.ms===32),false);
  win.emit('show');assert.equal([...h.intervals.values()].some(i=>i.ms===32),true);
  h.screen.emit('display-metrics-changed');assert.ok(win.state.roaming);
  h.emit('pet:menu');h.menu.find(i=>i.id==='pet-roaming').click({checked:false});h.closeMenu();
  assert.equal(h.config.petRoamingEnabled,false);assert.equal(win.state.roaming,null);
  h.pet.sync({...h.config,petAnimal:'cat',petRoamingEnabled:true});h.emit('pet:ready');
  assert.equal(win.state.roaming,null);assert.equal([...h.intervals.values()].some(i=>i.ms===32),false);
  h.pet.dispose();assert.equal(h.intervals.size,0);
});
