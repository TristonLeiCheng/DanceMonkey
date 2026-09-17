const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const TASK_FILE = path.join("Journal", "task-module.json");
const PROJECT_FILE = path.join("Journal", "zentask-projects.json");

function readEnvelope(file) {
  if (!fs.existsSync(file)) return { schemaVersion: 2, items: [] };
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (Array.isArray(parsed)) return { schemaVersion: 2, items: parsed };
  return {
    schemaVersion: parsed.SchemaVersion || parsed.schemaVersion || 2,
    items: parsed.Items || parsed.items || [],
  };
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temporary, file);
}

function value(item, name, fallback = "") {
  const camel = name[0].toLowerCase() + name.slice(1);
  return item?.[name] ?? item?.[camel] ?? fallback;
}

function priorityValues(priority) {
  switch (priority) {
    case "Urgent & Important":
    case "Critical":
    case "Q1":
      return [5, 5];
    case "Not Urgent & Important":
    case "Q2":
      return [5, 2];
    case "Urgent & Not Important":
    case "Q3":
      return [2, 5];
    case "High":
      return [4, 4];
    case "Low":
    case "Q4":
      return [2, 2];
    default:
      return [3, 3];
  }
}

function priorityLabel(impact, urgency) {
  if (impact >= 4 && urgency >= 4) return "Urgent & Important";
  if (impact >= 4) return "Not Urgent & Important";
  if (urgency >= 4) return "Urgent & Not Important";
  return "Not Urgent & Not Important";
}

function nowIso() {
  return new Date().toISOString();
}

