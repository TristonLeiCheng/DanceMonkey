(function (root, factory) {
  const model = factory();
  if (typeof module === "object" && module.exports) module.exports = model;
  else root.DMZenModel = model;
})(globalThis, () => {
  const value = (item, name, fallback = "") => item?.[name] ?? item?.[name[0].toLowerCase() + name.slice(1)] ?? fallback;
  const has = (input, key) => Object.prototype.hasOwnProperty.call(input, key);
  const done = (task) => ["Completed", "Done"].includes(value(task, "WorkflowStatus"));
  const archived = (project) => Boolean(value(project, "ArchivedAt"));
  const statuses = ["Todo", "In Progress", "Blocked", "Completed"];
  const lifecycles = ["Planned", "In Progress", "Paused", "Completed"];
  const healthStatuses = ["On Track", "At Risk", "Blocked"];
  const lifecycle = (project) => value(project, "LifecycleStatus") || (value(project, "Status") === "Completed" ? "Completed" : "In Progress");
  const health = (project) => value(project, "Status") === "Completed" ? "On Track" : value(project, "Status", "On Track");
  const list = (item, key) => Array.isArray(value(item, key, [])) ? value(item, key, []) : [];
  const newId = () => crypto.randomUUID();
  function priorityValues(priority) {
    if (["Urgent & Important", "Critical", "Q1"].includes(priority)) return [5, 5];
    if (["Not Urgent & Important", "Q2"].includes(priority)) return [5, 2];
    if (["Urgent & Not Important", "Q3"].includes(priority)) return [2, 5];
    if (priority === "High") return [4, 4];
    if (["Low", "Q4"].includes(priority)) return [2, 2];
    return [3, 3];
  }
  function priorityLabel(impact, urgency) {
    if (impact >= 4 && urgency >= 4) return "Urgent & Important";
    if (impact >= 4) return "Not Urgent & Important";
    if (urgency >= 4) return "Urgent & Not Important";
    return "Not Urgent & Not Important";
  }
  function required(text, label) {
    const result = String(text || "").trim();
    if (!result) throw new Error(`${label}不能为空`);
    return result;
  }
  function date(text) {
    if (!text) return null;
    const result = String(text).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString().slice(0, 10) !== result) {
      throw new Error("日期格式无效");
    }
    return result;
  }
  function notePaths(paths) {
    if (!Array.isArray(paths)) throw new Error("关联笔记必须是列表");
    return [...new Set(paths.map((entry) => {
      const path = String(entry).replaceAll("\\", "/");
      if (!path.toLowerCase().endsWith(".md") || path.startsWith("/") || path.includes(":") || /[\x00-\x1f]/.test(path) || path.split("/").some((part) => !part || part === "." || part === "..")) {
        throw new Error("请选择知识库中的 Markdown 笔记");
      }
      return path;
    }))];
  }
  function notePath(path) {
    return notePaths([path])[0];
  }
  function milestone(input, previous = {}, timestamp = new Date().toISOString()) {
    const id = String(input.id || value(previous, "Id") || "");
    if (!id) throw new Error("里程碑缺少 ID");
    const completed = input.completed === undefined ? value(previous, "CompletedAt", null) : input.completed ? value(previous, "CompletedAt") || timestamp : null;
    return { ...previous, Id: id, Name: required(input.name, "里程碑名称"), DueDate: date(input.dueDate), AcceptanceCriteria: String(input.acceptanceCriteria || "").trim(), CompletedAt: completed, CreatedAt: value(previous, "CreatedAt") || timestamp, UpdatedAt: timestamp };
  }
  function milestoneProgress(stage, tasks) {
    const assigned = tasks.filter((task) => value(task, "MilestoneId") === value(stage, "Id"));
    const completed = assigned.filter(done).length;
    return { total: assigned.length, completed, percent: value(stage, "CompletedAt") ? 100 : assigned.length ? Math.round(100 * completed / assigned.length) : 0 };
  }
  function normalizeTaskTitle(title) {
    return String(title || "").normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
  }
  function duplicateTaskCandidates(candidates, tasks, projectId, sourceNotePath) {
    const source = sourceNotePath ? notePath(sourceNotePath) : "";
    return candidates.map((candidate) => {
      const title = normalizeTaskTitle(candidate.title);
      const exact = tasks.find((task) => value(task, "ProjectId") === projectId && value(task, "SourceNotePath") === source && normalizeTaskTitle(value(task, "Title")) === title);
      const suspected = exact || tasks.find((task) => value(task, "ProjectId") === projectId && normalizeTaskTitle(value(task, "Title")) === title);
      return { ...candidate, duplicate: Boolean(exact), suspectedDuplicate: Boolean(suspected), duplicateTaskId: value(suspected, "Id") };
    });
  }
  function createTaskBatch(inputs, ids, projects, existingTasks, timestamp = new Date().toISOString()) {
    if (!Array.isArray(inputs) || !inputs.length || inputs.length > 50) throw new Error("请选择 1 至 50 项任务");
    const created = inputs.map((input, index) => createTask(input, ids[index], projects, timestamp));
    const seen = [...existingTasks];
    for (const task of created) {
      const duplicate = duplicateTaskCandidates([{ title: value(task, "Title") }], seen, value(task, "ProjectId"), value(task, "SourceNotePath"))[0];
      if (duplicate.suspectedDuplicate) throw new Error(`疑似重复任务：${value(task, "Title")}，请返回预览确认`);
      seen.push(task);
    }
    return created;
  }
  function taskCandidatesFromNote(markdown) {
    const text = String(markdown || "").replace(/```[\s\S]*?```/g, "");
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const candidates = lines.flatMap((line) => {
      const match = line.match(/^(?:[-*+]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)(.+)$/);
      if (!match || /^[-*+]\s+\[[xX]\]/.test(line)) return [];
      const title = match[1].replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\*\*/g, "").trim();
      return title ? [{ title: title.slice(0, 160), excerpt: line.slice(0, 500) }] : [];
    });
    if (!candidates.length) {
      const paragraph = lines.find((line) => !/^#{1,6}\s/.test(line));
      if (paragraph) candidates.push({ title: paragraph.slice(0, 160), excerpt: paragraph.slice(0, 500) });
    }
    return candidates.slice(0, 20);
  }
  // Resolve legacy name-only links only when unambiguous. IDs always take precedence.
  function normalizeState(state) {
    const projects = state.projects || [];
    const tasks = (state.tasks || []).map((task) => {
      const id = value(task, "ProjectId");
      const matches = id ? projects.filter((p) => value(p, "Id") === id)
        : value(task, "ProjectLinkUnresolved", false) ? []
        : projects.filter((p) => value(p, "Name") === value(task, "Project") && value(task, "Project") !== "Unassigned");
      if (!id && matches.length > 1) return { ...task, ProjectLinkUnresolved: true };
      return matches.length === 1 ? { ...task, ProjectId: value(matches[0], "Id"), Project: value(matches[0], "Name") } : { ...task };
    });
    return { ...state, tasks, projects };
  }
  function applyProject(existing, input, timestamp = new Date().toISOString()) {
    const next = { ...existing };
    if (has(input, "name")) next.Name = required(input.name, "项目名称");
    for (const [key, target] of Object.entries({ owner: "Owner", description: "Description", category: "Category", goal: "Goal", acceptanceCriteria: "AcceptanceCriteria", nextAction: "NextAction", blockers: "Blockers" })) {
      if (has(input, key)) next[target] = String(input[key] || "").trim();
    }
    for (const [key, target, allowed] of [["priority", "Priority", ["Low", "Medium", "High", "Critical"]], ["status", "Status", healthStatuses], ["lifecycleStatus", "LifecycleStatus", lifecycles]]) {
      if (has(input, key)) {
        if (!allowed.includes(input[key])) throw new Error("项目状态或优先级无效");
        next[target] = input[key];
      }
    }
    if (has(input, "progress")) next.Progress = Math.max(0, Math.min(100, Number(input.progress) || 0));
    if (has(input, "team")) next.Team = Math.max(1, Number(input.team) || 1);
    if (has(input, "dueDate")) next.DueDate = date(input.dueDate);
    if (has(input, "linkedNotes")) next.LinkedNotes = notePaths(input.linkedNotes);
    if (has(input, "milestones")) {
      if (!Array.isArray(input.milestones)) throw new Error("里程碑格式无效");
      const previous = new Map(list(existing, "Milestones").map((item) => [value(item, "Id"), item]));
      const ids = new Set();
      next.Milestones = input.milestones.map((item) => {
        const stage = milestone(item, previous.get(item.id) || {}, timestamp);
        if (ids.has(stage.Id)) throw new Error("里程碑 ID 重复");
        ids.add(stage.Id);
        return stage;
      });
    }
    if (has(input, "addUpdate")) {
      const update = input.addUpdate;
      if (!update || !healthStatuses.includes(update.health)) throw new Error("请选择有效的项目健康度");
      const summary = required(update.summary, "进展说明");
      const entry = { Id: newId(), CreatedAt: timestamp, Health: update.health, Summary: summary, Risks: String(update.risks || "").trim(), NextAction: String(update.nextAction || "").trim() };
      next.Updates = [entry, ...list(existing, "Updates")];
      next.Status = update.health;
      if (entry.NextAction) next.NextAction = entry.NextAction;
      if (entry.Risks) next.Blockers = entry.Risks;
    }
    if (has(input, "archived")) next.ArchivedAt = input.archived ? value(existing, "ArchivedAt") || timestamp : null;
    next.UpdatedAt = timestamp;
    return next;
  }
  function createProject(input, id, timestamp = new Date().toISOString()) {
    return applyProject({ Id: id, Name: required(input.name, "项目名称"), Owner: "", Progress: 0, Priority: "Medium", Status: "On Track", LifecycleStatus: "Planned", Category: "", Team: 1, Description: "", Goal: "", AcceptanceCriteria: "", NextAction: "", Blockers: "", DueDate: null, LinkedNotes: [], Milestones: [], Updates: [], ArchivedAt: null, CreatedAt: timestamp }, input, timestamp);
  }
  function applyTask(existing, input, projects, timestamp = new Date().toISOString()) {
    const next = { ...existing };
    if (has(input, "title")) next.Title = required(input.title, "任务标题");
    if (has(input, "projectId")) {
      const project = projects.find((p) => value(p, "Id") === input.projectId);
      if (input.projectId && !project) throw new Error("项目不存在，请重新选择");
      if (project && archived(project) && input.projectId !== value(existing, "ProjectId")) throw new Error("请先恢复项目再添加任务");
      next.ProjectId = project ? value(project, "Id") : "";
      next.Project = project ? value(project, "Name") : "Unassigned";
      next.ProjectLinkUnresolved = false;
      if (value(existing, "ProjectId") !== next.ProjectId && !has(input, "milestoneId")) next.MilestoneId = "";
    }
    if (has(input, "milestoneId")) {
      const id = String(input.milestoneId || "");
      const project = projects.find((p) => value(p, "Id") === next.ProjectId);
      if (id && !list(project, "Milestones").some((stage) => value(stage, "Id") === id)) throw new Error("里程碑不属于所选项目");
      next.MilestoneId = id;
    }
    if (has(input, "sourceNotePath")) next.SourceNotePath = input.sourceNotePath ? notePath(input.sourceNotePath) : "";
    if (has(input, "sourceExcerpt")) next.SourceExcerpt = String(input.sourceExcerpt || "").slice(0, 500);
    if (next.SourceExcerpt && !next.SourceNotePath) throw new Error("任务来源笔记缺失");
    if (has(input, "sourceNotePath") && next.SourceNotePath) next.SourceTag = "Note";
    if (has(input, "priority")) [next.Impact, next.Urgency] = priorityValues(input.priority);
    for (const [key, target] of Object.entries({ raci: "RaciRole", energy: "EnergyLevel", notes: "Notes", tags: "Tags", objective: "Objective", keyResult: "KeyResult" })) {
      if (has(input, key)) next[target] = String(input[key] || "");
    }
    for (const [key, target] of [["dueDate", "DueDate"], ["startDate", "StartDate"], ["endDate", "EndDate"]]) {
      if (has(input, key)) next[target] = date(input[key]);
    }
    if (has(input, "workflowStatus")) {
      const status = input.workflowStatus === "Done" ? "Completed" : input.workflowStatus;
      if (!statuses.includes(status)) throw new Error("任务状态无效");
      next.WorkflowStatus = status;
    }
    if (has(input, "checklist")) {
      if (!Array.isArray(input.checklist)) throw new Error("检查清单格式无效");
      next.Checklist = input.checklist;
    }
    next.IsDone = done(next);
    next.CompletedAt = next.IsDone ? value(existing, "CompletedAt") || timestamp : null;
    next.IsHighEnergy = value(next, "EnergyLevel") === "High";
    next.DueDateDisplay = value(next, "DueDate") ? String(value(next, "DueDate")).slice(0, 10) : "—";
    next.PriorityLabel = priorityLabel(Number(value(next, "Impact", 3)), Number(value(next, "Urgency", 3)));
    next.UpdatedAt = timestamp;
    const trail = value(existing, "AuditTrail", []);
    next.AuditTrail = [...(Array.isArray(trail) ? trail : []), `${timestamp} ${has(input, "workflowStatus") ? `status -> ${next.WorkflowStatus}` : "edited"}`];
    return next;
  }
  function createTask(input, id, projects, timestamp = new Date().toISOString()) {
    const task = applyTask({ Id: id, Title: required(input.title, "任务标题"), ProjectId: "", Project: "Unassigned", MilestoneId: "", Impact: 3, Urgency: 3, SourceTag: "Manual", Layer: input.layer || "Project Task", RaciRole: "Responsible", EnergyLevel: "Medium", WorkflowStatus: "Todo", DueDate: null, StartDate: null, EndDate: null, Notes: "", Tags: "", Checklist: [], Objective: "", KeyResult: "", CreatedAt: timestamp }, input, projects, timestamp);
    task.AuditTrail = [`${timestamp} created`];
    return task;
  }
  function renameNoteLinks(projects, from, to) {
    return projects.map((project) => {
      const notes = value(project, "LinkedNotes", []);
      const next = notes.map((note) => note === from || note.startsWith(`${from}/`) ? to + note.slice(from.length) : note);
      return next.some((note, i) => note !== notes[i]) ? applyProject(project, { linkedNotes: next }) : project;
    });
  }
  function renameTaskSources(tasks, from, to) {
    return tasks.map((task) => {
      const source = value(task, "SourceNotePath");
      if (source !== from && !source.startsWith(`${from}/`)) return task;
      return { ...task, SourceNotePath: to + source.slice(from.length) };
    });
  }
  function attentionItems(state, now = new Date()) {
    const day = (value) => String(value || "").slice(0, 10);
    const localDay = (dateValue) => `${dateValue.getFullYear()}-${String(dateValue.getMonth() + 1).padStart(2, "0")}-${String(dateValue.getDate()).padStart(2, "0")}`;
    const today = localDay(now);
    const upcoming = localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7));
    const staleBefore = new Date(now.getTime() - 14 * 86400000).toISOString();
    const items = [];
    for (const project of state.projects || []) {
      if (archived(project) || lifecycle(project) === "Completed") continue;
      const projectId = value(project, "Id");
      const add = (kind, label, detail, target = {}) => items.push({ kind, label, detail, projectId, projectName: value(project, "Name"), ...target });
      if (["At Risk", "Blocked"].includes(health(project))) add("health", health(project) === "Blocked" ? "项目健康度受阻" : "项目健康度有风险", "请更新风险、负责人或下一步行动");
      for (const stage of list(project, "Milestones")) {
        const due = day(value(stage, "DueDate"));
        if (value(stage, "CompletedAt") || !due) continue;
        if (due < today) add("milestone-overdue", "里程碑已逾期", `${value(stage, "Name")} · ${due}`, { milestoneId: value(stage, "Id") });
        else if (due <= upcoming) add("milestone-upcoming", "里程碑 7 天内到期", `${value(stage, "Name")} · ${due}`, { milestoneId: value(stage, "Id") });
      }
      for (const task of (state.tasks || []).filter((entry) => value(entry, "ProjectId") === projectId && !done(entry))) {
        const due = day(value(task, "DueDate"));
        if (value(task, "WorkflowStatus") === "Blocked") add("task-blocked", "任务受阻", value(task, "Title"), { taskId: value(task, "Id"), taskFilter: "open" });
        else if (due && due < today) add("task-overdue", "任务已逾期", `${value(task, "Title")} · ${due}`, { taskId: value(task, "Id"), taskFilter: "open" });
      }
      const latest = list(project, "Updates").map((entry) => value(entry, "CreatedAt")).sort().at(-1);
      if ((!latest && value(project, "CreatedAt") < staleBefore) || (latest && latest < staleBefore)) add("stale-update", "超过 14 天未更新", latest ? `上次更新 ${day(latest)}` : "尚无进展记录");
    }
    return items;
  }
  function validateMilestoneLinks(state, projectId, milestones) {
    const ids = new Set(milestones.map((stage) => value(stage, "Id")));
    if (state.tasks.some((task) => value(task, "ProjectId") === projectId && value(task, "MilestoneId") && !ids.has(value(task, "MilestoneId")))) {
      throw new Error("里程碑仍有关联任务，请先转移任务");
    }
  }
  function previewApi(load, save) {
    const state = () => normalizeState(load());
    const find = (items, id) => {
      const item = items.find((entry) => value(entry, "Id") === id);
      if (!item) throw new Error("记录不存在");
      return item;
    };
    return {
      load: async () => state(),
      addTask: async (input) => { const next = state(); next.tasks.unshift(createTask(input, crypto.randomUUID(), next.projects)); return save(next); },
      addTasksBatch: async (inputs) => { const next = state(); const created = createTaskBatch(inputs, inputs.map(() => crypto.randomUUID()), next.projects, next.tasks); next.tasks.unshift(...created); const source = value(created[0], "SourceNotePath"); const project = next.projects.find((entry) => value(entry, "Id") === value(created[0], "ProjectId")); if (project && source && !list(project, "LinkedNotes").includes(source)) project.LinkedNotes = [...list(project, "LinkedNotes"), source]; return save(next); },
      updateTask: async (id, input) => { const next = state(); Object.assign(find(next.tasks, id), applyTask(find(next.tasks, id), input, next.projects)); return save(next); },
      toggleTask: async (id) => { const next = state(); const task = find(next.tasks, id); Object.assign(task, applyTask(task, { workflowStatus: done(task) ? "Todo" : "Completed" }, next.projects)); return save(next); },
      deleteTask: async (id) => { const next = state(); next.tasks = next.tasks.filter((t) => value(t, "Id") !== id); return save(next); },
      addProject: async (input) => { const next = state(); next.projects.unshift(createProject(input, crypto.randomUUID())); return save(next); },
      updateProject: async (id, input) => { const next = state(); const project = find(next.projects, id); const updated = applyProject(project, input); if (input.milestones) validateMilestoneLinks(next, id, updated.Milestones); Object.assign(project, updated); return save(normalizeState(next)); },
      deleteMilestone: async (projectId, milestoneId, reassignTo) => { const next = state(); const project = find(next.projects, projectId); const stages = list(project, "Milestones"); if (!stages.some((stage) => value(stage, "Id") === milestoneId)) throw new Error("里程碑不存在"); if (reassignTo && !stages.some((stage) => value(stage, "Id") === reassignTo && reassignTo !== milestoneId)) throw new Error("目标里程碑无效"); const linked = next.tasks.filter((task) => value(task, "ProjectId") === projectId && value(task, "MilestoneId") === milestoneId); if (linked.length && reassignTo === undefined) throw new Error(`仍有 ${linked.length} 项关联任务，请选择转移目标或明确设为未分配`); next.tasks = next.tasks.map((task) => linked.includes(task) ? { ...task, MilestoneId: reassignTo || "" } : task); project.Milestones = stages.filter((stage) => value(stage, "Id") !== milestoneId); return save(next); },
      deleteProject: async (id) => { const next = state(); next.projects = next.projects.filter((p) => value(p, "Id") !== id); next.tasks = next.tasks.map((t) => value(t, "ProjectId") === id ? { ...t, ProjectId: "", Project: "Unassigned" } : t); return save(next); },
    };
  }
  return { value, done, archived, statuses, lifecycles, healthStatuses, lifecycle, health, list, milestoneProgress, normalizeTaskTitle, duplicateTaskCandidates, createTaskBatch, taskCandidatesFromNote, attentionItems, priorityValues, priorityLabel, normalizeState, applyProject, createProject, applyTask, createTask, renameNoteLinks, renameTaskSources, validateMilestoneLinks, previewApi };
});
