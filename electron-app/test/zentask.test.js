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

for (const environment of ["desktop", "preview"]) {
  test(`${environment}: milestones, lifecycle, health updates, and note sources survive reload`, async (t) => {
    let memory = { projects: [], tasks: [] };
    const { root, store } = fixture(t);
    const api = environment === "desktop" ? store : model.previewApi(() => structuredClone(memory), (next) => { memory = structuredClone(next); return next; });
    let project = (await api.addProject({ name: "跨平台发布", lifecycleStatus: "Planned" })).projects[0];
    const stage = { id: "m1", name: "Mac 验收", dueDate: "2026-10-01", acceptanceCriteria: "安装后能打开" };
    project = (await api.updateProject(project.Id, { milestones: [stage], lifecycleStatus: "In Progress" })).projects[0];
    let task = (await api.addTask({ title: "测试安装", projectId: project.Id, milestoneId: "m1", sourceNotePath: "项目/会议.md", sourceExcerpt: "- [ ] 测试安装" })).tasks[0];
    await api.updateProject(project.Id, { addUpdate: { health: "At Risk", summary: "签名未验证", risks: "公证等待中", nextAction: "完成验证" } });
    let state = environment === "desktop" ? createZenTaskStore(root).load() : await api.load();
    project = state.projects[0];
    assert.equal(model.lifecycle(project), "In Progress");
    assert.equal(model.health(project), "At Risk");
    assert.equal(project.Updates.length, 1);
    assert.equal(project.Updates[0].Summary, "签名未验证");
    assert.equal(project.NextAction, "完成验证");
    assert.deepEqual(model.milestoneProgress(project.Milestones[0], state.tasks), { total: 1, completed: 0, percent: 0 });
    assert.equal(state.tasks[0].SourceNotePath, "项目/会议.md");
    await assert.rejects(async () => api.addTask({ title: "非法阶段", projectId: project.Id, milestoneId: "other" }), /里程碑/);
    await assert.rejects(async () => api.updateProject(project.Id, { milestones: [] }), /关联任务/);
    task = (await api.updateTask(task.Id, { workflowStatus: "Completed" })).tasks[0];
    assert.equal(model.milestoneProgress(project.Milestones[0], [task]).percent, 100);
    await api.updateProject(project.Id, { milestones: [{ ...stage, completed: true }], lifecycleStatus: "Completed" });
    state = environment === "desktop" ? createZenTaskStore(root).load() : await api.load();
    assert.equal(model.lifecycle(state.projects[0]), "Completed");
    assert.ok(state.projects[0].Milestones[0].CompletedAt);
    assert.equal(state.tasks[0].MilestoneId, "m1");
  });
}

test("old completed projects map to lifecycle without rewriting their JSON", (t) => {
  const { root, store } = fixture(t, { projects: [{ Id: "old", Name: "旧版", Status: "Completed" }], tasks: [] });
  const before = fs.readFileSync(path.join(root, "Journal", "zentask-projects.json"), "utf8");
  const project = store.load().projects[0];
  assert.equal(model.lifecycle(project), "Completed");
  assert.equal(model.health(project), "On Track");
  assert.equal(fs.readFileSync(path.join(root, "Journal", "zentask-projects.json"), "utf8"), before);
});

test("note candidate extraction skips completed checkboxes and code blocks", () => {
  const candidates = model.taskCandidatesFromNote("# 会议\n- [ ] 验证 Mac 安装\n- [x] 已完成事项\n```md\n- 不应导入\n```\n1. 记录风险");
  assert.deepEqual(candidates.map((item) => item.title), ["验证 Mac 安装", "记录风险"]);
});

for (const environment of ["desktop", "preview"]) {
  test(`${environment}: note task batch is atomic, deduplicated, and links source`, async (t) => {
    let memory = { projects: [], tasks: [] };
    const { root, store } = fixture(t);
    const api = environment === "desktop" ? store : model.previewApi(() => structuredClone(memory), (next) => { memory = structuredClone(next); return next; });
    const project = (await api.addProject({ name: "导入" })).projects[0];
    let state = await api.addTasksBatch([
      { title: "验证 安装", projectId: project.Id, sourceNotePath: "会议/发布.md" },
      { title: "记录风险", projectId: project.Id, sourceNotePath: "会议/发布.md" },
    ]);
    assert.equal(state.tasks.length, 2);
    assert.deepEqual(state.projects[0].LinkedNotes, ["会议/发布.md"]);
    const duplicateBatch = () => api.addTasksBatch([
      { title: "新任务", projectId: project.Id, sourceNotePath: "会议/发布.md" },
      { title: "  验证　安装 ", projectId: project.Id, sourceNotePath: "会议/发布.md" },
    ]);
    if (environment === "desktop") assert.throws(duplicateBatch, /重复/);
    else await assert.rejects(duplicateBatch, /重复/);
    state = environment === "desktop" ? createZenTaskStore(root).load() : await api.load();
    assert.equal(state.tasks.length, 2, "failed batch writes nothing");
  });
}

