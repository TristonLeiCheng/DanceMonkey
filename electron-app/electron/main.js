const { app, BrowserWindow, dialog, globalShortcut, ipcMain, screen, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { createAiService } = require("./ai");
const { createAppSettings, toAccelerator } = require("./app-settings");
const { createFolderSyncService, defaultProfile } = require("./folder-sync");
const { createFolderSyncScheduler, normalizeProfiles } = require("./folder-sync-scheduler");
const { createLegacyConfig } = require("./legacy-config");
const { createPlatformAdapter } = require("./platform");
const { createQuickAccessService } = require("./quick-access");
const { createScreenshotController } = require("./screenshot-controller");
const { createStore } = require("./store");
const { createWorkspace } = require("./workspace");
const { createZenTaskStore } = require("./zentask");
const platform = createPlatformAdapter();

app.setName("DM");
app.commandLine.appendSwitch("enable-transparent-visuals");

// 更名后沿用旧版「雾笺」的用户数据，避免笔记与待办丢失
(() => {
  const nextDir = path.join(app.getPath("appData"), "DM");
  const previousDir = path.join(app.getPath("appData"), "雾笺");
  if (!fs.existsSync(nextDir) && fs.existsSync(previousDir)) {
    try {
      fs.renameSync(previousDir, nextDir);
    } catch {
      app.setPath("userData", previousDir);
    }
  }
})();

// 从网络盘运行时子进程沙箱无法初始化，GPU 与网络服务进程会启动失败。
// 映射盘（如 Z:）需要 realpath 解析成 UNC 路径才能识别。
function runningOnNetworkDrive() {
  try {
    return /^\\\\/.test(fs.realpathSync.native(__dirname));
  } catch {
    return false;
  }
}

const onNetworkDrive = runningOnNetworkDrive();

const softwareRender = process.argv.includes("--lumen-software-render") || onNetworkDrive;

// 软件渲染下透明窗口同样能正常合成，所有形态都保持透明，界面才能悬浮在桌面上
const windowSurface = { transparent: true, backgroundColor: "#00000000" };

// 部分远程桌面、虚拟机与网络盘环境无法启动 GPU 进程，此时退回软件渲染
if (softwareRender) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-compositing");
  app.commandLine.appendSwitch("disable-gpu-sandbox");
  // GPU 留在主进程内，避免创建必定失败的 GPU 子进程
  app.commandLine.appendSwitch("in-process-gpu");
  app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
  app.commandLine.appendSwitch("no-sandbox");
}

// 重复启动会争抢同一份缓存目录并弹出多套窗口，这里只保留首个实例
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const isDev = !app.isPackaged;
let store;
let workspaceStore;
let aiService;
let zenTaskStore;
let quickAccessService;
let folderSyncService;
let folderSyncScheduler;
let appUpdateService;
let screenshotController;
let appSettings;
let proxyEnforcement;
let legacyConfig;
let overlay = null;
let workspaceWindow = null;
let mode = "collapsed";
let registeredHotkeys = [];
const syncAbortControllers = new Map();

function listSyncProfiles() {
  return normalizeProfiles(legacyConfig.read().folderSyncProfiles);
}

function saveSyncProfiles(profiles) {
  return normalizeProfiles(
    legacyConfig.write({ folderSyncProfiles: normalizeProfiles(profiles) }).folderSyncProfiles,
  );
}

function findSyncProfile(id) {
  const profile = listSyncProfiles().find((item) => item.id === id);
  if (!profile) throw new Error("同步任务不存在");
  return profile;
}

function broadcastSyncProgress(payload) {
  for (const win of [overlay, workspaceWindow]) {
    if (win && !win.isDestroyed()) {
      win.webContents.send("folderSync:progress", payload);
    }
  }
}

function sameQuickNotes(left, right) {
  return JSON.stringify(
    left.map(({ id, filePath, title, body }) => ({ id, filePath, title, body })),
  ) ===
    JSON.stringify(
      right.map(({ id, filePath, title, body }) => ({ id, filePath, title, body })),
    );
}

