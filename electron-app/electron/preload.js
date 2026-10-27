const { contextBridge, ipcRenderer } = require("electron");

let notesGeneration = 0;
const notesReady = ipcRenderer.invoke("githubSync:generation").then((value) => { notesGeneration = value; });
const noteWrites = new Set();
function writeNotes(channel, ...args) {
  const request = notesReady.then(() => ipcRenderer.invoke(channel, ...args, notesGeneration));
  noteWrites.add(request);
  request.then(() => noteWrites.delete(request), () => noteWrites.delete(request));
  return request;
}

let beforeQuitHandler = async () => {};
ipcRenderer.on("app:quitting", async (_event, payload) => {
  try {
    await beforeQuitHandler(payload.phase);
    if (payload.phase === "prepare") {
      await Promise.all([...noteWrites]);
      ipcRenderer.send("app:quit-ready", { id: payload.id });
    }
  } catch {
    if (payload.phase === "prepare") ipcRenderer.send("app:quit-ready", { id: payload.id, error: true });
  }
});

contextBridge.exposeInMainWorld("lumen", {
  platform: process.platform,
  // 软件渲染下 backdrop-filter 几乎无效，界面需要退回不依赖模糊的实心样式
  softwareRender: process.argv.includes("--lumen-software-render"),
  getState: () => ipcRenderer.invoke("store:get"),
  setState: (partial) => writeNotes("store:set", partial),
  setShell: (mode) => ipcRenderer.invoke("shell:set", mode),
  openWorkspace: (section) => ipcRenderer.invoke("workspace:open", section),
  vaults: {
    list: () => ipcRenderer.invoke("vaults:list"),
    open: () => ipcRenderer.invoke("vaults:open"),
    select: (root) => ipcRenderer.invoke("vaults:select", root),
  },
  pkb: {
    preview: (root) => ipcRenderer.invoke("pkb:preview", { root }),
    initialize: (root) => ipcRenderer.invoke("pkb:initialize", { root }),
    createNote: (input) => writeNotes("pkb:createNote", input),
    search: (root, query) => ipcRenderer.invoke("pkb:search", { root, query }),
  },
  workspace: {
    list: () => ipcRenderer.invoke("workspace:list"),
    read: (path) => ipcRenderer.invoke("workspace:read", path),
    write: (path, content) => writeNotes("workspace:write", path, content),
    createFile: (parent, name) => writeNotes("workspace:createFile", parent, name),
    createNote: (input) => writeNotes("workspace:createNote", input),
    createFolder: (parent, name) => writeNotes("workspace:createFolder", parent, name),
    rename: (path, name) => writeNotes("workspace:rename", path, name),
    remove: (path) => writeNotes("workspace:remove", path),
  },
  ai: {
    getSettings: () => ipcRenderer.invoke("ai:settings:get"),
    saveSettings: (settings) => ipcRenderer.invoke("ai:settings:save", settings),
    chat: (payload) => ipcRenderer.invoke("ai:chat", payload),
    cancel: (requestId) => ipcRenderer.invoke("ai:cancel", requestId),
    onChunk: (cb) => {
      const listener = (_event, payload) => cb(payload);
      ipcRenderer.on("ai:chunk", listener);
      return () => ipcRenderer.removeListener("ai:chunk", listener);
    },
  },
  personas: {
    list: () => ipcRenderer.invoke("personas:list"),
    get: (id) => ipcRenderer.invoke("personas:get", id),
    create: (input) => ipcRenderer.invoke("personas:create", input),
    updateProfile: (input) => ipcRenderer.invoke("personas:updateProfile", input),
    addSources: (input) => ipcRenderer.invoke("personas:addSources", input),
    importFiles: (input) => ipcRenderer.invoke("personas:importFiles", input),
    importNotes: (input) => ipcRenderer.invoke("personas:importNotes", input),
    removeSource: (input) => ipcRenderer.invoke("personas:removeSource", input),
    generate: (input) => ipcRenderer.invoke("personas:generate", input),
    saveCard: (input) => ipcRenderer.invoke("personas:saveCard", input),
    chat: (input) => ipcRenderer.invoke("personas:chat", input),
    newConversation: (input) => ipcRenderer.invoke("personas:newConversation", input),
    selectConversation: (input) => ipcRenderer.invoke("personas:selectConversation", input),
    deleteConversation: (input) => ipcRenderer.invoke("personas:deleteConversation", input),
    restoreCard: (input) => ipcRenderer.invoke("personas:restoreCard", input),
    remove: (input) => ipcRenderer.invoke("personas:remove", input),
    cancel: (requestId) => ipcRenderer.invoke("personas:cancel", requestId),
    onChunk: (cb) => {
      const listener = (_event, payload) => cb(payload);
      ipcRenderer.on("personas:chunk", listener);
      return () => ipcRenderer.removeListener("personas:chunk", listener);
    },
    onProgress: (cb) => {
      const listener = (_event, payload) => cb(payload);
      ipcRenderer.on("personas:progress", listener);
      return () => ipcRenderer.removeListener("personas:progress", listener);
    },
  },
  outlook: {
    status: () => ipcRenderer.invoke("outlook:status"),
    configure: (input) => ipcRenderer.invoke("outlook:configure", input),
    connect: () => ipcRenderer.invoke("outlook:connect"),
    disconnect: () => ipcRenderer.invoke("outlook:disconnect"),
    importAndGenerate: (input) => ipcRenderer.invoke("outlook:importAndGenerate", input),
    cancel: (requestId) => ipcRenderer.invoke("outlook:cancel", requestId),
    onProgress: (cb) => {
      const listener = (_event, payload) => cb(payload);
      ipcRenderer.on("outlook:progress", listener);
      return () => ipcRenderer.removeListener("outlook:progress", listener);
    },
  },
  screenshot: {
    quick: () => ipcRenderer.invoke("screenshot:quick"),
    region: () => ipcRenderer.invoke("screenshot:region"),
    onFollowUp: (cb) => {
      const listener = () => cb();
      ipcRenderer.on("screenshot:follow-up", listener);
      return () => ipcRenderer.removeListener("screenshot:follow-up", listener);
    },
  },
  reminders: {
    list: () => ipcRenderer.invoke("reminders:list"),
    save: input => ipcRenderer.invoke("reminders:save", input),
    remove: id => ipcRenderer.invoke("reminders:remove", id),
    reset: id => ipcRenderer.invoke("reminders:reset", id),
    act: (id, action) => ipcRenderer.invoke("reminders:act", id, action),
    test: input => ipcRenderer.invoke("reminders:test", input),
    saveSettings: input => ipcRenderer.invoke("reminders:settings", input),
    import: mode => ipcRenderer.invoke("reminders:import", mode),
    export: () => ipcRenderer.invoke("reminders:export"),
    onChanged: cb => {
      const listener = () => cb();
      ipcRenderer.on("reminders:changed", listener);
      return () => ipcRenderer.removeListener("reminders:changed", listener);
    },
  },
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    save: (payload) => ipcRenderer.invoke("settings:save", payload),
    applyProxy: () => ipcRenderer.invoke("settings:apply-proxy"),
    onPetChanged: (cb) => {
      const listener = (_event, settings) => cb(settings);
      ipcRenderer.on("settings:pet-changed", listener);
      return () => ipcRenderer.removeListener("settings:pet-changed", listener);
    },
  },
  githubSync: {
    status: () => ipcRenderer.invoke("githubSync:status"),
    configureAuth: (input) => ipcRenderer.invoke("githubSync:configureAuth", input),
    startAuth: () => ipcRenderer.invoke("githubSync:startAuth"),
    pollAuth: () => ipcRenderer.invoke("githubSync:pollAuth"),
    cancelAuth: () => ipcRenderer.invoke("githubSync:cancelAuth"),
    openInstallation: () => ipcRenderer.invoke("githubSync:openInstallation"),
    openVerification: () => ipcRenderer.invoke("githubSync:openVerification"),
    copyCode: () => ipcRenderer.invoke("githubSync:copyCode"),
    openCreateRepository: () => ipcRenderer.invoke("githubSync:openCreateRepository"),
    repositories: () => ipcRenderer.invoke("githubSync:repositories"),
    disconnect: () => ipcRenderer.invoke("githubSync:disconnect"),
    bind: (input) => ipcRenderer.invoke("githubSync:bind", input),
    preview: () => ipcRenderer.invoke("githubSync:preview"),
    inspectConflict: (input) => ipcRenderer.invoke("githubSync:inspectConflict", input),
    resolveConflicts: (input) => ipcRenderer.invoke("githubSync:resolveConflicts", input),
    sync: (input) => ipcRenderer.invoke("githubSync:sync", input),
    openBackup: () => ipcRenderer.invoke("githubSync:openBackup"),
    onEditor: (cb) => {
      const listener = async (_event, payload) => {
        try {
          if (payload.phase === "resume") notesGeneration = payload.generation;
          await cb(payload);
          await Promise.all([...noteWrites]);
          ipcRenderer.send("githubSync:editor-ready", { id: payload.id });
        } catch {
          ipcRenderer.send("githubSync:editor-ready", { id: payload.id, error: true });
        }
      };
      ipcRenderer.on("githubSync:editor", listener);
      return () => ipcRenderer.removeListener("githubSync:editor", listener);
    },
  },
  appUpdate: {
    info: () => ipcRenderer.invoke("appUpdate:info"),
    check: () => ipcRenderer.invoke("appUpdate:check"),
    apply: () => ipcRenderer.invoke("appUpdate:apply"),
    onState: (cb) => {
      const listener = (_event, payload) => cb(payload);
      ipcRenderer.on("appUpdate:state", listener);
      return () => ipcRenderer.removeListener("appUpdate:state", listener);
    },
  },
  zenTask: {
    load: () => ipcRenderer.invoke("zentask:load"),
    addTask: (input) => writeNotes("zentask:addTask", input),
    addTasksBatch: (inputs) => writeNotes("zentask:addTasksBatch", inputs),
    updateTask: (id, input) => writeNotes("zentask:updateTask", id, input),
    toggleTask: (id) => writeNotes("zentask:toggleTask", id),
    deleteTask: (id) => writeNotes("zentask:deleteTask", id),
    addProject: (input) => writeNotes("zentask:addProject", input),
    updateProject: (id, input) => writeNotes("zentask:updateProject", id, input),
    deleteMilestone: (projectId, milestoneId, reassignTo) => writeNotes("zentask:deleteMilestone", projectId, milestoneId, reassignTo),
    deleteProject: (id) => writeNotes("zentask:deleteProject", id),
  },
  quickAccess: {
    list: () => ipcRenderer.invoke("quickAccess:list"),
    add: (input) => ipcRenderer.invoke("quickAccess:add", input),
    update: (id, input) => ipcRenderer.invoke("quickAccess:update", id, input),
    remove: (id) => ipcRenderer.invoke("quickAccess:remove", id),
    togglePin: (id) => ipcRenderer.invoke("quickAccess:togglePin", id),
    open: (id) => ipcRenderer.invoke("quickAccess:open", id),
    refresh: () => ipcRenderer.invoke("quickAccess:refresh"),
  },
  folderSync: {
    list: () => ipcRenderer.invoke("folderSync:list"),
    save: (profile) => ipcRenderer.invoke("folderSync:save", profile),
    remove: (id) => ipcRenderer.invoke("folderSync:remove", id),
    preview: (idOrProfile) => ipcRenderer.invoke("folderSync:preview", idOrProfile),
    run: (id) => ipcRenderer.invoke("folderSync:run", id),
    cancel: (id) => ipcRenderer.invoke("folderSync:cancel", id),
    log: (id) => ipcRenderer.invoke("folderSync:log", id),
    openLog: (id) => ipcRenderer.invoke("folderSync:openLog", id),
    browse: () => ipcRenderer.invoke("folderSync:browse"),
    createFromLink: (linkPath, linkName) =>
      ipcRenderer.invoke("folderSync:createFromLink", linkPath, linkName),
    onProgress: (cb) => {
      const listener = (_event, payload) => cb(payload);
      ipcRenderer.on("folderSync:progress", listener);
      return () => ipcRenderer.removeListener("folderSync:progress", listener);
    },
    onScheduler: (cb) => {
      const listener = (_event, payload) => cb(payload);
      ipcRenderer.on("folderSync:scheduler", listener);
      return () => ipcRenderer.removeListener("folderSync:scheduler", listener);
    },
  },
  quitApp: () => ipcRenderer.invoke("app:quit"),
  onBeforeQuit: (callback) => {
    beforeQuitHandler = callback;
    return () => { if (beforeQuitHandler === callback) beforeQuitHandler = async () => {}; };
  },
  getAppVersion: () => ipcRenderer.invoke("app:version"),
  window: {
    minimize: () => ipcRenderer.invoke("window:minimize"),
    isMaximized: () => ipcRenderer.invoke("window:isMaximized"),
    toggleMaximize: () => ipcRenderer.invoke("window:toggleMaximize"),
    close: () => ipcRenderer.invoke("window:close"),
    onMaximized: (cb) => {
      const listener = (_event, maximized) => cb(maximized);
      ipcRenderer.on("window:maximized", listener);
      return () => ipcRenderer.removeListener("window:maximized", listener);
    },
  },
  onState: (cb) => {
    const listener = (_e, next) => cb(next);
    ipcRenderer.on("store:updated", listener);
    return () => ipcRenderer.removeListener("store:updated", listener);
  },
  onToggleQuick: (cb) => {
    const listener = () => cb();
    ipcRenderer.on("shortcut:toggle-quick", listener);
    return () => ipcRenderer.removeListener("shortcut:toggle-quick", listener);
  },
  onFocusTitle: (cb) => {
    const listener = () => cb();
    ipcRenderer.on("focus:title", listener);
    return () => ipcRenderer.removeListener("focus:title", listener);
  },
  onShellMode: (cb) => {
    const listener = (_e, next) => cb(next);
    ipcRenderer.on("shell:mode", listener);
    return () => ipcRenderer.removeListener("shell:mode", listener);
  },
  onWorkspaceChanged: (cb) => {
    const listener = (_event, change) => cb(change);
    ipcRenderer.on("workspace:changed", listener);
    return () => ipcRenderer.removeListener("workspace:changed", listener);
  },
  onWorkspaceSection: (cb) => {
    const listener = (_event, section) => cb(section);
    ipcRenderer.on("workspace:section", listener);
    return () => ipcRenderer.removeListener("workspace:section", listener);
  },
});
