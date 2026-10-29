const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWorkspace } = require('../electron/workspace');
const { createNoteWindows } = require('../electron/note-windows');
function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-documents-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const A = createWorkspace(path.join(temp, 'A')), B = createWorkspace(path.join(temp, 'B'));
  A.write('same.md', '# A'); B.write('same.md', '# B');
  let workspace = A, busy = false, allowed = false;
  const handlers = {}, events = {}, errors = [], changed = [], writes = [];
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; this.webContents = new EventEmitter(); this.webContents.mainFrame = {};
      this.webContents.send = (channel, payload) => writes.push({ win: this, channel, payload }); this.webContents.setWindowOpenHandler = () => {}; }
    static fromWebContents(sender) { return manager.windows().find(win => win.webContents === sender); }
    isDestroyed() { return Boolean(this.destroyed); }
    isMinimized() { return false; }
    show() {} focus() { this.focused = true; } setMenuBarVisibility() {} loadURL(url) { this.url = url; }
    close() { const event = { prevented: false, preventDefault() { this.prevented = true; } }; this.emit('close', event); if (!event.prevented) { this.destroyed = true; this.emit('closed'); } }
  }
  const manager = createNoteWindows({ BrowserWindow: Window,
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; }, on: (name, fn) => { events[name] = fn; } },
    dialog: { showErrorBox: (...args) => errors.push(args), showOpenDialog: async () => ({ canceled: true }) },
    getWorkspace: () => workspace, rendererUrl: hash => `http://localhost/${hash}`, icon: '',
    assertWritable: generation => { if (busy || generation !== 5) throw new Error('stale'); },
    isBusy: () => busy, canClose: () => allowed, changed: root => changed.push(root), timeoutMs: 15 });
  t.after(() => { allowed = true; for (const win of manager.windows()) win.close(); });
  const event = win => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame });
  return { manager, A, B, handlers, events, errors, changed, writes, event,
    switch: () => { workspace = B; }, busy: value => { busy = value; }, allow: () => { allowed = true; } };
}
test('separate documents deduplicate canonical paths and stay pinned across vault switches', t => {
  const f = fixture(t), { handlers: h } = f;
  h['note:open']({}, 'same.md'); const a = f.manager.windows()[0];
  h['note:open']({}, './same.md'); assert.equal(f.manager.windows().length, 1); assert.equal(a.focused, true);
  f.switch(); h['note:open']({}, 'same.md'); const b = f.manager.windows()[1];
  assert.equal(f.manager.windows().length, 2);
  h['note:write'](f.event(a), '# changed A', 5);
  assert.equal(f.A.read('same.md'), '# changed A'); assert.equal(f.B.read('same.md'), '# B');
  assert.equal(h['note:read'](f.event(b)).content, '# B');
  assert.throws(() => h['note:write'](f.event(a), 'stale', 4), /stale/);
  assert.throws(() => h['note:open']({}, '../escape.md'));
});
test('external edits, deletion and symlinks cannot be overwritten; explicit reload adopts disk', t => {
  const f = fixture(t), h = f.handlers;
  h['note:open']({}, 'same.md'); const win = f.manager.windows()[0], event = f.event(win);
  f.A.write('same.md', 'external');
  assert.throws(() => h['note:write'](event, 'local', 5), /其他程序/);
  assert.equal(f.A.read('same.md'), 'external');
  assert.equal(h['note:read'](event).content, 'external'); h['note:write'](event, 'merged', 5);
  fs.unlinkSync(path.join(f.A.root, 'same.md'));
  assert.throws(() => h['note:write'](event, 'recreate', 5), /移动或删除/);
  assert.equal(fs.existsSync(path.join(f.A.root, 'same.md')), false);
  assert.throws(() => h['note:read']({ ...event, senderFrame: {} }), /无效/);
  if (process.platform !== 'win32') {
    fs.symlinkSync(path.join(f.B.root, 'same.md'), path.join(f.A.root, 'same.md'));
    assert.throws(() => h['note:write'](event, 'escaped', 5), /移动或删除/);
  }
});
test('native close waits for successful flush, rejects another window and keeps failed drafts', async t => {
  const f = fixture(t); f.handlers['note:open']({}, 'same.md'); const win = f.manager.windows()[0];
  win.close(); assert.equal(win.isDestroyed(), false); assert.equal(f.writes.at(-1).channel, 'note:close-request');
  assert.doesNotThrow(() => f.events['note:close-ready']({ sender: {}, senderFrame: {} }, {}));
  f.events['note:close-ready'](f.event(win), { error: true }); assert.equal(win.isDestroyed(), false); assert.equal(f.errors.length, 1);
  assert.throws(() => f.manager.assertAvailable(f.A.root, 'same.md'), /独立窗口/);
  f.busy(true); win.close(); assert.equal(f.writes.length, 1); f.busy(false);
  win.close(); f.events['note:close-ready'](f.event(win), {}); assert.equal(win.isDestroyed(), true);
  assert.equal(f.manager.windows().length, 0);
});
test('unresponsive close times out without discarding and completed app quit can close', async t => {
  const f = fixture(t); f.handlers['note:open']({}, 'same.md'); const win = f.manager.windows()[0];
  win.close(); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(win.isDestroyed(), false); assert.equal(f.errors.length, 1);
  f.allow(); win.close(); assert.equal(win.isDestroyed(), true);
});

test('document task batches keep their original vault and override a forged source path', t => {
  const { createZenTaskStore } = require('../electron/zentask');
  const f = fixture(t), h = f.handlers;
  const storeA = createZenTaskStore(f.A.root), storeB = createZenTaskStore(f.B.root);
  const state = storeA.addProject({ name: 'A project' }), project = state.projects[0];
  h['note:open']({}, 'same.md'); const event = f.event(f.manager.windows()[0]);
  f.switch();
  h['note:tasks-add'](event, [{ projectId: project.Id, title: 'task', sourceNotePath: 'forged.md', sourceExcerpt: 'excerpt' }], 5);
  const saved = h['note:tasks-load'](event);
  assert.equal(saved.tasks.length, 1); assert.equal(saved.tasks[0].SourceNotePath, 'same.md');
  assert.equal(storeB.load().tasks.length, 0);
});
test('local open uses document directory and image reads stay in the pinned vault', t => {
  const f = fixture(t), h = f.handlers;
  f.manager.openLocal(path.join(f.B.root, 'same.md'));
  const event = f.event(f.manager.windows()[0]);
  fs.writeFileSync(path.join(f.B.root, '图片.png'), Buffer.from([137, 80, 78, 71]));
  assert.equal(h['note:read'](event).root, f.B.root);
  assert.equal(h['note:image'](event, '图片.png'), 'data:image/png;base64,iVBORw==');
  assert.throws(() => h['note:image'](event, '../A/same.md'));
  assert.throws(() => h['note:image'](event, 'same.md'), /不支持/);
  assert.equal(h['note:image'](event, 'https://example.com/photo.png'), 'https://example.com/photo.png');
});