function refreshQuickNotes({ broadcast = true } = {}) {
  const current = store.get();
  const notes = workspaceStore.listQuickNotes();
  // 待办不再属于任何笔记本，旧状态可能把它当成当前本子，导致笔记页空白
  const strandedNotebook = current.activeNotebookId === "todos";
  if (sameQuickNotes(current.notes, notes) && !strandedNotebook) return current;

  const activeNoteId = notes.some((note) => note.id === current.activeNoteId)
    ? current.activeNoteId
    : notes[0]?.id || null;
  const next = store.set({ notes, activeNoteId, activeNotebookId: "inbox" });
  if (broadcast && overlay && !overlay.isDestroyed()) {
    overlay.webContents.send("store:updated", next);
  }
  return next;
}

function notifyWorkspaceChanged(change = {}) {
  if (workspaceWindow && !workspaceWindow.isDestroyed()) {
    workspaceWindow.webContents.send("workspace:changed", change);
  }
}

function rendererUrl(hash = "") {
  if (isDev) return `http://127.0.0.1:5173/${hash}`;
  return `${require("node:url").pathToFileURL(path.join(__dirname, "../index.html")).href}${hash}`;
}

function workspaceHash(section = "notes") {
  return section && section !== "notes" ? `#workspace/${section}` : "#workspace";
}

// 收起态想要的宽度小于 Windows 允许的窗口最小宽度，
// 因此窗口按最小宽度创建，多出的部分推到屏幕右缘之外，只留这一段可见
const COLLAPSED_VISIBLE_WIDTH = 6;
const COLLAPSED_MIN_WIDTH = 32;

// 所有形态都贴屏幕右缘，窗口只覆盖可见部分，其余桌面区域可正常点击
function boundsForMode(next) {
  const { workArea } = screen.getPrimaryDisplay();
  const size =
    next === "collapsed"
      ? { width: COLLAPSED_MIN_WIDTH, height: 120 }
      : next === "rail"
        ? { width: 56, height: 260 }
        : { width: 384, height: Math.round(workArea.height * 0.68) };
  const visibleWidth = next === "collapsed" ? COLLAPSED_VISIBLE_WIDTH : size.width;
  return {
    x: workArea.x + workArea.width - visibleWidth,
    y: Math.round(workArea.y + (workArea.height - size.height) / 2),
    ...size,
  };
}

function applyShell(next) {
  if (!overlay) return;
  mode = next;
  overlay.setBounds(boundsForMode(next), false);
  overlay.webContents.send("shell:mode", next);
}

function openWorkspace(section = "notes") {
  const hash = workspaceHash(section);
  if (workspaceWindow && !workspaceWindow.isDestroyed()) {
    workspaceWindow.webContents.send("workspace:section", section || "notes");
    workspaceWindow.show();
    workspaceWindow.focus();
    return;
  }

  const { workArea } = screen.getPrimaryDisplay();
  workspaceWindow = new BrowserWindow({
    width: Math.min(1280, Math.round(workArea.width * 0.86)),
    height: Math.min(840, Math.round(workArea.height * 0.86)),
    minWidth: 820,
    minHeight: 560,
    frame: false,
    ...windowSurface,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: softwareRender ? ["--lumen-software-render"] : [],
    },
  });
  workspaceWindow.setMenuBarVisibility(false);
  void workspaceWindow.loadURL(rendererUrl(hash));
  workspaceWindow.once("ready-to-show", () => {
    workspaceWindow.show();
    workspaceWindow.focus();
  });
  workspaceWindow.on("closed", () => {
    workspaceWindow = null;
  });
}

