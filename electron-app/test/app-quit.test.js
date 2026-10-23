const test = require("node:test");
const assert = require("node:assert/strict");
const { createAppQuitController } = require("../electron/app-quit");
const { installDesktopIntegration } = require("../electron/desktop-integration");
const tick = () => new Promise(setImmediate);
function fixture(options = {}) {
  const events = [], errors = [];
  let quits = 0, resumes = 0, stops = 0;
  const sender = { isDestroyed: () => false, send: (channel, payload) => events.push({ channel, ...payload }) };
  const controller = createAppQuitController({
    getWindows: () => [{ isDestroyed: () => false, webContents: sender }],
    stopBackground: async () => { stops++; }, resumeBackground: () => { resumes++; },
    quit: () => { quits++; }, onError: (error) => errors.push(error), timeoutMs: 1000, ...options,
  });
  return { controller, sender, events, errors, counts: () => ({ quits, resumes, stops }),
    acknowledge: () => controller.acknowledge(sender, events.find((event) => event.phase === "prepare")) };
}

test("quit freezes editors, waits for pending writes, then cleans up and exits once", async () => {
  let cleaned = false;
  const f = fixture({ cleanup: async () => { cleaned = true; } });
  const first = f.controller.request(), second = f.controller.request();
  assert.equal(first, second); await tick();
  assert.deepEqual(f.events.map((event) => event.phase), ["waiting", "prepare"]);
  assert.equal(cleaned, false); assert.equal(f.counts().quits, 0);
  f.controller.acknowledge({}, f.events.at(-1)); await tick();
  assert.equal(f.counts().quits, 0, "unrelated windows cannot acknowledge another editor's save");
  f.acknowledge(); assert.equal((await first).success, true);
  assert.equal(cleaned, true); assert.equal(f.counts().quits, 1);
  assert.equal(f.controller.allowed, true);
});

test("native quit requests use the same save flow and are allowed after preparation", async () => {
  const f = fixture(); let prevented = 0;
  const event = { preventDefault: () => prevented++ };
  f.controller.beforeQuit(event); await tick(); f.acknowledge(); await tick();
  f.controller.beforeQuit(event);
  assert.equal(prevented, 1); assert.equal(f.counts().quits, 1);
});

test("save failure keeps the app open, restores interaction and permits retry", async () => {
  const f = fixture(); const first = f.controller.request(); await tick();
  f.controller.acknowledge(f.sender, { ...f.events.at(-1), error: true });
  assert.equal((await first).success, false);
  assert.equal(f.counts().quits, 0); assert.equal(f.counts().resumes, 1);
  assert.equal(f.events.at(-1).phase, "resume"); assert.match(f.errors[0], /保存失败/);
  const second = f.controller.request(); await tick();
  f.controller.acknowledge(f.sender, f.events.at(-1));
  assert.equal((await second).success, true); assert.equal(f.counts().quits, 1);
});

test("an unresponsive editor times out visibly instead of silently swallowing quit", async () => {
  const f = fixture({ timeoutMs: 15 });
  assert.equal((await f.controller.request()).success, false);
  assert.match(f.errors[0], /超时/); assert.equal(f.controller.allowed, false);
  assert.equal(f.counts().resumes, 1);
});

test("no-window exit still stops background work and does not wait for acknowledgements", async () => {
  const f = fixture({ getWindows: () => [] });
  assert.equal((await f.controller.request()).success, true);
  assert.equal(f.counts().quits, 1); assert.equal(f.counts().stops, 1);
});

test("Mac menu-bar and Windows tray icons expose show/quit actions and clean up on exit", () => {
  for (const platform of ["darwin", "win32"]) {
    const calls = [], events = new Map(); let shown = 0, quit = 0, menu, destroyed = 0;
    const images = [];
    class FakeTray {
      constructor(image, guid) { this.image = image; this.guid = guid; this.events = new Map(); }
      setToolTip(value) { this.tooltip = value; }
      setContextMenu(value) { this.menu = value; }
      on(name, callback) { this.events.set(name, callback); }
      isDestroyed() { return destroyed > 0; }
      destroy() { destroyed++; }
    }
    const app = { on: (name, callback) => events.set(name, callback), removeListener: (name) => events.delete(name),
      setActivationPolicy: (policy) => calls.push(policy),
      dock: { show: () => { calls.push("dock"); }, setIcon: () => calls.push("icon"), setMenu: () => calls.push("dock-menu") } };
    const integration = installDesktopIntegration({ app, platform, icon: "logo.png", trayIcon: platform === "darwin" ? "trayTemplate.png" : "logo.ico",
      Tray: FakeTray, nativeImage: { createFromPath: (file) => {
        const image = { file, isEmpty: () => false, setTemplateImage(value) { this.template = value; } }; images.push(image); return image;
      } },
      Menu: { buildFromTemplate: (template) => template, setApplicationMenu: (template) => { menu = template; } },
      showApplication: () => shown++, requestQuit: () => quit++,
    });
    const exit = menu[0].submenu.find((item) => item.label === "退出软件");
    assert.equal(exit.accelerator, "CommandOrControl+Q"); exit.click(); events.get("activate")();
    assert.equal(quit, 1); assert.equal(shown, 1);
    assert.equal(calls.includes("regular"), platform === "darwin");
    assert.equal(calls.includes("dock"), platform === "darwin");
    const tray = integration.tray;
    assert.match(tray.tooltip, /DanceMonkey/);
    assert.deepEqual(tray.menu.filter(item => item.label).map(item => item.label), ["显示主界面", "桌面宠物", "退出软件"]);
    tray.menu.find(item => item.label === "显示主界面").click();
    tray.menu.find(item => item.label === "退出软件").click();
    assert.equal(quit, 2); assert.equal(shown, 2);
    if (platform === "darwin") {
      assert.equal(tray.image.template, true); assert.equal(tray.image.file, "trayTemplate.png");
      assert.equal(tray.events.has("click"), false, "Mac click opens its native menu without opening a window");
    } else {
      assert.equal(tray.image.file, "logo.ico"); assert.match(tray.guid, /^[a-f0-9-]{36}$/);
      tray.events.get("click")(); assert.equal(shown, 3);
    }
    integration.dispose(); integration.dispose();
    assert.equal(destroyed, 1); assert.equal(events.has("activate"), false);
  }
});
