const { createProxyEnforcement } = require("../proxy-enforcement");
const { createAppUpdateService } = require("../app-update");

module.exports = {
  createProxyEnforcement,
  createAppUpdateService,
  supportsSystemProxyWrite: true,
  supportsInAppUpdate: true,
};
