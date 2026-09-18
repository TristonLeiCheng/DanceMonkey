const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lumen", {
  platform: process.platform,
  // 软件渲染下 backdrop-filter 几乎无效，界面需要退回不依赖模糊的实心样式
  softwareRender: process.argv.includes("--lumen-software-render"),
  getState: () => ipcRenderer.invoke("store:get"),
  setState: (partial) => ipcRenderer.invoke("store:set", partial),
  setShell: (mode) => ipcRenderer.invoke("shell:set", mode),
  openWorkspace: (section) => ipcRenderer.invoke("workspace:open", section),
  workspace: {
    list: () => ipcRenderer.invoke("workspace:list"),
    read: (path) => ipcRenderer.invoke("workspace:read", path),
    write: (path, content) => ipcRenderer.invoke("workspace:write", path, content),
    createFile: (parent, name) => ipcRenderer.invoke("workspace:createFile", parent, name),
    createFolder: (parent, name) => ipcRenderer.invoke("workspace:createFolder", parent, name),
    rename: (path, name) => ipcRenderer.invoke("workspace:rename", path, name),
    remove: (path) => ipcRenderer.invoke("workspace:remove", path),
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
  screenshot: {
    quick: () => ipcRenderer.invoke("screenshot:quick"),
    region: () => ipcRenderer.invoke("screenshot:region"),
    onFollowUp: (cb) => {
      const listener = () => cb();
      ipcRenderer.on("screenshot:follow-up", listener);
      return () => ipcRenderer.removeListener("screenshot:follow-up", listener);
    },
  },
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    save: (payload) => ipcRenderer.invoke("settings:save", payload),
    applyProxy: () => ipcRenderer.invoke("settings:apply-proxy"),
  },
  appUpdate: {
    info: () => ipcRenderer.invoke("appUpdate:info"),
    check: (options) => ipcRenderer.invoke("appUpdate:check", options),
    apply: (launchInfo) => ipcRenderer.invoke("appUpdate:apply", launchInfo),
    onProgress: (cb) => {
      const listener = (_event, payload) => cb(payload);
      ipcRenderer.on("appUpdate:progress", listener);
      return () => ipcRenderer.removeListener("appUpdate:progress", listener);
    },
  },
  zenTask: {
    load: () => ipcRenderer.invoke("zentask:load"),
    addTask: (input) => ipcRenderer.invoke("zentask:addTask", input),
    addTasksBatch: (inputs) => ipcRenderer.invoke("zentask:addTasksBatch", inputs),
    updateTask: (id, input) => ipcRenderer.invoke("zentask:updateTask", id, input),
    toggleTask: (id) => ipcRenderer.invoke("zentask:toggleTask", id),
    deleteTask: (id) => ipcRenderer.invoke("zentask:deleteTask", id),
    addProject: (input) => ipcRenderer.invoke("zentask:addProject", input),
    updateProject: (id, input) => ipcRenderer.invoke("zentask:updateProject", id, input),
    deleteMilestone: (projectId, milestoneId, reassignTo) => ipcRenderer.invoke("zentask:deleteMilestone", projectId, milestoneId, reassignTo),
    deleteProject: (id) => ipcRenderer.invoke("zentask:deleteProject", id),
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
  window: {
    minimize: () => ipcRenderer.invoke("window:minimize"),
    toggleMaximize: () => ipcRenderer.invoke("window:toggleMaximize"),
    close: () => ipcRenderer.invoke("window:close"),
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
