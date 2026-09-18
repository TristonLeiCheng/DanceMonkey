function createPlatformAdapter() {
  if (process.platform === "win32") return require("./windows");
  if (process.platform === "darwin") return require("./macos");
  throw new Error(`Unsupported platform: ${process.platform}`);
}

module.exports = { createPlatformAdapter };