app.whenReady().then(() => {
  legacyConfig = createLegacyConfig(app.getPath("appData"));
  store = createStore(app.getPath("userData"));
  workspaceStore = createWorkspace(legacyConfig.notesRoot(app.getPath("documents")));
  aiService = createAiService(legacyConfig);
  zenTaskStore = createZenTaskStore(workspaceStore.root);
  quickAccessService = createQuickAccessService(legacyConfig, shell, {
    desktop: app.getPath("desktop"),
    documents: app.getPath("documents"),
    downloads: app.getPath("downloads"),
  });
  folderSyncService = createFolderSyncService(app.getPath("appData"));
  folderSyncScheduler = createFolderSyncScheduler({
    getProfiles: listSyncProfiles,
    saveProfiles: saveSyncProfiles,
    runProfile: async (profile) => {
      const controller = new AbortController();
      syncAbortControllers.set(profile.id, controller);
      try {
        return await folderSyncService.run(profile, {
          signal: controller.signal,
          onProgress: (progress) =>
            broadcastSyncProgress({ profileId: profile.id, ...progress }),
        });
      } finally {
        syncAbortControllers.delete(profile.id);
      }
    },
    onTick: (event) => {
      for (const win of [overlay, workspaceWindow]) {
        if (win && !win.isDestroyed()) {
          win.webContents.send("folderSync:scheduler", event);
        }
      }
    },
  });
  folderSyncScheduler.start();
  screenshotController = createScreenshotController({
    getNotesRoot: () => legacyConfig.notesRoot(app.getPath("documents")),
    aiService,
    store,
    getOverlay: () => overlay,
    getWorkspaceWindow: () => workspaceWindow,
    openWorkspace,
    applyShell,
    isDev,
  });
  proxyEnforcement = platform.createProxyEnforcement();
  appSettings = createAppSettings(legacyConfig, {
    proxyEnforcement,
    onHotkeysChanged: () => registerAllHotkeys(),
  });
  appUpdateService = platform.createAppUpdateService({
    getInstallDirectory: () =>
      app.isPackaged ? path.dirname(process.execPath) : path.resolve(app.getAppPath()),
    getCurrentVersion: () => {
      try {
        return require("../package.json").version || "1.0.0";
      } catch {
        return app.getVersion() || "1.0.0";
      }
    },
    isStartupEnabled: () => {
      try {
        const { execFileSync } = require("node:child_process");
        const out = execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-Command",
            "(Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'DanceMonkey' -ErrorAction SilentlyContinue).DanceMonkey",
          ],
          { encoding: "utf8", windowsHide: true, timeout: 3000 },
        );
        return Boolean(String(out || "").trim());
      } catch {
        return false;
      }
    },
  });
  void proxyEnforcement.startOrUpdate(appSettings.get()).catch((error) => {
    console.warn("proxy enforcement start failed", error?.message || error);
  });
  const initial = store.get();
  if (!initial.quickNotesMigrated) {
    // 直接接管旧版 NoteVault，不把 3.0 的临时 LumenVault 内容写入旧笔记库。
    const notes = workspaceStore.listQuickNotes();
    store.set({
      quickNotesMigrated: true,
      notes,
      activeNoteId: notes.some((note) => note.id === initial.activeNoteId)
        ? initial.activeNoteId
        : notes[0]?.id || null,
      activeNotebookId: "inbox",
    });
  } else {
    refreshQuickNotes({ broadcast: false });
  }

  overlay = new BrowserWindow({
    ...boundsForMode("collapsed"),
    frame: false,
    ...windowSurface,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    // 收起态只有几像素宽，需显式放开系统默认的窗口最小尺寸限制
    minWidth: 1,
    minHeight: 1,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: softwareRender ? ["--lumen-software-render"] : [],
    },
  });

  overlay.setAlwaysOnTop(true, "screen-saver");
  overlay.setMenuBarVisibility(false);
  void overlay.loadURL(rendererUrl());
  // 折叠态只有一条 16px 细边，启动时先展开面板，让用户确认程序已经起来；
  // 之后失焦会按既有逻辑自动收回细条
  overlay.once("ready-to-show", () => {
    overlay.show();
    applyShell("panel");
    overlay.focus();
  });

  // 再次启动时唤出既有窗口，而不是让用户以为程序没反应
  app.on("second-instance", () => {
    if (!overlay || overlay.isDestroyed()) return;
    applyShell("panel");
    overlay.show();
    overlay.focus();
  });

  // 面板失焦才收起；快捷轨只靠鼠标离开收起，避免一展开就被 blur 打回细条
  overlay.on("blur", () => {
    if (store.get().pinned || mode !== "panel") return;
    applyShell("collapsed");
  });

  ipcMain.handle("store:get", () => refreshQuickNotes({ broadcast: false }));
  ipcMain.handle("store:set", (event, partial) => {
    const normalized = { ...partial };
    if (Array.isArray(partial.notes)) {
      const previousById = new Map(
        store.get().notes.map((note) => [note.id, note.filePath]),
      );
      normalized.notes = workspaceStore.syncQuickNotes(partial.notes);
      if (
        partial.activeNoteId &&
        !normalized.notes.some((note) => note.id === partial.activeNoteId)
      ) {
        normalized.activeNoteId = normalized.notes[0]?.id || null;
      }
      const renames = normalized.notes
        .map((note) => ({
          from: previousById.get(note.id),
          to: note.filePath,
        }))
        .filter((change) => change.from && change.from !== change.to);
      for (const change of renames) zenTaskStore.relocateNotes(change.from, change.to);
      notifyWorkspaceChanged({ renames });
    }
    const next = store.set(normalized);
    // 发起方通过返回值拿到结果，再广播给它只会造成重复渲染
    for (const win of [overlay, workspaceWindow]) {
      if (win && !win.isDestroyed() && win.webContents !== event.sender) {
        win.webContents.send("store:updated", next);
      }
    }
    return next;
  });
  ipcMain.handle("shell:set", (_e, next) => applyShell(next));
  ipcMain.handle("workspace:open", (_e, section) => openWorkspace(section));
  ipcMain.handle("workspace:list", () => ({
    root: workspaceStore.root,
    tree: workspaceStore.list(),
  }));
  ipcMain.handle("workspace:read", (_e, relativePath) => workspaceStore.read(relativePath));
  ipcMain.handle("workspace:write", (_e, relativePath, content) => {
    const result = workspaceStore.write(relativePath, content);
    refreshQuickNotes();
    return result;
  });
  ipcMain.handle("workspace:createFile", (_e, parent, name) => {
    const result = workspaceStore.createFile(parent, name);
    refreshQuickNotes();
    return result;
  });
  ipcMain.handle("workspace:createFolder", (_e, parent, name) => {
    const result = workspaceStore.createFolder(parent, name);
    refreshQuickNotes();
    return result;
  });
  ipcMain.handle("workspace:rename", (_e, relativePath, name) => {
    const result = workspaceStore.rename(relativePath, name);
    zenTaskStore.relocateNotes(relativePath, result);
    refreshQuickNotes();
    return result;
  });
  ipcMain.handle("workspace:remove", (_e, relativePath) => {
    const result = workspaceStore.remove(relativePath);
    refreshQuickNotes();
    return result;
  });
  ipcMain.handle("ai:settings:get", () => aiService.getSettings());
  ipcMain.handle("ai:settings:save", (_event, settings) =>
    aiService.saveSettings(settings),
  );
  ipcMain.handle("ai:chat", async (event, payload) => {
    const requestId = payload?.requestId;
    try {
      const text = await aiService.chat(payload || {}, (chunk) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send("ai:chunk", { requestId, chunk });
        }
      });
      return { success: true, text };
    } catch (error) {
      return { success: false, error: error?.message || "AI 请求失败" };
    }
  });
  ipcMain.handle("ai:cancel", (_event, requestId) => aiService.cancel(requestId));
  ipcMain.handle("zentask:load", () => zenTaskStore.load());
  ipcMain.handle("zentask:addTask", (_event, input) => zenTaskStore.addTask(input));
  ipcMain.handle("zentask:updateTask", (_event, id, input) =>
    zenTaskStore.updateTask(id, input),
  );
  ipcMain.handle("zentask:toggleTask", (_event, id) => zenTaskStore.toggleTask(id));
  ipcMain.handle("zentask:deleteTask", (_event, id) => zenTaskStore.deleteTask(id));
  ipcMain.handle("zentask:addProject", (_event, input) =>
    zenTaskStore.addProject(input),
  );
  ipcMain.handle("zentask:updateProject", (_event, id, input) =>
    zenTaskStore.updateProject(id, input),
  );
  ipcMain.handle("zentask:deleteProject", (_event, id) =>
    zenTaskStore.deleteProject(id),
  );
  ipcMain.handle("quickAccess:list", () => quickAccessService.list());
  ipcMain.handle("quickAccess:add", (_event, input) => quickAccessService.add(input));
  ipcMain.handle("quickAccess:update", (_event, id, input) =>
    quickAccessService.update(id, input),
  );
  ipcMain.handle("quickAccess:remove", (_event, id) => quickAccessService.remove(id));
  ipcMain.handle("quickAccess:togglePin", (_event, id) =>
    quickAccessService.togglePin(id),
  );
  ipcMain.handle("quickAccess:open", (_event, id) => quickAccessService.open(id));
  ipcMain.handle("quickAccess:refresh", () => quickAccessService.refresh());
  ipcMain.handle("folderSync:list", () => listSyncProfiles());
  ipcMain.handle("folderSync:save", (_event, profile) => {
    const profiles = listSyncProfiles();
    const next = defaultProfile({ ...profile });
    const index = profiles.findIndex((item) => item.id === next.id);
    if (index >= 0) profiles[index] = { ...profiles[index], ...next, id: profiles[index].id };
    else profiles.push(next);
    return saveSyncProfiles(profiles);
  });
  ipcMain.handle("folderSync:remove", (_event, id) => {
    const profiles = listSyncProfiles().filter((item) => item.id !== id);
    return saveSyncProfiles(profiles);
  });
  ipcMain.handle("folderSync:preview", (_event, idOrProfile) => {
    const profile =
      typeof idOrProfile === "string" ? findSyncProfile(idOrProfile) : defaultProfile(idOrProfile);
    return folderSyncService.preview(profile);
  });
  ipcMain.handle("folderSync:run", async (event, id) => {
    const profile = findSyncProfile(id);
    if (syncAbortControllers.has(id)) throw new Error("该任务正在同步中");
    const controller = new AbortController();
    syncAbortControllers.set(id, controller);
    try {
      const result = await folderSyncService.run(profile, {
        signal: controller.signal,
        onProgress: (progress) => broadcastSyncProgress({ profileId: id, ...progress }),
      });
      const profiles = listSyncProfiles();
      const index = profiles.findIndex((item) => item.id === id);
      if (index >= 0) {
        profiles[index] = {
          ...profiles[index],
          lastRunAt: new Date().toISOString(),
          lastStatus: result.cancelled
            ? "已取消"
            : result.errorCount
              ? `错误 ${result.errorCount}`
              : "成功",
        };
        saveSyncProfiles(profiles);
      }
      return { success: true, result, profiles: listSyncProfiles() };
    } catch (error) {
      return { success: false, error: error?.message || "同步失败", profiles: listSyncProfiles() };
    } finally {
      syncAbortControllers.delete(id);
    }
  });
  ipcMain.handle("folderSync:cancel", (_event, id) => {
    syncAbortControllers.get(id)?.abort();
    return true;
  });
  ipcMain.handle("folderSync:log", (_event, id) => {
    const profile = findSyncProfile(id);
    return folderSyncService.readRecentLog(profile);
  });
  ipcMain.handle("folderSync:openLog", async (_event, id) => {
    const profile = findSyncProfile(id);
    const logFile = path.join(
      app.getPath("appData"),
      "DanceMonkey",
      "sync-logs",
      `${String(profile.id).replace(/[^a-zA-Z0-9_-]/g, "_")}.log`,
    );
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    if (!fs.existsSync(logFile)) fs.writeFileSync(logFile, "", "utf8");
    const error = await shell.openPath(logFile);
    if (error) throw new Error(error);
    return true;
  });
  ipcMain.handle("folderSync:browse", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win || undefined, {
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : result.filePaths[0] || null;
  });
  ipcMain.handle("folderSync:createFromLink", (_event, linkPath, linkName) => {
    const master = String(linkPath || "").trim();
    if (!master || /^https?:\/\//i.test(master)) {
      throw new Error("网页入口无法创建文件夹同步任务");
    }
    const name = String(linkName || path.basename(master) || "同步任务").trim();
    const profile = defaultProfile({
      name,
      masterPath: master,
      slavePath: "",
      mode: "masterToSlave",
      enabled: false,
      autoSyncEnabled: false,
      lastStatus: "请补全从文件夹后启用",
    });
    const profiles = [...listSyncProfiles(), profile];
    saveSyncProfiles(profiles);
    return { profiles: listSyncProfiles(), profile };
  });
  ipcMain.handle("window:minimize", (event) =>
    BrowserWindow.fromWebContents(event.sender)?.minimize(),
  );
  ipcMain.handle("window:toggleMaximize", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return false;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return win.isMaximized();
  });
  ipcMain.handle("window:close", (event) =>
    BrowserWindow.fromWebContents(event.sender)?.close(),
  );
  ipcMain.handle("app:quit", () => app.quit());
  ipcMain.handle("screenshot:quick", () => screenshotController.captureQuick());
  ipcMain.handle("screenshot:region", () => screenshotController.beginRegionCapture());
  ipcMain.on("region:submit", (_event, payload) => {
    void screenshotController.finishRegionCapture(payload || {});
  });
  ipcMain.handle("screenshot-result:copy", () => screenshotController.copyCurrent());
  ipcMain.handle("screenshot-result:save-note", () => screenshotController.saveCurrentNote());
  ipcMain.handle("screenshot-result:analyze", () => screenshotController.analyzeCurrent());
  ipcMain.on("screenshot-result:continue", (_event, markdown) => {
    screenshotController.continueWithAnalysis(markdown);
  });
  ipcMain.on("screenshot-result:close", () => screenshotController.closeResultWindow());
  ipcMain.handle("screenshot-choice:action", (_event, action) =>
    screenshotController.handleChoice(action),
  );
  ipcMain.handle("screenshot-editor:save", (_event, payload) =>
    screenshotController.saveEditorImage(payload || {}),
  );
  ipcMain.handle("screenshot-editor:copy", (_event, payload) =>
    screenshotController.copyEditorImage(payload || {}),
  );
  ipcMain.on("screenshot-editor:close", () => screenshotController.closeEditorWindow());
  ipcMain.handle("screenshot-editor:watermark", () => screenshotController.getWatermarkMeta());
  ipcMain.handle("settings:get", () => appSettings.get());
  ipcMain.handle("settings:save", async (_event, payload) => {
    try {
      const settings = await appSettings.save(payload || {});
      return { success: true, settings };
    } catch (error) {
      return { success: false, error: error?.message || "保存失败" };
    }
  });
  ipcMain.handle("settings:apply-proxy", async () => {
    try {
      await appSettings.applyProxyNow();
      return { success: true };
    } catch (error) {
      return { success: false, error: error?.message || "应用代理失败" };
    }
  });
  ipcMain.handle("appUpdate:info", () => ({
    currentVersion: appUpdateService.getCurrentVersion(),
    installDirectory: appUpdateService.getInstallDirectory(),
  }));
  ipcMain.handle("appUpdate:check", async (event, options = {}) => {
    try {
      const settings = { ...appSettings.get(), ...(options || {}) };
      if (options?.save !== false) {
        await appSettings.save({
          ...appSettings.get(),
          updateManifestUrl: settings.updateManifestUrl,
          updateGitHubRepo: settings.updateGitHubRepo,
          updateAssetKeyword: settings.updateAssetKeyword,
        });
      }
      const sendProgress = (message) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send("appUpdate:progress", { message });
        }
      };
      const result = await appUpdateService.checkAndPrepare(
        {
          updateManifestUrl: settings.updateManifestUrl,
          updateGitHubRepo: settings.updateGitHubRepo,
          updateAssetKeyword: settings.updateAssetKeyword,
        },
        sendProgress,
      );
      return {
        success: true,
        isUpdateAvailable: result.isUpdateAvailable,
        currentVersionText: result.currentVersionText,
        latestVersionText: result.latestVersionText,
        message: result.message,
        releaseNotes: result.manifest?.releaseNotes || "",
        launchInfo: result.launchInfo
          ? {
              installDirectory: result.launchInfo.installDirectory,
              exeName: result.launchInfo.exeName,
              sourceDirectory: result.launchInfo.sourceDirectory,
              scriptPath: result.launchInfo.scriptPath,
              updateStartupEntry: result.launchInfo.updateStartupEntry,
            }
          : null,
      };
    } catch (error) {
      return { success: false, error: error?.message || "检查更新失败" };
    }
  });
  ipcMain.handle("appUpdate:apply", async (_event, launchInfo) => {
    try {
      if (!launchInfo?.scriptPath || !launchInfo?.sourceDirectory || !launchInfo?.installDirectory) {
        throw new Error("升级信息不完整，请重新检查更新。");
      }
      appUpdateService.launchUpdaterAndRestart({
        ...launchInfo,
        exeName: launchInfo.exeName || "DanceMonkey.exe",
        updateStartupEntry: Boolean(launchInfo.updateStartupEntry),
      });
      setTimeout(() => app.quit(), 400);
      return { success: true };
    } catch (error) {
      return { success: false, error: error?.message || "启动升级失败" };
    }
  });

  function registerHotkey(accelerator, handler) {
    try {
      if (!accelerator) return false;
      const ok = globalShortcut.register(accelerator, handler);
      if (ok) registeredHotkeys.push(accelerator);
      else console.warn("hotkey occupied", accelerator);
      return ok;
    } catch (error) {
      console.warn("hotkey failed", accelerator, error?.message || error);
      return false;
    }
  }

  function togglePanelHotkey() {
    if (!overlay) return;
    if (mode === "panel") {
      if (store.get().pinned) overlay.focus();
      else applyShell("collapsed");
      return;
    }
    applyShell("panel");
    overlay.show();
    overlay.focus();
    overlay.webContents.send("shortcut:toggle-quick");
  }

  function registerAllHotkeys() {
    for (const accelerator of registeredHotkeys) {
      try {
        globalShortcut.unregister(accelerator);
      } catch {}
    }
    registeredHotkeys = [];
    const settings = appSettings.get();
    const panelHotkey = toAccelerator(settings.globalChatHotkey, "Alt+Q");
    const quickHotkey = toAccelerator(settings.quickScreenshotHotkey, "CommandOrControl+Shift+S");
    const regionHotkey = toAccelerator(settings.regionScreenshotHotkey, "CommandOrControl+Shift+R");
    registerHotkey(panelHotkey, togglePanelHotkey);
    registerHotkey(quickHotkey, () => {
      void screenshotController.captureQuick();
    });
    registerHotkey(regionHotkey, () => {
      void screenshotController.beginRegionCapture();
    });
  }

  registerAllHotkeys();
});

app.on("before-quit", () => {
  folderSyncScheduler?.stop();
  void proxyEnforcement?.stop?.();
});

app.on("window-all-closed", () => {
  globalShortcut.unregisterAll();
  proxyEnforcement?.stop();
  app.quit();
});
