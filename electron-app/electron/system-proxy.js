const { session } = require("electron");
const { ProxyAgent, Socks5ProxyAgent, fetch: undiciFetch } = require("undici");

const agentCache = new Map();

function parseProxyDirective(directive) {
  const part = String(directive || "").trim();
  if (!part) return { kind: "direct" };
  if (/^DIRECT$/i.test(part)) return { kind: "direct" };

  const match = /^(PROXY|HTTP|HTTPS|SOCKS5?|SOCKS4A?)\s+(\S+)/i.exec(part);
  if (!match) return null;

  const type = match[1].toUpperCase();
  const host = match[2].replace(/^\[|\]$/g, "");

  if (type.startsWith("SOCKS")) {
    const scheme = type === "SOCKS4" || type === "SOCKS4A" ? "socks4" : "socks5";
    return {
      kind: "socks",
      url: host.includes("://") ? host : `${scheme}://${host}`,
    };
  }

  const scheme = type === "HTTPS" ? "https" : "http";
  return {
    kind: "http",
    url: host.includes("://") ? host : `${scheme}://${host}`,
  };
}

function envProxyFallback() {
  const value =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    "";
  return value.trim()
    ? { kind: "http", url: value.trim() }
    : { kind: "direct" };
}

/**
 * 使用 Chromium/Electron 解析当前系统代理（含 PAC、手动代理）。
 * 返回 { kind:'direct'|'http'|'socks', url? }
 */
async function resolveSystemProxy(targetUrl) {
  try {
    const raw = await session.defaultSession.resolveProxy(String(targetUrl));
    const parts = String(raw || "")
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean);

    for (const part of parts) {
      const parsed = parseProxyDirective(part);
      if (!parsed) continue;
      if (parsed.kind === "direct") return parsed;
      return parsed;
    }
  } catch {
    // app 未就绪或解析失败时回退到环境变量
  }
  return envProxyFallback();
}

function dispatcherFor(proxy) {
  if (!proxy || proxy.kind === "direct" || !proxy.url) return undefined;

  const key = `${proxy.kind}|${proxy.url}`;
  let agent = agentCache.get(key);
  if (agent) return agent;

  agent =
    proxy.kind === "socks"
      ? new Socks5ProxyAgent(proxy.url)
      : new ProxyAgent(proxy.url);
  agentCache.set(key, agent);
  return agent;
}

async function fetchWithSystemProxy(url, options = {}) {
  const proxy = await resolveSystemProxy(url);
  const dispatcher = dispatcherFor(proxy);
  const request = dispatcher ? { ...options, dispatcher } : { ...options };
  try {
    return await undiciFetch(url, request);
  } catch (error) {
    const hint =
      proxy?.kind && proxy.kind !== "direct"
        ? `（已尝试系统代理 ${proxy.url}）`
        : "（当前为直连，未走系统代理）";
    if (error && typeof error === "object") {
      error.message = `${error.message || "fetch failed"}${hint}`;
    }
    throw error;
  }
}

module.exports = {
  fetchWithSystemProxy,
  resolveSystemProxy,
  parseProxyDirective,
};
