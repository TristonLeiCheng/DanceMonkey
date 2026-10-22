const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function section(file, start, end) {
  const source = fs.readFileSync(path.join(__dirname, "../src", file), "utf8");
  return source.slice(source.indexOf(start), source.indexOf(end));
}

test("project selection and open note picker are cleared on vault switch", () => {
  const context = vm.createContext({});
  const reset = section("project-manager.js", "    function resetVault()", "    return { render, renderModal");
  vm.runInContext(`
    let selectedId = 'same-id'; let picker = {selected: new Set(['old.md'])};
    let dialog = {type:'milestone'}; let files = ['old.md']; let filesLoaded = true;
    let focusedTaskId = 'old-task'; let milestoneFilter = 'old-stage'; let taskQuery = 'old';
    let pageError = 'old error'; let renderedAttention = ['old-project'];
    ${reset}
    resetVault();
  `, context);
  for (const name of ["selectedId", "focusedTaskId", "taskQuery", "pageError"]) assert.equal(vm.runInContext(name, context), "");
  assert.equal(vm.runInContext("picker", context), null);
  assert.equal(vm.runInContext("dialog", context), null);
  assert.equal(vm.runInContext("filesLoaded", context), false);
  assert.equal(vm.runInContext("files.length + renderedAttention.length", context), 0);
});

test("module reload clears old tasks before reading the destination vault", async () => {
  let finishLoad;
  let resets = 0;
  let githubLoads = 0;
  const context = vm.createContext({
    Promise,
    projectManager: { resetVault: () => { resets += 1; } },
    loadZen: () => new Promise((resolve) => { finishLoad = resolve; }),
    githubUI: { load: async () => { githubLoads += 1; } },
  });
  const reload = section("workspace-modules.js", "    async function reloadVault()", "    return { pauseGitHub:");
  vm.runInContext(`let modal = {id:'old'}; let error = 'old'; let tasks = ['old']; let projects = ['old']; ${reload}`, context);
  const pending = vm.runInContext("reloadVault()", context);
  assert.equal(vm.runInContext("modal", context), null);
  assert.equal(vm.runInContext("tasks.length + projects.length", context), 0);
  assert.equal(resets, 1);
  assert.equal(githubLoads, 1);
  finishLoad();
  await pending;
});

function modulesFixture() {
  const model = require("../src/zen-model");
  let data = {
    projects: [model.createProject({ name: "选中的项目" }, "p1"), model.createProject({ name: "其他项目" }, "p2")],
    tasks: [
      { Id: "t1", Title: "原任务", ProjectId: "p1", MilestoneId: "m1", WorkflowStatus: "Todo" },
      { Id: "t2", Title: "其他阶段的任务", ProjectId: "p1", MilestoneId: "m2", WorkflowStatus: "Todo" },
    ],
  };
  data.projects[0].Milestones = [{ Id: "m1", Name: "所选阶段" }, { Id: "m2", Name: "其他阶段" }];
  let githubLoads = 0;
  const preview = { id: "existing-preview" };
  const context = vm.createContext({ window: {
    DMZenModel: model,
    DMGitHubSyncUI: { create: () => ({
      handleAction: async () => false,
      load: async () => { githubLoads += 1; preview.id = ""; },
      pause() {},
    }) },
  }, document: { querySelector: () => null } });
  for (const file of ["project-manager.js", "workspace-modules.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../src", file), "utf8"), context);
  }
  const esc = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
  const api = {
    zenTask: { load: async () => structuredClone(data) },
    workspace: { list: async () => ({ tree: [{ type: "file", path: "关联.md", name: "关联.md" }] }) },
  };
  const modules = context.window.DMWorkspaceModules.create(api, { esc, attr: esc, rerender() {} });
  const click = (action, id = "") => modules.handleClick({
    target: { classList: { contains: () => false }, closest: () => ({ dataset: { moduleAction: action, id } }) },
    preventDefault() {}, stopPropagation() {},
  });
  return { modules, click, data, preview, githubLoads: () => githubLoads };
}

test("same-vault task refresh preserves selected project, stage filter and GitHub preview", async () => {
  const { modules, click, data, preview, githubLoads } = modulesFixture();
  await modules.reloadSyncedTasks();
  await modules.openProject("p1");
  await click("pm-filter-stage", "m1");
  assert.match(modules.render("projects"), /原任务/);
  assert.doesNotMatch(modules.render("projects"), /其他阶段的任务/);
  data.tasks[0].Title = "同步后的任务";
  data.projects[0].Name = "同步后的项目";
  await modules.reloadSyncedTasks();
  const html = modules.render("projects");
  assert.match(html, /同步后的任务/);
  assert.match(html, /同步后的项目/);
  assert.doesNotMatch(html, /其他阶段的任务/);
  assert.equal(preview.id, "existing-preview");
  assert.equal(githubLoads(), 0);
});

test("task, project, milestone, progress and note-picker dialogs block preparation until closed", async () => {
  const { modules, click } = modulesFixture();
  await modules.reloadSyncedTasks();
  await modules.openProject("p1");
  assert.doesNotThrow(() => modules.prepareSync());
  for (const action of ["add-task", "add-project", "pm-new-milestone", "pm-new-update", "pm-link-notes"]) {
    await click(action);
    const form = modules.renderModal();
    assert.notEqual(form, "", action);
    assert.throws(() => modules.prepareSync(), /先保存或关闭/, action);
    assert.equal(modules.renderModal(), form, "prepare must not mutate the pending form");
    assert.equal(modules.closeModal(), true);
    assert.doesNotThrow(() => modules.prepareSync());
  }
});
