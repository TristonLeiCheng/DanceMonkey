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
