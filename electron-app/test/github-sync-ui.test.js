const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function setup(api = {}) {
  const window = {};
  const timers = new Map();
  let serial = 0;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/github-sync-ui.js"), "utf8"), {
    window, document: { querySelector: () => null }, Date,
    setTimeout: (fn, delay) => { const id = ++serial; timers.set(id, { fn, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
  });
  const escape = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
  return { ui: window.DMGitHubSyncUI.create(api, { esc: escape, attr: escape }), timers };
}

test("unconfigured build explains the prerequisite instead of pretending to authorize", async () => {
  let requests = 0;
  const { ui } = setup({ githubSync: {
    status: async () => ({ success: true, auth: {}, sync: {} }),
    startAuth: async () => { requests += 1; return { success: true }; },
  } });
  await ui.load();
  assert.match(ui.render(), /data-github-advanced >/);
  await ui.handleAction("github-connect");
  assert.equal(requests, 0);
  assert.match(ui.render(), /data-github-advanced open/);
  assert.match(ui.render(), /尚未预置/);
  assert.match(ui.render(), /<dialog class="github-setup-dialog"/);
  await ui.handleAction("github-setup-close");
  assert.doesNotMatch(ui.render(), /<dialog/);
});

test("selecting is not binding: confirmation enables preview, then preview enables sync", async () => {
  const bound = [], pages = [];
  let binding = null;
  const { ui } = setup({ githubSync: {
    status: async () => ({ success: true, auth: { connected: true, login: "test" }, sync: { binding } }),
    repositories: async () => ({ success: true, repositories: [{ owner: "test", repo: "notes", fullName: "test/notes", defaultBranch: "trunk" }] }),
    bind: async (input) => { bound.push(input); binding = { ...input, branch: "trunk" }; return { success: true }; },
    preview: async () => ({ success: true, id: "p", uploads: ["note.md"], conflicts: [] }),
    openCreateRepository: async () => { pages.push("create"); return { success: true }; },
    openInstallation: async () => { pages.push("install"); return { success: true }; },
  } });
  await ui.load(); await ui.handleAction("github-create");
  assert.match(ui.render(), /已打开 GitHub 创建页/);
  await ui.handleAction("github-install"); await ui.handleAction("github-repositories");
  assert.match(ui.render(), /value="test\/notes" selected/);
  assert.match(ui.render(), /尚未绑定笔记库/);
  assert.match(ui.render(), /data-module-action="github-preview" disabled/);
  await ui.handleAction("github-use-repository");
  assert.equal(JSON.stringify(bound), JSON.stringify([{ owner: "test", repo: "notes" }]));
  assert.deepEqual(pages, ["create", "install"]);
  assert.match(ui.render(), /data-module-action="github-preview" >/);
  assert.match(ui.render(), /data-module-action="github-sync" disabled/);
  await ui.handleAction("github-preview");
  assert.match(ui.render(), /data-module-action="github-sync" >/);
});

test("changing vault clears the previous preview and manual binding fields", async () => {
  let root = "/vault-a";
  const { ui } = setup({ githubSync: {
    status: async () => ({ success: true, root, auth: { connected: true, login: "test" }, sync: { binding: root === "/vault-a" ? { owner: "test", repo: "notes-a", branch: "main" } : null } }),
    preview: async () => ({ success: true, id: "a-preview", uploads: ["only-a.md"], conflicts: [] }),
  } });
  await ui.load();
  await ui.handleAction("github-preview");
  assert.match(ui.render(), /only-a.md/);
  root = "/vault-b";
  await ui.load();
  const html = ui.render();
  assert.doesNotMatch(html, /only-a\.md|value="notes-a"|test\/notes-a/);
  assert.match(html, /data-github-field="repo" value=""/);
  assert.match(html, /data-module-action="github-sync" disabled/);
  assert.match(html, /\/vault-b/);
});

test("browser preview never presents a working GitHub connection", () => {
  const { ui } = setup();
  assert.match(ui.render(), /Electron/);
  assert.doesNotMatch(ui.render(), /data-module-action="github-connect"/);
});

test("UI presents real binding, escaped conflict paths and disables conflicted sync", async () => {
  const { ui } = setup({ githubSync: {
    status: async () => ({ success: true, auth: { connected: true, login: "<user>" }, sync: { binding: { owner: "o", repo: "r", branch: "main" } }, root: "/tmp/notes" }),
    preview: async () => ({ success: true, id: "one", uploads: [], downloads: [], deletions: [], conflicts: ["<script>.md"] }),
  } });
  await ui.load(); await ui.handleAction("github-preview");
  const html = ui.render();
  assert.match(html, /&lt;user>/);
  assert.match(html, /&lt;script>.md/);
  assert.match(html, /data-module-action="github-sync" disabled/);
  assert.doesNotMatch(html, /<script>/);
});

test("task and project sync preview labels exact data paths and preserves conflict protection", async () => {
  const { ui } = setup({ githubSync: {
    status: async () => ({ success: true, auth: { connected: true }, sync: { binding: { owner: "o", repo: "r", branch: "main" } } }),
    preview: async () => ({
      success: true, id: "data-preview",
      uploads: ["Journal/task-module.json"],
      downloads: ["Journal/zentask-projects.json", "notes/task-module.json.md"],
      deletions: [{ path: "Journal/task-module.json", side: "local" }, { path: "Journal/zentask-projects.json", side: "remote" }],
      conflicts: ["Journal/zentask-projects.json"],
    }),
  } });
  await ui.load(); await ui.handleAction("github-preview");
  const html = ui.render();
  assert.match(html, /<li>任务数据 · Journal\/task-module\.json<\/li>/);
  assert.match(html, /<li>项目数据 · Journal\/zentask-projects\.json<\/li>/);
  assert.match(html, /<li>任务数据 · Journal\/task-module\.json（本地删除）<\/li>/);
  assert.match(html, /<li>项目数据 · Journal\/zentask-projects\.json（远端删除）<\/li>/);
  assert.match(html, /<li>notes\/task-module\.json\.md<\/li>/);
  assert.match(html, /data-module-action="github-sync" disabled/);
  assert.match(html, /不逐条自动合并/);
  assert.match(html, /其他 JSON、应用设置、API Key 和隐藏目录不上传/);
});

test("device polling respects interval and leaving settings cancels authorization", async () => {
  let cancelled = 0, polls = 0;
  const { ui, timers } = setup({ githubSync: {
    status: async () => ({ success: true, auth: { clientId: "client", appSlug: "notes-app" }, sync: {}, root: "/notes" }),
    startAuth: async () => ({ success: true, userCode: "ABCD", expiresAt: Date.now() + 100000, interval: 5 }),
    pollAuth: async () => { polls += 1; return { success: true, status: "pending", pending: true, interval: 12 }; },
    cancelAuth: async () => { cancelled += 1; return { success: true }; },
  } });
  await ui.load(); ui.render(); await ui.handleAction("github-connect");
  const timer = [...timers.values()][0]; assert.equal(timer.delay, 5000);
  await timer.fn();
  assert.equal(polls, 1); assert.equal([...timers.values()].at(-1).delay, 12000);
  ui.pause(); assert.equal(cancelled, 1);
  await timer.fn(); assert.equal(polls, 1);
});

test("native confirmation cancellation is not shown as sync success", async () => {
  const { ui } = setup({ githubSync: {
    status: async () => ({ success: true, auth: { connected: true }, sync: { binding: { owner: "o", repo: "r", branch: "main" } } }),
    preview: async () => ({ success: true, id: "p", uploads: ["a.md"], conflicts: [] }),
    sync: async () => ({ success: true, cancelled: true }),
  } });
  await ui.load(); await ui.handleAction("github-preview"); await ui.handleAction("github-sync");
  assert.match(ui.render(), /已取消，未执行同步/);
  assert.doesNotMatch(ui.render(), /手动同步完成/);
});

test("click choices require every conflict, compare safely, preview without writes and retain cancelled plan", async () => {
  const calls = [], files = ["<note>.md", "Journal/task-module.json"];
  let failResolution = true;
  const { ui } = setup({ githubSync: {
    status: async () => ({ success: true, auth: { connected: true }, sync: { binding: { owner: "o", repo: "r", branch: "main" } }, root: "/vault" }),
    preview: async () => ({ success: true, id: "p", conflicts: files,
      conflictDetails: [{ path: files[0], options: ["local", "remote", "both", "combine"], remoteDeleted: false },
        { path: files[1], options: ["local", "remote"], localDeleted: true }] }),
    inspectConflict: async (input) => { calls.push(["inspect", input]); return { success: true, path: input.path,
      local: { bytes: 100, text: '<script>alert("local")</script>', truncated: true }, remote: { deleted: true } }; },
    resolveConflicts: async (input) => { calls.push(["resolve", input]); return failResolution ? { success: false, error: "关联不兼容，请调整选择" } :
      { success: true, id: "resolved", conflicts: [], uploads: files, resolutions: input.resolutions }; },
    sync: async (input) => { calls.push(["sync", input]); return { success: true, cancelled: true }; },
  } });
  await ui.load(); await ui.handleAction("github-preview");
  assert.match(ui.render(), /还剩 2 \/ 2/);
  assert.match(ui.render(), /采用本地删除/);
  await ui.handleAction("github-conflict-combine", files[0]);
  assert.match(ui.render(), /还剩 1 \/ 2/); assert.match(ui.render(), /不会自动去重/);
  await ui.handleAction("github-resolve"); assert.equal(calls.length, 0);
  await ui.handleAction("github-conflict-both", files[1]);
  assert.match(ui.render(), /还剩 1 \/ 2/);
  await ui.handleAction("github-conflict-remote", files[1]);
  assert.match(ui.render(), /data-module-action="github-resolve" >/);
  await ui.handleAction("github-compare", files[0]);
  assert.match(ui.render(), /&lt;script>/); assert.doesNotMatch(ui.render(), /<script>/);
  assert.match(ui.render(), /仅显示前 16 KB/);
  await ui.handleAction("github-resolve");
  assert.match(ui.render(), /关联不兼容/); assert.match(ui.render(), /还剩 0 \/ 2/);
  failResolution = false; await ui.handleAction("github-resolve");
  const request = calls.filter(([name]) => name === "resolve").at(-1)[1];
  assert.equal(JSON.stringify(request), JSON.stringify({ previewId: "p", resolutions: [
    { path: files[0], strategy: "combine" }, { path: files[1], strategy: "remote" },
  ] }));
  assert.equal(calls.some(([name]) => name === "sync"), false);
  assert.match(ui.render(), /冲突解决方案 · 尚未写入/);
  assert.match(ui.render(), /data-module-action="github-sync" >/);
  await ui.handleAction("github-sync");
  assert.equal(calls.at(-1)[1].previewId, "resolved");
  assert.match(ui.render(), /已取消/); assert.match(ui.render(), /冲突解决方案 · 尚未写入/);
  await ui.handleAction("github-preview");
  assert.match(ui.render(), /还剩 2 \/ 2/);
  assert.doesNotMatch(ui.render(), /<pre>/);
  await ui.handleAction("github-conflicts-local");
  assert.match(ui.render(), /还剩 0 \/ 2/); assert.match(ui.render(), /两端都会删除此文件/);
  await ui.handleAction("github-conflicts-remote");
  assert.match(ui.render(), /还剩 0 \/ 2/);
});
