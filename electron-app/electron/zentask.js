const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const model = require("../src/zen-model");
const { value, priorityLabel } = model;

const TASK_FILE = path.join("Journal", "task-module.json");
const PROJECT_FILE = path.join("Journal", "zentask-projects.json");

function readEnvelope(file) {
  if (!fs.existsSync(file)) return { schemaVersion: 2, items: [] };
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (Array.isArray(parsed)) return { schemaVersion: 2, items: parsed };
  return { schemaVersion: parsed.SchemaVersion || parsed.schemaVersion || 2, items: parsed.Items || parsed.items || [] };
}

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function createZenTaskStore(notesRoot, options = {}) {
  const taskFile = path.join(notesRoot, TASK_FILE);
  const projectFile = path.join(notesRoot, PROJECT_FILE);
  function load() {
    return model.normalizeState({ tasks: readEnvelope(taskFile).items, projects: readEnvelope(projectFile).items, taskFile, projectFile });
  }
  function write(file, items) {
    options.beforeWrite?.(file, items);
    atomicWrite(file, { SchemaVersion: readEnvelope(file).schemaVersion, Items: items });
  }
  function restore(file, contents) {
    if (contents) fs.writeFileSync(file, contents); else if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  function find(items, id, label) {
    const item = items.find((entry) => value(entry, "Id") === id);
    if (!item) throw new Error(`${label}不存在`);
    return item;
  }
  function addTask(input) {
    const state = load();
    state.tasks.unshift(model.createTask(input, crypto.randomUUID().replaceAll("-", ""), state.projects));
    write(taskFile, state.tasks);
    return load();
  }
  function addTasksBatch(inputs) {
    const state = load();
    const ids = inputs.map(() => crypto.randomUUID().replaceAll("-", ""));
    const created = model.createTaskBatch(inputs, ids, state.projects, state.tasks);
    const source = value(created[0], "SourceNotePath");
    const project = state.projects.find((entry) => value(entry, "Id") === value(created[0], "ProjectId"));
    const oldTasks = fs.existsSync(taskFile) ? fs.readFileSync(taskFile) : null;
    const oldProjects = fs.existsSync(projectFile) ? fs.readFileSync(projectFile) : null;
    try {
      state.tasks.unshift(...created);
      if (project && source && !model.list(project, "LinkedNotes").includes(source)) project.LinkedNotes = [...model.list(project, "LinkedNotes"), source];
      write(projectFile, state.projects);
      write(taskFile, state.tasks);
    } catch (error) {
      if (oldTasks) fs.writeFileSync(taskFile, oldTasks); else if (fs.existsSync(taskFile)) fs.unlinkSync(taskFile);
      if (oldProjects) fs.writeFileSync(projectFile, oldProjects); else if (fs.existsSync(projectFile)) fs.unlinkSync(projectFile);
      throw error;
    }
    return load();
  }
  function updateTask(id, input) {
    const state = load();
    const task = find(state.tasks, id, "任务");
    Object.assign(task, model.applyTask(task, input, state.projects));
    write(taskFile, state.tasks);
    return load();
  }
  function toggleTask(id) {
    const task = find(load().tasks, id, "任务");
    return updateTask(id, { workflowStatus: model.done(task) ? "Todo" : "Completed" });
  }
  function deleteTask(id) {
    write(taskFile, load().tasks.filter((task) => value(task, "Id") !== id));
    return load();
  }
  function addProject(input) {
    const state = load();
    const project = model.createProject(input, crypto.randomUUID().replaceAll("-", ""));
    // Capture existing unique legacy links before a new same-name project is added.
    write(taskFile, state.tasks);
    state.projects.unshift(project);
    write(projectFile, state.projects);
    return load();
  }
  function updateProject(id, input) {
    const state = load();
    const project = find(state.projects, id, "项目");
    const next = model.applyProject(project, input);
    if (input.milestones) model.validateMilestoneLinks(state, id, next.Milestones);
    // Persist unambiguous legacy name-only links before changing their names.
    if (value(project, "Name") !== value(next, "Name")) write(taskFile, state.tasks);
    Object.assign(project, next);
    write(projectFile, state.projects);
    // Task display names are resolved from ProjectId on every read.
    return load();
  }
  function deleteMilestone(projectId, milestoneId, reassignTo) {
    const state = load();
    const project = find(state.projects, projectId, "项目");
    const stages = model.list(project, "Milestones");
    if (!stages.some((stage) => value(stage, "Id") === milestoneId)) throw new Error("里程碑不存在");
    if (reassignTo && !stages.some((stage) => value(stage, "Id") === reassignTo && reassignTo !== milestoneId)) throw new Error("目标里程碑无效");
    const linked = state.tasks.filter((task) => value(task, "ProjectId") === projectId && value(task, "MilestoneId") === milestoneId);
    if (linked.length && reassignTo === undefined) throw new Error(`仍有 ${linked.length} 项关联任务，请选择转移目标或明确设为未分配`);
    state.tasks = state.tasks.map((task) => linked.includes(task) ? { ...task, MilestoneId: reassignTo || "" } : task);
    project.Milestones = stages.filter((stage) => value(stage, "Id") !== milestoneId);
    const oldTasks = fs.existsSync(taskFile) ? fs.readFileSync(taskFile) : null;
    const oldProjects = fs.existsSync(projectFile) ? fs.readFileSync(projectFile) : null;
    try {
      write(taskFile, state.tasks);
      write(projectFile, state.projects);
    } catch (error) {
      // Best-effort bounded rollback: restore only the two files this operation owns.
      try { restore(taskFile, oldTasks); } catch {}
      try { restore(projectFile, oldProjects); } catch {}
      throw error;
    }
    return load();
  }
  function deleteProject(id) {
    const state = load();
    state.tasks = state.tasks.map((task) => value(task, "ProjectId") === id
      ? { ...task, ProjectId: "", Project: "Unassigned", UpdatedAt: new Date().toISOString() } : task);
    write(taskFile, state.tasks);
    write(projectFile, state.projects.filter((project) => value(project, "Id") !== id));
    return load();
  }
  function relocateNotes(from, to) {
    const state = load();
    const projects = state.projects;
    const next = model.renameNoteLinks(projects, from, to);
    if (next.some((project, i) => project !== projects[i])) write(projectFile, next);
    const tasks = model.renameTaskSources(state.tasks, from, to);
    if (tasks.some((task, i) => task !== state.tasks[i])) write(taskFile, tasks);
  }
  return { load, addTask, addTasksBatch, updateTask, toggleTask, deleteTask, addProject, updateProject, deleteMilestone, deleteProject, relocateNotes };
}

module.exports = { createZenTaskStore, value, priorityLabel };
