const path = require("node:path");

const packagerConfig = {
  asar: true,
  executableName: "DanceMonkey",
  appBundleId: "com.dancemonkey.desktop",
  // Local builds use an ad-hoc signature so Electron's nested Helper bundles are valid.
  // Release builds use an installed Developer ID identity and optional notarization.
  ...(process.platform === "darwin"
    ? {
        osxSign: process.env.DM_MAC_SIGN === "1"
          ? { continueOnError: false }
          : {
              identity: "-",
              identityValidation: false,
              // osx-sign applies Hardened Runtime per file, not as a top-level option.
              optionsForFile: () => ({ hardenedRuntime: false }),
              preAutoEntitlements: false,
              timestamp: false,
              continueOnError: false,
            },
        osxNotarize: process.env.DM_MAC_SIGN === "1" && process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID
          ? {
              appleId: process.env.APPLE_ID,
              appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
              teamId: process.env.APPLE_TEAM_ID,
            }
          : undefined,
      }
    : {}),
};

if (process.platform === "win32") {
  packagerConfig.icon = path.join(__dirname, "assets", "logo.ico");
}

module.exports = {
  packagerConfig,
  makers: [
    { name: "@electron-forge/maker-zip", platforms: ["win32", "darwin"] },
  ],
};
