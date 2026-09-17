const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_CONFIG = {
  provider: "openai",
  apiEndpoint: "",
  apiKey: "",
  model: "gpt-3.5-turbo",
  modelProfiles: [
    { name: "GPT-3.5 Turbo", model: "gpt-3.5-turbo" },
    { name: "GPT-4o Mini", model: "gpt-4o-mini" },
    { name: "GPT-4o", model: "gpt-4o" },
  ],
  promptSnippets: [],
  globalChatSystemPrompt: "",
  notesRootPath: null,
  globalChatHotkey: "Alt+Q",
  quickScreenshotHotkey: "Ctrl+Shift+S",
  regionScreenshotHotkey: "Ctrl+Shift+R",
  proxyForceEnabled: false,
  proxyForceMode: "manual",
  proxyPacUrl: "",
  proxyServer: "",
  proxyPort: 8080,
  proxyBypass: "",
  proxyRefreshMinutes: 3,
  proxyPacUrlShanghai: "",
  proxyPacUrlBeijing: "",
  updateManifestUrl: "",
  updateGitHubRepo: "TristonLeiCheng/DanceMonkey",
  updateAssetKeyword: "win-x64",
  quickLinks: [],
  quickLinksSeeded: false,
  folderSyncProfiles: [],
};

function createLegacyConfig(appDataPath) {
  const directory = path.join(appDataPath, "DanceMonkey");
  const file = path.join(directory, "config.json");
  const olderFile = path.join(appDataPath, "DesktopAssistant", "config.json");

  function ensureConfig() {
    fs.mkdirSync(directory, { recursive: true });
    if (!fs.existsSync(file) && fs.existsSync(olderFile)) {
      fs.copyFileSync(olderFile, file, fs.constants.COPYFILE_EXCL);
    }
  }

  function read() {
    ensureConfig();
    try {
      return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(file, "utf8")) };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  function write(partial) {
    const next = { ...read(), ...partial };
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(next, null, 2), "utf8");
    fs.renameSync(temporary, file);
    return next;
  }

  function notesRoot(documentsPath) {
    const configured = String(read().notesRootPath || "").trim();
    return configured || path.join(documentsPath, "NoteVault");
  }

  return { file, read, write, notesRoot };
}

module.exports = { createLegacyConfig };
