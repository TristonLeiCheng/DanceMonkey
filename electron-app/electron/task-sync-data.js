const field = (item, name) => item?.[name] ?? item?.[name[0].toLowerCase() + name.slice(1)] ?? "";

function danglingReferences({ tasks = [], projects = [] } = {}) {
  const projectById = new Map(projects.map((project) => [field(project, "Id"), project]));
  const references = new Map();
  for (const task of tasks) {
    const taskId = field(task, "Id");
    const projectId = field(task, "ProjectId");
    const milestoneId = field(task, "MilestoneId");
    const project = projectById.get(projectId);
    if (projectId !== "" && !project) {
      references.set(JSON.stringify(["project", taskId, projectId]), `任务 ${taskId} 引用的项目 ${projectId} 不存在`);
    }
    const milestones = field(project, "Milestones");
    if (milestoneId !== "" && (!Array.isArray(milestones) || !milestones.some((milestone) => field(milestone, "Id") === milestoneId))) {
      references.set(JSON.stringify(["milestone", taskId, projectId, milestoneId]), `任务 ${taskId} 引用的项目 ${projectId} 中不存在里程碑 ${milestoneId}`);
    }
  }
  return references;
}

function assertTaskReferences({ local, remote, merged }) {
  const localDangling = danglingReferences(local);
  const remoteDangling = danglingReferences(remote);
  for (const [reference, detail] of danglingReferences(merged)) {
    // Existing broken links remain editable; only the merge's new damage blocks sync.
    if (!localDangling.has(reference) && !remoteDangling.has(reference)) {
      throw new Error(`同步会产生新的悬空引用：${detail}。请先协调任务和项目后再同步。`);
    }
  }
}

module.exports = { assertTaskReferences };
