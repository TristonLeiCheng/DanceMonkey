const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createReminderService, normalizeReminder, dueSlot } = require('../electron/reminders');
const { popupBounds } = require('../electron/reminder-popup');
function fixture(t, config = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-reminders-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let clock = new Date(2026, 9, 27, 8).getTime(), idle = 0;
  const events = [], errors = [];
  const configStore = { read: () => ({ healthReminderEnabled: false, ...config }), write: input => Object.assign(config, input) };
  const make = (extra = {}) => createReminderService({ directory, configStore, now: () => clock, getIdleSeconds: () => idle, onDue: (item, options) => events.push({ item, options }), onError: error => errors.push(error), ...extra });
  const service = make();
  return { directory, service, events, errors, make, advance: minutes => { clock += minutes * 60000; }, idle: value => { idle = value; }, at: (h, m = 0) => { clock = new Date(2026, 9, 27, h, m).getTime(); } };
}
const definition = (partial = {}) => ({ id: 'custom', title: '测试提醒', message: '内容', trigger: { skipWhenIdle: false }, schedule: { kind: 'IntervalMinutes', intervalMinutes: 1 }, ...partial });

test('reads legacy numeric enums, built-ins, runtime counts and global popup setting without losing data', t => {
  const f = fixture(t, { defaultReminderPopupStyle: 2 });
  f.service.importData({ reminders: [definition({ notifyStyle: 1, popupStyleOverride: 5, schedule: { kind: 2, times: ['9:00', '14:00'] } })] });
  const data = f.service.exportData();
  data.runtime.find(item => item.reminderId === 'custom').todayAckCount = 3;
  fs.writeFileSync(path.join(f.directory, 'reminders.json'), JSON.stringify(data));
  const loaded = f.make().list();
  const item = loaded.reminders.find(item => item.id === 'custom');
  assert.equal(item.schedule.kind, 'Daily'); assert.equal(item.notifyStyle, 'PetBubble');
  assert.equal(item.popupStyleOverride, 'Compact'); assert.equal(item.runtime.todayAckCount, 3);
  assert.equal(loaded.settings.defaultPopupStyle, 'DynamicIsland'); assert.equal(loaded.reminders.length, 3);
});

test('intervals fire once while pending, acknowledge persists, editing restarts interval', t => {
  const f = fixture(t); f.service.save(definition()); f.advance(1); f.service.tick(); f.service.tick();
  assert.equal(f.events.length, 1); assert.equal(f.service.list().reminders.at(-1).pending, true);
  f.service.act('custom', 'done');
  assert.equal(f.make().list().reminders.at(-1).runtime.todayAckCount, 1);
  f.advance(1); f.service.tick(); assert.equal(f.events.length, 2);
  f.service.save(definition()); assert.equal(f.service.list().reminders.at(-1).pending, false);
  assert.equal(f.service.list().reminders.at(-1).runtime.todayAckCount, 1);
  f.service.tick(); assert.equal(f.events.length, 2);
});

test('snooze fires at the chosen time for once and calendar schedules, once completes disabled', t => {
  const f = fixture(t); f.service.save(definition({ schedule: { kind: 'Once', onceAt: new Date(2026, 9, 27, 8).toISOString() } }));
  f.service.tick(); f.service.act('custom', 'snooze'); f.advance(9); f.service.tick(); assert.equal(f.events.length, 1);
  f.advance(1); f.service.tick(); assert.equal(f.events.length, 2); f.service.act('custom', 'done');
  assert.equal(f.service.list().reminders.at(-1).enabled, false);
  f.service.save(definition({ schedule: { kind: 'Daily', times: ['08:00'] } })); f.service.tick(); f.service.act('custom', 'snooze');
  f.advance(10); f.service.tick(); assert.equal(f.events.length, 4);
});

test('multiple daily slots never oscillate or replay earlier slots after acknowledging', t => {
  const f = fixture(t); f.service.save(definition({ schedule: { kind: 'Daily', times: ['08:00', '09:00', '10:00'] } }));
  f.at(9); f.service.tick(); f.service.act('custom', 'done');
  for (let i = 0; i < 4; i++) { f.service.tick(); }
  assert.equal(f.events.length, 1); f.at(10); f.service.tick(); assert.equal(f.events.length, 2);
  assert.equal(dueSlot(normalizeReminder(definition({ schedule: { kind: 'Weekly', weekdays: 1, times: ['08:00'] } })), new Date(2026, 9, 27, 10), null), null);
  assert.equal(dueSlot(normalizeReminder(definition({ schedule: { kind: 'Monthly', dayOfMonth: 28, times: ['08:00'] } })), new Date(2026, 9, 27, 10), null), null);
});

