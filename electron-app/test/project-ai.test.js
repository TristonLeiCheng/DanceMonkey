const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const model = require("../src/zen-model");
const projectAi = require("../electron/project-ai");

const NOW = new Date(2026, 10, 17, 10, 0, 0);
const iso = (y, m, d) => new Date(y, m - 1, d, 9, 0, 0).toISOString();

function state() {
  const project = model.createProject({
    name: "官网改版", goal: "上线新版官网", acceptanceCriteria: "首页转化率提升 10%", nextAction: "确认设计稿",
    dueDate: "2026-12-31", linkedNotes: ["20_Work/官网方案.md", "70_Finance/预算.md"],
    milestones: [{ id: "m1", name: "设计定稿", dueDate: "2026-11-25", acceptanceCriteria: "评审通过" }],
  }, "p1", iso(2026, 10, 1));
  project.Updates = [{ Id: "u1", CreatedAt: iso(2026, 11, 10), Health: "On Track", Summary: "完成需求调研", Risks: "", NextAction: "出设计稿" }];
  const task = (input, id) => ({ ...model.createTask({ projectId: "p1", ...input }, id, [project], iso(2026, 11, 1)) });
  const tasks = [
    task({ title: "普通待办", dueDate: "2026-12-10" }, "t1"),
    task({ title: "等待法务审核", workflowStatus: "Blocked" }, "t2"),
    task({ title: "已经逾期的稿件", dueDate: "2026-11-10" }, "t3"),
    { ...task({ title: "本周完成的首页线框", workflowStatus: "Completed", milestoneId: "m1" }, "t4"), CompletedAt: iso(2026, 11, 15) },
    { ...task({ title: "很早完成的调研", workflowStatus: "Completed" }, "t5"), CompletedAt: iso(2026, 9, 1) },
    { Id: "x1", Title: "别的项目任务", ProjectId: "p2", WorkflowStatus: "Todo" },
  ];
  return { projects: [project, model.createProject({ name: "别的项目" }, "p2")], tasks };
}

