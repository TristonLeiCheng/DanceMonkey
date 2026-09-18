const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createZenTaskStore } = require("../electron/zentask");
const model = require("../src/zen-model");

function fixture(t, seed = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dm-project-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (seed) {
    fs.mkdirSync(path.join(root, "Journal"));
    for (const [file, items] of [["task-module.json", seed.tasks], ["zentask-projects.json", seed.projects]]) {
      fs.writeFileSync(path.join(root, "Journal", file), JSON.stringify({ SchemaVersion: 2, Items: items }));
    }
  }
  return { root, store: createZenTaskStore(root) };
}

test("editing a project preserves hidden and legacy fields", (t) => {
  const { store } = fixture(t, { projects: [{ Id: "p1", Name: "旧项目", Progress: 65, Team: 8, ExtraLegacy: { keep: true }, LinkedNotes: ["项目/方案.md"] }], tasks: [] });
  const p = store.updateProject("p1", { name: "新名称", goal: "可交付" }).projects[0];
  assert.equal(p.Progress, 65);
  assert.equal(p.Team, 8);
  assert.deepEqual(p.ExtraLegacy, { keep: true });
  assert.deepEqual(p.LinkedNotes, ["项目/方案.md"]);
  assert.throws(() => store.updateProject("p1", { name: "   " }), /不能为空/);
  assert.equal(store.load().projects[0].Name, "新名称");
});

test("same-name projects never steal each other's tasks on rename", (t) => {
  const { root, store } = fixture(t, { projects: [{ Id: "a", Name: "同名" }, { Id: "b", Name: "同名" }], tasks: [{ Id: "ta", ProjectId: "a", Project: "同名" }, { Id: "tb", ProjectId: "b", Project: "同名" }, { Id: "legacy", Project: "同名" }] });
  store.updateProject("a", { name: "新版" });
  const tasks = createZenTaskStore(root).load().tasks;
  assert.equal(tasks[0].ProjectId, "a");
  assert.equal(tasks[0].Project, "新版");
  assert.equal(tasks[1].ProjectId, "b");
  assert.equal(tasks[2].ProjectId, undefined);
  assert.equal(tasks[2].ProjectLinkUnresolved, true);
});

test("unique legacy name links survive rename, including camelCase data", (t) => {
  const { root, store } = fixture(t, { projects: [{ id: "p", name: "原名" }], tasks: [{ id: "t", project: "原名", title: "待办" }] });
  store.updateProject("p", { name: "改名" });
  assert.equal(createZenTaskStore(root).load().tasks[0].ProjectId, "p");
  assert.equal(store.load().tasks[0].Project, "改名");
});

test("adding a duplicate project name preserves previously unique legacy ownership", (t) => {
  const { store } = fixture(t, { projects: [{ Id: "original", Name: "产品" }], tasks: [{ Id: "t", Project: "产品" }] });
  store.addProject({ name: "产品" });
  assert.equal(store.load().tasks[0].ProjectId, "original");
});

test("task status updates preserve dates, priority, checklist, and custom fields", (t) => {
  const { store } = fixture(t);
  const p = store.addProject({ name: "交付" }).projects[0];
  let task = store.addTask({ title: "验收", projectId: p.Id, priority: "Not Urgent & Important", startDate: "2026-09-01", endDate: "2026-10-01", dueDate: "2026-09-30", notes: "不要丢失", tags: "发布", energy: "High", checklist: [{ Text: "签名", Done: false }] }).tasks[0];
  const original = structuredClone(task);
  task = store.updateTask(task.Id, { workflowStatus: "Blocked" }).tasks[0];
  for (const key of ["Title", "ProjectId", "Impact", "Urgency", "StartDate", "EndDate", "DueDate", "Notes", "Tags", "Checklist", "EnergyLevel"]) assert.deepEqual(task[key], original[key], key);
  task = store.updateTask(task.Id, { workflowStatus: "Completed" }).tasks[0];
  assert.equal(task.IsDone, true);
  assert.ok(task.CompletedAt);
  const completedAt = task.CompletedAt;
  assert.equal(store.updateTask(task.Id, { notes: "验收完成" }).tasks[0].CompletedAt, completedAt);
  task = store.toggleTask(task.Id).tasks[0];
  assert.equal(task.CompletedAt, null);
  assert.equal(task.IsDone, false);
  assert.throws(() => store.updateTask(task.Id, { workflowStatus: "Invalid" }), /状态无效/);
});

test("new completed tasks have consistent completion metadata", (t) => {
  const { store } = fixture(t);
  const task = store.addTask({ title: "已交付", workflowStatus: "Completed" }).tasks[0];
  assert.ok(task.IsDone && task.CompletedAt);
});

for (const environment of ["desktop", "preview"]) {
  test(`${environment}: archive, reload, restore preserve task and note relationships`, async (t) => {
    let memory = { projects: [], tasks: [] };
    const { root, store } = fixture(t);
    const api = environment === "desktop" ? store : model.previewApi(() => structuredClone(memory), (next) => { memory = structuredClone(next); return next; });
    const p = (await api.addProject({ name: "发布", linkedNotes: ["项目/方案.md"] })).projects[0];
    const task = (await api.addTask({ title: "签名", projectId: p.Id })).tasks[0];
    await api.updateProject(p.Id, { archived: true });
    let state = environment === "desktop" ? createZenTaskStore(root).load() : await api.load();
    assert.ok(state.projects[0].ArchivedAt);
    assert.equal(state.tasks[0].ProjectId, p.Id);
    assert.equal(state.tasks[0].Id, task.Id);
    assert.deepEqual(state.projects[0].LinkedNotes, ["项目/方案.md"]);
    await assert.rejects(async () => api.addTask({ title: "不应加入", projectId: p.Id }), /先恢复/);
    state = await api.updateProject(p.Id, { archived: false });
    assert.equal(state.projects[0].ArchivedAt, null);
    assert.equal((await api.addTask({ title: "恢复后可加入", projectId: p.Id })).tasks.length, 2);
  });
}

test("note associations deduplicate, validate paths, and survive folder rename", (t) => {
  const { store } = fixture(t);
  const p = store.addProject({ name: "笔记", linkedNotes: ["项目/方案.md", "项目/方案.md", "项目二/说明.md"] }).projects[0];
  assert.equal(p.LinkedNotes.length, 2);
  store.relocateNotes("项目", "归档/项目");
  assert.deepEqual(store.load().projects[0].LinkedNotes, ["归档/项目/方案.md", "项目二/说明.md"]);
  for (const bad of ["../秘密.md", "/tmp/a.md", "https://a.md", "x.txt", "a/../b.md"]) {
    assert.throws(() => store.updateProject(p.Id, { linkedNotes: [bad] }), /Markdown/);
  }
  assert.throws(() => store.updateProject(p.Id, { dueDate: "2026-02-30" }), /日期/);
  store.updateProject(p.Id, { linkedNotes: [] });
  assert.deepEqual(store.load().projects[0].LinkedNotes, []);
});

test("malformed persisted JSON is reported rather than overwritten", (t) => {
  const { root, store } = fixture(t);
  store.addProject({ name: "应保留" });
  const file = path.join(root, "Journal", "zentask-projects.json");
  fs.writeFileSync(file, "{invalid");
  assert.throws(() => store.addProject({ name: "不能覆盖" }));
  assert.equal(fs.readFileSync(file, "utf8"), "{invalid");
});
