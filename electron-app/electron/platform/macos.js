function createProxyEnforcement() {
  return {
    async startOrUpdate() {
      return { enabled: false };
    },
    applyNow() {
      throw new Error("macOS 暂不支持强制写入系统代理；请在系统设置中配置代理。");
    },
    stop() {},
  };
}

function createAppUpdateService({ getInstallDirectory, getCurrentVersion }) {
  return {
    getInstallDirectory,
    getCurrentVersion,
    checkAndPrepare() {
      throw new Error("macOS 版本暂不支持应用内更新，请下载安装新版 DMG。");
    },
    launchUpdaterAndRestart() {
      throw new Error("macOS 版本暂不支持应用内更新，请下载安装新版 DMG。");
    },
  };
}

module.exports = {
  createProxyEnforcement,
  createAppUpdateService,
  supportsSystemProxyWrite: false,
  supportsInAppUpdate: false,
};
