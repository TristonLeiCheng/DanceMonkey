const petModel = require("./pet-model");
const {
  migrateConfig,
  normalizeNetworkMode,
  normalizeManualProxy,
} = require("./config-migration");
const SETTINGS_KEYS = [
  ...Object.keys(petModel.DEFAULTS),
  "globalChatHotkey",
  "quickScreenshotHotkey",
  "regionScreenshotHotkey",
  "proxyForceEnabled",
  "aiNetworkMode",
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
  ...petModel.DEFAULTS,
  globalChatHotkey: "Alt+Q",
  quickScreenshotHotkey: "Ctrl+Shift+S",
  regionScreenshotHotkey: "Ctrl+Shift+R",
  proxyForceEnabled: false,
  aiNetworkMode: "system",
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
  config = migrateConfig(config);
  const next = { ...DEFAULT_SETTINGS };
  for (const key of SETTINGS_KEYS) {
    if (config[key] !== undefined && config[key] !== null)
      next[key] = config[key];
  }
  next.proxyForceEnabled =
    next.proxyForceEnabled === true || next.proxyForceEnabled === "true";
  next.aiNetworkMode = normalizeNetworkMode(next.aiNetworkMode);
  next.proxyForceMode =
    String(next.proxyForceMode || "manual").toLowerCase() === "pac"
      ? "pac"
      : "manual";
  next.proxyPort = Number.isFinite(Number(next.proxyPort))
    ? Number(next.proxyPort)
    : 8080;
  next.proxyRefreshMinutes = Number(next.proxyRefreshMinutes) || 3;
  next.updateManifestUrl = String(next.updateManifestUrl || "").trim();
  next.updateGitHubRepo =
    String(next.updateGitHubRepo || "").trim() || "TristonLeiCheng/DanceMonkey";
  next.updateAssetKeyword =
    String(next.updateAssetKeyword || "").trim() || "win-x64";
  Object.assign(next, petModel.normalizeSettings(config));
  return next;
}

function parseHotkey(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const parts = raw
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1).map((part) => part.toLowerCase());
  const hasMod = mods.some((mod) =>
    [
      "ctrl",
      "control",
      "alt",
      "shift",
      "win",
      "meta",
      "cmd",
      "command",
    ].includes(mod),
  );
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
  const values = hotkeys.map(([key]) =>
    String(next[key]).toLowerCase().replace(/\s+/g, ""),
  );
  if (new Set(values).size !== values.length) {
    throw new Error("三个快捷键不能重复。");
  }
  if (next.proxyForceEnabled) {
    if (next.proxyForceMode === "pac") {
      try {
        const url = new URL(String(next.proxyPacUrl || "").trim());
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password
        )
          throw Error("invalid");
        next.proxyPacUrl = url.href;
      } catch {
        throw new Error("请填写有效的 HTTP/HTTPS PAC 地址，不包含账号或密码。");
      }
    } else {
      const parsed = normalizeManualProxy(next.proxyServer, next.proxyPort);
      next.proxyServer = parsed.server;
      next.proxyPort = parsed.port;
    }
  }
  next.proxyRefreshMinutes = Math.min(
    60,
    Math.max(1, Math.round(Number(next.proxyRefreshMinutes) || 3)),
  );
  return next;
}

function createAppSettings(
  configStore,
  { proxyEnforcement, onHotkeysChanged, onPetChanged } = {},
) {
  function get() {
    return pickSettings(configStore.read());
  }

  async function save(input) {
    const validated = validateSettings({ ...get(), ...input });
    const saved = configStore.write(validated);
    const settings = pickSettings(saved);
    if (proxyEnforcement) {
      const result = await proxyEnforcement.startOrUpdate(settings);
      if (result?.notice) settings.proxyNotice = result.notice;
    }
    onPetChanged?.(settings);
    if (typeof onHotkeysChanged === "function") {
      onHotkeysChanged(settings);
    }
    return settings;
  }

  async function applyProxyNow() {
    const settings = get();
    if (!settings.proxyForceEnabled) {
      throw new Error("请先启用系统代理自动维护并保存。");
    }
    await proxyEnforcement.applyNow(settings);
    return { success: true };
  }

  return {
    get,
    save,
    applyProxyNow,
    pickSettings,
    toAccelerator,
    validateSettings,
  };
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