test("attention excludes archived/completed and applies documented 7/14 day thresholds", () => {
  const now = new Date("2026-06-15T12:00:00Z");
  const active = model.createProject({ name: "活跃", status: "At Risk", lifecycleStatus: "In Progress" }, "active", "2026-05-01T00:00:00Z");
  active.Milestones = [{ Id: "m", Name: "交付", DueDate: "2026-06-20" }];
  const archived = model.createProject({ name: "归档", archived: true }, "archived", "2026-05-01T00:00:00Z");
  const completed = model.createProject({ name: "完成", lifecycleStatus: "Completed" }, "completed", "2026-05-01T00:00:00Z");
  const items = model.attentionItems({ projects: [active, archived, completed], tasks: [{ Id: "t", Title: "卡住", ProjectId: "active", WorkflowStatus: "Blocked" }] }, now);
  assert.ok(items.some((item) => item.kind === "milestone-upcoming" && item.milestoneId === "m"));
  assert.ok(items.some((item) => item.kind === "task-blocked" && item.taskId === "t"));
  assert.ok(items.some((item) => item.kind === "health"));
  assert.ok(items.some((item) => item.kind === "stale-update"));
  assert.deepEqual([...new Set(items.map((item) => item.projectName))], ["活跃"]);
});

test("milestone reorder preserves IDs and safe delete requires explicit task reassignment", async (t) => {
  const { store } = fixture(t);
  let project = store.addProject({ name: "阶段" }).projects[0];
  project = store.updateProject(project.Id, { milestones: [{ id: "a", name: "A" }, { id: "b", name: "B" }] }).projects[0];
  const task = store.addTask({ title: "关联", projectId: project.Id, milestoneId: "a" }).tasks[0];
  project = store.updateProject(project.Id, { milestones: [{ id: "b", name: "B" }, { id: "a", name: "A" }] }).projects[0];
  assert.deepEqual(project.Milestones.map((stage) => stage.Id), ["b", "a"]);
  assert.throws(() => store.deleteMilestone(project.Id, "a"), /选择转移目标/);
  const state = store.deleteMilestone(project.Id, "a", "b");
  assert.equal(state.tasks.find((entry) => entry.Id === task.Id).MilestoneId, "b");
  assert.deepEqual(state.projects[0].Milestones.map((stage) => stage.Id), ["b"]);
});

test("desktop milestone delete rolls back task reassignment when project write fails", (t) => {
  const { root, store } = fixture(t);
  let project = store.addProject({ name: "原子删除" }).projects[0];
  project = store.updateProject(project.Id, { milestones: [{ id: "a", name: "A" }, { id: "b", name: "B" }] }).projects[0];
  const task = store.addTask({ title: "保持关联", projectId: project.Id, milestoneId: "a" }).tasks[0];
  const taskFile = path.join(root, "Journal", "task-module.json");
  const projectFile = path.join(root, "Journal", "zentask-projects.json");
  const beforeTasks = fs.readFileSync(taskFile, "utf8");
  const beforeProjects = fs.readFileSync(projectFile, "utf8");
  const failing = createZenTaskStore(root, { beforeWrite(file) { if (file === projectFile) throw new Error("injected project write failure"); } });
  assert.throws(() => failing.deleteMilestone(project.Id, "a", "b"), /injected/);
  assert.equal(fs.readFileSync(taskFile, "utf8"), beforeTasks);
  assert.equal(fs.readFileSync(projectFile, "utf8"), beforeProjects);
  const state = store.load();
  assert.equal(state.tasks.find((entry) => entry.Id === task.Id).MilestoneId, "a");
  assert.deepEqual(state.projects[0].Milestones.map((stage) => stage.Id), ["a", "b"]);
});

test("renaming a note moves task source and project link together", (t) => {
  const { store } = fixture(t);
  const project = store.addProject({ name: "发布", linkedNotes: ["项目/会议.md"] }).projects[0];
  const task = store.addTask({ title: "复核", projectId: project.Id, sourceNotePath: "项目/会议.md", sourceExcerpt: "复核" }).tasks[0];
  store.relocateNotes("项目", "归档/项目");
  assert.equal(store.load().tasks.find((item) => item.Id === task.Id).SourceNotePath, "归档/项目/会议.md");
  assert.deepEqual(store.load().projects[0].LinkedNotes, ["归档/项目/会议.md"]);
});