test("project context lists urgent tasks first, stays within the project, and skips protected note titles", () => {
  const { text, summary } = projectAi.buildProjectContext(state(), "p1", { now: NOW });
  assert.match(text, /# 项目：官网改版/);
  assert.match(text, /上线新版官网/);
  assert.match(text, /首页转化率提升 10%/);
  assert.match(text, /设计定稿 · 目标 2026-11-25 · 任务 1\/1/);
  assert.doesNotMatch(text, /别的项目任务/);
  const blocked = text.indexOf("等待法务审核");
  const overdue = text.indexOf("已经逾期的稿件");
  const normal = text.indexOf("普通待办");
  assert.ok(blocked > 0 && blocked < overdue && overdue < normal, "blocked, then overdue, then the rest");
  assert.match(text, /\[待办·逾期\] 已经逾期的稿件/);
  assert.match(text, /本周完成的首页线框 · 完成于 2026-11-15/);
  assert.doesNotMatch(text, /很早完成的调研/);
  assert.match(text, /官网方案/);
  assert.doesNotMatch(text, /预算/);
  assert.equal(summary.protectedNotesSkipped, 1);
  assert.equal(summary.openTasks, 3);
  assert.equal(summary.recentDone, 1);
  assert.equal(summary.truncated, false);
});

test("project context honours source toggles and truncates task lists to the budget", () => {
  const data = state();
  const { text } = projectAi.buildProjectContext(data, "p1", { now: NOW, include: { tasks: false, milestones: false, updates: false, notes: false } });
  assert.doesNotMatch(text, /普通待办|设计定稿|完成需求调研|官网方案/);
  assert.match(text, /上线新版官网/);
  for (let index = 0; index < 120; index += 1) data.tasks.push({ Id: `bulk${index}`, Title: `批量任务 ${index} ${"说明".repeat(30)}`, ProjectId: "p1", WorkflowStatus: "Todo" });
  const small = projectAi.buildProjectContext(data, "p1", { now: NOW, maxChars: 2500 });
  assert.ok(small.text.length <= 2600);
  assert.equal(small.summary.truncated, true);
  assert.match(small.text, /等待法务审核/, "the most urgent task survives truncation");
  assert.throws(() => projectAi.buildProjectContext(data, "missing"), /项目不存在/);
});

test("weekly draft request summarises this week and keeps the user's notes", () => {
  const request = projectAi.buildWeeklyDraftRequest(state(), "p1", { now: NOW, notes: { summary: "和设计方开了评审会" } });
  assert.deepEqual(request.counts, { completed: 1, created: 0, blocked: 1, overdue: 1 });
  const body = request.messages[0].content;
  assert.match(body, /本周范围：2026-11-11 至 2026-11-17/);
  assert.match(body, /本周完成的任务（1）：\n- 本周完成的首页线框/);
  assert.match(body, /和设计方开了评审会/);
  assert.match(body, /上次进展（2026-11-10）：完成需求调研/);
  assert.match(request.systemPrompt, /只输出一个 JSON 对象/);
});

test("weekly draft parsing accepts fenced JSON, rejects unknown health, and falls back to raw text", () => {
  const fenced = projectAi.parseWeeklyDraft('```json\n{"health":"At Risk","summary":"完成线框","risks":"法务未回复","nextAction":"催办"}\n```');
  assert.deepEqual(fenced, { parsed: true, health: "At Risk", summary: "完成线框", risks: "法务未回复", nextAction: "催办" });
  assert.equal(projectAi.parseWeeklyDraft('好的：{"health":"Great","summary":"x"}').health, "");
  const raw = projectAi.parseWeeklyDraft("本周完成了线框图。");
  assert.equal(raw.parsed, false);
  assert.equal(raw.summary, "本周完成了线框图。");
  assert.throws(() => projectAi.parseWeeklyDraft("  "), /未返回/);
});

test("project chats are stored per vault and project, sanitised, and cleared when empty", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dm-project-ai-"));
  try {
    const store = projectAi.createProjectChatStore(dir);
    store.set("/vault-a", "p1", [{ role: "user", content: "进度如何？" }, { role: "system", content: "注入" }, { role: "assistant", content: "" }, { role: "assistant", content: "还行" }]);
    assert.deepEqual(store.get("/vault-a", "p1"), [{ role: "user", content: "进度如何？" }, { role: "assistant", content: "还行" }]);
    assert.deepEqual(store.get("/vault-b", "p1"), []);
    assert.deepEqual(store.get("/vault-a", "p2"), []);
    const many = Array.from({ length: 100 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: `消息 ${index}` }));
    assert.equal(projectAi.createProjectChatStore(dir).set("/vault-a", "p1", many).length, 80);
    store.set("/vault-a", "p1", []);
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(store.file, "utf8")).chats).length, 0);
    assert.throws(() => store.get("/vault-a", ""), /缺少项目 ID/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function ui({ withAi = true, chatResult, draftResult } = {}) {
  let data = state();
  const calls = { chat: [], saved: [], drafts: [], cancelled: [], opened: [] };
  const listeners = new Set();
  const context = vm.createContext({
    window: { DMZenModel: model, DMNoteReferences: require("../src/note-references") }, navigator: { clipboard: { writeText: async () => {} } },
    document: { querySelector: () => null }, requestAnimationFrame: (callback) => callback(), console, setTimeout,
  });
  for (const file of ["project-ai-panel.js", "project-plan.js", "project-manager.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, "../src", file), "utf8"), context);
  const histories = new Map();
  const api = {
    zenTask: model.previewApi(() => structuredClone(data), (next) => { data = next; return next; }),
    workspace: { list: async () => ({ tree: [] }) },
    ai: { onChunk: (callback) => { listeners.add(callback); return () => listeners.delete(callback); }, cancel: async (id) => calls.cancelled.push(id) },
  };
  if (withAi) {
    api.projectAi = {
      history: async (id) => histories.get(id) || [],
      saveHistory: async (id, messages) => { histories.set(id, messages); calls.saved.push(messages); return messages; },
      chat: async (payload) => {
        calls.chat.push(payload);
        for (const listener of listeners) listener({ requestId: payload.requestId, chunk: "部分" });
        return chatResult ? chatResult(payload) : { success: true, text: "建议先解决法务审核。", context: { truncated: false, protectedNotesSkipped: 1 } };
      },
      draftUpdate: async (payload) => { calls.drafts.push(payload); return draftResult ? draftResult(payload) : { success: true, counts: { completed: 1, created: 0, blocked: 1, overdue: 1 }, draft: { parsed: true, health: "At Risk", summary: "完成首页线框", risks: "法务审核受阻", nextAction: "催办法务" } }; },
    };
  }
  const esc = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
  const manager = context.window.DMProjectManager.create({ api, esc, attr: esc, rerender() {}, getState: () => data, onResult: async (next) => { data = next; },
    editTask() {}, editProject() {}, openNote: async (path) => { calls.opened.push(path); } });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return { manager, calls, histories, api, getState: () => data, settle };
}

test("AI tab sends only the project id and selected sources, then keeps the conversation per project", async () => {
  const { manager, calls, histories, settle } = ui();
  await manager.open("p1", "ai");
  await settle();
  let html = manager.render();
  assert.match(html, /项目 AI 助手/);
  assert.match(html, /任务 · 3/);
  assert.match(html, /笔记标题 · 2/);
  assert.match(html, /只有用 @ 选中的笔记才发送正文/);
  await manager.handleAction("pm-ai-toggle", "notes");
  await manager.handleAction("pm-ai-prompt", "1");
  await settle();
  assert.equal(calls.chat.length, 1);
  assert.equal(calls.chat[0].projectId, "p1");
  assert.equal(calls.chat[0].include.notes, false);
  assert.equal(calls.chat[0].include.tasks, true);
  assert.equal("context" in calls.chat[0], false, "the renderer never sends project data itself");
  assert.match(calls.chat[0].messages.at(-1).content, /最值得推进的 3 件事/);
  assert.equal(histories.get("p1").map((message) => message.role).join(","), "user,assistant");
  html = manager.render();
  assert.match(html, /建议先解决法务审核/);
  assert.match(html, /已排除 1 篇受保护目录笔记/);
  await manager.handleAction("pm-ai-clear", "");
  assert.equal(histories.get("p1").length, 0);
});

test("failed AI replies surface the error and keep the question on screen", async () => {
  const { manager, settle } = ui({ chatResult: () => ({ success: false, error: "API 错误 (401)：invalid key" }) });
  await manager.open("p1", "ai");
  await settle();
  await manager.handleAction("pm-ai-prompt", "0");
  await settle();
  const html = manager.render();
  assert.match(html, /invalid key/);
  assert.match(html, /总结这个项目的现状/);
  assert.match(html, /data-module-action="pm-ai-send"/);
});

test("weekly update dialog drafts with AI, fills the form for review, and saves only on submit", async () => {
  const { manager, calls, getState, settle } = ui();
  await manager.open("p1", "updates");
  await manager.handleAction("pm-new-update", "");
  assert.match(manager.renderModal(), /AI 起草/);
  await manager.handleAction("pm-draft-update", "");
  await settle();
  assert.equal(calls.drafts[0].projectId, "p1");
  const html = manager.renderModal();
  assert.match(html, /完成首页线框/);
  assert.match(html, /法务审核受阻/);
  assert.match(html, /value="At Risk" selected/);
  assert.match(html, /本周完成 1 项/);
  assert.equal(model.list(getState().projects[0], "Updates").length, 1, "nothing is saved before the user submits");
});

test("stopping a draft leaves the form unchanged, and the AI tab offers weekly drafting only for active projects", async () => {
  let release;
  const { manager, calls, settle } = ui({ draftResult: () => new Promise((resolve) => { release = () => resolve({ success: false, error: "请求超时或已停止生成。" }); }) });
  await manager.open("p1", "updates");
  await manager.handleAction("pm-new-update", "");
  await manager.handleAction("pm-draft-update", "");
  assert.match(manager.renderModal(), /停止起草/);
  assert.match(manager.renderModal(), /<textarea name="summary"[^>]*disabled/);
  await manager.handleAction("pm-cancel-draft", "");
  assert.equal(calls.cancelled.length, 1);
  release();
  await settle();
  const html = manager.renderModal();
  assert.match(html, /已停止起草/);
  assert.doesNotMatch(html, /module-error/);
  await manager.handleAction("pm-close-dialog", "");
  await manager.handleAction("pm-tab", "ai");
  await settle();
  assert.match(manager.render(), /起草本周进展/);
  await manager.handleAction("pm-archive", "p1");
  await manager.open("p1", "ai");
  await settle();
  assert.doesNotMatch(manager.render(), /起草本周进展/);
});

test("browser preview explains that project AI needs the desktop app", async () => {
  const { manager } = ui({ withAi: false });
  await manager.open("p1", "ai");
  assert.match(manager.render(), /浏览器预览不连接 AI/);
  await manager.handleAction("pm-new-update", "");
  assert.doesNotMatch(manager.renderModal(), /AI 起草/);
});

const actionsBlock = (actions) => `建议如下。\n\n\`\`\`dm-actions\n${JSON.stringify({ actions })}\n\`\`\``;

test("action blocks are split from the reply, and incomplete or malformed blocks yield no actions", () => {
  assert.deepEqual(projectAi.splitActions(actionsBlock([{ type: "create_task", title: "A" }])).raw, [{ type: "create_task", title: "A" }]);
  assert.equal(projectAi.splitActions(actionsBlock([])).display, "建议如下。");
  const partial = projectAi.splitActions("正文\n```dm-actions\n{\"actions\":[");
  assert.equal(partial.display, "正文");
  assert.equal(partial.raw.length, 0);
  assert.equal(projectAi.splitActions("正文\n```dm-actions\nnot json\n```\n结尾").display, "正文\n\n结尾");
});

test("proposed actions are validated against the project and invalid ones are counted, not shown", () => {
  const data = state();
  const reply = actionsBlock([
    { type: "create_task", title: "联系法务负责人", dueDate: "2026-11-20", milestoneId: "m1", priority: "High" },
    { type: "create_task", title: "联系法务负责人" },
    { type: "create_task", title: "普通待办" },
    { type: "create_task", title: "错误里程碑", milestoneId: "nope" },
    { type: "create_task", title: "错误日期", dueDate: "2026-02-30" },
    { type: "update_task", taskId: "t2", status: "In Progress" },
    { type: "update_task", taskId: "t1", status: "Todo" },
    { type: "update_task", taskId: "x1", status: "Completed" },
  ]);
  const { actions, dropped, display } = projectAi.extractActions(reply, data, "p1");
  assert.equal(display, "建议如下。");
  assert.deepEqual(actions.map((action) => action.type), ["create_task", "update_task"]);
  assert.equal(actions[0].detail, "截止 2026-11-20 · 里程碑 设计定稿 · 优先级 高");
  assert.match(actions[1].detail, /「等待法务审核」 状态 受阻 → 进行中/);
  assert.equal(actions.every((action) => action.state === "pending" && action.id), true);
  assert.equal(dropped, 6);
  const project = projectAi.extractActions(actionsBlock([{ type: "update_project", health: "At Risk", nextAction: "催法务" }]), data, "p1").actions[0];
  assert.deepEqual(project.changes, { nextAction: "催法务", status: "At Risk" });
  const many = projectAi.extractActions(actionsBlock(Array.from({ length: 10 }, (_, index) => ({ type: "create_task", title: `任务 ${index}` }))), data, "p1");
  assert.equal(many.actions.length, 8);
  assert.equal(many.dropped, 2);
  data.projects[0].ArchivedAt = iso(2026, 11, 16);
  assert.throws(() => projectAi.checkAction({ type: "create_task", title: "x" }, data, "p1"), /已归档/);
});

function seededStore() {
  const { createZenTaskStore } = require("../electron/zentask");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dm-project-ai-store-"));
  const data = state();
  fs.mkdirSync(path.join(dir, "Journal"));
  fs.writeFileSync(path.join(dir, "Journal", "zentask-projects.json"), JSON.stringify({ SchemaVersion: 2, Items: data.projects }));
  fs.writeFileSync(path.join(dir, "Journal", "task-module.json"), JSON.stringify({ SchemaVersion: 2, Items: data.tasks }));
  return { store: createZenTaskStore(dir), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("applying actions writes through the task store and each one can be undone", () => {
  const { store, cleanup } = seededStore();
  try {
    const actions = projectAi.extractActions(actionsBlock([
      { type: "create_task", title: "联系法务负责人", dueDate: "2026-11-20", milestoneId: "m1" },
      { type: "update_task", taskId: "t2", status: "In Progress", dueDate: "2026-11-30" },
      { type: "update_project", health: "At Risk", nextAction: "催法务" },
    ]), store.load(), "p1").actions;
    const created = projectAi.applyAction(store, "p1", actions[0]);
    const task = created.state.tasks.find((entry) => entry.Title === "联系法务负责人");
    assert.equal(task.ProjectId, "p1");
    assert.equal(task.MilestoneId, "m1");
    assert.equal(task.Tags, "AI 建议");
    assert.equal(created.undo.type, "delete_task");
    assert.equal(created.undo.taskId, task.Id);
    assert.throws(() => projectAi.applyAction(store, "p1", actions[0]), /已有同名任务/, "re-applying is rejected as a duplicate");

    const updated = projectAi.applyAction(store, "p1", actions[1]);
    const t2 = updated.state.tasks.find((entry) => entry.Id === "t2");
    assert.equal(t2.WorkflowStatus, "In Progress");
    assert.equal(t2.DueDate, "2026-11-30");
    assert.deepEqual(updated.undo.changes, { workflowStatus: "Blocked", dueDate: "" });

    const projectResult = projectAi.applyAction(store, "p1", actions[2]);
    assert.equal(projectResult.state.projects[0].Status, "At Risk");
    assert.equal(projectResult.state.projects[0].NextAction, "催法务");

    let after = projectAi.undoAction(store, "p1", projectResult.undo);
    assert.equal(after.projects[0].Status, "On Track");
    assert.equal(after.projects[0].NextAction, "确认设计稿");
    after = projectAi.undoAction(store, "p1", updated.undo);
    assert.equal(after.tasks.find((entry) => entry.Id === "t2").WorkflowStatus, "Blocked");
    assert.equal(after.tasks.find((entry) => entry.Id === "t2").DueDate, null);
    after = projectAi.undoAction(store, "p1", created.undo);
    assert.equal(after.tasks.some((entry) => entry.Title === "联系法务负责人"), false);
    assert.throws(() => projectAi.undoAction(store, "p1", created.undo), /已不存在/);
    assert.throws(() => projectAi.applyAction(store, "p1", { type: "update_task", taskId: "x1", changes: { workflowStatus: "Completed" } }), /不属于本项目/);
  } finally { cleanup(); }
});

test("history keeps action cards for display, and the model sees their outcome as text", () => {
  const messages = projectAi.sanitizeMessages([
    { role: "user", content: "排期" },
    { role: "assistant", content: "建议如下", droppedActions: 2, actions: [{ type: "create_task", title: "A", summary: "新建任务「A」", state: "applied" }, { type: "drop_table", state: "pending" }, { type: "update_task", summary: "更新任务「B」", state: "weird" }] },
  ]);
  assert.equal(messages[1].actions.length, 2);
  assert.equal(messages[1].actions[1].state, "pending");
  assert.equal(messages[1].droppedActions, 2);
  const sent = projectAi.modelMessages(messages);
  assert.deepEqual(Object.keys(sent[1]), ["role", "content"]);
  assert.match(sent[1].content, /\[操作建议：新建任务「A」（已应用）；更新任务「B」（待确认）\]/);
  assert.match(projectAi.projectChatSystemPrompt("x"), /dm-actions/);
  assert.doesNotMatch(projectAi.projectChatSystemPrompt("x", { readOnly: true }), /dm-actions/);
});

test("daily brief covers active projects and attention items, and is cached per vault and day", () => {
  const data = state();
  data.projects[1].ArchivedAt = iso(2026, 11, 1);
  const request = projectAi.buildBriefRequest(data, NOW);
  const body = request.messages[0].content;
  assert.match(body, /今天：2026-11-17/);
  assert.match(body, /官网改版：正常 · 计划中 · 完成率 40%（2\/5） · 受阻 1 · 逾期 1/);
  assert.doesNotMatch(body, /别的项目/);
  assert.match(body, /\[任务受阻\] 官网改版：等待法务审核/);
  assert.match(body, /\[任务已逾期\] 官网改版：已经逾期的稿件 · 2026-11-10/);
  assert.doesNotMatch(body, /设计定稿/, "a milestone 8 days out is not yet an attention item");
  assert.deepEqual(request.counts, { projects: 1, attention: request.counts.attention });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dm-project-ai-brief-"));
  try {
    const store = projectAi.createProjectChatStore(dir);
    store.setBrief("/a", { date: "2026-11-17", text: "1. 催法务", generatedAt: NOW.toISOString() });
    assert.equal(store.getBrief("/a", "2026-11-17").text, "1. 催法务");
    assert.equal(store.getBrief("/a", "2026-11-18"), null);
    assert.equal(store.getBrief("/b", "2026-11-17"), null);
    store.set("/a", "p1", [{ role: "user", content: "hi" }]);
    assert.equal(store.getBrief("/a", "2026-11-17").text, "1. 催法务", "chat writes keep the brief");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function actionUi(options = {}) {
  const harness = ui({ ...options, chatResult: options.chatResult || (() => ({ success: true, text: "建议如下。", droppedActions: 1, actions: [
    { id: "a1", type: "create_task", title: "联系法务负责人", detail: "截止 2026-11-20", label: "新建任务", summary: "新建任务「联系法务负责人」", state: "pending" },
    { id: "a2", type: "update_task", taskId: "t2", changes: { workflowStatus: "In Progress" }, label: "更新任务", summary: "更新任务", detail: "「等待法务审核」 状态 受阻 → 进行中", state: "pending" },
  ] })) });
  return harness;
}

test("action cards apply through the API without display fields, refresh project data, and can be undone", async () => {
  const harness = actionUi();
  const { manager, settle, histories } = harness;
  const applied = [];
  let failNext = false;
  const projectAiApi = { applyAction: async (projectId, action) => {
    applied.push({ projectId, action });
    if (failNext) throw new Error("Error invoking remote method 'projectAi:applyAction': Error: 已有同名任务：联系法务负责人");
    return { state: harness.getState(), undo: { type: "delete_task", taskId: "new" } };
  }, undoAction: async () => harness.getState() };
  await manager.open("p1", "ai");
  await settle();
  Object.assign(harness.api.projectAi, projectAiApi);
  await manager.handleAction("pm-ai-prompt", "3");
  await settle();
  let html = manager.render();
  assert.match(html, /建议的操作 · 2/);
  assert.match(html, /联系法务负责人/);
  assert.match(html, /另有 1 项建议与当前项目数据不符/);
  assert.match(html, /data-module-action="pm-ai-apply-all"/);
  await manager.handleAction("pm-ai-apply", "1:0");
  assert.equal(applied[0].projectId, "p1");
  assert.equal(applied[0].action.title, "联系法务负责人");
  for (const key of ["label", "summary", "detail", "state", "id"]) assert.equal(key in applied[0].action, false, `${key} is not sent`);
  html = manager.render();
  assert.match(html, /已应用/);
  assert.match(html, /data-module-action="pm-ai-undo" data-id="1:0"/);
  assert.equal(histories.get("p1")[1].actions[0].state, "applied", "card state is persisted");
  await manager.handleAction("pm-ai-undo", "1:0");
  assert.match(manager.render(), /已撤销/);
  failNext = true;
  await manager.handleAction("pm-ai-apply", "1:1");
  html = manager.render();
  assert.match(html, /已有同名任务：联系法务负责人/);
  assert.doesNotMatch(html, /Error invoking/);
  assert.match(html, />重试</);
  await manager.handleAction("pm-ai-dismiss", "1:1");
  assert.match(manager.render(), /已忽略/);
});

test("apply-all stops at the first failure, and archived projects show cards without apply buttons", async () => {
  const harness = actionUi();
  const { manager, settle } = harness;
  const calls = [];
  await manager.open("p1", "ai");
  await settle();
  harness.api.projectAi.applyAction = async (_id, action) => { calls.push(action.type); throw new Error("写入失败"); };
  await manager.handleAction("pm-ai-prompt", "0");
  await settle();
  await manager.handleAction("pm-ai-apply-all", "1");
  assert.deepEqual(calls, ["create_task"]);
  await manager.handleAction("pm-archive", "p1");
  await manager.open("p1", "ai");
  await settle();
  const html = manager.render();
  assert.match(html, /项目已归档/);
  assert.doesNotMatch(html, /data-module-action="pm-ai-apply"/);
  assert.doesNotMatch(html, /拆解成任务/);
});

test("streamed action blocks are hidden while the reply is still arriving", () => {
  const context = vm.createContext({ window: {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/project-ai-panel.js"), "utf8"), context);
  const { visibleText } = context.window.DMProjectAIPanel;
  assert.equal(visibleText("建议\n```dm-actions\n{\"act"), "建议");
  assert.equal(visibleText("建议\n```dm-ac"), "建议");
  assert.equal(visibleText("代码 ```js"), "代码 ```js");
});

test("the project list shows a daily brief that can be generated and stopped", async () => {
  const harness = ui();
  const { manager, settle } = harness;
  let resolveBrief;
  harness.api.projectAi.getBrief = async () => null;
  harness.api.projectAi.brief = (payload) => new Promise((resolve) => { resolveBrief = () => resolve({ success: true, brief: { date: "x", text: "1. **催法务**", generatedAt: new Date(2026, 10, 18, 9, 5).toISOString() } }); harness.calls.briefRequest = payload; });
  manager.render();
  await settle();
  let html = manager.render();
  assert.match(html, /AI 今日简报/);
  assert.match(html, /生成简报/);
  await manager.handleAction("pm-ai-brief", "");
  assert.match(manager.render(), /data-module-action="pm-ai-brief-stop"/);
  assert.ok(harness.calls.briefRequest.requestId);
  resolveBrief();
  await settle();
  html = manager.render();
  assert.match(html, /催法务/);
  assert.match(html, /今天 09:05 生成/);
  assert.match(html, /重新生成/);
  await manager.handleAction("pm-filter", "archived");
  assert.doesNotMatch(manager.render(), /AI 今日简报/);
});

test("portfolio context lists active projects with focus tasks and stays within budget", () => {
  const data = state();
  data.projects.push(model.createProject({ name: "已完成的旧项目", lifecycleStatus: "Completed" }, "p3"));
  data.projects.push({ ...model.createProject({ name: "归档项目" }, "p4"), ArchivedAt: iso(2026, 11, 1) });
  const { text, summary } = projectAi.buildPortfolioContext(data, { now: NOW });
  assert.match(text, /进行中 2 个，已完成 1 个，已归档 1 个/);
  assert.match(text, /已完成项目：已完成的旧项目/);
  assert.match(text, /## 官网改版（正常 · 计划中/);
  assert.match(text, /\[受阻\] 等待法务审核/);
  assert.match(text, /下一里程碑：设计定稿（目标 2026-11-25）/);
  assert.match(text, /## 需要关注/);
  assert.doesNotMatch(text, /## 归档项目/);
  assert.doesNotMatch(text, /ID t1/);
  assert.equal(summary.included, 2);
  for (let index = 0; index < 40; index += 1) data.projects.push(model.createProject({ name: `批量项目 ${index}`, goal: "目标".repeat(80) }, `bulk${index}`));
  const small = projectAi.buildPortfolioContext(data, { now: NOW, maxChars: 3000 });
  assert.equal(small.summary.truncated, true);
  assert.ok(small.text.length <= 3100);
  assert.match(small.text, /## 需要关注/, "attention items are kept when projects are cut");
  assert.doesNotMatch(projectAi.portfolioSystemPrompt("x"), /dm-actions/);
});

test("plan replies become editable groups: existing milestones, duplicates unselected, bad dates cleared", () => {
  const data = state();
  const reply = JSON.stringify({ milestones: [
    { milestoneId: "m1", name: "忽略", tasks: [{ title: "完成首页视觉稿", dueDate: "2026-11-24", priority: "High" }, { title: "普通待办" }] },
    { name: "开发上线", dueDate: "2026-13-01", acceptanceCriteria: "线上可访问", tasks: [{ title: "搭建页面" }, { title: "搭建页面" }, { title: "" }] },
    { name: "", tasks: [{ title: "无名阶段任务" }] },
    { milestoneId: "unknown", tasks: [] },
  ] });
  const { groups, dropped } = projectAi.parsePlan("```json\n" + reply + "\n```", data, "p1");
  assert.equal(groups.length, 2);
  assert.equal(groups[0].existingId, "m1");
  assert.equal(groups[0].name, "设计定稿");
  assert.deepEqual(groups[0].tasks.map((task) => [task.title, task.selected, task.duplicate]), [["完成首页视觉稿", true, false], ["普通待办", false, true]]);
  assert.equal(groups[1].existingId, "");
  assert.equal(groups[1].dueDate, "");
  assert.deepEqual(groups[1].tasks.map((task) => task.selected), [true, false]);
  assert.equal(dropped, 3);
  assert.throws(() => projectAi.parsePlan("我觉得可以这样做", data, "p1"), /无法识别/);
  assert.throws(() => projectAi.parsePlan('{"milestones":[]}', data, "p1"), /没有给出可用的里程碑/);
  const request = projectAi.buildPlanRequest(data, "p1", { now: NOW, notes: "两个人" });
  assert.match(request.systemPrompt, /不早于今天（2026-11-17）、不晚于项目截止日期 2026-12-31/);
  assert.match(request.messages[0].content, /上线新版官网/);
  assert.match(request.messages[0].content, /两个人/);
  data.projects[0].ArchivedAt = iso(2026, 11, 16);
  assert.throws(() => projectAi.buildPlanRequest(data, "p1"), /已归档/);
});

test("applying a plan creates milestones and linked tasks, and rolls milestones back if tasks fail", () => {
  const { store, cleanup } = seededStore();
  try {
    const result = projectAi.applyPlan(store, "p1", { groups: [
      { existingId: "m1", tasks: [{ title: "完成首页视觉稿", dueDate: "2026-11-24", priority: "High" }] },
      { name: "开发上线", dueDate: "2026-12-20", acceptanceCriteria: "线上可访问", tasks: [{ title: "搭建页面" }, { title: "接入统计" }] },
      { name: "复盘", tasks: [] },
    ] });
    assert.deepEqual(result.created, { milestones: 2, tasks: 3 });
    const stages = result.state.projects[0].Milestones;
    assert.deepEqual(stages.map((stage) => stage.Name), ["设计定稿", "开发上线", "复盘"]);
    const launch = stages[1];
    assert.equal(launch.DueDate, "2026-12-20");
    const created = result.state.tasks.filter((task) => task.Tags === "AI 计划");
    assert.equal(created.length, 3);
    assert.equal(created.find((task) => task.Title === "搭建页面").MilestoneId, launch.Id);
    assert.equal(created.find((task) => task.Title === "完成首页视觉稿").MilestoneId, "m1");

    const before = store.load().projects[0].Milestones.length;
    assert.throws(() => projectAi.applyPlan(store, "p1", { groups: [{ name: "会失败的阶段", tasks: [{ title: "普通待办" }] }] }), /疑似重复任务/);
    assert.equal(store.load().projects[0].Milestones.length, before, "milestone is rolled back");
    assert.throws(() => projectAi.applyPlan(store, "p1", { groups: [] }), /至少选择/);
    assert.throws(() => projectAi.applyPlan(store, "p1", { groups: [{ existingId: "gone", tasks: [{ title: "x" }] }] }), /不存在/);
    assert.throws(() => projectAi.applyPlan(store, "p1", { groups: [{ name: "日期错", dueDate: "2026-02-30", tasks: [] }] }), /日期无效/);
  } finally { cleanup(); }
});

test("AI notes go to an output folder with front matter, and saved note paths survive history sanitising", () => {
  const { createWorkspace } = require("../electron/workspace");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dm-ai-note-"));
  try {
    const workspace = createWorkspace(dir);
    const first = workspace.createAiNote({ title: "官网改版：下一步/建议", body: "1. **催法务**", project: "官网改版" });
    const second = workspace.createAiNote({ title: "官网改版：下一步/建议", body: "x" });
    assert.equal(first.path, "AI 输出/官网改版：下一步-建议.md");
    assert.equal(second.path, "AI 输出/官网改版：下一步-建议 2.md");
    const content = fs.readFileSync(path.join(dir, first.path), "utf8");
    assert.match(content, /^---\nid: "/);
    assert.match(content, /type: "ai-output"/);
    assert.match(content, /project: "官网改版"/);
    assert.match(content, /> 由 AI 根据项目数据生成/);
    assert.match(content, /1\. \*\*催法务\*\*/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const clean = projectAi.sanitizeMessages([{ role: "assistant", content: "a", savedNote: "AI 输出/a.md" }, { role: "assistant", content: "b", savedNote: "../../etc/passwd" }, { role: "user", content: "c", savedNote: "x.md" }]);
  assert.equal(clean[0].savedNote, "AI 输出/a.md");
  assert.equal("savedNote" in clean[1], false);
  assert.equal("savedNote" in clean[2], false);
});

test("the project list offers a portfolio conversation that sends no project id and saves replies as notes", async () => {
  const harness = ui();
  const { manager, calls, histories, settle } = harness;
  const saved = [];
  harness.api.projectAi.getBrief = async () => null;
  harness.api.projectAi.brief = async () => ({ success: true, brief: { date: "2026-11-18", text: "1. 催法务", generatedAt: new Date().toISOString() } });
  harness.api.projectAi.saveNote = async (input) => { saved.push(input); return { path: `AI 输出/${input.title}.md`, linked: Boolean(input.projectId), state: harness.getState() }; };
  manager.render();
  await settle();
  let html = manager.render();
  assert.match(html, /问问所有项目/);
  assert.match(html, /本周风险/);
  await manager.handleAction("pm-ai-prompt", "1");
  await settle();
  assert.equal(calls.chat[0].scope, "portfolio");
  assert.equal(calls.chat[0].projectId, "__portfolio__");
  assert.equal("include" in calls.chat[0], false);
  assert.equal(histories.get("__portfolio__").length, 2);
  await manager.handleAction("pm-ai-save-note", "1");
  assert.equal(saved[0].projectId, "");
  assert.equal(saved[0].kind, "insight");
  assert.match(saved[0].title, /^项目组合：列出所有逾期或受阻的任务/);
  html = manager.render();
  assert.match(html, /已存为笔记 · 打开/);
  assert.equal(histories.get("__portfolio__")[1].savedNote, saved[0].title ? `AI 输出/${saved[0].title}.md` : "");
  await manager.handleAction("pm-ai-brief", "");
  await settle();
  await manager.handleAction("pm-ai-brief-save", "");
  assert.equal(saved[1].kind, "digest");
  assert.equal(saved[1].title, "今日简报 2026-11-18");
  assert.match(manager.render(), /已保存为笔记/);
});

test("project replies saved as notes are linked to the project", async () => {
  const harness = ui();
  const { manager, settle } = harness;
  const saved = [];
  harness.api.projectAi.saveNote = async (input) => { saved.push(input); return { path: "AI 输出/x.md", linked: true, state: harness.getState() }; };
  await manager.open("p1", "ai");
  await settle();
  await manager.handleAction("pm-ai-prompt", "0");
  await settle();
  await manager.handleAction("pm-ai-save-note", "1");
  assert.equal(saved[0].projectId, "p1");
  assert.match(saved[0].title, /^官网改版：请用 5 条以内总结/);
  assert.match(manager.render(), /并关联到项目资料/);
});

test("plan dialog generates a preview, skips unselected items, creates and returns to milestones", async () => {
  const harness = ui();
  const { manager, settle } = harness;
  const applied = [];
  harness.api.projectAi.plan = async (payload) => { harness.calls.plan = payload; return { success: true, plan: { dropped: 1, groups: [
    { key: "0", existingId: "", name: "开发上线", dueDate: "2026-12-20", acceptanceCriteria: "线上可访问", selected: true, tasks: [
      { key: "0-0", title: "搭建页面", dueDate: "", priority: "High", duplicate: false, selected: true },
      { key: "0-1", title: "普通待办", dueDate: "", priority: "", duplicate: true, selected: false }] },
  ] } }; };
  harness.api.projectAi.applyPlan = async (projectId, plan) => { applied.push({ projectId, plan }); return { state: harness.getState(), created: { milestones: 1, tasks: 1 } }; };
  await manager.open("p1", "milestones");
  assert.match(manager.render(), /AI 拆解计划/);
  await manager.handleAction("pm-plan-open", "");
  let modal = manager.renderModal();
  assert.match(modal, /上线新版官网/);
  assert.match(modal, /生成计划/);
  await manager.handleAction("pm-plan-generate", "");
  await settle();
  assert.equal(harness.calls.plan.projectId, "p1");
  modal = manager.renderModal();
  assert.match(modal, /将创建 1 个里程碑、1 项任务/);
  assert.match(modal, /已有同名任务/);
  assert.match(modal, /另有 1 项/);
  await manager.handleAction("pm-plan-create", "");
  assert.deepEqual(JSON.parse(JSON.stringify(applied[0].plan)), { groups: [{ existingId: "", name: "开发上线", dueDate: "2026-12-20", acceptanceCriteria: "线上可访问", tasks: [{ title: "搭建页面", dueDate: "", priority: "High" }] }] });
  assert.equal(manager.renderModal(), "");
  assert.match(manager.render(), /id="pm-tab-milestones"[^>]*aria-selected="true"/);
});

test("plan dialog keeps the notes after a failed generation and blocks vault sync while open", async () => {
  const harness = ui();
  const { manager, settle } = harness;
  harness.api.projectAi.plan = async () => ({ success: false, error: "API 错误 (500)：busy" });
  harness.api.projectAi.applyPlan = async () => ({});
  await manager.open("p1", "overview");
  assert.doesNotMatch(manager.render(), /用 AI 拆解目标/, "projects with a plan get no hint");
  const tasks = harness.getState().tasks;
  tasks.splice(tasks.findIndex((task) => task.Id === "x1"), 1);
  await manager.open("p2", "overview");
  assert.match(manager.render(), /用 AI 拆解目标/, "an empty project gets a hint");
  await manager.handleAction("pm-plan-open", "");
  assert.equal(manager.hasPendingEdits(), true);
  await manager.handleAction("pm-plan-generate", "");
  await settle();
  const modal = manager.renderModal();
  assert.match(modal, /busy/);
  assert.match(modal, /生成计划/);
  assert.equal(manager.closeModal(), true);
  assert.equal(manager.hasPendingEdits(), false);
});

test("AI note tasks keep only real excerpts, drop duplicates, and protected notes are never sent", async () => {
  const note = "## 周会\n- 张三下周三前把报价发给客户\n结论：方案 A 通过。\n小李负责更新首页文案";
  const reply = JSON.stringify({ tasks: [
    { title: "发送报价给客户", dueDate: "2026-11-25", priority: "High", excerpt: "张三下周三前把报价发给客户" },
    { title: "发送报价给客户" },
    { title: "更新首页文案", excerpt: "编造的原文" },
    { title: "确认日期", dueDate: "明天" },
    { title: "" },
  ] });
  const candidates = projectAi.parseNoteTasks(reply, note);
  assert.deepEqual(candidates.map((item) => [item.title, item.dueDate, item.priority, item.excerpt]), [
    ["发送报价给客户", "2026-11-25", "High", "张三下周三前把报价发给客户"], ["更新首页文案", "", "", ""], ["确认日期", "", "", ""]]);
  assert.equal(candidates.every((item) => item.fromAi), true);
  assert.throws(() => projectAi.parseNoteTasks('{"tasks":[]}', note), /没有在这段内容中找到/);
  assert.throws(() => projectAi.parseNoteTasks("好的", note), /无法识别/);
  const request = projectAi.buildNoteTaskRequest(state(), "p1", note, { now: NOW });
  assert.match(request.systemPrompt, /今天是 2026-11-17/);
  assert.match(request.messages[0].content, /目标项目：官网改版/);
  assert.match(request.messages[0].content, /已有任务：\n- 普通待办/);
  assert.match(request.messages[0].content, /<note>\n## 周会/);
  const calls = [];
  const ai = { chat: async (payload) => { calls.push(payload); return reply; } };
  await assert.rejects(projectAi.extractNoteTasks(ai, state(), { projectId: "p1", text: note, sourcePath: "70_Finance/预算.md" }), /受保护目录/);
  assert.equal(calls.length, 0);
  const result = await projectAi.extractNoteTasks(ai, state(), { projectId: "p1", text: note, sourcePath: "20_Work/周会.md", requestId: "r1" });
  assert.equal(result.candidates.length, 3);
  assert.equal(calls[0].requestId, "r1");
  assert.equal(calls[0].temperature, 0.2);
});

test("brief headline is a plain first item, and persona reviews are labelled for the project model", () => {
  assert.equal(projectAi.briefHeadline("## 今日\n1. **官网改版**：催办[法务](x)\n2. 其他"), "官网改版：催办法务");
  assert.equal(projectAi.briefHeadline("没有需要关注的事项。"), "没有需要关注的事项。");
  assert.equal(projectAi.briefHeadline("- " + "很长".repeat(60), 10), "很长很长很长很长很长…");
  const messages = projectAi.sanitizeMessages([{ role: "assistant", content: "缺回滚方案 [S1]", persona: " 评审者 ", citations: [{ id: "S1", title: "笔记", excerpt: "回滚", extra: "x" }] }]);
  assert.equal(messages[0].persona, "评审者");
  assert.deepEqual(messages[0].citations, [{ id: "S1", title: "笔记", excerpt: "回滚" }]);
  assert.match(projectAi.modelMessages(messages)[0].content, /^\[人物分身「评审者」的审阅（AI 模拟）\]\n缺回滚方案/);
});

test("persona review picker lists personas with cards and records the review in the project conversation", async () => {
  const harness = ui();
  const { manager, settle, histories } = harness;
  const reviews = [];
  harness.api.personas = { list: async () => [{ id: "a", name: "评审者", hasCard: true }, { id: "b", name: "草稿人物", hasCard: false }] };
  harness.api.projectAi.personaReview = async (payload) => { reviews.push(payload); return { success: true, name: "评审者", text: "缺回滚方案 [S1]", citations: [{ id: "S1", title: "评审笔记", excerpt: "上线前必须准备回滚方案", sourceId: "s" }] }; };
  await manager.open("p1", "ai");
  await settle();
  await manager.handleAction("pm-ai-review-open", "");
  await settle();
  manager.render();
  await settle();
  let html = manager.render();
  assert.match(html, /<option value="a" selected>评审者<\/option>/);
  assert.doesNotMatch(html, /草稿人物/);
  assert.match(html, /不代表本人/);
  await manager.handleAction("pm-ai-review-start", "");
  await settle();
  assert.equal(reviews[0].projectId, "p1");
  assert.equal(reviews[0].personaId, "a");
  assert.equal(reviews[0].focus, "目标、完成标准和整体计划是否合理");
  const saved = histories.get("p1");
  assert.match(saved[0].content, /请人物分身「评审者」审阅这个项目/);
  assert.equal(saved[1].persona, "评审者");
  assert.equal(saved[1].citations[0].title, "评审笔记");
  html = manager.render();
  assert.match(html, /评审者 · 人物分身审阅（AI 模拟）/);
  assert.match(html, /引用的人物资料 · 1/);
  assert.doesNotMatch(html, /data-module-action="pm-ai-review-start"/, "picker closes after starting");
});

test("persona review picker explains when no persona has a card", async () => {
  const harness = ui();
  const { manager, settle } = harness;
  harness.api.personas = { list: async () => [{ id: "b", name: "草稿人物", hasCard: false }] };
  harness.api.projectAi.personaReview = async () => ({ success: true });
  await manager.open("p1", "ai");
  await settle();
  await manager.handleAction("pm-ai-review-open", "");
  await settle();
  const html = manager.render();
  assert.match(html, /还没有已生成人物卡的人物分身/);
  assert.doesNotMatch(html, /pm-ai-review-start/);
  await manager.handleAction("pm-ai-review-close", "");
  assert.doesNotMatch(manager.render(), /pm-ai-review"/);
});

test("a turn never starts before the stored conversation has loaded, so history cannot be overwritten", async () => {
  const harness = ui();
  const { manager, calls, histories, settle } = harness;
  let release;
  histories.set("p1", [{ role: "user", content: "旧问题" }, { role: "assistant", content: "旧回答" }]);
  const history = harness.api.projectAi.history;
  harness.api.projectAi.history = (id) => new Promise((resolve) => { release = () => resolve(history(id)); });
  await manager.open("p1", "ai");
  const html = manager.render();
  assert.match(html, /data-module-action="pm-ai-prompt" data-id="0" disabled/);
  const clicked = manager.handleAction("pm-ai-prompt", "0");
  await settle();
  assert.equal(calls.chat.length, 0, "the click waits for history");
  assert.equal(histories.get("p1").length, 2, "stored history is untouched");
  release();
  await clicked;
  await settle();
  assert.equal(histories.get("p1").map((message) => message.content.slice(0, 3)).join("|"), "旧问题|旧回答|请用 |建议先");
});

test("damaged project history blocks reads, sends, clears and brief writes without changing the original file", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dm-project-history-damage-"));
  try {
    const store = projectAi.createProjectChatStore(dir);
    assert.deepEqual(store.get("/a", "p1"), [], "only a missing file starts empty");
    assert.equal(store.getBrief("/a", "2026-11-19"), null);
    const messages = [{ role: "user", content: "原来的问题" }, { role: "assistant", content: "原来的回答" }];
    const brief = { date: "2026-11-19", text: "今天的重点", generatedAt: NOW.toISOString() };
    store.set("/a", "p1", messages);
    store.set("/b", "p2", messages);
    store.setBrief("/a", brief);
    const original = fs.readFileSync(store.file, "utf8");
    const valid = JSON.parse(original);
    const cases = {
      truncated: original.slice(0, -8), empty: "", null: "null", array: "[]",
      missingChats: JSON.stringify({ version: 1 }),
      arrayChats: JSON.stringify({ ...valid, chats: [] }),
      invalidConversation: JSON.stringify({ ...valid, chats: { ...valid.chats, bad: { messages: {} } } }),
      invalidMessage: JSON.stringify({ ...valid, chats: { ...valid.chats, bad: { messages: [{ role: "assistant", content: null }] } } }),
      invalidBriefs: JSON.stringify({ ...valid, briefs: [] }),
      invalidBrief: JSON.stringify({ ...valid, briefs: { "/a": { text: "残缺简报" } } }),
      futureVersion: JSON.stringify({ ...valid, version: 2 }),
    };
    for (const [name, damaged] of Object.entries(cases)) await t.test(name, () => {
      fs.writeFileSync(store.file, damaged);
      const reopened = projectAi.createProjectChatStore(dir);
      for (const operation of [
        () => reopened.get("/a", "p1"), () => reopened.get("/b", "p2"),
        () => reopened.getBrief("/a", brief.date),
        () => reopened.set("/a", "p1", [{ role: "user", content: "新问题" }]),
        () => reopened.set("/b", "p3", messages), () => reopened.set("/a", "p1", []),
        () => reopened.setBrief("/a", brief),
      ]) {
        assert.throws(operation, /损坏或格式不兼容.*原文件已保留/);
        assert.equal(fs.readFileSync(store.file, "utf8"), damaged);
      }
      assert.deepEqual(fs.readdirSync(dir), ["project-ai-chats.json"], "no replacement or temporary file is left behind");
    });
    fs.writeFileSync(store.file, original);
    store.set("/a", "p1", [...messages, { role: "user", content: "恢复后续聊" }]);
    assert.deepEqual(store.get("/b", "p2"), messages);
    assert.deepEqual(store.getBrief("/a", brief.date), brief);
    assert.equal(store.get("/a", "p1").length, 3);
    // Earlier v1 files predate daily briefs and remain readable.
    delete valid.briefs;
    fs.writeFileSync(store.file, JSON.stringify(valid));
    assert.deepEqual(store.get("/a", "p1"), messages);
    store.setBrief("/a", brief);
    assert.deepEqual(store.get("/b", "p2"), messages);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("history access errors and failed atomic saves preserve every existing conversation", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dm-project-history-io-"));
  try {
    const store = projectAi.createProjectChatStore(dir);
    const messages = [{ role: "user", content: "保留这条记录" }];
    store.set("/a", "p1", messages);
    store.set("/b", "p2", messages);
    const original = fs.readFileSync(store.file, "utf8");
    const read = fs.readFileSync;
    const blocked = t.mock.method(fs, "readFileSync", (file, ...args) => {
      if (file === store.file) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return read(file, ...args);
    });
    assert.throws(() => store.get("/a", "p1"), /无法读取.*已停止保存/);
    assert.throws(() => store.set("/a", "p1", []), /无法读取.*已停止保存/);
    assert.equal(read(store.file, "utf8"), original);
    blocked.mock.restore();
    const rename = fs.renameSync;
    t.mock.method(fs, "renameSync", (from, to) => {
      if (to === store.file) throw Object.assign(new Error("disk error"), { code: "EIO" });
      return rename(from, to);
    });
    for (const operation of [
      () => store.set("/a", "p1", []),
      () => store.set("/a", "p1", [{ role: "user", content: "追加内容" }]),
      () => store.setBrief("/a", { date: "2026-11-19", text: "简报", generatedAt: NOW.toISOString() }),
    ]) {
      assert.throws(operation, /disk error/);
      assert.equal(read(store.file, "utf8"), original);
      assert.deepEqual(fs.readdirSync(dir), ["project-ai-chats.json"]);
    }
  } finally { t.mock.restoreAll(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("undo refuses later manual task and project edits, including edits to newly created tasks", async (t) => {
  const cases = [
    ["deadline", { type: "update_task", taskId: "t1", dueDate: "2026-12-20" }, (store) => store.updateTask("t1", { dueDate: "2026-12-21" })],
    ["status and completion", { type: "update_task", taskId: "t2", status: "In Progress", dueDate: "2026-12-20" }, (store) => store.updateTask("t2", { workflowStatus: "Completed" })],
    ["task notes", { type: "update_task", taskId: "t1", dueDate: "2026-12-20" }, (store) => store.updateTask("t1", { notes: "人工补充的说明" })],
    ["project next step", { type: "update_project", nextAction: "AI 下一步", health: "At Risk" }, (store) => store.updateProject("p1", { nextAction: "人工安排的下一步" })],
    ["project health", { type: "update_project", health: "At Risk" }, (store) => store.updateProject("p1", { status: "Blocked" })],
    ["project risks", { type: "update_project", blockers: "AI 风险" }, (store) => store.updateProject("p1", { blockers: "人工更新的风险" })],
    ["new task title", { type: "create_task", title: "AI 新建任务" }, (store, undo) => store.updateTask(undo.taskId, { title: "人工改名后的任务" })],
    ["new task completion", { type: "create_task", title: "AI 新建任务" }, (store, undo) => store.updateTask(undo.taskId, { workflowStatus: "Completed" })],
  ];
  for (const [name, action, edit] of cases) await t.test(name, () => {
    const { store, cleanup } = seededStore();
    try {
      const { undo } = projectAi.applyAction(store, "p1", action);
      edit(store, undo);
      const current = store.load();
      const originals = [current.taskFile, current.projectFile].map((file) => fs.readFileSync(file, "utf8"));
      assert.throws(() => projectAi.undoAction(store, "p1", JSON.parse(JSON.stringify(undo))), /AI 操作后已被修改.*已保留当前数据/);
      assert.deepEqual(store.load(), current, "the whole operation is refused, including otherwise unchanged fields");
      assert.deepEqual([current.taskFile, current.projectFile].map((file) => fs.readFileSync(file, "utf8")), originals);
    } finally { cleanup(); }
  });
});

test("saved undo guards survive reopening, permit unchanged records, and reject legacy or wrong-project undo", () => {
  const { store, cleanup } = seededStore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dm-project-undo-history-"));
  try {
    const action = { type: "update_task", taskId: "t1", dueDate: "2026-12-20" };
    const { undo } = projectAi.applyAction(store, "p1", action);
    const chats = projectAi.createProjectChatStore(dir);
    chats.set("/a", "p1", [{ role: "assistant", content: "已调整日期", actions: [{ ...action, state: "applied", undo }] }]);
    const restored = projectAi.createProjectChatStore(dir).get("/a", "p1")[0].actions[0].undo;
    assert.deepEqual(restored, undo);
    store.updateTask("t2", { notes: "另一项任务的人工修改" });
    const { createZenTaskStore } = require("../electron/zentask");
    const reopened = createZenTaskStore(path.dirname(path.dirname(store.load().taskFile)));
    const undone = projectAi.undoAction(reopened, "p1", restored);
    assert.equal(undone.tasks.find((task) => task.Id === "t1").DueDate, "2026-12-10");
    assert.equal(undone.tasks.find((task) => task.Id === "t2").Notes, "另一项任务的人工修改");
    const projectUndo = projectAi.applyAction(store, "p1", { type: "update_project", nextAction: "新的下一步" }).undo;
    const before = store.load();
    for (const legacy of [
      { type: "delete_task", taskId: "t1" },
      { type: "update_task", taskId: "t1", changes: { dueDate: "2026-12-01" } },
      { type: "update_project", changes: { nextAction: "旧值" } },
    ]) assert.throws(() => projectAi.undoAction(store, "p1", legacy), /缺少有效的撤销校验记录/);
    assert.throws(() => projectAi.undoAction(store, "p2", projectUndo), /缺少有效的撤销校验记录/);
    assert.deepEqual(store.load(), before);
    store.updateProject("p1", { archived: true });
    assert.throws(() => projectAi.undoAction(store, "p1", projectUndo), /已归档/);
  } finally { cleanup(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("failed history reads block sending and clearing until retry restores the original conversation", async (t) => {
  for (const scope of ["project", "portfolio"]) await t.test(scope, async () => {
    const { manager, calls, api, settle } = ui();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dm-project-history-ui-"));
    try {
      const store = projectAi.createProjectChatStore(dir);
      const id = scope === "project" ? "p1" : "__portfolio__";
      const messages = [{ role: "user", content: "重启前的问题" }, { role: "assistant", content: "重启前的回答" }];
      store.set("/a", id, messages);
      const original = fs.readFileSync(store.file, "utf8");
      fs.writeFileSync(store.file, "broken history");
      let reads = 0, writes = 0;
      api.projectAi.history = async (key) => { reads += 1; return store.get("/a", key); };
      api.projectAi.saveHistory = async (key, next) => { writes += 1; return store.set("/a", key, next); };
      if (scope === "project") await manager.open("p1", "ai");
      manager.render();
      await settle();
      const html = manager.render();
      assert.match(html, /原文件已保留/);
      assert.match(html, /data-module-action="pm-ai-reload"/);
      assert.match(html, /data-module-action="pm-ai-prompt" data-id="0" disabled/);
      await manager.handleAction("pm-ai-prompt", "0");
      await manager.handleAction("pm-ai-clear", "");
      await settle();
      assert.equal(calls.chat.length, 0);
      assert.equal(writes, 0);
      assert.equal(reads, 1, "rendering does not repeatedly retry the damaged file");
      assert.equal(fs.readFileSync(store.file, "utf8"), "broken history");
      fs.writeFileSync(store.file, original);
      await manager.handleAction("pm-ai-reload", "");
      assert.match(manager.render(), /重启前的回答/);
      assert.doesNotMatch(manager.render(), /原文件已保留/);
      await manager.handleAction("pm-ai-prompt", "0");
      await settle();
      assert.equal(calls.chat.length, 1);
      assert.deepEqual(JSON.parse(JSON.stringify(calls.chat[0].messages.slice(0, 2))), messages);
      assert.equal(store.get("/a", id).length, 4);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

test("a failed clear or send keeps the visible conversation when the file becomes damaged", async () => {
  const { manager, calls, api, histories, settle } = ui();
  const messages = [{ role: "user", content: "保留问题" }, { role: "assistant", content: "保留回答" }];
  histories.set("p1", messages);
  await manager.open("p1", "ai");
  manager.render();
  await settle();
  api.projectAi.saveHistory = async () => { throw new Error("项目 AI 对话记录损坏，原文件已保留"); };
  await manager.handleAction("pm-ai-clear", "");
  assert.match(manager.render(), /保留回答/);
  assert.match(manager.render(), /原文件已保留/);
  await manager.handleAction("pm-ai-prompt", "0");
  await settle();
  assert.equal(calls.chat.length, 0);
  assert.match(manager.render(), /保留回答/);
  assert.deepEqual(histories.get("p1"), messages);
});

test('project references restore per conversation, show full paths and sources, and are removed from later requests', async () => {
  const sources = [{ id: 'N1', title: '方案', path: '资料/方案.md' }];
  const { manager, api, histories, calls, settle } = ui({ chatResult: () => ({ success: true, text: '周五交付 [N1]', sources }) });
  api.projectAi.listNotes = async () => sources;
  histories.set('p1', [{ role: 'user', content: '之前的问题', references: sources }]);
  await manager.open('p1', 'ai'); manager.render(); await settle();
  assert.match(manager.render(), /已选 1\/8 篇/);
  assert.match(manager.render(), /<small>资料\/方案.md<\/small>/);
  await manager.handleAction('pm-ai-prompt', '0'); await settle();
  assert.deepEqual(Array.from(calls.chat[0].references), ['资料/方案.md']);
  assert.match(manager.render(), /aria-label="回答来源"/);
  assert.match(manager.render(), /\[N1\] 方案/);
  await manager.handleAction('pm-ai-source', '2:N1');
  assert.deepEqual(calls.opened, ['资料/方案.md']);
  await manager.handleAction('pm-ai-remove-reference', '0');
  await manager.handleAction('pm-ai-prompt', '0'); await settle();
  assert.equal(calls.chat[1].references.length, 0);
  assert.equal(histories.get('p1')[2].sources[0].path, '资料/方案.md');
  await manager.open('p2', 'ai'); manager.render(); await settle();
  assert.match(manager.render(), /已选 0\/8 篇/);
  await manager.handleAction('pm-ai-prompt', '0'); await settle();
  assert.equal(calls.chat[2].references.length, 0);
});

test('reopening a project refreshes cached paths and source clicks resolve later moves without changing citation ids', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-project-cached-source-')));
  try {
    const { createWorkspace } = require('../electron/workspace');
    const { createNoteChatStore } = require('../electron/note-ai-history');
    const notes = createNoteChatStore(path.join(dir, 'data'));
    const ws = createWorkspace(path.join(dir, 'vault'), { noteHistory: notes });
    ws.createFolder('', '资料'); ws.write('资料/方案.md', '原资料');
    const store = projectAi.createProjectChatStore(path.join(dir, 'data'), { noteHistory: notes });
    store.set(ws.root, 'p1', [
      { role: 'user', content: '原问题', references: [{ path: '资料/方案.md', title: '方案' }] },
      { role: 'assistant', content: '第一轮 [N2]', sources: [{ id: 'N2', path: '资料/方案.md', title: '方案' }] },
      { role: 'assistant', content: '第二轮 [N1]', sources: [{ id: 'N1', path: '资料/方案.md', title: '方案' }] },
    ]);
    const { manager, api, calls, settle } = ui();
    api.projectAi.listNotes = async () => [];
    api.projectAi.history = async id => { notes.reconcile(ws); return store.get(ws.root, id); };
    api.projectAi.saveHistory = async (id, messages) => store.set(ws.root, id, messages);
    api.projectAi.resolveReferences = async (items, id) => { notes.reconcile(ws); store.get(ws.root, id); return store.resolveReferences(ws.root, items); };
    await manager.open('p1', 'ai'); await settle();
    ws.rename('资料/方案.md', '新方案'); ws.write('资料/方案.md', '新建的另一篇笔记');
    await manager.open('p1', 'ai'); await settle();
    const html = manager.render();
    assert.match(html, /已选 1\/8/);
    assert.match(html, /<small>资料\/新方案.md<\/small>/);
    assert.match(html, /data-id="1:N2"/); assert.match(html, /data-id="2:N1"/);
    await manager.handleAction('pm-ai-source', '1:N2');
    assert.equal(calls.opened.at(-1), '资料/新方案.md');
    await manager.handleAction('pm-ai-remove-reference', '0');
    ws.rename('资料', '移动后');
    // Even a source button in an already-open view must re-resolve before opening.
    await manager.handleAction('pm-ai-source', '2:N1');
    assert.equal(calls.opened.at(-1), '移动后/新方案.md');
    assert.equal(ws.read(calls.opened.at(-1)), '原资料');
    await manager.open('p1', 'ai'); await settle();
    assert.match(manager.render(), /已选 0\/8/, 'refresh does not restore a reference the user removed');
    assert.equal(store.get(ws.root, 'p1')[1].sources[0].path, '移动后/新方案.md');
    let release;
    api.projectAi.resolveReferences = items => new Promise(resolve => { release = () => resolve(items); });
    const opened = calls.opened.length;
    const pending = manager.handleAction('pm-ai-source', '1:N2');
    manager.resetVault(); release(); await pending;
    assert.equal(calls.opened.length, opened, 'a delayed source click cannot open the same path in a different vault');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
