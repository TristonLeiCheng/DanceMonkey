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
    for (const [key, target, allowed] of [["priority", "Priority", ["Low", "Medium", "High", "Critical"]], ["status", "Status", ["On Track", "At Risk", "Blocked", "Completed"]]]) {
      if (has(input, key)) {
        if (!allowed.includes(input[key])) throw new Error("项目状态或优先级无效");
        next[target] = input[key];
      }
    }
    if (has(input, "progress")) next.Progress = Math.max(0, Math.min(100, Number(input.progress) || 0));
    if (has(input, "team")) next.Team = Math.max(1, Number(input.team) || 1);
    if (has(input, "dueDate")) next.DueDate = date(input.dueDate);
    if (has(input, "linkedNotes")) next.LinkedNotes = notePaths(input.linkedNotes);
    if (has(input, "archived")) next.ArchivedAt = input.archived ? value(existing, "ArchivedAt") || timestamp : null;
    next.UpdatedAt = timestamp;
    return next;
  }
  function createProject(input, id, timestamp = new Date().toISOString()) {
    return applyProject({ Id: id, Name: required(input.name, "项目名称"), Owner: "", Progress: 0, Priority: "Medium", Status: "On Track", Category: "", Team: 1, Description: "", Goal: "", AcceptanceCriteria: "", NextAction: "", Blockers: "", DueDate: null, LinkedNotes: [], ArchivedAt: null, CreatedAt: timestamp }, input, timestamp);
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
    }
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
    const task = applyTask({ Id: id, Title: required(input.title, "任务标题"), ProjectId: "", Project: "Unassigned", Impact: 3, Urgency: 3, SourceTag: "Manual", Layer: input.layer || "Project Task", RaciRole: "Responsible", EnergyLevel: "Medium", WorkflowStatus: "Todo", DueDate: null, StartDate: null, EndDate: null, Notes: "", Tags: "", Checklist: [], Objective: "", KeyResult: "", CreatedAt: timestamp }, input, projects, timestamp);
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
      updateTask: async (id, input) => { const next = state(); Object.assign(find(next.tasks, id), applyTask(find(next.tasks, id), input, next.projects)); return save(next); },
      toggleTask: async (id) => { const next = state(); const task = find(next.tasks, id); Object.assign(task, applyTask(task, { workflowStatus: done(task) ? "Todo" : "Completed" }, next.projects)); return save(next); },
      deleteTask: async (id) => { const next = state(); next.tasks = next.tasks.filter((t) => value(t, "Id") !== id); return save(next); },
      addProject: async (input) => { const next = state(); next.projects.unshift(createProject(input, crypto.randomUUID())); return save(next); },
      updateProject: async (id, input) => { const next = state(); const project = find(next.projects, id); Object.assign(project, applyProject(project, input)); return save(normalizeState(next)); },
      deleteProject: async (id) => { const next = state(); next.projects = next.projects.filter((p) => value(p, "Id") !== id); next.tasks = next.tasks.map((t) => value(t, "ProjectId") === id ? { ...t, ProjectId: "", Project: "Unassigned" } : t); return save(next); },
    };
  }
  return { value, done, archived, statuses, priorityValues, priorityLabel, normalizeState, applyProject, createProject, applyTask, createTask, renameNoteLinks, previewApi };
});
