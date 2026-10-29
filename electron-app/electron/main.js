const { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, powerMonitor, powerSaveBlocker, safeStorage, screen, shell, Tray } = require("electron");
const { createReminderService } = require("./reminders");
const { createReminderPopup } = require("./reminder-popup");
const { registerReminderIpc } = require("./reminder-ipc");
const { createDesktopPet } = require("./desktop-pet");
const { registerGitHubSync } = require("./github-ipc");
const { fetchWithSystemProxy, refreshSystemProxy, configureApplicationProxy } = require("./system-proxy");
const fs = require("node:fs");
const path = require("node:path");
const { createAiService } = require("./ai");
const { createAppQuitController } = require("./app-quit");
const { installDesktopIntegration } = require("./desktop-integration");
const { createAppUpdateController } = require("./app-update-controller");
const { createAppSettings, toAccelerator } = require("./app-settings");
const { createFolderSyncService, defaultProfile } = require("./folder-sync");
const { createFolderSyncScheduler, normalizeProfiles } = require("./folder-sync-scheduler");
const { createLegacyConfig } = require("./legacy-config");
const { createPlatformAdapter } = require("./platform");
const { createQuickAccessService } = require("./quick-access");
const { createScreenshotController } = require("./screenshot-controller");
const { createStore } = require("./store");
const { createWorkspace } = require("./workspace");
const { createNoteWindows } = require("./note-windows");
const { createZenTaskStore } = require("./zentask");
const { createVaultRegistry, registerVaultIpc } = require("./vaults");
const { registerPkbIpc } = require("./pkb-ipc");
const { createPersonaService } = require("./personas");
const { registerPersonaIpc } = require("./persona-ipc");
const { createOutlookAuth } = require("./outlook-auth");
const { createOutlookMailClient } = require("./outlook-mail");
const { createOutlookImporter } = require("./outlook-import");
const { registerOutlookIpc } = require("./outlook-ipc");
const platform = createPlatformAdapter();

app.setName("DM");
if (process.platform === "win32") app.setAppUserModelId("com.dancemonkey.desktop");
app.commandLine.appendSwitch("enable-transparent-visuals");
if (process.env.DM_E2E_ROOT) {
  // UI tests are isolated from the user's vault and settings.
  app.setPath("appData", path.join(process.env.DM_E2E_ROOT, "app-data"));
  app.setPath("userData", path.join(process.env.DM_E2E_ROOT, "user-data"));
  app.setPath("documents", path.join(process.env.DM_E2E_ROOT, "documents"));
  app.commandLine.appendSwitch("remote-debugging-port", process.env.DM_E2E_PORT || "9333");
}

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
let appUpdateController;
let quitController;
let desktopIntegration;
let desktopPet;
let reminderService;
let reminderPopup;
let screenshotController;
let appSettings;
let proxyEnforcement;
let legacyConfig;
let githubNotes;
let overlay = null;
let workspaceWindow = null;
let noteWindows;
const pendingMarkdownFiles = [];
function openMarkdownFile(file) {
  if (!/\.md$/i.test(file)) return;
  if (!noteWindows) { pendingMarkdownFiles.push(file); return; }
  try { noteWindows.openLocal(path.resolve(file)); }
  catch (error) { dialog.showErrorBox('无法打开 Markdown', error.message); }
}
app.on('open-file', (event, file) => { event.preventDefault(); openMarkdownFile(file); });
const editorWindows = () => [overlay, workspaceWindow, ...(noteWindows?.windows() || [])];
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
  if (isDev) return `http://127.0.0.1:${process.env.DM_E2E_SERVER_PORT || "5173"}/${hash}`;
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

function showApplication() {
  if (quitController?.pending) return;
  if (workspaceWindow && !workspaceWindow.isDestroyed()) {
    if (workspaceWindow.isMinimized()) workspaceWindow.restore();
    workspaceWindow.show();
    workspaceWindow.focus();
  } else openWorkspace();
}

const appWindowIcon = path.join(__dirname, "../assets", process.platform === "win32" ? "logo.ico" : "logo.png");

