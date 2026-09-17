const SETTINGS_KEYS = [
  "globalChatHotkey",
  "quickScreenshotHotkey",
  "regionScreenshotHotkey",
  "proxyForceEnabled",
  "proxyForceMode",
  "proxyPacUrl",
  "proxyServer",
  "proxyPort",
  "proxyBypass",
  "proxyRefreshMinutes",
  "proxyPacUrlShanghai",
  "proxyPacUrlBeijing",
  "updateManifestUrl",
  "updateGitHubRepo",
  "updateAssetKeyword",
];

const DEFAULT_SETTINGS = {
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
};

function pickSettings(config = {}) {
  const next = { ...DEFAULT_SETTINGS };
  for (const key of SETTINGS_KEYS) {
    if (config[key] !== undefined && config[key] !== null) next[key] = config[key];
  }
  // 兼容旧版 PascalCase
  if (config.GlobalChatHotkey) next.globalChatHotkey = config.GlobalChatHotkey;
  if (config.QuickScreenshotHotkey) next.quickScreenshotHotkey = config.QuickScreenshotHotkey;
  if (config.RegionScreenshotHotkey) next.regionScreenshotHotkey = config.RegionScreenshotHotkey;
  if (config.ProxyForceEnabled != null) next.proxyForceEnabled = config.ProxyForceEnabled;
  if (config.ProxyForceMode) next.proxyForceMode = config.ProxyForceMode;
  if (config.ProxyPacUrl != null) next.proxyPacUrl = config.ProxyPacUrl;
  if (config.ProxyServer != null) next.proxyServer = config.ProxyServer;
  if (config.ProxyPort != null) next.proxyPort = config.ProxyPort;
  if (config.ProxyBypass != null) next.proxyBypass = config.ProxyBypass;
  if (config.ProxyRefreshMinutes != null) next.proxyRefreshMinutes = config.ProxyRefreshMinutes;
  if (config.ProxyPacUrlShanghai != null) next.proxyPacUrlShanghai = config.ProxyPacUrlShanghai;
  if (config.ProxyPacUrlBeijing != null) next.proxyPacUrlBeijing = config.ProxyPacUrlBeijing;
  if (config.UpdateManifestUrl != null) next.updateManifestUrl = config.UpdateManifestUrl;
  if (config.UpdateGitHubRepo != null) next.updateGitHubRepo = config.UpdateGitHubRepo;
  if (config.UpdateAssetKeyword != null) next.updateAssetKeyword = config.UpdateAssetKeyword;

  next.proxyForceEnabled = Boolean(next.proxyForceEnabled);
  next.proxyForceMode = String(next.proxyForceMode || "manual").toLowerCase() === "pac" ? "pac" : "manual";
  next.proxyPort = Number(next.proxyPort) || 8080;
  next.proxyRefreshMinutes = Number(next.proxyRefreshMinutes) || 3;
  next.updateManifestUrl = String(next.updateManifestUrl || "").trim();
  next.updateGitHubRepo =
    String(next.updateGitHubRepo || "").trim() || "TristonLeiCheng/DanceMonkey";
  next.updateAssetKeyword = String(next.updateAssetKeyword || "").trim() || "win-x64";
  return next;
}

function parseHotkey(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const parts = raw.split("+").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1).map((part) => part.toLowerCase());
  const hasMod = mods.some((mod) => ["ctrl", "control", "alt", "shift", "win", "meta", "cmd", "command"].includes(mod));
  if (!hasMod || !key) return null;
  return raw.replace(/\s+/g, "");
}

function toAccelerator(value, fallback) {
  const parsed = parseHotkey(value) || parseHotkey(fallback) || fallback;
  return String(parsed)
    .replace(/\bCtrl\b/gi, "CommandOrControl")
    .replace(/\bControl\b/gi, "CommandOrControl")
    .replace(/\bCmd\b/gi, "CommandOrControl")
    .replace(/\bCommand\b/gi, "CommandOrControl")
    .replace(/\bWin\b/gi, "Super")
    .replace(/\bMeta\b/gi, "Super")
    .replace(/\s+/g, "");
}

function validateSettings(input = {}) {
  const next = pickSettings(input);
  const hotkeys = [
    ["globalChatHotkey", "唤出面板快捷键"],
    ["quickScreenshotHotkey", "全屏截图快捷键"],
    ["regionScreenshotHotkey", "框选截图快捷键"],
  ];
  for (const [key, label] of hotkeys) {
    if (!parseHotkey(next[key])) {
      throw new Error(`${label}无效，请使用如 Ctrl+Shift+S 的组合键。`);
    }
  }
  const values = hotkeys.map(([key]) => String(next[key]).toLowerCase().replace(/\s+/g, ""));
  if (new Set(values).size !== values.length) {
    throw new Error("三个快捷键不能重复。");
  }
  if (next.proxyForceEnabled) {
    if (next.proxyForceMode === "pac") {
      if (!/^https?:\/\//i.test(String(next.proxyPacUrl || "").trim())) {
        throw new Error("启用强制代理（PAC）时，请填写有效的 PAC 地址。");
      }
    } else if (!String(next.proxyServer || "").trim()) {
      throw new Error("启用强制代理（手动）时，请填写代理地址。");
    }
    const port = Number(next.proxyPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("代理端口必须在 1-65535 之间。");
    }
  }
  next.proxyRefreshMinutes = Math.min(60, Math.max(1, Math.round(Number(next.proxyRefreshMinutes) || 3)));
  return next;
}

function createAppSettings(configStore, { proxyEnforcement, onHotkeysChanged } = {}) {
  function get() {
    return pickSettings(configStore.read());
  }

  async function save(input) {
    const validated = validateSettings(input);
    const saved = configStore.write(validated);
    const settings = pickSettings(saved);
    if (proxyEnforcement) {
      await proxyEnforcement.startOrUpdate(settings);
    }
    if (typeof onHotkeysChanged === "function") {
      onHotkeysChanged(settings);
    }
    return settings;
  }

  async function applyProxyNow() {
    const settings = get();
    if (!settings.proxyForceEnabled) {
      throw new Error("请先启用强制代理并保存。");
    }
    await proxyEnforcement.applyNow(settings);
    return { success: true };
  }

  return { get, save, applyProxyNow, pickSettings, toAccelerator, validateSettings };
}

module.exports = {
  SETTINGS_KEYS,
  DEFAULT_SETTINGS,
  pickSettings,
  parseHotkey,
  toAccelerator,
  validateSettings,
  createAppSettings,
};
