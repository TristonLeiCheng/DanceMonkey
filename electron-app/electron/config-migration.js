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
  value === "system" ? "system" : "direct";
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
module.exports = { migrateConfig, normalizeNetworkMode, normalizeManualProxy };
