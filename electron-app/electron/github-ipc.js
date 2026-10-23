const fs = require("node:fs");
const path = require("node:path");
const { createGitHubAuth } = require("./github-auth");
const { createGitHubSync } = require("./github-sync");
const { createGitHubTransport } = require("./github-transport");
const { createGitHubCoordinator } = require("./github-coordinator");
const { createSyncDirectories } = require("./github-vaults");

function registerGitHubSync({ app, ipcMain, safeStorage, shell, clipboard, dialog, BrowserWindow, fetch,
  root, getWindows, isFolderSyncBusy, refreshNotes }) {
  let shuttingDown = false;
  let shutdownController = new AbortController();
  let activeOperation = Promise.resolve();
  async function fetchForSync(url, options = {}) {
    const signal = options.signal ? AbortSignal.any([options.signal, shutdownController.signal]) : shutdownController.signal;
    signal.throwIfAborted();
    let abort;
    try {
      return await Promise.race([
        fetch(url, { ...options, signal }),
        new Promise((_, reject) => {
          abort = () => reject(new Error("GitHub 操作已停止。"));
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        }),
      ]);
    } finally { if (abort) signal.removeEventListener("abort", abort); }
  }
  const directory = path.join(app.getPath("userData"), "github-notes");
  const defaults = require("./github-app.json");
  const auth = createGitHubAuth({ directory: path.join(directory, "auth"), safeStorage, fetch: fetchForSync,
    clientId: process.env.DM_GITHUB_CLIENT_ID || defaults.clientId,
    appSlug: process.env.DM_GITHUB_APP_SLUG || defaults.appSlug,
    openExternal: (url) => shell.openExternal(url) });
  let device = null;
  const syncDirectory = createSyncDirectories(directory, root);
  const makeSync = (nextRoot) => createGitHubSync({ root: nextRoot, directory: syncDirectory(nextRoot),
    http: createGitHubTransport(fetchForSync), getToken: () => auth.getToken() });
  let sync = makeSync(root);
  const coordinator = createGitHubCoordinator({
    getParticipants: () => getWindows().filter((win) => win && !win.isDestroyed()).map((win) => win.webContents),
  });
  let preview = null;
  let operationBusy = false;
  const trusted = (event) => {
    if (!getWindows().some((win) => win && !win.isDestroyed() && win.webContents === event.sender) ||
        event.senderFrame !== event.sender.mainFrame) return false;
    try {
      const url = new URL(event.senderFrame.url);
      if (app.isPackaged) return url.protocol === "file:" &&
        require("node:url").fileURLToPath(url) === path.join(app.getAppPath(), "index.html");
      return url.origin === `http://127.0.0.1:${process.env.DM_E2E_SERVER_PORT || "5173"}` && url.pathname === "/";
    } catch { return false; }
  };
  const state = async () => ({ auth: await auth.status(), sync: { ...sync.status(), busy: operationBusy }, root });
  const settledState = async () => {
    const result = await state();
    result.sync.busy = false;
    return result;
  };
  const handle = (name, operation) => ipcMain.handle(`githubSync:${name}`, async (event, input) => {
    if (shuttingDown) return { success: false, error: "正在退出软件，请稍候。" };
    if (!trusted(event)) return { success: false, error: "此操作只能从 DM 主窗口发起。" };
    try { return { success: true, ...await operation(event, input) }; }
    catch (error) {
      const message = String(error?.message || "");
      return { success: false, error: /[㐀-鿿]/.test(message)
        ? message.slice(0, 1200) : "GitHub 笔记操作失败，请检查网络、仓库访问权限或本地目录权限。" };
    }
  });
  const exclusive = async (operation) => {
    if (shuttingDown) throw new Error("正在退出软件，请稍候。");
    if (operationBusy) throw new Error("已有 GitHub 操作正在进行，请稍后重试。");
    operationBusy = true;
    let finish;
    activeOperation = new Promise((resolve) => { finish = resolve; });
    try { return await operation(); } finally { operationBusy = false; finish(); }
  };
  const withEditors = (operation) => exclusive(async () => {
    auth.cancel();
    if (isFolderSyncBusy()) throw new Error("请等待截图或文件夹同步完成后再同步 GitHub 笔记。");
    return coordinator.run(async () => {
      if (isFolderSyncBusy()) throw new Error("请等待截图或文件夹同步完成后重试。");
      try { return await operation(); } finally { refreshNotes(); }
    });
  });

  ipcMain.handle("githubSync:generation", () => coordinator.generation);
  ipcMain.on("githubSync:editor-ready", (event, payload) => coordinator.acknowledge(event.sender, payload));
  handle("status", state);
  handle("configureAuth", (_event, input) => exclusive(async () => {
    preview = null;
    device = null;
    auth.cancel();
    await auth.configure(input || {});
    return settledState();
  }));
  handle("startAuth", () => exclusive(async () => {
    preview = null;
    device = null;
    device = await auth.start();
    return device;
  }));
  handle("pollAuth", async () => {
    if (coordinator.busy) throw new Error("笔记同步期间不能切换登录状态。");
    const result = await auth.poll();
    if (!result.pending) device = null;
    return result;
  });
  handle("cancelAuth", async () => { device = null; await auth.cancel(); return state(); });
  handle("copyCode", () => {
    if (!device || Date.now() >= device.expiresAt) throw new Error("验证码已失效，请重新连接。");
    clipboard.writeText(device.userCode);
    return {};
  });
  handle("openVerification", async () => {
    if (!device || Date.now() >= device.expiresAt) throw new Error("验证码已失效，请重新连接。");
    await shell.openExternal("https://github.com/login/device");
    return {};
  });
  handle("openCreateRepository", async () => {
    if (!auth.status().connected) throw new Error("请先连接 GitHub，再创建笔记库。");
    // GitHub 的网页由用户确认名称和 Private；不通过 API 创建或索取 Administration 权限。
    await shell.openExternal("https://github.com/new");
    return {};
  });
  handle("repositories", () => exclusive(async () => ({ repositories: await auth.repositories() })));
  handle("openInstallation", async () => {
    const info = await auth.status();
    if (!/^[a-zA-Z0-9-]+$/.test(info.appSlug || "")) throw new Error("请先配置 GitHub App 名称。");
    await shell.openExternal(`https://github.com/apps/${info.appSlug}/installations/new`);
    return {};
  });
  handle("disconnect", () => exclusive(async () => {
    preview = null;
    device = null;
    await auth.disconnect();
    return settledState();
  }));
  handle("bind", (_event, input) => exclusive(async () => {
    const info = await auth.repository(input || {});
    if (!info.private) throw new Error("首版仅支持私有笔记仓库，避免意外公开笔记和截图。");
    await sync.configure({ owner: info.owner, repo: info.repo, branch: input?.branch || info.defaultBranch || "main" });
    preview = null;
    return settledState();
  }));
  handle("preview", () => withEditors(async () => {
    const binding = sync.status().binding;
    if (!binding) throw new Error("请先绑定笔记仓库。");
    const info = await auth.repository(binding);
    if (!info.private) throw new Error("仓库已变为公开状态，请先在 GitHub 恢复为私有仓库。");
    preview = null;
    preview = await sync.preview();
    return preview;
  }));
  handle("sync", (event, input) => withEditors(async () => {
    if (!preview || input?.previewId !== preview.id) throw new Error("请先重新预览同步差异。");
    if (preview.conflicts?.length) throw new Error("存在冲突，请先处理冲突并重新预览。");
    const binding = sync.status().binding;
    const info = await auth.repository(binding);
    if (!info.private) throw new Error("仅允许同步到私有仓库，请重新检查仓库设置。");
    const result = await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender), {
      type: "warning",
      title: "确认 GitHub 笔记同步",
      message: `同步到 ${binding.owner}/${binding.repo} · ${binding.branch}？`,
      detail: `本地目录：${root}\n上传 ${preview.uploads?.length || 0} 项，下载 ${preview.downloads?.length || 0} 项，删除 ${preview.deletions?.length || 0} 项。\n笔记、图片、任务和项目数据会上传至 GitHub，删除的内容仍可能保留在 Git 历史中。仅同步 Journal/task-module.json 和 Journal/zentask-projects.json 两个业务 JSON；应用配置、API Key 和其他 JSON 不会上传。\n任务和项目按整个文件处理冲突，不自动合并记录。操作前会保留本地备份；这不是端到端加密。`,
      buttons: ["取消", "确认同步"], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (result.response !== 1) return { cancelled: true };
    const verified = await auth.repository(binding);
    if (!verified.private) throw new Error("仓库已变为公开状态，已取消上传。");
    const current = preview;
    preview = null;
    return sync.sync({ previewId: current.id });
  }));
  handle("openBackup", async () => {
    const target = syncDirectory(root);
    fs.mkdirSync(target, { recursive: true });
    const error = await shell.openPath(target);
    if (error) throw new Error("无法打开同步备份目录。");
    return {};
  });

  return {
    async shutdown() {
      shuttingDown = true;
      shutdownController.abort();
      await auth.cancel();
      await activeOperation;
    },
    resume() { shuttingDown = false; shutdownController = new AbortController(); },
    trusted,
    runLocalOperation: (operation) => withEditors(() => {
      preview = null;
      return operation();
    }),
    switchRoot: async (nextRoot, commit) => {
      if (nextRoot === root) return;
      return withEditors(async () => {
        if (!fs.existsSync(nextRoot) || fs.realpathSync(nextRoot) !== nextRoot || !fs.statSync(nextRoot).isDirectory()) {
          throw new Error("笔记库目录已变化，请重新选择目录。");
        }
        const nextSync = makeSync(nextRoot);
        if (nextSync.status().error) throw new Error(nextSync.status().error);
        // Commit is synchronous: no renderer can observe a half-switched context.
        commit();
        root = nextRoot;
        sync = nextSync;
        preview = null;
        device = null;
      });
    },
    assertWritable: (generation) => coordinator.assertWritable(generation),
    get busy() { return operationBusy || coordinator.busy; },
  };
}

module.exports = { registerGitHubSync };