function createZenTaskStore(notesRoot) {
  const taskFile = path.join(notesRoot, TASK_FILE);
  const projectFile = path.join(notesRoot, PROJECT_FILE);

  function load() {
    const tasks = readEnvelope(taskFile).items;
    const projects = readEnvelope(projectFile).items;
    return { tasks, projects, taskFile, projectFile };
  }

  function writeTasks(items, schemaVersion = 2) {
    atomicWrite(taskFile, { SchemaVersion: schemaVersion, Items: items });
  }

  function writeProjects(items, schemaVersion = 2) {
    atomicWrite(projectFile, { SchemaVersion: schemaVersion, Items: items });
  }

  function addTask(input) {
    const title = String(input.title || "").trim();
    if (!title) throw new Error("任务标题不能为空");
    const taskEnvelope = readEnvelope(taskFile);
    const projects = readEnvelope(projectFile).items;
    const project = projects.find((item) => value(item, "Id") === input.projectId);
    const [impact, urgency] = priorityValues(input.priority);
    const timestamp = nowIso();
    const task = {
      Id: crypto.randomUUID().replaceAll("-", ""),
      ProjectId: project ? value(project, "Id") : "",
      Project: project ? value(project, "Name") : "Unassigned",
      Title: title,
      SourceTag: "Manual",
      Layer: input.layer || "Project Task",
      Impact: impact,
      Urgency: urgency,
      RaciRole: input.raci || "Responsible",
      EnergyLevel: input.energy || "Medium",
      WorkflowStatus: input.workflowStatus || "Todo",
      DueDate: input.dueDate || null,
      StartDate: input.startDate || null,
      EndDate: input.endDate || null,
      Notes: String(input.notes || "").trim(),
      Tags: String(input.tags || "").trim(),
      Checklist: Array.isArray(input.checklist) ? input.checklist : [],
      Objective: String(input.objective || "").trim(),
      KeyResult: String(input.keyResult || "").trim(),
      CreatedAt: timestamp,
      UpdatedAt: timestamp,
      CompletedAt: null,
      AuditTrail: [`${timestamp} created`],
      IsDone: false,
      IsHighEnergy: input.energy === "High",
      DueDateDisplay: input.dueDate ? String(input.dueDate).slice(0, 10) : "—",
      PriorityLabel: priorityLabel(impact, urgency),
    };
    taskEnvelope.items.unshift(task);
    writeTasks(taskEnvelope.items, taskEnvelope.schemaVersion);
    return load();
  }

  function updateTask(id, input) {
    const envelope = readEnvelope(taskFile);
    const task = envelope.items.find((item) => value(item, "Id") === id);
    if (!task) throw new Error("任务不存在");
    const projects = readEnvelope(projectFile).items;
    const project = projects.find((item) => value(item, "Id") === input.projectId);
    const [impact, urgency] = priorityValues(input.priority);
    const completed = input.workflowStatus === "Completed" || input.workflowStatus === "Done";
    Object.assign(task, {
      Title: String(input.title || value(task, "Title")).trim(),
      ProjectId: project ? value(project, "Id") : "",
      Project: project ? value(project, "Name") : "Unassigned",
      Impact: impact,
      Urgency: urgency,
      RaciRole: input.raci || value(task, "RaciRole", "Responsible"),
      EnergyLevel: input.energy || value(task, "EnergyLevel", "Medium"),
      WorkflowStatus: input.workflowStatus || value(task, "WorkflowStatus", "Todo"),
      DueDate: input.dueDate || null,
      StartDate: input.startDate || null,
      EndDate: input.endDate || null,
      Notes: String(input.notes || ""),
      Tags: String(input.tags || ""),
      UpdatedAt: nowIso(),
      CompletedAt: completed ? value(task, "CompletedAt") || nowIso() : null,
      IsDone: completed,
      IsHighEnergy: input.energy === "High",
      DueDateDisplay: input.dueDate ? String(input.dueDate).slice(0, 10) : "—",
      PriorityLabel: priorityLabel(impact, urgency),
    });
    const audit = value(task, "AuditTrail", []);
    task.AuditTrail = Array.isArray(audit) ? [...audit, `${nowIso()} edited`] : [`${nowIso()} edited`];
    writeTasks(envelope.items, envelope.schemaVersion);
    return load();
  }

  function toggleTask(id) {
    const envelope = readEnvelope(taskFile);
    const task = envelope.items.find((item) => value(item, "Id") === id);
    if (!task) throw new Error("任务不存在");
    const done = !["Completed", "Done"].includes(value(task, "WorkflowStatus"));
    task.WorkflowStatus = done ? "Completed" : "Todo";
    task.CompletedAt = done ? nowIso() : null;
    task.UpdatedAt = nowIso();
    task.IsDone = done;
    const audit = value(task, "AuditTrail", []);
    task.AuditTrail = Array.isArray(audit)
      ? [...audit, `${nowIso()} status -> ${task.WorkflowStatus}`]
      : [`${nowIso()} status -> ${task.WorkflowStatus}`];
    writeTasks(envelope.items, envelope.schemaVersion);
    return load();
  }

  function deleteTask(id) {
    const envelope = readEnvelope(taskFile);
    envelope.items = envelope.items.filter((item) => value(item, "Id") !== id);
    writeTasks(envelope.items, envelope.schemaVersion);
    return load();
  }

  function addProject(input) {
    const name = String(input.name || "").trim();
    if (!name) throw new Error("项目名称不能为空");
    const envelope = readEnvelope(projectFile);
    envelope.items.unshift({
      Id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      Name: name,
      Owner: String(input.owner || "").trim(),
      Progress: Number(input.progress) || 0,
      Priority: input.priority || "Medium",
      Status: input.status || "On Track",
      Category: input.category || "New Initiatives",
      Team: Number(input.team) || 1,
      Description: String(input.description || "").trim(),
    });
    writeProjects(envelope.items, envelope.schemaVersion);
    return load();
  }

  function updateProject(id, input) {
    const envelope = readEnvelope(projectFile);
    const project = envelope.items.find((item) => value(item, "Id") === id);
    if (!project) throw new Error("项目不存在");
    const oldName = value(project, "Name");
    Object.assign(project, {
      Name: String(input.name || oldName).trim(),
      Owner: String(input.owner || ""),
      Progress: Number(input.progress) || 0,
      Priority: input.priority || "Medium",
      Status: input.status || "On Track",
      Category: input.category || "New Initiatives",
      Team: Number(input.team) || 1,
      Description: String(input.description || ""),
    });
    writeProjects(envelope.items, envelope.schemaVersion);

    const tasks = readEnvelope(taskFile);
    for (const task of tasks.items) {
      if (value(task, "ProjectId") === id || value(task, "Project") === oldName) {
        task.ProjectId = id;
        task.Project = project.Name;
      }
    }
    writeTasks(tasks.items, tasks.schemaVersion);
    return load();
  }

  function deleteProject(id) {
    const envelope = readEnvelope(projectFile);
    envelope.items = envelope.items.filter((item) => value(item, "Id") !== id);
    writeProjects(envelope.items, envelope.schemaVersion);
    const tasks = readEnvelope(taskFile);
    for (const task of tasks.items) {
      if (value(task, "ProjectId") === id) {
        task.ProjectId = "";
        task.Project = "Unassigned";
        task.UpdatedAt = nowIso();
      }
    }
    writeTasks(tasks.items, tasks.schemaVersion);
    return load();
  }

  return { load, addTask, updateTask, toggleTask, deleteTask, addProject, updateProject, deleteProject };
}

module.exports = { createZenTaskStore, value, priorityLabel };
