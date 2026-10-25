// Keep staged files and update sources in the main process. Renderers only see status.
function createAppUpdateController({ service, getSettings, supported = true, automatic = true,
  broadcast = () => {}, quit = () => {}, canApply = () => true, logError = console.warn,
  timers = { setTimeout, clearTimeout, setInterval, clearInterval },
}) {
  let state = { supported, phase: "idle", currentVersion: service.getCurrentVersion(), latestVersion: "", message: "" };
  let staged = null;
  let checking = null;
  let applying = null;
  let startupTimer = null;
  let interval = null;
  const getState = () => ({ ...state });
  const publicError = (error, fallback) => error?.code === "DM_MAC_UPDATE_INSTALL_LOCATION"
    ? "请将应用移到可写的应用程序文件夹后重试。" : error?.code === 'DM_PET_UPDATE_UNAVAILABLE' ? error.message : fallback;
  function publish(patch) {
    state = { ...state, ...patch };
    broadcast(getState());
    return getState();
  }
  function check() {
    if (!supported) return Promise.resolve({ success: false, error: "当前系统暂不支持应用内更新。", ...getState() });
    if (checking) return checking;
    if (staged) return Promise.resolve({ success: true, ...getState() });
    publish({ phase: "checking", message: "正在检查更新…" });
    checking = Promise.resolve().then(async () => {
      try {
        const result = await service.checkAndPrepare(getSettings(), (message) => {
          publish({ message });
        });
        staged = result.launchInfo || null;
        if (result.isUpdateAvailable && !staged) throw new Error("更新未准备完成");
        return { success: true, ...publish({
          phase: staged ? "ready" : "latest",
          latestVersion: result.latestVersionText,
          message: staged ? `新版本 v${result.latestVersionText} 已准备好，点击安装并重启。` : "当前已是最新版本。",
        }) };
      } catch (error) {
        logError("Application update check failed", error);
        const message = publicError(error, "检查或下载更新失败，请稍后重试。");
        return { success: false, error: message, ...publish({ phase: "error", message }) };
      } finally { checking = null; }
    });
    return checking;
  }
  function apply() {
    if (applying) return applying;
    if (!staged) return Promise.resolve({ success: false, error: "请先检查并准备更新。" });
    if (!canApply()) return Promise.resolve({ success: false, error: "正在执行任务，请等待完成后再更新。" });
    publish({ phase: "installing", message: "正在安装更新，即将重启…" });
    applying = Promise.resolve().then(async () => {
      try {
        await service.launchUpdaterAndRestart(staged);
        quit();
        return { success: true };
      } catch (error) {
        logError("Application update launch failed", error);
        publish({ phase: "ready", message: publicError(error, "启动更新失败，请点击安装重试。") });
        applying = null;
        return { success: false, error: state.message };
      }
    });
    return applying;
  }
  function start() {
    if (!supported || !automatic || interval !== null) return;
    startupTimer = timers.setTimeout(() => { startupTimer = null; void check(); }, 30_000);
    interval = timers.setInterval(() => { void check(); }, 6 * 60 * 60 * 1000);
    startupTimer?.unref?.();
    interval?.unref?.();
  }
  function stop() {
    if (startupTimer !== null) timers.clearTimeout(startupTimer);
    if (interval !== null) timers.clearInterval(interval);
    startupTimer = interval = null;
  }
  return { getState, check, apply, start, stop };
}
module.exports = { createAppUpdateController };
