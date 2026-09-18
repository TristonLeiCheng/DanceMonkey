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

function createZenTaskStore(notesRoot) {
  const taskFile = path.join(notesRoot, TASK_FILE);
  const projectFile = path.join(notesRoot, PROJECT_FILE);
  function load() {
    return model.normalizeState({ tasks: readEnvelope(taskFile).items, projects: readEnvelope(projectFile).items, taskFile, projectFile });
  }
  function write(file, items) {
    atomicWrite(file, { SchemaVersion: readEnvelope(file).schemaVersion, Items: items });
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
    // Persist unambiguous legacy name-only links before changing their names.
    if (value(project, "Name") !== value(next, "Name")) write(taskFile, state.tasks);
    Object.assign(project, next);
    write(projectFile, state.projects);
    // Task display names are resolved from ProjectId on every read.
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
    const projects = load().projects;
    const next = model.renameNoteLinks(projects, from, to);
    if (next.some((project, i) => project !== projects[i])) write(projectFile, next);
  }
  return { load, addTask, updateTask, toggleTask, deleteTask, addProject, updateProject, deleteProject, relocateNotes };
}

module.exports = { createZenTaskStore, value, priorityLabel };
