// Normalize persisted keys before defaults are merged, so explicit false/empty values win.
const ALIASES = Object.fromEntries(
  [
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
    "aiNetworkMode",
    "networkProxyMode", "manualProxyProtocol", "manualProxyHost", "manualProxyPort", "manualProxyBypass",
  ].map((key) => [key[0].toUpperCase() + key.slice(1), key]),
);
function migrateConfig(config = {}) {
  const next = { ...config };
  for (const [old, key] of Object.entries(ALIASES)) {
    if (next[key] == null && next[old] != null) next[key] = next[old];
    delete next[old];
  }
  return next;
}
const normalizeNetworkMode = (value) =>
  ["system", "manual", "inherit"].includes(value) ? value : "direct";
function normalizeApplicationProxy(config = {}) {
  let protocol = String(config.manualProxyProtocol || "http").toLowerCase();
  let host = String(config.manualProxyHost || "").trim(), port = Number(config.manualProxyPort ?? 8080);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) {
    let url;
    try { url = new URL(host); } catch { throw Error("手动代理地址格式无效。"); }
    if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== "/"))
      throw Error("代理地址只需 IP 或主机与端口，不包含账号、密码或路径。");
    protocol = url.protocol.slice(0, -1);
    host = url.hostname;
    port = Number(url.port || (protocol === "https" ? 443 : protocol === "socks5" ? 1080 : 80));
  } else {
    const pair = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(host);
    if (pair) { host = pair[1]; port = Number(pair[2]); }
  }
  if (!["http", "https", "socks5"].includes(protocol)) throw Error("代理协议请选择 HTTP、HTTPS 或 SOCKS5。");
  const normalized = normalizeManualProxy(host, port);
  host = normalized.server.replace(/^\[|\]$/g, ""); port = normalized.port;
  const bypass = String(config.manualProxyBypass || "").trim();
  for (const rule of bypass.split(/[;,\s]+/).filter(Boolean)) {
    if (rule === "<local>") continue;
    const [address, bits, extra] = rule.split("/");
    if (bits !== undefined) {
      const family = require("node:net").isIP(address.replace(/^\[|\]$/g, ""));
      if (extra !== undefined || !family || !/^\d+$/.test(bits) || Number(bits) > (family === 4 ? 32 : 128))
        throw Error("直连例外中的 IP 网段无效，请使用如 10.0.0.0/8 的格式。");
    } else if (!/^[\w.*:[\]-]+$/.test(rule)) throw Error("直连例外仅支持主机、IP、通配符、IP 网段或 <local>。");
  }
  return { manualProxyProtocol: protocol, manualProxyHost: host, manualProxyPort: port, manualProxyBypass: bypass };
}
function networkRoute(config = {}, scope = "app") {
  config = migrateConfig(config);
  const appMode = ["direct", "manual"].includes(config.networkProxyMode) ? config.networkProxyMode : "system";
  const aiMode = normalizeNetworkMode(config.aiNetworkMode);
  const mode = scope === "ai" && aiMode !== "inherit" ? aiMode : appMode;
  return { mode, ...Object.fromEntries(["manualProxyProtocol", "manualProxyHost", "manualProxyPort", "manualProxyBypass"].map(key => [key, config[key]])) };
}
function normalizeManualProxy(server, port) {
  let host = String(server || "").trim(),
    number = Number(port);
  if (/^http:\/\//i.test(host)) {
    const url = new URL(host);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw Error("代理地址只需主机与端口，不包含账号、密码或路径。");
    host = url.hostname;
    number = Number(url.port || 80);
  } else {
    const pair = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(host);
    if (pair) {
      host = pair[1];
      number = Number(pair[2]);
    }
  }
  if (
    !host ||
    /[\s/@;\\?#\x00-\x1f]/.test(host) ||
    host.includes("://") ||
    !Number.isInteger(number) ||
    number < 1 ||
    number > 65535
  )
    throw Error("请填写有效的代理主机和1–65535之间的端口。");
  const bracketed =
    host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  try {
    new URL(`http://${bracketed}:${number}`);
  } catch {
    throw Error("代理主机格式无效。");
  }
  return { server: host, port: number };
}
module.exports = { migrateConfig, normalizeNetworkMode, normalizeManualProxy, normalizeApplicationProxy, networkRoute };
