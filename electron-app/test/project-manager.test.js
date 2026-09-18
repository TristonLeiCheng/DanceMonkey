const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const model = require("../src/zen-model");
const context = { window: { DMZenModel: model } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/project-manager.js"), "utf8"), context);

function fixture() {
  let state = {
    projects: [model.createProject({ name: "产品", linkedNotes: ["项目/说明.md"] }, "p1"), model.createProject({ name: "产品二" }, "p2")],
    tasks: [{ Id: "t1", Title: "本项目任务", ProjectId: "p1", WorkflowStatus: "Todo" }, { Id: "t2", Title: "不应混入", Notes: "产品", ProjectId: "p2" }],
  };
  const api = { zenTask: model.previewApi(() => structuredClone(state), (next) => next), workspace: { list: async () => ({ tree: [{ type: "file", name: "说明.md", path: "项目/说明.md" }] }) } };
  const calls = [];
  const esc = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
  const manager = context.window.DMProjectManager.create({ api, esc, attr: esc, rerender() {}, getState: () => state, onResult: async (next) => { state = next; }, editTask: (task, projectId) => calls.push({ task, projectId }), editProject() {}, openNote: async (note) => calls.push({ note }) });
  return { manager, calls, api, getState: () => state };
}

test("project detail uses exact IDs, new tasks inherit project, and note links open the source", async () => {
  const { manager, calls } = fixture();
  await manager.open("p1");
  assert.match(manager.render(), /本项目任务/);
  assert.doesNotMatch(manager.render(), /不应混入/);
  await manager.handleAction("pm-add-task", "p1");
  assert.equal(calls[0].projectId, "p1");
  await manager.handleAction("pm-open-note", "项目/说明.md");
  assert.equal(calls[1].note, "项目/说明.md");
  await manager.handleAction("pm-view", "board");
  assert.match(manager.render(), /pm-board/);
  assert.match(manager.render(), /本项目任务/);
});

test("archive hides editing, keeps relationships, and can be restored from the archive list", async () => {
  const { manager, getState } = fixture();
  await manager.open("p1");
  await manager.handleAction("pm-archive", "p1");
  assert.match(manager.render(), /项目已归档/);
  assert.doesNotMatch(manager.render(), /data-module-action="pm-add-task"/);
  assert.match(manager.render(), /本项目任务/);
  assert.equal(getState().tasks[0].ProjectId, "p1");
  await manager.handleAction("pm-back", "");
  assert.match(manager.render(), /产品/);
  assert.doesNotMatch(manager.render(), /产品二/);
  await manager.handleAction("pm-restore", "p1");
  assert.equal(getState().projects[0].ArchivedAt, null);
});

test("failed note reads remain visible as errors, and project content is escaped", async () => {
  const { manager, api, getState } = fixture();
  getState().projects[0].Name = '<img src=x onerror="alert(1)">';
  await manager.open("p1");
  assert.doesNotMatch(manager.render(), /<img/);
  assert.match(manager.render(), /&lt;img/);
  api.workspace.list = async () => { throw new Error("无法读取知识库"); };
  await manager.handleAction("pm-link-notes", "");
  assert.match(manager.render(), /无法读取知识库/);
  assert.equal(manager.renderModal(), "");
});

test("milestone cards show task progress and can be confirmed independently of task status", async () => {
  const { manager, getState } = fixture();
  getState().projects[0].Milestones = [{ Id: "m1", Name: "首版交付", AcceptanceCriteria: "验收通过", DueDate: "2026-10-01", CompletedAt: null }];
  getState().tasks[0].MilestoneId = "m1";
  await manager.open("p1");
  assert.match(manager.render(), /首版交付/);
  assert.match(manager.render(), /任务 0\/1/);
  assert.match(manager.render(), /里程碑 · 首版交付/);
  await manager.handleAction("pm-toggle-milestone", "m1");
  assert.ok(getState().projects[0].Milestones[0].CompletedAt);
  assert.equal(getState().tasks[0].WorkflowStatus, "Todo");
  assert.match(manager.render(), /已验收/);
  await manager.handleAction("pm-toggle-milestone", "m1");
  assert.equal(getState().projects[0].Milestones[0].CompletedAt, null);
});

test("attention opens relevant project context and milestone controls reorder/delete", async () => {
  const { manager, getState } = fixture();
  const project = getState().projects[0];
  project.Status = "Blocked";
  project.Milestones = [{ Id: "a", Name: "阶段 A" }, { Id: "b", Name: "阶段 B" }];
  getState().tasks[0].MilestoneId = "a";
  const overview = manager.render();
  assert.match(overview, /Needs attention/);
  assert.match(overview, /项目健康度受阻/);
  await manager.handleAction("pm-attention", "0");
  assert.match(manager.render(), /产品/);
  await manager.handleAction("pm-move-milestone-down", "a");
  assert.deepEqual(getState().projects[0].Milestones.map((stage) => stage.Id), ["b", "a"]);
  await manager.handleAction("pm-delete-milestone", "a");
  assert.match(manager.renderModal(), /仍有 1 项关联任务/);
  assert.match(manager.renderModal(), /我确认删除/);
});

test("task attention isolates the exact task and can return to all project tasks", async () => {
  const { manager, getState } = fixture();
  getState().tasks[0].DueDate = "2020-01-01";
  getState().tasks.push({ Id: "t3", Title: "其他待办", ProjectId: "p1", WorkflowStatus: "Todo" });
  assert.match(manager.render(), /任务已逾期/);
  await manager.handleAction("pm-attention", "0");
  assert.match(manager.render(), /pm-task-focused/);
  assert.doesNotMatch(manager.render(), /其他待办/);
  await manager.handleAction("pm-clear-task-focus", "");
  assert.match(manager.render(), /其他待办/);
});

test("detail separates lifecycle, health, weekly history and source links", async () => {
  const { manager, calls, getState } = fixture();
  getState().projects[0].LifecycleStatus = "Paused";
  getState().projects[0].Status = "At Risk";
  getState().projects[0].Updates = [{ Id: "u1", CreatedAt: "2026-09-18", Health: "At Risk", Summary: "方案待确认", Risks: "审批延迟", NextAction: "联系负责人" }];
  getState().tasks[0].SourceNotePath = "项目/说明.md";
  getState().tasks[0].SourceExcerpt = "- 本项目任务";
  await manager.open("p1");
  const html = manager.render();
  assert.match(html, /阶段 · 已暂停/);
  assert.match(html, /健康度 · 有风险/);
  assert.match(html, /方案待确认/);
  assert.match(html, /来源笔记/);
  await manager.handleAction("pm-open-task-source", "项目/说明.md");
  assert.equal(calls[0].note, "项目/说明.md");
  await manager.handleAction("pm-new-update", "");
  assert.match(manager.renderModal(), /本周进展/);
  await manager.handleAction("pm-close-dialog", "");
  assert.equal(manager.renderModal(), "");
});
