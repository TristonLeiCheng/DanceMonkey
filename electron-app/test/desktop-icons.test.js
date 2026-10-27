const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeDesktopScene, createDesktopIconReader } = require('../electron/desktop-icons');
const area = { x: -1600, y: 25, width: 1600, height: 900 };
const icon = (patch = {}) => ({ name: '计划.md', key: 'file:///Desktop/计划.md', position: { x: -200, y: 300 }, ...patch });
const scene = (patch = {}) => ({ hidden: false, iconSize: 60, icons: [icon()], windows: [], ...patch });
const window = (patch = {}) => ({ id: 42, layer: 0, alpha: 1, bounds: { X: -240, Y: 260, Width: 80, Height: 80 }, ...patch });

test('Finder points become icon rectangles in DIP; names are bounded and file URLs never leave the reader', () => {
  const result = normalizeDesktopScene(scene(), { area });
  assert.equal(result.status, 'ready'); assert.equal(result.icons.length, 1);
  const p = result.icons[0]; assert.equal(p.x, -230); assert.equal(p.y, 270); assert.equal(p.width, 60);
  assert.equal(p.key, undefined); assert.match(p.id, /^[a-f0-9]{24}$/);
  assert.equal(normalizeDesktopScene(scene({ icons: [icon({ position: [-200, 300] })] }), { area }).icons[0].id, p.id);
  assert.equal(normalizeDesktopScene(scene({ icons: [icon({ name: '\u0000' + 'a'.repeat(100) })] }), { area }).icons[0].name.length, 80);
});
test('covered and hidden icons are excluded; pet window, wallpaper and transparent windows are ignored', () => {
  assert.equal(normalizeDesktopScene(scene({ windows: [window()] }), { area }).icons.length, 0);
  assert.equal(normalizeDesktopScene(scene({ windows: [window()] }), { area, excludeWindowId: 42 }).icons.length, 1);
  for (const patch of [{ layer: -1 }, { alpha: 0 }]) {
    assert.equal(normalizeDesktopScene(scene({ windows: [window(patch)] }), { area }).icons.length, 1);
  }
  assert.equal(normalizeDesktopScene(scene({ hidden: true }), { area }).status, 'desktop-hidden');
  assert.equal(normalizeDesktopScene(scene({ windows: [window({ layer: 20 })] }), { area }).icons.length, 1);
  assert.equal(normalizeDesktopScene(scene({ arrangement: 'arranged by kind' }), { area }).status, 'layout-unsupported');
});
test('offscreen, invalid, duplicated and cross-display rectangles cannot become collision platforms', () => {
  const icons = [icon(), icon(), icon({ key: 'invalid', position: null }), icon({ key: 'edge', position: [-1, 300] }), icon({ key: 'other', position: [100, 300] })];
  const result = normalizeDesktopScene(scene({ icons }), { area }); assert.equal(result.icons.length, 1);
  assert.throws(() => normalizeDesktopScene({}, { area }), /Invalid/);
});
test('reader is explicit, cancellable, and reports Finder denial without logging desktop contents', async () => {
  let calls = 0;
  const reader = createDesktopIconReader({ platform: 'darwin', run: (command, args, options, callback) => {
    calls++; assert.equal(command, '/usr/bin/osascript'); assert.ok(options.signal); callback(null, JSON.stringify(scene()), '');
  } });
  assert.equal(calls, 0);
  const controller = new AbortController();
  assert.equal((await reader.read({ area, signal: controller.signal })).icons.length, 1);
  const denied = createDesktopIconReader({ platform: 'darwin', run: (_c, _a, _o, cb) => cb(new Error('denied'), '', 'Not authorized (-1743)') });
  await assert.rejects(denied.read({ area }), e => e.sceneStatus === 'permission-required');
  const unsupported = createDesktopIconReader({ platform: 'win32', run: () => { throw Error('must not run'); } });
  assert.equal((await unsupported.read({ area })).status, 'unsupported');
});

test('OS icon lookup is limited to visible scene IDs, caches images, and clears paths on exit', async () => {
  let calls=0, requested;
  const reader=createDesktopIconReader({platform:'darwin',run:(_c,_a,_o,cb)=>cb(null,JSON.stringify(scene()),''),loadIcon:async file=>{
    calls++;requested=file;return 'data:image/png;base64,aGVsbG8=';
  }});
  assert.equal(await reader.getIcon('unknown'),null);assert.equal(calls,0);
  const {icons}=await reader.read({area});const id=icons[0].id;
  assert.equal(await reader.getIcon(id),'data:image/png;base64,aGVsbG8=');
  assert.equal(await reader.getIcon(id),'data:image/png;base64,aGVsbG8=');
  assert.equal(calls,1);assert.equal(requested,'/Desktop/计划.md');
  reader.clear();assert.equal(await reader.getIcon(id),null);assert.equal(calls,1);
});
test('OS icon completion after reader cleanup is discarded', async () => {
  let resolveImage;
  let signal;
  const reader=createDesktopIconReader({platform:'darwin',run:(_c,_a,_o,cb)=>cb(null,JSON.stringify(scene()),''),loadIcon:(_file,options)=>new Promise(resolve=>{resolveImage=resolve;signal=options.signal;})});
  const {icons}=await reader.read({area});const pending=reader.getIcon(icons[0].id);reader.clear();
  assert.equal(signal.aborted,true);resolveImage('data:image/png;base64,aGVsbG8=');
  assert.equal(await pending,null);
});

test('native icon helper failure falls back without breaking scene reading', async () => {
  const reader=createDesktopIconReader({platform:'darwin',run:(_c,_a,_o,cb)=>cb(null,JSON.stringify(scene()),''),loadIcon:async()=>{throw Error('native helper failed');}});
  const first=await reader.read({area});assert.equal(await reader.getIcon(first.icons[0].id),null);
  const second=await reader.read({area});assert.equal(second.status,'ready');assert.equal(second.icons.length,1);
});
