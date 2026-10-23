const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function setup({ beforeApply = async () => {}, apply = async () => ({ success: true }) } = {}) {
  const slots = [{ dataset: { appUpdateSlot: "title" } }, { dataset: { appUpdateSlot: "settings" } }];
  const window = {};
  vm.runInNewContext(fs.readFileSync(require.resolve("../src/app-update-ui.js"), "utf8"), {
    window, document: { querySelectorAll: () => slots },
  });
  let state = { supported: true, phase: "idle", currentVersion: "3.5.0", message: "" };
  let listener, checks = 0, applies = 0;
  const notify = (patch) => { state = { ...state, ...patch }; listener(state); };
  const ui = window.DMAppUpdateUI.create({ appUpdate: {
    info: async () => state,
    onState: (callback) => { listener = callback; },
    check: async () => { checks++; notify({ phase: "ready", latestVersion: "3.6.0" }); return { success: true, ...state }; },
    apply: async (...args) => { applies++; assert.equal(args.length, 0); return apply(); },
  } }, { esc: (text) => String(text).replaceAll("<", "&lt;"), beforeApply });
  return { ui, slots, notify, counts: () => ({ checks, applies }) };
}

test("manual check prepares update, then installs without a path confirmation", async () => {
  const { ui, counts } = setup(); await ui.load();
  assert.equal(ui.renderButton(), ""); assert.match(ui.renderSettings(), /检查更新/);
  await ui.handleAction("app-update-check"); assert.deepEqual(counts(), { checks: 1, applies: 0 });
  assert.match(ui.renderButton(), /更新并重启/); assert.match(ui.renderSettings(), /安装更新/);
  assert.doesNotMatch(ui.renderSettings(), /URL|GitHub|目录|路径/);
  await ui.handleAction("app-update-apply"); assert.deepEqual(counts(), { checks: 1, applies: 1 });
});

test("automatic readiness updates both slots and survives status reload", async () => {
  const { ui, slots, notify } = setup(); notify({ phase: "ready", latestVersion: "3.6.0" });
  assert.match(slots[0].innerHTML, /更新并重启/); assert.match(slots[1].innerHTML, /安装更新/);
  await ui.load(); assert.match(ui.renderButton(), /更新并重启/);
  notify({ phase: "installing" }); assert.match(slots[0].innerHTML, /disabled/);
});

test("notes finish saving before apply and rapid clicks apply only once", async () => {
  let finish;
  const { ui, notify, counts } = setup({ beforeApply: () => new Promise((resolve) => { finish = resolve; }) });
  notify({ phase: "ready" }); const pending = ui.handleAction("app-update-apply");
  await ui.handleAction("app-update-apply"); assert.equal(counts().applies, 0);
  finish(); await pending; assert.equal(counts().applies, 1);
});

test("save failure prevents restart and retains update for retry", async () => {
  const { ui, notify, counts } = setup({ beforeApply: async () => { throw new Error("private path"); } });
  notify({ phase: "ready" }); await ui.handleAction("app-update-apply");
  assert.equal(counts().applies, 0); assert.match(ui.renderSettings(), /笔记保存失败/);
  assert.doesNotMatch(ui.renderSettings(), /private path/);
  assert.match(ui.renderButton(), /role="alert"/);
});
