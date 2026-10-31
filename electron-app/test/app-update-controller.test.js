const test = require("node:test");
const assert = require("node:assert/strict");
const { createAppUpdateController } = require("../electron/app-update-controller");

function setup(overrides = {}) {
  const timeouts = new Map(), intervals = new Map(), events = [];
  let checks = 0, launches = 0, quits = 0;
  const launchInfo = { scriptPath: "C:\\private\\apply.ps1", sourceDirectory: "C:\\private\\payload", installDirectory: "C:\\DM" };
  const service = {
    getCurrentVersion: () => "3.5.0",
    checkAndPrepare: async (settings, progress) => {
      checks++;
      assert.equal(settings.updateManifestUrl, "private-source");
      progress("正在下载更新包...");
      return { isUpdateAvailable: true, latestVersionText: "3.6.0", launchInfo };
    },
    launchUpdaterAndRestart: async (info) => { launches++; assert.equal(info, launchInfo); },
    ...overrides.service,
  };
  const controller = createAppUpdateController({
    service, getSettings: () => ({ updateManifestUrl: "private-source" }),
    broadcast: (state) => events.push(state), quit: () => quits++, logError() {},
    timers: {
      setTimeout: (fn, delay) => { const timer = {}; timeouts.set(timer, { fn, delay }); return timer; },
      clearTimeout: (timer) => timeouts.delete(timer),
      setInterval: (fn, delay) => { const timer = {}; intervals.set(timer, { fn, delay }); return timer; },
      clearInterval: (timer) => intervals.delete(timer),
    }, ...overrides.controller,
  });
  return { controller, timeouts, intervals, events, counts: () => ({ checks, launches, quits }) };
}

test("automatic checks stage once without restarting or exposing paths", async () => {
  const { controller, timeouts, intervals, events, counts } = setup();
  controller.start(); controller.start();
  assert.equal(timeouts.size, 1); assert.equal(intervals.size, 1);
  assert.equal([...timeouts.values()][0].delay, 30_000);
  assert.equal([...intervals.values()][0].delay, 6 * 60 * 60 * 1000);
  const [timer, callback] = [...timeouts.entries()][0]; timeouts.delete(timer); callback.fn();
  await controller.check();
  assert.equal(controller.getState().phase, "ready");
  assert.deepEqual(counts(), { checks: 1, launches: 0, quits: 0 });
  assert.doesNotMatch(JSON.stringify(events), /private|scriptPath|installDirectory|launchInfo/);
  [...intervals.values()][0].fn();
  assert.equal(counts().checks, 1);
  await controller.apply();
  assert.deepEqual(counts(), { checks: 1, launches: 1, quits: 1 });
  controller.stop(); assert.equal(intervals.size, 0);
});

test("overlapping manual and automatic checks share a pending operation", async () => {
  let finish, requests = 0;
  const { controller } = setup({ service: { checkAndPrepare: () => {
    requests++; return new Promise((resolve) => { finish = resolve; });
  } } });
  const first = controller.check(), second = controller.check();
  assert.equal(first, second); await Promise.resolve(); assert.equal(requests, 1);
  finish({ isUpdateAvailable: false, latestVersionText: "3.5.0" });
  assert.equal((await first).phase, "latest");
});

test("background failure stays path-free and a later check recovers", async () => {
  let fail = true;
  const { controller } = setup({ service: { checkAndPrepare: async () => {
    if (fail) throw new Error("ENOENT C:\\private\\manifest.json");
    return { isUpdateAvailable: false, latestVersionText: "3.5.0" };
  } } });
  assert.equal((await controller.check()).success, false);
  assert.doesNotMatch(JSON.stringify(controller.getState()), /private|ENOENT/);
  fail = false; assert.equal((await controller.check()).phase, "latest");
});

test("failed launch retains ready update for retry and never quits", async () => {
  let attempts = 0;
  const { controller, counts } = setup({ service: { launchUpdaterAndRestart: async () => {
    if (++attempts === 1) throw new Error("spawn failure");
  } } });
  await controller.check(); assert.equal((await controller.apply()).success, false);
  assert.equal(controller.getState().phase, "ready"); assert.equal(counts().quits, 0);
  assert.equal((await controller.apply()).success, true); assert.equal(counts().quits, 1);
});

test('expired staged files allow a fresh download rather than an endless install retry', async () => {
  const { controller, counts } = setup({ service: { launchUpdaterAndRestart: async () => {
    throw Object.assign(new Error('missing /private/staging'), { code: 'ENOENT' });
  } } });
  await controller.check();
  assert.equal((await controller.apply()).success, false);
  assert.equal(controller.getState().phase, 'error');
  assert.doesNotMatch(controller.getState().message, /private/);
  await controller.check();
  assert.equal(counts().checks, 2);
  assert.equal(counts().quits, 0);
});

test('extraction errors expose the failing stage without private command output', async () => {
  const { controller } = setup({ service: { checkAndPrepare: async () => {
    throw Object.assign(new Error('tar /private/package.zip'), { updateStage: 'extract' });
  } } });
  const result = await controller.check();
  assert.match(result.error, /解压失败/);
  assert.doesNotMatch(JSON.stringify(result), /private|package.zip/);
});

test("apply requires staging, respects active operations and deduplicates clicks", async () => {
  let allowed = false, finish;
  const { controller, counts } = setup({ controller: { canApply: () => allowed }, service: {
    launchUpdaterAndRestart: () => new Promise((resolve) => { finish = resolve; }),
  } });
  assert.equal((await controller.apply()).success, false);
  await controller.check(); assert.equal((await controller.apply()).success, false);
  assert.equal(counts().quits, 0); allowed = true;
  const first = controller.apply(), second = controller.apply(); assert.equal(first, second);
  await Promise.resolve(); finish(); await first; assert.equal(counts().quits, 1);
});

test("unsupported platforms and development builds do not schedule updates", async () => {
  for (const options of [{ supported: false }, { automatic: false }]) {
    const { controller, timeouts, intervals, counts } = setup({ controller: options });
    controller.start(); assert.equal(timeouts.size + intervals.size, 0);
    if (options.supported === false) {
      assert.equal((await controller.check()).success, false); assert.equal(counts().checks, 0);
    }
  }
});

test("stopping before startup cancels both scheduled callbacks", () => {
  const { controller, timeouts, intervals } = setup();
  controller.start(); controller.stop(); assert.equal(timeouts.size + intervals.size, 0);
});

test("unwritable Mac installations get an actionable message without exposing filesystem details", async () => {
  const { controller } = setup({ service: { checkAndPrepare: async () => {
    throw Object.assign(new Error("EACCES /private/install-location"), { code: "DM_MAC_UPDATE_INSTALL_LOCATION" });
  } } });
  const result = await controller.check();
  assert.match(result.error, /可写的应用程序文件夹/);
  assert.doesNotMatch(JSON.stringify(result), /private|EACCES/);
});

test('pet compatibility rejection explains preservation and never quits', async () => {
  const message='更新包不包含当前选择的宠物，已保留当前版本与宠物设置。';
  const {controller,counts}=setup({service:{checkAndPrepare:async()=>{throw Object.assign(new Error(message),{code:'DM_PET_UPDATE_UNAVAILABLE'});}}});
  const result=await controller.check();assert.equal(result.error,message);assert.equal(counts().quits,0);
});
