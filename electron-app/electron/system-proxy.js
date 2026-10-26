const { session } = require("electron");
const {
  Agent,
  ProxyAgent,
  Socks5ProxyAgent,
  fetch: undiciFetch,
} = require("undici");

function parseProxyDirective(directive) {
  const part = String(directive || "").trim();
  if (/^DIRECT$/i.test(part)) return { kind: "direct" };
  const match = /^(PROXY|HTTP|HTTPS|SOCKS5?|SOCKS4A?)\s+(\S+)$/i.exec(part);
  if (!match) return null;
  const type = match[1].toUpperCase(),
    host = match[2];
  const socks = type.startsWith("SOCKS");
  return {
    kind: socks && type !== "SOCKS5" ? "unsupported" : socks ? "socks" : "http",
    url: host.includes("://")
      ? host
      : `${socks ? (type === "SOCKS5" ? "socks5" : "socks4") : type === "HTTPS" ? "https" : "http"}://${host}`,
  };
}
function routeLabel(proxy) {
  if (proxy.kind === "direct") return "直连";
  try {
    const url = new URL(proxy.url);
    return `代理 ${url.protocol}//${url.host}`;
  } catch {
    return "代理（地址格式无效）";
  }
}
const CONNECT_ERRORS = new Set([
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "EPROTONOSUPPORT",
]);
function isConnectFailure(error) {
  for (let e = error, depth = 0; e && depth < 5; e = e.cause, depth++)
    if (CONNECT_ERRORS.has(e.code)) return true;
  return false;
}
function replayable(body) {
  return (
    body == null ||
    typeof body === "string" ||
    Buffer.isBuffer(body) ||
    body instanceof Uint8Array ||
    body instanceof ArrayBuffer
  );
}
function createProxyTransport({
  getSession = () => session.defaultSession,
  fetch = undiciFetch,
  agentFactory = (proxy) =>
    proxy.kind === "direct"
      ? new Agent({ connect: { timeout: 8000 } })
      : proxy.kind === "socks"
        ? new Socks5ProxyAgent(proxy.url)
        : new ProxyAgent({ uri: proxy.url, connectTimeout: 8000 }),
} = {}) {
  const agents = new Map();
  async function resolveRoutes(url, mode = "system", signal) {
    signal?.throwIfAborted();
    if (mode === "direct") return [{ kind: "direct" }];
    try {
      const resolution = getSession().resolveProxy(String(url));
      const raw = await new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
        Promise.resolve(resolution)
          .then(resolve, reject)
          .finally(() => signal?.removeEventListener("abort", abort));
      });
      const routes = String(raw || "")
        .split(";")
        .map(parseProxyDirective)
        .filter(Boolean);
      if (routes.length) return routes;
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") throw error;
      /* Do not silently substitute environment proxies or bypass system policy. */
    }
    throw Object.assign(
      new Error(
        "无法读取系统代理 / PAC。请刷新系统代理设置，或将 AI 连接方式切换为“直连”后重试。",
      ),
      { code: "DM_PROXY_RESOLVE" },
    );
  }
  function dispatcher(proxy) {
    if (proxy.kind === "unsupported")
      throw Object.assign(new Error("Unsupported proxy protocol"), {
        code: "EPROTONOSUPPORT",
      });
    const key = `${proxy.kind}|${proxy.url || ""}`;
    if (!agents.has(key)) {
      if (agents.size >= 16) {
        const [first, old] = agents.entries().next().value;
        agents.delete(first);
        Promise.resolve(old.close?.()).catch(() => {});
      }
      agents.set(key, agentFactory(proxy));
    }
    return agents.get(key);
  }
  async function request(url, options = {}, mode = "system") {
    const routes = await resolveRoutes(url, mode, options.signal),
      attempts = [];
    for (let i = 0; i < routes.length; i++) {
      const proxy = routes[i];
      attempts.push(routeLabel(proxy));
      try {
        // A dedicated Agent enforces direct mode even if a global/environment dispatcher exists.
        return await fetch(url, { ...options, dispatcher: dispatcher(proxy) });
      } catch (error) {
        if (options.signal?.aborted || error?.name === "AbortError")
          throw error;
        // Retry only failures before the request reached the origin, with replayable bodies.
        // Never replay HTTP responses, partially transmitted requests, streams or TLS/auth failures.
        if (
          i + 1 < routes.length &&
          proxy.kind !== "direct" &&
          replayable(options.body) &&
          isConnectFailure(error)
        )
          continue;
        const hint =
          mode === "direct"
            ? "当前 AI 使用直连；如网络需要代理，请切换为“跟随系统”。"
            : "请检查系统代理或 PAC；AI 可切换为“直连”后重试。";
        throw Object.assign(
          new Error(`网络连接失败（${attempts.join(" → ")}）。${hint}`),
          { code: "DM_NETWORK_CONNECTION" },
        );
      }
    }
  }
  async function refresh() {
    const old = [...agents.values()];
    agents.clear();
    for (const agent of old) Promise.resolve(agent.close?.()).catch(() => {});
    try {
      await getSession().forceReloadProxyConfig?.();
    } catch {
      throw Object.assign(
        new Error("无法刷新系统代理 / PAC，请检查系统代理设置。"),
        { code: "DM_PROXY_RESOLVE" },
      );
    }
  }
  return { fetch: request, resolveRoutes, refresh };
}
const transport = createProxyTransport();
module.exports = {
  parseProxyDirective,
  createProxyTransport,
  fetchWithSystemProxy: transport.fetch,
  refreshSystemProxy: transport.refresh,
  resolveSystemProxy: async (url) => (await transport.resolveRoutes(url))[0],
};