test('active use resets for idle, sleep gaps and restart; intervals skip idle', t => {
  const f = fixture(t); f.service.save(definition({ trigger: { skipWhenIdle: true }, schedule: { kind: 'ActiveUseInterval', intervalMinutes: 2 } }));
  f.advance(1); f.service.tick(); f.idle(301); f.advance(1); f.service.tick(); assert.equal(f.events.length, 0);
  f.idle(0); f.service.tick(); f.advance(1); f.service.tick(); assert.equal(f.events.length, 0);
  f.advance(1); f.service.tick(); assert.equal(f.events.length, 1);
  f.service.act('custom', 'done'); f.advance(5); f.service.tick(); assert.equal(f.events.length, 1);
  f.advance(1); f.service.tick(); f.advance(1); f.service.tick(); assert.equal(f.events.length, 2);
  f.advance(5); const restarted = f.make(); restarted.tick(); assert.equal(f.events.length, 3); // An unfinished notification is restored, without counting closed-app time.
});

test('test notification does not alter runtime; replace protects built-ins; invalid imports are atomic', t => {
  const f = fixture(t); f.service.save(definition());
  const before = f.service.exportData(); f.service.test('custom'); assert.deepEqual(f.service.exportData(), before); assert.equal(f.events[0].options.test, true);
  assert.throws(() => f.service.remove('builtin-water'), /不能删除/);
  assert.throws(() => f.service.importData({ reminders: [definition(), definition()] }, 'replace'), /重复/);
  assert.deepEqual(f.service.exportData(), before);
  f.service.importData({ reminders: [definition({ id: 'new' }), definition({ id: 'builtin-water', title: '篡改' })] }, 'replace');
  const list = f.service.list().reminders; assert.equal(list.length, 3); assert.equal(list.find(item => item.id === 'builtin-water').title, '该喝水啦');
  assert.equal(list.some(item => item.id === 'custom'), false);
});

test('corrupt files are retained and invalid schedules rejected', t => {
  const f = fixture(t); const file = path.join(f.directory, 'reminders.json'); fs.writeFileSync(file, '{bad');
  assert.throws(() => f.make(), /原文件已保留/); assert.equal(fs.readFileSync(file, 'utf8'), '{bad');
  assert.throws(() => normalizeReminder(definition({ schedule: { kind: 'Daily', times: ['25:00'] } })), /时间格式/);
  assert.throws(() => normalizeReminder(definition({ schedule: { kind: 'Weekly', weekdays: 0 } })), /星期/);
});

test('all popup placements respect display work area including negative coordinates', () => {
  const area = { x: -1440, y: 100, width: 1440, height: 900 };
  for (const style of ['GlassCard', 'Circular', 'DynamicIsland', 'Toast', 'Banner', 'Compact']) {
    const bounds = popupBounds(style, area);
    assert.ok(bounds.x >= area.x && bounds.x + bounds.width <= area.x + area.width);
    assert.ok(bounds.y >= area.y && bounds.y + bounds.height <= area.y + area.height);
  }
});


test('unfinished one-shot survives restart and a failed popup can retry without losing the reminder', t => {
  const f = fixture(t); f.service.save(definition({ schedule: { kind: 'Once', onceAt: new Date(2026, 9, 27, 8).toISOString() } }));
  const broken = f.make({ onDue: () => { throw new Error('window failed'); } });
  broken.tick(); assert.equal(f.errors.length, 1);
  assert.equal(broken.list().reminders.at(-1).runtime.lastTriggeredAt, undefined);
  const restored = f.make(); restored.tick(); assert.equal(f.events.length, 1);
  const reopened = f.make(); reopened.tick(); assert.equal(f.events.length, 2);
  reopened.act('custom', 'done'); f.make().tick(); assert.equal(f.events.length, 2);
});

