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

const { createMacAppUpdateService: createAppUpdateService } = require("../mac-app-update");

module.exports = {
  createProxyEnforcement,
  createAppUpdateService,
  supportsSystemProxyWrite: false,
  supportsInAppUpdate: true,
};
