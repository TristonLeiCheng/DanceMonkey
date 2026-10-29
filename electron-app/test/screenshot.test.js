const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { createRequire } = require("node:module");
const { Blob } = require("node:buffer");

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");
const DATA_URL = `data:image/png;base64,${PNG.toString("base64")}`;
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(t, options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dm-screenshot-test-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = { writes: [], legacy: [], windows: [], errors: [] };
  let write = options.write || (async () => {});
  let rootError = null;
  const makeImage = (data) => ({
    toPNG: () => Buffer.from(data),
    toJPEG: () => Buffer.from("preview"),
    isEmpty: () => !Buffer.from(data).subarray(0, 8).equals(PNG.subarray(0, 8)),
    getSize: () => ({ width: 1, height: 1 }),
    crop: () => makeImage(data),
  });
  const image = makeImage(PNG);
  class ClipboardItem {
    constructor(items) { this.items = items; this.types = Object.keys(items); }
    async getType(type) {
      if (!Object.hasOwn(this.items, type)) throw new Error("Unknown clipboard type");
      return this.items[type];
    }
  }
  class BrowserWindow extends EventEmitter {
    constructor() {
      super();
      this.destroyed = false;
      this.visible = false;
      this.hideCount = 0;
      this.webContents = { send() {} };
      calls.windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    hide() { this.visible = false; this.hideCount += 1; }
    show() { this.visible = true; }
    showInactive() { this.visible = true; this.restoredInactive = true; }
    focus() {}
    loadURL() {}
    setMenuBarVisibility() {}
    setBounds() {}
    destroy() { this.destroyed = true; this.emit("closed"); }
  }
  const display = { id: 1, scaleFactor: 1, size: { width: 1, height: 1 },
    bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1080 } };
  const electron = {
    BrowserWindow,
    systemPreferences: { getMediaAccessStatus: () => options.permission || 'granted' },
    dialog: { showMessageBox: async details => { calls.errors.push(details); return {response:1}; } },
    shell: { openExternal: async () => {} },
    clipboard: {
      writeImage: (value) => { calls.legacy.push(value); },
    },
    nativeImage: {
      createFromBuffer: makeImage,
      createFromPath: (file) => makeImage(fs.readFileSync(file)),
    },
    screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayNearestPoint: () => display },
    desktopCapturer: { getSources: async () => { await options.onCapture?.(calls); return [{ display_id: "1", thumbnail: image }]; } },
  };
  if (!options.legacy) {
    electron.ClipboardItem = ClipboardItem;
    electron.clipboard.write = async (items) => { calls.writes.push(items); return write(items); };
  }
  function load(name, dependencies = {}) {
    const file = path.join(__dirname, "../electron", name);
    const realRequire = createRequire(file);
    const module = { exports: {} };
    const context = vm.createContext({
      module, exports: module.exports, Buffer, Blob, process, console, __dirname: path.dirname(file), __filename: file,
      setTimeout: (callback) => setImmediate(callback), clearTimeout: clearImmediate,
      require: (id) => id === "electron" ? electron : Object.hasOwn(dependencies, id) ? dependencies[id] : realRequire(id),
    });
    vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
    return module.exports;
  }
  const screenshot = load("screenshot.js");
  const { createScreenshotController } = load("screenshot-controller.js", { "./screenshot": screenshot });
  const appWindows = options.visibleAppWindows ? [new BrowserWindow(), new BrowserWindow()] : [];
  for (const win of appWindows) win.show();
  const petWindow = options.pet ? new BrowserWindow() : null;
  petWindow?.show();
  const controller = createScreenshotController({
    getNotesRoot: () => { if (rootError) throw rootError; return root; },
    aiService: {}, store: { get: () => ({}), set: (value) => value },
    getOverlay: () => appWindows[0], getWorkspaceWindow: () => appWindows[1],
    getPetWindow: () => petWindow,
  });
  function seedCurrentImage() {
    const file = path.join(root, "existing.png");
    fs.writeFileSync(file, PNG);
    controller.openEditorWindow(file);
    controller.closeEditorWindow();
    return file;
  }
  return { root, image, screenshot, controller, calls, appWindows, petWindow, seedCurrentImage,
    setWrite: (next) => { write = next; },
    failRoot: (error = null) => { rootError = error; },
  };
}