test('island attaches to physical display edge through expansion, including menu/notch inset and negative coordinates', () => {
  for (const screenBounds of [{ x: 0, y: 0, width: 1512, height: 982 }, { x: -1920, y: -1080, width: 1920, height: 1080 }]) {
    const area = { ...screenBounds, y: screenBounds.y + 38, height: screenBounds.height - 80 };
    const collapsed = popupBounds('DynamicIsland', area, { screenBounds });
    const expanded = popupBounds('DynamicIsland', area, { screenBounds, expanded: true });
    assert.equal(collapsed.y, screenBounds.y); assert.equal(expanded.y, collapsed.y);
    assert.equal(collapsed.height, 44); assert.equal(expanded.height, 238);
    assert.equal(collapsed.x + collapsed.width / 2, screenBounds.x + screenBounds.width / 2);
    assert.equal(expanded.x + expanded.width / 2, collapsed.x + collapsed.width / 2);
  }
});

function popupFixture(t) {
  const { EventEmitter } = require('node:events');
  const { createReminderPopup } = require('../electron/reminder-popup');
  const handlers = new Map(), windows = [], actions = [];
  const display = { id: 1, bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 38, width: 1512, height: 900 } };
  const screen = Object.assign(new EventEmitter(), { getCursorScreenPoint: () => ({ x: 500, y: 500 }), getDisplayNearestPoint: () => display, getAllDisplays: () => [display], getPrimaryDisplay: () => display });
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height }; this.webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler() {}, send() {} }); windows.push(this); }
    setAlwaysOnTop(value, level) { this.level = level; }
    setVisibleOnAllWorkspaces() {}
    getBounds() { return this.bounds; }
    setBounds(value) { this.bounds = value; }
    showInactive() { this.shown = true; }
    show() { this.shown = true; }
    isDestroyed() { return !!this.dead; }
    loadFile() { return Promise.resolve(); }
    destroy() { this.dead = true; this.emit('closed'); }
    close() { let prevented = false; this.emit('close', { preventDefault() { prevented = true; } }); if (!prevented) this.destroy(); }
  }
  const ipcMain = { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) };
  const popup = createReminderPopup({ BrowserWindow: Window, screen, ipcMain, onAction: (...args) => actions.push(args) });
  t.after(() => popup.dispose());
  return { popup, windows, actions, screen, display, invoke: (name, sender, ...args) => handlers.get(`reminder-popup:${name}`)({ sender }, ...args) };
}

test('native popup has no full-window material/rounded frame and island can expand and collapse without shifting its top', t => {
  const f = popupFixture(t);
  f.popup.show({ id: 'water' }, { defaultPopupStyle: 'DynamicIsland', acrylic: true });
  const win = f.windows[0]; win.emit('ready-to-show');
  assert.equal(win.options.backgroundColor, '#00000000');
  assert.equal(win.options.roundedCorners, false); assert.equal(win.options.hasShadow, false);
  assert.equal(win.options.vibrancy, undefined); assert.equal(win.options.backgroundMaterial, undefined);
  assert.equal(win.options.enableLargerThanScreen, true); assert.equal(win.level, 'screen-saver');
  assert.equal(f.invoke('get', win.webContents).topInset, 38);
  assert.equal(f.invoke('get', win.webContents).islandBounds.collapsed.width, 300);
  assert.equal(f.invoke('get', win.webContents).islandBounds.expanded.width, 420);
  assert.equal(f.invoke('expand', {}, true, false), false);
  f.invoke('expand', win.webContents, true, false); assert.equal(win.bounds.height, 238); assert.equal(win.bounds.y, 0);
  f.invoke('expand', win.webContents, false, false); assert.equal(win.bounds.height, 44); assert.equal(win.bounds.y, 0);
  f.display.workArea.y = 24; f.screen.emit('display-metrics-changed'); assert.equal(win.bounds.height, 44);
});

test('border-free popup keeps test isolation, native close snooze and queued reminders', t => {
  const f = popupFixture(t);
  f.popup.show({ id: 'preview' }, { defaultPopupStyle: 'GlassCard', test: true, acrylic: true });
  f.popup.show({ id: 'water' }, { defaultPopupStyle: 'Toast', acrylic: true });
  assert.equal(f.windows.length, 1);
  f.invoke('act', f.windows[0].webContents, 'done');
  assert.equal(f.actions.length, 0); assert.equal(f.windows.length, 2);
  assert.equal(f.windows[1].options.vibrancy, undefined);
  f.windows[1].close(); assert.deepEqual(f.actions, [['water', 'snooze']]);
});
