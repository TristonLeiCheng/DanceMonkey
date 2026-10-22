const test = require("node:test");
const assert = require("node:assert/strict");
const { assertTaskReferences } = require("../electron/task-sync-data");

const state = (tasks = [], projects = []) => ({ tasks, projects });

test("rejects a new task combined with deletion of its project without changing input", () => {
  const input = {
    local: state([{ Id: "t", ProjectId: "p", Extra: { keep: true } }], [{ Id: "p" }]),
    remote: state(),
    merged: state([{ Id: "t", ProjectId: "p", Extra: { keep: true } }]),
  };
  const before = structuredClone(input);
  assert.throws(() => assertTaskReferences(input), /项目 p 不存在.*请先协调任务和项目/);
  assert.deepEqual(input, before);
});

test("preserves dangling project references already present on either side", () => {
  const broken = state([{ Id: "old", ProjectId: "missing" }]);
  assert.doesNotThrow(() => assertTaskReferences({ local: broken, remote: state(), merged: broken }));
  assert.doesNotThrow(() => assertTaskReferences({ local: state(), remote: broken, merged: broken }));
});

test("a different task pointing to the same missing project is a new broken reference", () => {
  assert.throws(() => assertTaskReferences({
    local: state([{ Id: "old", ProjectId: "p" }]),
    remote: state([{ Id: "new", ProjectId: "p" }], [{ Id: "p" }]),
    merged: state([{ Id: "old", ProjectId: "p" }, { Id: "new", ProjectId: "p" }]),
  }), /任务 new 引用的项目 p 不存在/);
});

test("allows independent task creation and project edits without rewriting raw data", () => {
  const input = {
    local: state([{ Id: "t", ProjectId: "p", Title: "新增任务" }], [{ Id: "p", Name: "原名" }, { Id: "unused" }]),
    remote: state([], [{ Id: "p", Name: "更新名称", Extra: { keep: true } }]),
    merged: state([{ Id: "t", ProjectId: "p", Title: "新增任务" }], [{ Id: "p", Name: "更新名称", Extra: { keep: true } }]),
  };
  const before = structuredClone(input);
  assert.doesNotThrow(() => assertTaskReferences(input));
  assert.deepEqual(input, before);
});

test("supports uppercase and camelCase legacy identifiers and milestone fields", () => {
  const local = state([{ id: "t", projectId: "p", milestoneId: "m" }], [{ Id: "p", Milestones: [{ id: "m" }] }]);
  const remote = state([], [{ id: "p", milestones: [{ Id: "m" }] }]);
  const merged = state(local.tasks, remote.projects);
  assert.doesNotThrow(() => assertTaskReferences({ local, remote, merged }));
  assert.throws(() => assertTaskReferences({ local, remote: state(), merged: state(local.tasks) }), /项目 p 不存在/);

  const historical = state([{ id: "old", projectId: "missing", milestoneId: "gone" }]);
  const recased = state([{ Id: "old", ProjectId: "missing", MilestoneId: "gone" }]);
  assert.doesNotThrow(() => assertTaskReferences({ local: historical, remote: state(), merged: recased }));
});

test("rejects a new task combined with deletion of its milestone", () => {
  const local = state([{ Id: "t", ProjectId: "p", MilestoneId: "m" }], [{ Id: "p", Milestones: [{ Id: "m" }] }]);
  const remote = state([], [{ Id: "p", Milestones: [] }]);
  assert.throws(() => assertTaskReferences({ local, remote, merged: state(local.tasks, remote.projects) }), /项目 p 中不存在里程碑 m.*请先协调任务和项目/);
});

test("milestone identifiers must resolve within the task's project", () => {
  const tasks = [{ Id: "t", ProjectId: "p", MilestoneId: "m" }];
  const local = state(tasks, [{ Id: "p", Milestones: [{ Id: "m" }] }]);
  const remote = state([], [{ Id: "p" }, { Id: "other", Milestones: [{ Id: "m" }] }]);
  assert.throws(() => assertTaskReferences({ local, remote, merged: state(tasks, remote.projects) }), /不存在里程碑 m/);
});

test("preserves historical dangling milestones including when their project is missing", () => {
  for (const projects of [[], [{ Id: "p", Milestones: [] }]]) {
    const broken = state([{ Id: "old", ProjectId: "p", MilestoneId: "missing" }], projects);
    assert.doesNotThrow(() => assertTaskReferences({ local: broken, remote: state(), merged: broken }));
    assert.doesNotThrow(() => assertTaskReferences({ local: state(), remote: broken, merged: broken }));
  }
});

test("unassigned tasks and legacy project names are outside reference validation", () => {
  assert.doesNotThrow(() => assertTaskReferences({
    local: state(), remote: state(),
    merged: state([{ Id: "unassigned" }, { Id: "legacy", Project: "旧项目名称", Extra: 1 }]),
  }));
});
