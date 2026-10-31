(() => {
  function create(api, { esc, beforeApply = async () => {} }) {
    const attr = (value) => esc(value).replaceAll('"', "&quot;");
    let state = { supported: Boolean(api.appUpdate), phase: "idle", currentVersion: "", message: "" };
    let localBusy = false;
    let localError = "";
    let loading = null;
    const busy = () => localBusy || ["checking", "installing"].includes(state.phase);
    const ready = () => ["ready", "installing"].includes(state.phase);
    function renderButton() {
      const notice = localError ? `<span class="ws-update-notice" role="alert">${esc(localError)}</span>` : "";
      if (!ready()) return notice;
      return `${notice}<button type="button" class="ws-update-restart" data-action="app-update-apply" ${busy() ? "disabled" : ""} title="${attr(state.latestVersion ? `安装 v${state.latestVersion} 并重启` : "安装更新并重启")}">${state.phase === "installing" ? "正在重启…" : "更新并重启"}</button>`;
    }
    function renderSettings() {
      return `<p class="ws-settings-desc">当前版本${state.currentVersion ? ` v${esc(state.currentVersion)}` : ""}。${state.supported ? "自动检查更新，准备好后可点击右上角“更新并重启”。" : "当前系统暂不支持应用内更新。"}</p>
        ${state.supported ? `<div class="ws-settings-actions"><button class="module-primary" type="button" data-action="app-update-${ready() ? "apply" : "check"}" ${busy() ? "disabled" : ""}>${state.phase === "installing" ? "正在安装…" : ready() ? "安装更新" : busy() ? "检查中…" : "检查更新"}</button></div>` : ""}
        <p class="ws-settings-update-status" role="status" aria-live="polite">${esc(localError || state.message)}</p>
        ${api.appUpdate?.openLogs && (localError || state.phase === 'error') ? '<button class="module-secondary" type="button" data-action="app-update-logs">打开更新日志</button>' : ''}`;
    }
    // Only touch update slots so background events preserve editors and settings drafts.
    function refresh() {
      for (const slot of document.querySelectorAll("[data-app-update-slot]")) {
        slot.innerHTML = slot.dataset.appUpdateSlot === "title" ? renderButton() : renderSettings();
      }
    }
    function accept(next) { state = next; localError = ""; refresh(); }
    api.appUpdate?.onState?.(accept);
    async function load() {
      if (!api.appUpdate?.info) return;
      if (loading) return loading;
      loading = (async () => {
        try { accept(await api.appUpdate.info()); }
        catch { localError = "无法读取更新状态，请稍后重试。"; refresh(); }
        finally { loading = null; }
      })();
      return loading;
    }
    async function handleAction(action) {
      if (action === 'app-update-logs' && api.appUpdate?.openLogs) {
        try { if (!(await api.appUpdate.openLogs())?.success) throw new Error(); }
        catch { localError = '无法打开更新日志，请稍后重试。'; refresh(); }
        return true;
      }
      if (!["app-update-check", "app-update-apply"].includes(action)) return false;
      if (busy() || !state.supported) return true;
      localBusy = true;
      localError = "";
      refresh();
      try {
        if (action === "app-update-apply") {
          try { await beforeApply(); }
          catch { localError = "笔记保存失败，请保存成功后再更新。"; return true; }
          const result = await api.appUpdate.apply();
          if (!result?.success) localError = result?.error || "安装更新失败，请重试。";
        } else {
          const result = await api.appUpdate.check();
          if (result?.phase) accept(result);
          if (!result?.success) localError = result?.error || "检查更新失败，请重试。";
        }
      } catch { localError = "更新失败，请稍后重试。"; }
      finally { localBusy = false; refresh(); }
      return true;
    }
    return { load, renderButton, renderSettings, handleAction };
  }
  window.DMAppUpdateUI = { create };
})();
