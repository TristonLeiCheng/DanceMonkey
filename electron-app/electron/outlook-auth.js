const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { randomUUID } = require("node:crypto");

const CONFIG_FILE = "outlook-auth.json";
const CREDENTIALS_FILE = "outlook-auth.credentials";
const SCOPES = ["https://graph.microsoft.com/Mail.Read"];
const REQUEST_TIMEOUT_MS = 30000;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RELOGIN_CODES = new Set([
  "interaction_required", "login_required", "consent_required", "invalid_grant",
  "no_tokens_found", "no_account_in_silent_request", "token_refresh_required",
]);

function error(message, code) {
  return Object.assign(new Error(message), { code });
}

function configured(config) {
  return GUID.test(config.clientId) && GUID.test(config.tenantId);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function writeAtomic(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, contents);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
  }
}

function microsoftUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw error("微软登录地址无效。", "OUTLOOK_AUTH_URL"); }
  if (url.protocol !== "https:" || url.hostname !== "login.microsoftonline.com" ||
      url.username || url.password || url.port) {
    throw error("微软登录地址不受支持。", "OUTLOOK_AUTH_URL");
  }
  return url;
}

// MSAL's network interface keeps OAuth in the official SDK while using Electron's
// existing system-proxy-aware fetch. Never follow redirects with an OAuth body.
function networkClient(fetch) {
  async function request(method, value, options = {}) {
    const url = microsoftUrl(value);
    try {
      const response = await fetch(url.href, {
        method,
        headers: options.headers || {},
        ...(method === "POST" ? { body: options.body } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const headers = {};
      if (response.headers?.forEach) response.headers.forEach((value, key) => { headers[key] = value; });
      return { status: response.status, headers, body: await response.json() };
    } catch {
      throw error("无法连接微软登录服务，请检查网络或系统代理后重试。", "OUTLOOK_AUTH_NETWORK");
    }
  }
  return {
    sendGetRequestAsync: (url, options) => request("GET", url, options),
    sendPostRequestAsync: (url, options) => request("POST", url, options),
  };
}

function accountSelector(account) {
  return {
    homeAccountId: String(account?.homeAccountId || ""),
    environment: String(account?.environment || "").toLowerCase(),
    tenantId: String(account?.tenantId || "").toLowerCase(),
  };
}

function sameAccount(account, selector) {
  const value = accountSelector(account);
  return Boolean(value.homeAccountId) && value.homeAccountId === selector.homeAccountId &&
    value.environment === selector.environment && value.tenantId === selector.tenantId;
}

function publicAccount(account) {
  return { id: `${account.tenantId}:${account.homeAccountId}`, username: account.username || "", name: account.name || "" };
}

function sanitizeAuthError(cause) {
  if (String(cause?.code || "").startsWith("OUTLOOK_AUTH_")) return cause;
  const code = String(cause?.errorCode || "");
  if (RELOGIN_CODES.has(code) || cause?.name === "InteractionRequiredAuthError") {
    return error("Outlook 登录已过期或需要公司重新授权，请重新连接 Outlook。", "OUTLOOK_AUTH_REQUIRED");
  }
  if (code === "access_denied" || code === "user_cancelled") {
    return error("已取消 Outlook 登录；如公司要求管理员批准，请联系 IT 后重新连接。", "OUTLOOK_AUTH_CANCELLED");
  }
  if (["unauthorized_client", "invalid_client", "invalid_resource", "invalid_scope"].includes(code)) {
    return error("微软应用配置或邮件读取权限有误，请检查应用 ID、租户 ID 和委托权限 Mail.Read。", "OUTLOOK_AUTH_CONFIG");
  }
  // SDK/network errors can include OAuth bodies and proxy credentials. Only our
  // curated messages cross IPC; do not append cause.message or raw diagnostics.
  return error("Outlook 连接失败，请检查微软应用配置、公司授权和网络后重试。", "OUTLOOK_AUTH_FAILED");
}

/**
 * MSAL Node 7 owns the PKCE loopback server and exposes no abort API. To close a
 * cancelled listener, deliver an OAuth denial only to the exact random loopback
 * port from the SDK-generated authorization URL. No auth code/token is sent.
 * Using node:http here deliberately bypasses system proxies for this local hop.
 */
function closeLoginListener(attempt) {
  if (!attempt.callbackPort || attempt.closing) return;
  attempt.closing = true;
  const body = new URLSearchParams({ error: "access_denied", state: attempt.state || "" }).toString();
  const request = http.request({
    hostname: "127.0.0.1", port: attempt.callbackPort, method: "POST", path: "/",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) },
  }, (response) => response.resume());
  request.on("error", () => {});
  request.setTimeout(2000, () => request.destroy());
  request.end(body);
}

function createOutlookAuth({ directory, safeStorage, openExternal,
  fetch = (...args) => globalThis.fetch(...args),
  msalFactory = (configuration) => new (require("@azure/msal-node").PublicClientApplication)(configuration),
} = {}) {
  if (!directory || typeof directory !== "string") throw new Error("必须提供 Outlook 配置目录。");
  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== "function") throw new Error("必须提供 safeStorage。");
  const configFile = path.join(directory, CONFIG_FILE);
  const credentialsFile = path.join(directory, CREDENTIALS_FILE);
  const storedConfig = readJson(configFile);
  let config = {
    clientId: String(storedConfig?.clientId || "").trim().toLowerCase(),
    tenantId: String(storedConfig?.tenantId || "").trim().toLowerCase(),
  };
  let generation = 0;
  let identity = null;
  let hydrated = false;
  let hydration = null;
  let pending = null;

  function secureStorageAvailable() {
    try {
      return safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== "basic_text";
    } catch { return false; }
  }

  function requireSecureStorage() {
    if (!secureStorageAvailable()) throw error("系统安全存储不可用，无法连接 Outlook；不会以明文保存凭据。", "OUTLOOK_AUTH_STORAGE");
  }

  function requireConfig() {
    if (!configured(config)) throw error("请先填写微软应用 ID 和公司租户 ID。", "OUTLOOK_AUTH_CONFIG");
  }

  function makeClient(settings, serializedCache) {
    const client = msalFactory({
      auth: { clientId: settings.clientId, authority: `https://login.microsoftonline.com/${settings.tenantId}` },
      system: {
        networkClient: networkClient(fetch),
        loggerOptions: { piiLoggingEnabled: false, loggerCallback: () => {} },
      },
    });
    if (serializedCache) client.getTokenCache().deserialize(serializedCache);
    return client;
  }

  function clearCredentials() {
    try { fs.rmSync(credentialsFile, { force: true }); }
    catch { throw error("无法清除本机 Outlook 登录凭据，请检查应用数据目录权限。", "OUTLOOK_AUTH_STORAGE"); }
  }

  function invalidate() {
    generation += 1;
    identity = null;
    hydration = null;
    hydrated = true;
    if (pending) {
      pending.cancelled = error("Outlook 登录状态已变化，请重新连接。", "OUTLOOK_AUTH_CHANGED");
      closeLoginListener(pending);
    }
  }

  function persist(client, account, settings) {
    requireSecureStorage();
    try {
      const plaintext = JSON.stringify({
        version: 1, clientId: settings.clientId, tenantId: settings.tenantId,
        selector: accountSelector(account), cache: client.getTokenCache().serialize(),
      });
      writeAtomic(credentialsFile, safeStorage.encryptString(plaintext));
    } catch (cause) {
      throw sanitizeStorageError(cause);
    }
  }

  function sanitizeStorageError(cause) {
    if (cause?.code === "OUTLOOK_AUTH_STORAGE") return cause;
    return error("无法安全保存 Outlook 登录凭据，请检查系统钥匙串和应用数据目录。", "OUTLOOK_AUTH_STORAGE");
  }

  async function ensureIdentity() {
    if (hydrated || !configured(config) || !secureStorageAvailable()) return;
    if (hydration) return hydration;
    const initialGeneration = generation;
    const operation = (async () => {
      try {
        const data = JSON.parse(safeStorage.decryptString(fs.readFileSync(credentialsFile)));
        if (data?.version !== 1 || data.clientId !== config.clientId || data.tenantId !== config.tenantId ||
            typeof data.cache !== "string" || !data.selector) return;
        const client = makeClient(config, data.cache);
        const accounts = await client.getTokenCache().getAllAccounts();
        if (generation !== initialGeneration) return;
        const account = accounts.find((value) => sameAccount(value, data.selector) && accountSelector(value).tenantId === config.tenantId);
        if (account) identity = { client, account, settings: { ...config }, refresh: null };
      } catch {
        // A missing/corrupt keychain entry cannot restore a partial identity.
      } finally {
        if (generation === initialGeneration) hydrated = true;
      }
    })();
    hydration = operation;
    try { await operation; } finally { if (hydration === operation) hydration = null; }
  }

  async function status() {
    await ensureIdentity();
    const secure = secureStorageAvailable();
    return {
      configured: configured(config), connected: Boolean(identity && secure),
      clientId: config.clientId, tenantId: config.tenantId,
      account: identity && secure ? publicAccount(identity.account) : null,
      secureStorageAvailable: secure,
    };
  }

  async function configure({ clientId, tenantId } = {}) {
    const next = { clientId: String(clientId || "").trim().toLowerCase(), tenantId: String(tenantId || "").trim().toLowerCase() };
    if (!GUID.test(next.clientId)) throw error("请填写有效的微软应用（客户端）ID，格式应为 GUID。", "OUTLOOK_AUTH_CONFIG");
    if (!GUID.test(next.tenantId) || next.tenantId === "9188040d-6c67-4c5b-b112-36a304b66dad") {
      throw error("请填写公司目录（租户）ID，格式应为 GUID；当前仅支持公司 Microsoft 365。", "OUTLOOK_AUTH_CONFIG");
    }
    if (config.clientId !== next.clientId || config.tenantId !== next.tenantId) {
      invalidate();
      clearCredentials();
    }
    try { writeAtomic(configFile, JSON.stringify(next, null, 2)); } catch (cause) { throw sanitizeStorageError(cause); }
    config = next;
    return status();
  }

  async function connect() {
    requireConfig();
    requireSecureStorage();
    if (pending) throw error("Outlook 登录正在进行，请先完成浏览器中的登录。", "OUTLOOK_AUTH_BUSY");
    if (typeof openExternal !== "function") throw error("无法打开系统浏览器进行微软登录。", "OUTLOOK_AUTH_BROWSER");
    const attempt = { generation, settings: { ...config }, cancelled: null, callbackPort: null, state: "" };
    pending = attempt;
    const timer = setTimeout(() => {
      attempt.cancelled = error("Outlook 登录已超时，请重新连接。", "OUTLOOK_AUTH_TIMEOUT");
      closeLoginListener(attempt);
    }, LOGIN_TIMEOUT_MS);
    timer.unref?.();
    try {
      // Isolate an in-progress login from the active account's cache. In particular,
      // a late result after disconnect/configure can never persist old credentials.
      const client = makeClient(attempt.settings);
      const result = await client.acquireTokenInteractive({
        scopes: [...SCOPES], prompt: "select_account", nonce: randomUUID(),
        successTemplate: "<!doctype html><meta charset=utf-8><title>DanceMonkey</title><p>微软登录已完成，请返回 DanceMonkey。</p>",
        errorTemplate: "<!doctype html><meta charset=utf-8><title>DanceMonkey</title><p>登录已取消或失败，请返回 DanceMonkey 后重试。</p>",
        openBrowser: async (value) => {
          const url = microsoftUrl(value);
          if (attempt.cancelled || generation !== attempt.generation) throw attempt.cancelled || error("Outlook 登录状态已变化。", "OUTLOOK_AUTH_CHANGED");
          const callback = new URL(url.searchParams.get("redirect_uri"));
          if (callback.protocol !== "http:" || callback.hostname !== "localhost" || !callback.port ||
              callback.username || callback.password || callback.pathname !== "/" || callback.search || callback.hash) {
            throw error("微软登录回调地址无效。", "OUTLOOK_AUTH_URL");
          }
          attempt.callbackPort = Number(callback.port);
          attempt.state = url.searchParams.get("state") || "";
          await openExternal(url.href);
          if (attempt.cancelled) closeLoginListener(attempt);
        },
      });
      if (attempt.cancelled || generation !== attempt.generation) throw attempt.cancelled || error("Outlook 登录状态已变化。", "OUTLOOK_AUTH_CHANGED");
      if (!result?.account?.homeAccountId || accountSelector(result.account).tenantId !== config.tenantId || !result.accessToken) {
        throw error("请使用配置的公司租户账号连接 Outlook。", "OUTLOOK_AUTH_ACCOUNT");
      }
      persist(client, result.account, attempt.settings);
      generation += 1;
      hydrated = true;
      identity = { client, account: result.account, settings: attempt.settings, refresh: null };
      return await status();
    } catch (cause) {
      throw attempt.cancelled || sanitizeAuthError(cause);
    } finally {
      clearTimeout(timer);
      if (pending === attempt) pending = null;
    }
  }

  async function disconnect() {
    invalidate();
    clearCredentials();
    return status();
  }

  async function session() {
    requireConfig();
    requireSecureStorage();
    await ensureIdentity();
    if (!identity) throw error("请先连接 Outlook。", "OUTLOOK_AUTH_REQUIRED");
    const captured = identity;
    const capturedGeneration = generation;
    function assertCurrent() {
      requireSecureStorage();
      if (generation !== capturedGeneration || identity !== captured) {
        throw error("Outlook 登录账号或配置已变化，请重新开始导入。", "OUTLOOK_AUTH_CHANGED");
      }
    }
    async function getAccessToken() {
      assertCurrent();
      if (!captured.refresh) {
        const operation = (async () => {
          try {
            const result = await captured.client.acquireTokenSilent({ scopes: [...SCOPES], account: captured.account });
            assertCurrent();
            if (!result?.accessToken || !sameAccount(result.account, accountSelector(captured.account))) {
              throw error("Outlook 登录账号不匹配，请重新连接。", "OUTLOOK_AUTH_REQUIRED");
            }
            persist(captured.client, captured.account, captured.settings);
            return result.accessToken;
          } catch (cause) {
            assertCurrent();
            const sanitized = sanitizeAuthError(cause);
            if (sanitized.code === "OUTLOOK_AUTH_REQUIRED") {
              invalidate();
              clearCredentials();
            }
            throw sanitized;
          }
        })();
        captured.refresh = operation;
        operation.finally(() => { if (captured.refresh === operation) captured.refresh = null; }).catch(() => {});
      }
      const token = await captured.refresh;
      assertCurrent();
      return token;
    }
    return { accountId: publicAccount(captured.account).id, username: captured.account.username || "", assertCurrent, getAccessToken };
  }

  return { status, configure, connect, disconnect, session };
}

module.exports = { createOutlookAuth };
