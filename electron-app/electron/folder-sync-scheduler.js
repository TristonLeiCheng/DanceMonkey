const { defaultProfile } = require("./folder-sync");

function createFolderSyncScheduler(options) {
  const {
    getProfiles,
    saveProfiles,
    runProfile,
    onTick,
  } = options;

  let timer = null;
  let running = false;

  function dueProfiles(now = Date.now()) {
    return getProfiles().filter((profile) => {
      if (!profile?.enabled || !profile.autoSyncEnabled) return false;
      if (!String(profile.masterPath || "").trim() || !String(profile.slavePath || "").trim()) {
        return false;
      }
      const intervalMs = Math.max(1, Number(profile.autoSyncIntervalMinutes) || 30) * 60 * 1000;
      if (!profile.lastRunAt) return true;
      const last = Date.parse(profile.lastRunAt);
      if (!Number.isFinite(last)) return true;
      return now - last >= intervalMs;
    });
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      const due = dueProfiles();
      for (const profile of due) {
        onTick?.({ type: "start", profileId: profile.id, name: profile.name });
        try {
          const result = await runProfile(profile);
          const profiles = getProfiles();
          const index = profiles.findIndex((item) => item.id === profile.id);
          if (index >= 0) {
            profiles[index] = {
              ...profiles[index],
              lastRunAt: new Date().toISOString(),
              lastStatus: result?.cancelled ? "已取消" : result?.errorCount ? `错误 ${result.errorCount}` : "成功",
            };
            saveProfiles(profiles);
          }
          onTick?.({ type: "done", profileId: profile.id, result });
        } catch (error) {
          const profiles = getProfiles();
          const index = profiles.findIndex((item) => item.id === profile.id);
          if (index >= 0) {
            profiles[index] = {
              ...profiles[index],
              lastRunAt: new Date().toISOString(),
              lastStatus: `失败：${error.message}`,
            };
            saveProfiles(profiles);
          }
          onTick?.({ type: "error", profileId: profile.id, error: error.message });
        }
      }
    } finally {
      running = false;
    }
  }

  function start(intervalMs = 60_000) {
    stop();
    timer = setInterval(() => {
      tick().catch(() => {});
    }, Math.max(15_000, intervalMs));
    if (typeof timer.unref === "function") timer.unref();
    // 延迟首次巡检，避免和应用启动抢主线程
    setTimeout(() => {
      tick().catch(() => {});
    }, 20_000).unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, tick, dueProfiles };
}

function normalizeProfiles(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => defaultProfile(item || {}));
}

module.exports = { createFolderSyncScheduler, normalizeProfiles };
