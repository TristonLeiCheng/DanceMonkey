const { session } = require("electron");
const { BlockList, isIP } = require("node:net");
const tls = require("node:tls");
const { networkRoute, normalizeApplicationProxy } = require("./config-migration");
const {
  Agent,
  ProxyAgent,
  Socks5ProxyAgent,
  buildConnector,
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
function bypassesProxy(url, rules = "") {
  const host = new URL(String(url)).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return String(rules).split(/[;,\s]+/).filter(Boolean).some(rule => {
    rule = rule.toLowerCase();
    if (rule === "<local>") return !host.includes(".") && !host.includes(":");
    if (rule.includes("/")) {
      const [rawAddress, bits] = rule.split("/"), address = rawAddress.replace(/^\[|\]$/g, ""), family = isIP(host);
      if (!family || family !== isIP(address)) return false;
      const block = new BlockList();
      block.addSubnet(address, Number(bits), family === 4 ? "ipv4" : "ipv6");
      return block.check(host, family === 4 ? "ipv4" : "ipv6");
    }
    rule = rule.replace(/^\[|\]$/g, "");
    const pattern = rule.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
    return new RegExp(`^${pattern}$`, "i").test(host);
  });
}
function platformTrust() {
  // Respect trusted corporate roots installed in macOS Keychain / Windows
  // Certificate Store while retaining the runtime's standard roots and verification.
  try { return { ca: [...new Set([...tls.getCACertificates('default'), ...tls.getCACertificates('system')])] }; }
  catch { return {}; }
}
function createAgent(proxy) {
  const trust = platformTrust();
  if (proxy.kind === 'direct') return new Agent({ connect: { ...trust, timeout: 8000 } });
  if (proxy.kind === 'socks') {
    const connector = buildConnector({ timeout: 8000 });
    return new Socks5ProxyAgent(proxy.url, { requestTls: trust,
      connect: (options, callback) => connector({ ...options, hostname: options.hostname.replace(/^\[|\]$/g, '') }, callback) });
  }
  return new ProxyAgent({ uri: proxy.url, connectTimeout: 8000, proxyTls: trust, requestTls: trust });
}
function createProxyTransport({
  getSession = () => session.defaultSession,
  getConfig = () => ({}),
  resolverTimeoutMs = 8000,
  fetch = undiciFetch,
  agentFactory = createAgent,
} = {}) {
  const agents = new Map();
  async function resolveRoutes(url, selection, signal) {
    signal?.throwIfAborted();
    const route = typeof selection === "string" ? { mode: selection } : selection || networkRoute(getConfig());
    const mode = route.mode;
    if (mode === "direct") return [{ kind: "direct" }];
    if (mode === "manual") {
      const manual = normalizeApplicationProxy(route);
      if (bypassesProxy(url, manual.manualProxyBypass)) return [{ kind: "direct" }];
      const host = manual.manualProxyHost.includes(":") ? `[${manual.manualProxyHost}]` : manual.manualProxyHost;
      return [{ kind: manual.manualProxyProtocol === "socks5" ? "socks" : "http", url: `${manual.manualProxyProtocol}://${host}:${manual.manualProxyPort}` }];
    }
    if (mode !== "system") throw Error("未知网络连接方式，请重新保存网络设置。");
    try {
      const resolution = getSession().resolveProxy(String(url));
      const raw = await new Promise((resolve, reject) => {
        const finish = (fn, value) => { clearTimeout(timeout); signal?.removeEventListener("abort", abort); fn(value); };
        const abort = () => finish(reject, signal.reason);
        const timeout = setTimeout(() => finish(reject, Object.assign(new Error("PAC resolution timed out"), { code: "DM_PROXY_RESOLVE" })), resolverTimeoutMs);
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
        Promise.resolve(resolution).then(value => finish(resolve, value), error => finish(reject, error));
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
  async function request(url, options = {}, selection) {
    const route = typeof selection === "string" ? { mode: selection } : selection || networkRoute(getConfig());
    const mode = route.mode;
    const routes = await resolveRoutes(url, route, options.signal),
      attempts = [];
    for (let i = 0; i < routes.length; i++) {
      const proxy = routes[i];
      attempts.push(routeLabel(proxy));
      try {
        // A dedicated Agent enforces direct mode even if a global/environment dispatcher exists.
        let agent = dispatcher(proxy);
        if (mode === "manual" && route.manualProxyBypass) {
          // Fetch reuses its dispatcher across redirects: re-evaluate host exclusions
          // for each origin so a local bypass cannot make an external redirect direct.
          const manual = normalizeApplicationProxy(route), withoutBypass = { ...manual, manualProxyBypass: "" };
          const host = withoutBypass.manualProxyHost.includes(":") ? `[${withoutBypass.manualProxyHost}]` : withoutBypass.manualProxyHost;
          const fixed = { kind: manual.manualProxyProtocol === "socks5" ? "socks" : "http", url: `${manual.manualProxyProtocol}://${host}:${manual.manualProxyPort}` };
          agent = { dispatch(request, handler) {
            try { return dispatcher(bypassesProxy(request.origin, manual.manualProxyBypass) ? { kind: "direct" } : fixed).dispatch(request, handler); }
            catch (error) { handler.onError(error); return false; }
          } };
        }
        return await fetch(url, { ...options, dispatcher: agent });
      } catch (error) {
        if (options.signal?.aborted || error?.name === "AbortError")
          throw error;
        // Retry only failures before the request reached the origin, with replayable bodies.
        // Never replay HTTP responses, partially transmitted requests, streams or TLS/auth failures.
        if (
          i + 1 < routes.length &&
          mode === "system" && proxy.kind !== "direct" &&
          replayable(options.body) &&
          isConnectFailure(error)
        )
          continue;
        const hint = mode === "direct" ? "当前使用直连；如网络需要代理，请切换为“公司 / 系统默认”。"
          : mode === "manual" ? "请检查手动代理的协议、IP 和端口；未尝试其他连接方式。"
          : "请检查公司系统代理或 PAC；也可选择直连或手动代理后重试。";
        throw Object.assign(
          new Error(`网络连接失败（${attempts.join(" → ")}）。${hint}`),
          { code: "DM_NETWORK_CONNECTION" },
        );
      }
    }
  }
  function close() {
    const old = [...agents.values()];
    agents.clear();
    for (const agent of old) Promise.resolve(agent.close?.()).catch(() => {});
  }
  async function refresh() {
    close();
    try {
      await getSession().forceReloadProxyConfig?.();
    } catch {
      throw Object.assign(
        new Error("无法刷新系统代理 / PAC，请检查系统代理设置。"),
        { code: "DM_PROXY_RESOLVE" },
      );
    }
  }
  return { fetch: request, resolveRoutes, refresh, close };
}
let getApplicationConfig = () => ({});
const transport = createProxyTransport({ getConfig: () => getApplicationConfig() });
module.exports = {
  parseProxyDirective,
  createProxyTransport,
  bypassesProxy,
  configureApplicationProxy: reader => { getApplicationConfig = reader; },
  fetchWithSystemProxy: transport.fetch,
  refreshSystemProxy: transport.refresh,
  resolveSystemProxy: async (url) => (await transport.resolveRoutes(url))[0],
};