async function assertClipboardPng(items) {
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].types, ["image/png"]);
  const blob = await items[0].getType("image/png");
  assert.ok(blob instanceof Blob);
  assert.equal(blob.type, "image/png");
  assert.deepEqual(Buffer.from(await blob.arrayBuffer()), PNG);
}

test("PNG clipboard copies use the modern API and await its asynchronous completion", async (t) => {
  const gate = deferred();
  const f = fixture(t, { write: () => gate.promise });
  let completed = false;
  const pending = f.screenshot.copyImageToClipboard(f.image).then(() => { completed = true; });
  await tick();
  assert.equal(completed, false);
  assert.equal(f.calls.writes.length, 1);
  await assertClipboardPng(f.calls.writes[0]);
  assert.equal(f.calls.legacy.length, 0);
  gate.resolve();
  await pending;
  assert.equal(completed, true);
});

test("modern clipboard rejection propagates without silently falling back to a second write", async (t) => {
  const f = fixture(t, { write: async () => { throw new Error("Clipboard denied"); } });
  await assert.rejects(f.screenshot.copyImageToClipboard(f.image), /Clipboard denied/);
  assert.equal(f.calls.writes.length, 1);
  assert.equal(f.calls.legacy.length, 0);
});

test("legacy Electron can still copy and save a screenshot through writeImage", async (t) => {
  const f = fixture(t, { legacy: true });
  const file = await f.screenshot.savePngAndClipboardFast(f.image, f.root);
  assert.equal(f.calls.legacy.length, 1);
  assert.equal(f.calls.legacy[0], f.image);
  assert.deepEqual(fs.readFileSync(file), PNG);
});

for (const method of ["savePngAndClipboard", "savePngAndClipboardFast", "saveEditedPng"]) {
  test(`${method} waits for clipboard completion and saves the actual PNG in the selected vault`, async (t) => {
    const gate = deferred();
    const f = fixture(t, { write: () => gate.promise });
    let completed = false;
    const pending = f.screenshot[method](method === "saveEditedPng" ? DATA_URL : f.image, f.root)
      .then((file) => { completed = true; return file; });
    await tick();
    assert.equal(completed, false);
    await assertClipboardPng(f.calls.writes[0]);
    gate.resolve();
    const file = await pending;
    assert.ok(file.startsWith(`${f.root}${path.sep}`));
    assert.equal(path.extname(file), ".png");
    assert.deepEqual(fs.readFileSync(file), PNG);
  });
}

for (const method of ["copyCurrent", "copyEditorImage", "saveEditorImage"]) {
  test(`controller ${method} waits for copying and returns structured failures on rejection`, async (t) => {
    const gate = deferred();
    const f = fixture(t, { write: () => gate.promise });
    f.seedCurrentImage();
    let completed = false;
    const pending = f.controller[method]({ dataUrl: DATA_URL }).then((result) => { completed = true; return result; });
    await tick();
    assert.equal(completed, false);
    if (method === "saveEditorImage") {
      assert.equal(f.controller.writing, true);
      assert.equal(f.controller.busy, true);
    }
    await assertClipboardPng(f.calls.writes[0]);
    gate.resolve();
    const result = await pending;
    assert.equal(result.success, true);
    if (method === "saveEditorImage") {
      assert.equal(typeof result.imagePath, "string");
      assert.deepEqual(fs.readFileSync(result.imagePath), PNG);
      assert.equal(f.controller.writing, false);
      assert.equal(f.controller.busy, false);
    }
    f.setWrite(async () => { throw new Error("Clipboard denied"); });
    const failed = await f.controller[method]({ dataUrl: DATA_URL });
    assert.equal(failed.success, false);
    assert.match(failed.error, /Clipboard denied/);
    assert.equal(f.controller.writing, false);
    assert.equal(f.controller.busy, false);
  });
}