function openWorkspace(section = "notes") {
  if (githubNotes?.busy && (!workspaceWindow || workspaceWindow.isDestroyed())) return;
  const hash = workspaceHash(section);
  if (workspaceWindow && !workspaceWindow.isDestroyed()) {
    workspaceWindow.webContents.send("workspace:section", section || "notes");
    if (workspaceWindow.isMinimized()) workspaceWindow.restore();
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
    icon: appWindowIcon,
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
  workspaceWindow.on("close", (event) => { if (githubNotes?.busy && !quitController?.allowed) event.preventDefault(); });
  workspaceWindow.setMenuBarVisibility(false);
  void workspaceWindow.loadURL(rendererUrl(hash));
  workspaceWindow.once("ready-to-show", () => {
    workspaceWindow.show();
    workspaceWindow.focus();
  });
  const sendMaximizedState = () => {
    if (workspaceWindow && !workspaceWindow.isDestroyed()) {
      workspaceWindow.webContents.send("window:maximized", workspaceWindow.isMaximized());
    }
  };
  workspaceWindow.on("maximize", sendMaximizedState);
  workspaceWindow.on("unmaximize", sendMaximizedState);
  workspaceWindow.on("closed", () => {
    workspaceWindow = null;
  });
}

app.whenReady().then(() => {
  legacyConfig = createLegacyConfig(app.getPath("appData"));
  configureApplicationProxy(() => legacyConfig.read());
  store = createStore(app.getPath("userData"));
  const initialRoot = legacyConfig.notesRoot(app.getPath("documents"));
  if (legacyConfig.read().notesVaults?.length && !fs.existsSync(initialRoot)) {
    dialog.showErrorBox("笔记库不可用", "上次使用的笔记库目录不存在，请恢复目录或修正配置中的 notesRootPath 后重启。不会自动建立空库。");
    app.quit();
    return;
  }
  workspaceStore = createWorkspace(initialRoot);
  const vaultRegistry = createVaultRegistry({ config: legacyConfig, root: workspaceStore.root,
    protectedRoots: [app.getPath("userData"), path.dirname(legacyConfig.file)] });
  aiService = createAiService(legacyConfig);
  zenTaskStore = createZenTaskStore(workspaceStore.root);
  githubNotes = registerGitHubSync({
    app, ipcMain, safeStorage, shell, clipboard, dialog, BrowserWindow, fetch: fetchWithSystemProxy,
    root: workspaceStore.root,
    getWindows: editorWindows,
    isFolderSyncBusy: () => syncAbortControllers.size > 0 || Boolean(screenshotController?.busy),
    refreshNotes: () => refreshQuickNotes(),
  });
  noteWindows = createNoteWindows({
    BrowserWindow, ipcMain, dialog, getWorkspace: () => workspaceStore, rendererUrl, icon: appWindowIcon,
    assertWritable: generation => githubNotes.assertWritable(generation),
    isBusy: () => githubNotes.busy || Boolean(quitController?.pending),
    canClose: () => Boolean(quitController?.allowed),
    trusted: githubNotes.trusted,
    changed: root => { if (root === workspaceStore.root) { refreshQuickNotes(); notifyWorkspaceChanged(); } },
  });
  registerPkbIpc({
    ipcMain, dialog, BrowserWindow, getRoot: () => workspaceStore.root, githubNotes,
    refreshNotes: () => refreshQuickNotes(),
  });
  const personaService = createPersonaService({ userDataPath: app.getPath("userData"), aiService });
  registerPersonaIpc({
    ipcMain, dialog, BrowserWindow,
    service: personaService,
    trusted: githubNotes.trusted,
    getWorkspace: () => workspaceStore,
  });
  const outlookAuth = createOutlookAuth({ directory: path.join(app.getPath("userData"), "outlook"),
    safeStorage, openExternal: (url) => shell.openExternal(url), fetch: fetchWithSystemProxy });
  const outlookImporter = createOutlookImporter({ auth: outlookAuth,
    mail: createOutlookMailClient({ fetch: fetchWithSystemProxy }), personas: personaService });
  registerOutlookIpc({ ipcMain, trusted: githubNotes.trusted, auth: outlookAuth, importer: outlookImporter });
  registerVaultIpc({
    ipcMain, dialog, BrowserWindow, registry: vaultRegistry,
    trusted: githubNotes.trusted,
    busy: () => githubNotes.busy,
    switchVault: async (nextRoot) => githubNotes.switchRoot(nextRoot, () => {
      vaultRegistry.prepare(nextRoot);
      const nextWorkspace = createWorkspace(nextRoot);
      const nextZen = createZenTaskStore(nextRoot);
      const notes = nextWorkspace.listQuickNotes();
      nextWorkspace.list();
      const previous = store.get();
      const projected = { notes, activeNoteId: notes[0]?.id || null, activeNotebookId: "inbox" };
      // Both persistent writes must succeed before publishing the new store objects.
      store.set(projected);
      try { vaultRegistry.activate(nextRoot); }
      catch (error) { store.set(previous); throw error; }
      workspaceStore = nextWorkspace;
      zenTaskStore = nextZen;
    }),
  });
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
      if (githubNotes.busy) throw new Error("GitHub 笔记同步期间暂停文件夹同步。");
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
    getNotesRoot: () => {
      if (githubNotes.busy) throw new Error("正在同步或切换笔记库，请稍后再截图。");
      githubNotes.assertWritable();
      return workspaceStore.root;
    },
    aiService,
    store,
    getOverlay: () => overlay,
    getWorkspaceWindow: () => workspaceWindow,
    getPetWindow: () => desktopPet?.window,
    getDocumentWindows: () => noteWindows?.windows() || [],
    onFailure: result => {
      try { fs.writeFileSync(path.join(app.getPath('userData'), 'screenshot-last-error.json'), JSON.stringify({ at: new Date().toISOString(), ...result }), { mode: 0o600 }); } catch {}
    },
    openWorkspace,
    applyShell,
    isDev,
  });
  proxyEnforcement = platform.createProxyEnforcement({
    backupFile: path.join(app.getPath("userData"), "proxy-restore.json"), onChanged: refreshSystemProxy,
  });
  appSettings = createAppSettings(legacyConfig, {
    proxyEnforcement,
    onHotkeysChanged: () => registerAllHotkeys(),
    onPetChanged: (settings) => {
      desktopPet?.sync(settings);
      broadcastPetSettings(settings);
    },
  });
  function broadcastPetSettings(settings) {
    desktopIntegration?.refreshMenu();
    for (const win of [overlay, workspaceWindow]) {
      if (win && !win.isDestroyed()) win.webContents.send("settings:pet-changed", settings);
    }
  }
  desktopPet = createDesktopPet({
    BrowserWindow, screen, Menu, powerSaveBlocker, configStore: legacyConfig,
    desktopIcons: require('./desktop-icons').createDesktopIconReader(),
    getTasks: () => githubNotes?.busy ? null : zenTaskStore.load().tasks,
    openWorkspace,
    captureQuick: () => { void screenshotController.captureQuick(); },
    captureRegion: () => { void screenshotController.beginRegionCapture(); },
    requestQuit: () => { void quitController?.request(); },
    onSettingsChanged: broadcastPetSettings,
    onReminderAction: (id, action) => { reminderService.act(id, action); reminderPopup.dismiss(id); },
    onReminderFallback: (reminder, options) => reminderPopup.show(reminder, options),
    onError: (error) => dialog.showErrorBox("桌面宠物设置未能保存", error.message),
  });
  desktopPet.registerIpc(ipcMain);
  reminderPopup = createReminderPopup({ BrowserWindow, screen, ipcMain,
    onAction: (id, action) => { reminderService.act(id, action); desktopPet.dismissReminder(id); },
    onError: error => dialog.showErrorBox("提醒未能显示", error.message),
  });
  try {
    reminderService = createReminderService({ directory: path.dirname(legacyConfig.file), configStore: legacyConfig,
      getIdleSeconds: () => powerMonitor.getSystemIdleTime(),
      onDue: (reminder, options) => {
        if (reminder.notifyStyle === "PetBubble" && desktopPet.notifyReminder(reminder, options)) return;
        reminderPopup.show(reminder, options);
      },
      onChange: () => {
        for (const win of [overlay, workspaceWindow]) {
          if (win && !win.isDestroyed()) win.webContents.send("reminders:changed");
        }
      },
      onError: error => console.error("reminders:", error),
    });
    registerReminderIpc({ ipcMain, service: reminderService, popup: reminderPopup, pet: desktopPet, dialog, BrowserWindow, trusted: githubNotes.trusted });
    reminderService.start();
  } catch (error) {
    dialog.showErrorBox("定时提醒未能加载", error.message);
  }
  appUpdateService = platform.createAppUpdateService({
    getExecutablePath: () => process.execPath,
    getUserDataDirectory: () => app.getPath("userData"),
    getPetSettings: () => appSettings.get(),
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
  appUpdateController = createAppUpdateController({
    service: appUpdateService,
    getSettings: () => appSettings.get(),
    supported: platform.supportsInAppUpdate,
    automatic: app.isPackaged && !process.env.DM_E2E_ROOT,
    broadcast: (state) => {
      for (const win of [overlay, workspaceWindow]) {
        if (win && !win.isDestroyed()) win.webContents.send("appUpdate:state", state);
      }
    },
    canApply: () => !githubNotes?.busy && !syncAbortControllers.size && !screenshotController?.busy,
    quit: () => setTimeout(() => app.quit(), 400),
  });
  appUpdateController.start();
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
    icon: appWindowIcon,
    ...windowSurface,
    alwaysOnTop: true,
    skipTaskbar: false,
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

  quitController = createAppQuitController({
    getWindows: editorWindows,
    stopBackground: async () => {
      appUpdateController.stop();
      folderSyncScheduler.stop();
      reminderService?.stop();
      for (const controller of syncAbortControllers.values()) controller.abort();
      aiService.cancelAll();
      personaService.cancelAll();
      outlookImporter.cancelAll();
      await githubNotes.shutdown();
      while (syncAbortControllers.size || screenshotController.writing) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
    resumeBackground: () => {
      githubNotes.resume();
      appUpdateController.start();
      folderSyncScheduler.start();
      reminderService?.start();
    },
    cleanup: async () => {
      try { await proxyEnforcement.stop(); }
      catch { console.warn("Windows 代理恢复未完成，恢复记录已保留，启动后将重试。"); }
      reminderService?.stop(); reminderPopup?.dispose(); desktopPet.dispose(); globalShortcut.unregisterAll();
    },
    quit: () => app.quit(),
    onError: (message) => dialog.showErrorBox("未能退出软件", message),
  });
  desktopIntegration = installDesktopIntegration({ app, Menu, Tray, nativeImage, platform: process.platform,
    icon: path.join(__dirname, "../assets/logo.png"),
    trayIcon: path.join(__dirname, "../assets", process.platform === "darwin" ? "trayTemplate.png" : "logo.ico"),
    showApplication,
    getPetEnabled: () => desktopPet.enabled,
    togglePet: () => desktopPet.toggle(),
    requestQuit: () => { void quitController.request(); },
  });
  desktopPet.sync(appSettings.get());
  overlay.on("close", (event) => {
    if (!quitController.allowed) { event.preventDefault(); void quitController.request(); }
  });
  overlay.on("focus", () => { if (mode === "collapsed" && !quitController.pending) applyShell("panel"); });

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
  app.on("second-instance", (_event, argv) => {
    const files = argv.filter(arg => /\.md$/i.test(arg) && !arg.startsWith('-'));
    if (files.length) files.forEach(openMarkdownFile); else showApplication();
  });
  [...pendingMarkdownFiles.splice(0), ...process.argv.slice(1).filter(arg => /\.md$/i.test(arg) && !arg.startsWith('-'))].forEach(openMarkdownFile);

  // 面板失焦才收起；快捷轨只靠鼠标离开收起，避免一展开就被 blur 打回细条
  overlay.on("blur", () => {
    if (store.get().pinned || mode !== "panel") return;
    applyShell("collapsed");
  });

  ipcMain.handle("store:get", () => refreshQuickNotes({ broadcast: false }));
  ipcMain.handle("store:set", (event, partial, generation) => {
    if (Array.isArray(partial?.notes)) githubNotes.assertWritable(generation);
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
  ipcMain.handle("workspace:project", (_event, id) => {
    openWorkspace("projects");
    const send = () => workspaceWindow?.webContents.send("workspace:project", id);
    if (workspaceWindow?.webContents.isLoading()) workspaceWindow.webContents.once("did-finish-load", send);
    else send();
  });
  ipcMain.handle("workspace:list", () => ({
    root: workspaceStore.root,
    tree: workspaceStore.list(),
  }));
  ipcMain.handle("workspace:read", (_e, relativePath) => workspaceStore.read(relativePath));
  ipcMain.handle("workspace:write", (_e, relativePath, content, generation) => {
    githubNotes.assertWritable(generation);
    noteWindows.assertAvailable(workspaceStore.root, relativePath);
    const result = workspaceStore.write(relativePath, content);
    refreshQuickNotes();
    return result;
  });
  ipcMain.handle("workspace:createFile", (_e, parent, name, generation) => {
    githubNotes.assertWritable(generation);
    const result = workspaceStore.createFile(parent, name);
    refreshQuickNotes();
    return result;
  });
  ipcMain.handle("workspace:createNote", (_e, input, generation) => {
    githubNotes.assertWritable(generation);
    if (input?.root !== workspaceStore.root) throw new Error("笔记库已变化，请返回主页重试。");
    const result = workspaceStore.createNote(input);
    refreshQuickNotes();
    return result;
  });
  ipcMain.handle("workspace:createFolder", (_e, parent, name, generation) => {
    githubNotes.assertWritable(generation);
    const result = workspaceStore.createFolder(parent, name);
    refreshQuickNotes();
    return result;
  });
  ipcMain.handle("workspace:rename", (_e, relativePath, name, generation) => {
    githubNotes.assertWritable(generation);
    noteWindows.assertAvailable(workspaceStore.root, relativePath);
    const result = workspaceStore.rename(relativePath, name);
    zenTaskStore.relocateNotes(relativePath, result);
    refreshQuickNotes();
    return result;
  });
  ipcMain.handle("workspace:remove", (_e, relativePath, generation) => {
    githubNotes.assertWritable(generation);
    noteWindows.assertAvailable(workspaceStore.root, relativePath);
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
  for (const method of ["addTask", "addTasksBatch", "updateTask", "toggleTask", "deleteTask", "addProject", "updateProject", "deleteMilestone", "deleteProject"]) {
    ipcMain.handle(`zentask:${method}`, (_event, ...args) => {
      githubNotes.assertWritable(args.pop());
      return zenTaskStore[method](...args);
    });
  }
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
    if (githubNotes.busy) throw new Error("GitHub 笔记同步期间暂停文件夹同步。");
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
  ipcMain.handle("window:isMaximized", (event) =>
    Boolean(BrowserWindow.fromWebContents(event.sender)?.isMaximized()),
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
  ipcMain.handle("app:quit", () => quitController.request());
  ipcMain.on("app:quit-ready", (event, payload) => quitController.acknowledge(event.sender, payload));
  ipcMain.handle("app:version", () => app.getVersion());
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
  ipcMain.handle("settings:open-system-proxy", async () => {
    await shell.openExternal(process.platform === "win32" ? "ms-settings:network-proxy" : "x-apple.systempreferences:com.apple.Network-Settings.extension");
    return { success: true };
  });
  ipcMain.handle("settings:refresh-proxy", async () => {
    try { await refreshSystemProxy(); return { success: true }; }
    catch { return { success: false, error: "无法刷新公司系统代理，请检查系统网络设置。" }; }
  });
  ipcMain.handle("settings:apply-proxy", async () => {
    try {
      await appSettings.applyProxyNow();
      return { success: true };
    } catch (error) {
      return { success: false, error: error?.message || "应用代理失败" };
    }
  });
  ipcMain.handle("appUpdate:info", () => appUpdateController.getState());
  ipcMain.handle("appUpdate:check", () => appUpdateController.check());
  ipcMain.handle("appUpdate:apply", () => appUpdateController.apply());

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
  appUpdateService.confirmStartup?.();
});

app.on("before-quit", (event) => quitController?.beforeQuit(event));
app.on("will-quit", () => {
  reminderService?.stop();
  desktopPet?.dispose();
  desktopIntegration?.dispose();
  globalShortcut.unregisterAll();
});
app.on("window-all-closed", () => {
  if (quitController) void quitController.request();
  else app.quit();
});
