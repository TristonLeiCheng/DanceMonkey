const path = require("node:path");

const packagerConfig = {
  asar: true,
  // Keep development fixtures and design previews out of distributed applications.
  ignore: [/^\/(test|docs)(?:\/|$)/],
  afterCopy: [(buildPath, electronVersion, platform, arch, done) => {
    try { require('./electron/pet-package').writePetCatalog(buildPath); done(); }
    catch (error) { done(error); }
  }],
  executableName: "DanceMonkey",
  appBundleId: "com.dancemonkey.desktop",
  extendInfo: {
    CFBundleDocumentTypes: [{ CFBundleTypeName: "Markdown document", CFBundleTypeRole: "Editor", LSHandlerRank: "Owner", CFBundleTypeExtensions: ["md"], LSItemContentTypes: ["public.markdown", "net.daringfireball.markdown"] }],
    UTImportedTypeDeclarations: [{ UTTypeIdentifier: "net.daringfireball.markdown", UTTypeDescription: "Markdown document", UTTypeConformsTo: ["public.plain-text"], UTTypeTagSpecification: { "public.filename-extension": ["md"], "public.mime-type": "text/markdown" } }],
    NSAppleEventsUsageDescription: "开启宠物交互模式后读取 Finder 桌面图标的位置，用于靠近、跳跃和携带图标动画。",
    NSDesktopFolderUsageDescription: "在宠物交互模式中按 E 抱起图标时，获取所选桌面项目的系统图标用于携带动画。",
  },
  // Packager resolves the matching .ico/.icns for the target platform,
  // including when building the Windows package on macOS.
  icon: path.join(__dirname, "assets", "logo"),
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

module.exports = {
  hooks: { generateAssets: async () => {
    await require("esbuild").build({ entryPoints: [path.join(__dirname, "src/note-document.mjs")],
      bundle: true, format: "iife", target: "chrome120", minify: true,
      outfile: path.join(__dirname, "src/note-document.bundle.js") });
  } },
  packagerConfig,
  makers: [
    { name: "@electron-forge/maker-zip", platforms: ["win32", "darwin"] },
  ],
};