test("quick capture stays busy until clipboard and PNG saving finish, then opens its result", async (t) => {
  const gate = deferred();
  const f = fixture(t, { write: () => gate.promise });
  let completed = false;
  const pending = f.controller.captureQuick().then((result) => { completed = true; return result; });
  await tick();
  assert.equal(completed, false);
  assert.equal(f.controller.writing, true);
  assert.equal(f.controller.busy, true);
  assert.equal(f.calls.windows.length, 0);
  gate.resolve();
  const result = await pending;
  assert.equal(result.success, true);
  assert.deepEqual(fs.readFileSync(result.path), PNG);
  assert.equal(f.controller.writing, false);
  assert.equal(f.calls.windows.length, 1);
  f.controller.closeChoiceWindow();
  assert.equal(f.controller.busy, false);
});

test("quick capture reports clipboard failure, restores hidden windows and releases busy state", async (t) => {
  const f = fixture(t, { visibleAppWindows: true, write: async () => { throw new Error("Clipboard denied"); } });
  const result = await f.controller.captureQuick();
  assert.equal(result.success, false);
  assert.match(result.error, /Clipboard denied/);
  assert.equal(f.controller.writing, false);
  assert.equal(f.controller.busy, false);
  assert.equal(f.calls.windows.length, f.appWindows.length);
  for (const win of f.appWindows) {
    assert.equal(win.hideCount, 1);
    assert.equal(win.isVisible(), true);
  }
});

test("an unavailable vault releases editor-save and capture locks, allowing a later save", async (t) => {
  const f = fixture(t);
  f.failRoot(new Error("Vault unavailable"));
  for (const operation of [() => f.controller.saveEditorImage({ dataUrl: DATA_URL }), () => f.controller.captureQuick()]) {
    const result = await operation();
    assert.equal(result.success, false);
    assert.match(result.error, /Vault unavailable/);
    assert.equal(f.controller.writing, false);
    assert.equal(f.controller.busy, false);
  }
  assert.equal(f.calls.writes.length, 0);
  f.failRoot();
  const result = await f.controller.saveEditorImage({ dataUrl: DATA_URL });
  assert.equal(result.success, true);
  assert.deepEqual(fs.readFileSync(result.imagePath), PNG);
  assert.equal(f.controller.writing, false);
  assert.equal(f.controller.busy, false);
});

test("captures hide the desktop pet and restore it without focusing it, including capture failures", async (t) => {
  for (const fail of [false, true]) {
    let h;
    h = fixture(t, { pet: true, onCapture: () => {
      assert.equal(h.petWindow.isVisible(), false, 'pet cannot appear in desktop capture pixels');
      if (fail) throw new Error('capture unavailable');
    } });
    const result = await h.controller.captureQuick();
    assert.equal(result.success, !fail);
    assert.equal(h.petWindow.isVisible(), true);
    assert.equal(h.petWindow.restoredInactive, true, 'restoration must not steal focus');
  }
});

test('denied screen recording permission is actionable and visible even for shortcut callers', async t => {
  if (process.platform !== 'darwin') return;
  const f = fixture(t, {permission:'denied', visibleAppWindows:true});
  const result = await f.controller.captureQuick();
  assert.equal(result.success,false); assert.equal(result.code,'SCREEN_PERMISSION');
  assert.match(result.error,/屏幕.*录制/); assert.equal(f.calls.errors.length,1);
  assert.deepEqual(Array.from(f.calls.errors[0].buttons),['打开系统设置','关闭']);
  assert.ok(f.appWindows.every(win=>win.isVisible()));
});
test('a stalled screen source times out, reports an error and restores windows', async t => {
  const f = fixture(t, { onCapture: () => new Promise(()=>{}), visibleAppWindows:true });
  const result = await f.controller.captureQuick();
  assert.equal(result.success,false); assert.match(result.error,/超时/);
  assert.ok(f.appWindows.every(win=>win.isVisible())); assert.equal(f.controller.busy,false);
});
