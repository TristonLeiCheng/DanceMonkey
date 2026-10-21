const fs = require("node:fs");
const path = require("node:path");

// 固定 API 版本与 UA，避免跟随系统/依赖版本漂移。
const API_VERSION = "2022-11-28";
const USER_AGENT = "DanceMonkey-GitHubAuth/1.0";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const API_BASE = "https://api.github.com";

const CONFIG_FILE_NAME = "github-auth.json";
const CREDENTIALS_FILE_NAME = "github-auth.credentials";

const MIN_POLL_INTERVAL_SECONDS = 5;
const DEFAULT_EXPIRES_IN_SECONDS = 900;
const TOKEN_EXPIRY_SKEW_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 30000;

// 分页有界：安装数/仓库数均最多翻 10 页（每页 100 条），足够覆盖正常账户规模，
// 同时避免恶意/异常响应导致无限分页。
const PAGINATION_MAX_PAGES = 10;
const PAGINATION_PAGE_SIZE = 100;

// refresh_token 刷新时，仅这些错误代表"刷新令牌确实作废"，才允许清除本地凭据；
// 429/5xx/网络抖动等瞬时问题必须保留凭据，留给下次重试。
const FATAL_REFRESH_ERRORS = new Set([
  "bad_refresh_token",
  "invalid_grant",
  "unauthorized_client",
  "incorrect_client_credentials",
]);

function defaultFetch(...args) {
  if (typeof globalThis.fetch === "function") return globalThis.fetch(...args);
  return require("undici").fetch(...args);
}

/**
 * 仅允许访问 GitHub 的设备授权端点与 REST API，杜绝任何其它出站请求。
 * 同时拒绝携带 userinfo 或自定义端口的地址，防止 URL 拼接被滥用。
 */
function assertAllowedUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new Error("内部错误：请求地址无效。");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("内部错误：仅允许 HTTPS 请求。");
  }
  if (parsed.username || parsed.password) {
    throw new Error("内部错误：请求地址不得包含用户信息。");
  }
  if (parsed.port) {
    throw new Error("内部错误：请求地址不得包含自定义端口。");
  }
  const host = parsed.hostname.toLowerCase();
  if (host === "api.github.com") return;
  if (host === "github.com" && parsed.pathname.startsWith("/login/")) return;
  throw new Error("内部错误：请求目标不在允许列表中。");
}

/** 仅当确实是 GitHub 官方设备授权页面时才允许自动打开系统浏览器。 */
function isAllowedVerificationUri(value) {
  return /^https:\/\/github\.com\/login\/device\/?$/i.test(String(value || "").trim());
}

function readJsonSafe(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function writeSecretFile(file, buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, buffer, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // 某些平台（如 Windows）不支持 POSIX 权限位，忽略即可。
  }
}

function isValidClientId(value) {
  return /^[A-Za-z0-9._-]{6,255}$/.test(String(value || ""));
}

function isValidAppSlug(value) {
  return /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/i.test(String(value || ""));
}

function isValidOwner(value) {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(String(value || ""));
}

function isValidRepoName(value) {
  return /^[A-Za-z0-9._-]{1,100}$/.test(String(value || ""));
}

/**
 * 创建 GitHub App Device Flow 授权与凭据管理模块。
 *
 * 安全约束：
 * - 所有出站请求仅限 github.com/login/* 与 api.github.com（见 assertAllowedUrl），
 *   强制 redirect:'error' 与 30s 超时。
 * - token / refresh_token 只以 safeStorage 加密后的二进制写入独立的 0600 文件；
 *   若 safeStorage.isEncryptionAvailable() 为 false，拒绝登录且不提供明文回退。
 * - 返回给调用方（最终用于 UI）的数据绝不包含 token、device_code 或原始响应体/头。
 * - 切换 clientId、调用 disconnect() 都会递增内部 generation，任何此前仍在途的
 *   start()/刷新请求在拿到响应后都会检测 generation 是否过期，过期则整体丢弃，
 *   不会让旧身份的迟到响应复活为新的登录状态。
 */
function createGitHubAuth({ directory, safeStorage, fetch = defaultFetch, openExternal,
  clientId: initialClientId, appSlug: initialAppSlug } = {}) {
  if (!directory || typeof directory !== "string") {
    throw new Error("必须提供 directory（凭据与配置的存储目录）。");
  }
  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== "function") {
    throw new Error("必须提供 safeStorage。");
  }

  const configFile = path.join(directory, CONFIG_FILE_NAME);
  const credentialsFile = path.join(directory, CREDENTIALS_FILE_NAME);

  // 当前进行中的 device flow 会话（非持久化，仅存在于内存中）。
  let pending = null;
  let pollInFlight = false;
  let refreshInFlight = null;
  // 身份代际：configure() 切换 clientId 或 disconnect() 都会 +1。
  let generation = 0;

  function invalidateIdentity() {
    generation += 1;
    if (pending) pending.state = "cancelled";
    pending = null;
  }

  function readConfig() {
    const stored = readJsonSafe(configFile) || {};
    return {
      clientId: String(stored.clientId || initialClientId || "").trim(),
      appSlug: String(stored.appSlug ?? initialAppSlug ?? "").trim(),
      login: String(stored.login || "").trim(),
    };
  }

  function writeConfig(partial) {
    const next = { ...readConfig(), ...partial };
    writeJsonAtomic(configFile, next);
    return next;
  }

  function hasCredentialsFile() {
    try {
      return fs.statSync(credentialsFile).isFile();
    } catch {
      return false;
    }
  }

  function readCredentials() {
    if (!hasCredentialsFile()) return null;
    if (!safeStorage.isEncryptionAvailable()) return null;
    try {
      const buffer = fs.readFileSync(credentialsFile);
      const data = JSON.parse(safeStorage.decryptString(buffer));
      if (!data || typeof data !== "object" || !data.accessToken) return null;
      return data;
    } catch {
      return null;
    }
  }

  function persistCredentials(data) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("系统安全存储不可用，无法保存凭据（已拒绝明文回退）。");
    }
    const buffer = safeStorage.encryptString(JSON.stringify(data));
    writeSecretFile(credentialsFile, buffer);
  }

  function clearCredentials() {
    try {
      fs.rmSync(credentialsFile, { force: true });
    } catch {
      throw new Error("无法移除本机 GitHub 凭据，请检查应用数据目录权限。");
    }
  }

  function status() {
    const config = readConfig();
    const creds = readCredentials();
    const connected = Boolean(creds && creds.accessToken);
    return {
      connected,
      configured: isValidClientId(config.clientId) && isValidAppSlug(config.appSlug),
      secureStorageAvailable: safeStorage.isEncryptionAvailable(),
      login: connected ? config.login || "" : "",
      clientId: config.clientId || "",
      appSlug: config.appSlug || "",
      installationUrl: config.appSlug
        ? `https://github.com/apps/${config.appSlug}/installations/new`
        : undefined,
    };
  }

  function configure({ clientId, appSlug } = {}) {
    const nextClientId = String(clientId || "").trim();
    if (!isValidClientId(nextClientId)) {
      throw new Error("请填写有效的 GitHub App Client ID。");
    }
    let nextSlug = String(appSlug || "").trim();
    if (nextSlug) {
      if (!isValidAppSlug(nextSlug)) {
        throw new Error("GitHub App slug 格式无效。");
      }
      nextSlug = nextSlug.toLowerCase();
    }

    const previous = readConfig();
    const clientChanged = Boolean(previous.clientId) && previous.clientId !== nextClientId;
    if (clientChanged) {
      // 新 Client ID 不能沿用旧 App 的凭据或正在进行中的设备流会话。
      invalidateIdentity();
      clearCredentials();
      writeConfig({ clientId: nextClientId, appSlug: nextSlug, login: "" });
    } else {
      writeConfig({ clientId: nextClientId, appSlug: nextSlug });
    }
    return status();
  }

  async function requestJson(url, options, context) {
    assertAllowedUrl(url);
    let response;
    try {
      response = await fetch(url, {
        ...options,
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/json",
          "X-GitHub-Api-Version": API_VERSION,
          ...(options && options.headers ? options.headers : {}),
        },
      });
    } catch {
      // 绝不回显底层网络错误的原始信息（可能包含代理/主机细节）。
      throw new Error(`${context}：网络请求失败，请检查网络连接。`);
    }
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { response, body };
  }

  async function fetchPaginated(pathname, token, resultsKey, context) {
    const items = [];
    for (let page = 1; page <= PAGINATION_MAX_PAGES; page += 1) {
      const { response, body } = await requestJson(
        `${API_BASE}${pathname}?per_page=${PAGINATION_PAGE_SIZE}&page=${page}`,
        { headers: { Authorization: `Bearer ${token}` } },
        context,
      );
      if (!response.ok || !body) {
        throw new Error(`${context}失败（HTTP ${response.status}）。`);
      }
      const list = Array.isArray(body[resultsKey]) ? body[resultsKey] : [];
      items.push(...list);
      if (list.length < PAGINATION_PAGE_SIZE) break;
    }
    return items;
  }

  /**
   * 确认目标仓库确实绑定在本 App 的某个安装下，并返回该安装对象（含权限）。
   * repo.permissions 反映的是“当前用户”的权限，不能代表 App 安装实际能做什么，
   * 因此必须用 /user/installations + /user/installations/{id}/repositories 核实。
   */
  async function findBoundInstallation(token, owner, repo, appSlug) {
    const target = `${owner}/${repo}`.toLowerCase();
    const installations = await fetchPaginated(
      "/user/installations",
      token,
      "installations",
      "读取 GitHub App 安装列表",
    );
    for (const installation of installations) {
      if (installation.suspended_at || !Number.isSafeInteger(installation.id) || installation.id <= 0) continue;
      if (appSlug && String(installation.app_slug || "").toLowerCase() !== appSlug.toLowerCase()) continue;
      const repos = await fetchPaginated(
        `/user/installations/${installation.id}/repositories`,
        token,
        "repositories",
        "读取 GitHub App 安装可访问的仓库列表",
      );
      if (repos.some((item) => String(item.full_name || "").toLowerCase() === target)) {
        return installation;
      }
    }
    return null;
  }

  async function repositories() {
    const identity = generation;
    const token = await getToken();
    const config = readConfig();
    const installations = await fetchPaginated("/user/installations", token, "installations", "读取 GitHub App 安装列表");
    const items = new Map();
    for (const installation of installations) {
      if (config.appSlug && String(installation.app_slug || "").toLowerCase() !== config.appSlug.toLowerCase()) continue;
      if (installation.suspended_at || !["write", "admin"].includes(installation.permissions?.contents)) continue;
      if (!Number.isSafeInteger(installation.id) || installation.id <= 0) continue;
      const repos = await fetchPaginated(`/user/installations/${installation.id}/repositories`, token, "repositories", "读取可用笔记仓库");
      for (const repo of repos) {
        if (!repo.private || repo.archived || repo.disabled || repo.permissions?.push !== true) continue;
        const owner = String(repo.owner?.login || "");
        const name = String(repo.name || "");
        if (!isValidOwner(owner) || !isValidRepoName(name)) continue;
        const fullName = `${owner}/${name}`;
        items.set(fullName.toLowerCase(), { owner, repo: name, fullName, defaultBranch: String(repo.default_branch || "main"), private: true });
      }
    }
    if (identity !== generation) throw new Error("登录状态已变化，请重新加载笔记仓库。");
    return [...items.values()].sort((a, b) => a.fullName.localeCompare(b.fullName));
  }

  async function fetchLogin(accessToken) {
    const { response, body } = await requestJson(
      `${API_BASE}/user`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
      "获取用户信息",
    );
    if (!response.ok || !body || !body.login) {
      throw new Error("无法获取 GitHub 用户信息。");
    }
    return String(body.login);
  }

  async function start() {
    const config = readConfig();
    if (!config.clientId) {
      throw new Error("请先配置 GitHub App 的 Client ID。");
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("系统安全存储不可用，已拒绝登录（不支持明文保存凭据）。");
    }

    const requestedGeneration = generation;
    const { response, body } = await requestJson(
      DEVICE_CODE_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: config.clientId, scope: "offline_access" }),
      },
      "设备授权请求",
    );

    // 迟到保护：请求期间若 configure()/disconnect() 变更了身份，丢弃本次响应。
    if (generation !== requestedGeneration) {
      throw new Error("登录配置已变更，请重新开始登录。");
    }
    if (!response.ok || !body || !body.device_code || !body.user_code || !body.verification_uri) {
      throw new Error(`设备授权请求失败（HTTP ${response.status}）。`);
    }

    const interval = Math.max(MIN_POLL_INTERVAL_SECONDS, Number(body.interval) || MIN_POLL_INTERVAL_SECONDS);
    const expiresInSeconds = Number(body.expires_in) > 0 ? Number(body.expires_in) : DEFAULT_EXPIRES_IN_SECONDS;
    const expiresAt = Date.now() + expiresInSeconds * 1000;
    const verificationUri = String(body.verification_uri);

    pending = {
      deviceCode: String(body.device_code),
      interval,
      expiresAt,
      nextPollAt: Date.now() + interval * 1000,
      state: "awaiting",
      generation: requestedGeneration,
    };

    // 仅当确实是 GitHub 官方设备授权页面时才自动打开系统浏览器。
    if (isAllowedVerificationUri(verificationUri) && typeof openExternal === "function") {
      try {
        await openExternal(verificationUri);
      } catch {
        // 打开外部浏览器失败不影响登录流程，用户仍可手动访问 verificationUri。
      }
    }

    // 注意：绝不把 deviceCode 回传给调用方（renderer）。
    return { userCode: String(body.user_code), verificationUri, expiresAt, interval };
  }

  function cancel() {
    generation += 1;
    if (pending && pending.state === "awaiting") {
      pending.state = "cancelled";
    }
    return { cancelled: true };
  }

  /** 统一 poll() 返回形状，供 UI 据 status/pending/connected/interval 驱动轮询。 */
  function pollResult(statusValue, extra = {}) {
    return {
      status: statusValue,
      pending: statusValue === "pending",
      connected: status().connected,
      interval: pending ? pending.interval : 0,
      ...extra,
    };
  }

  async function poll() {
    const session = pending;
    if (!session) return pollResult("idle");

    if (session.state === "cancelled") return pollResult("cancelled");
    if (session.state === "expired") return pollResult("expired");
    if (session.state === "denied") return pollResult("denied");
    if (session.state === "error") return pollResult("error");
    if (session.state === "authorized") {
      return pollResult("authorized", { login: readConfig().login });
    }

    if (Date.now() >= session.expiresAt) {
      session.state = "expired";
      return pollResult("expired");
    }
    if (Date.now() < session.nextPollAt) {
      return pollResult("pending");
    }
    if (pollInFlight) {
      // 互斥：避免重叠的 poll() 调用同时打到 GitHub。
      return pollResult("pending");
    }

    pollInFlight = true;
    try {
      const requestedGeneration = generation;
      const config = readConfig();
      const { response, body } = await requestJson(
        ACCESS_TOKEN_URL,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_id: config.clientId,
            device_code: session.deviceCode,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          }),
        },
        "设备授权轮询",
      );

      // 迟到保护：会话在网络请求期间被取消/断开/身份变更，丢弃本次响应。
      if (pending !== session || session.state !== "awaiting" || generation !== requestedGeneration) {
        return pollResult(session.state === "awaiting" ? "idle" : session.state);
      }

      if (response.status === 429) {
        const retryAfter = Number(response.headers && response.headers.get && response.headers.get("retry-after")) || 5;
        session.interval = Math.max(session.interval, retryAfter);
        session.nextPollAt = Date.now() + session.interval * 1000;
        return pollResult("pending");
      }

      const error = body && typeof body.error === "string" ? body.error : null;

      if (response.ok && !error && body && body.access_token) {
        const now = Date.now();
        let login = "";
        try {
          login = await fetchLogin(body.access_token);
        } catch {
          login = "";
        }

        if (pending !== session || session.state !== "awaiting" || generation !== requestedGeneration) {
          return pollResult(session.state === "awaiting" ? "idle" : session.state);
        }

        persistCredentials({
          accessToken: String(body.access_token),
          refreshToken: body.refresh_token ? String(body.refresh_token) : "",
          accessTokenExpiresAt: body.expires_in ? now + Number(body.expires_in) * 1000 : null,
          refreshTokenExpiresAt: body.refresh_token_expires_in
            ? now + Number(body.refresh_token_expires_in) * 1000
            : null,
          scope: String(body.scope || ""),
        });
        writeConfig({ login });
        session.state = "authorized";
        return pollResult("authorized", { login });
      }

      switch (error) {
        case "authorization_pending":
          session.nextPollAt = Date.now() + session.interval * 1000;
          return pollResult("pending");
        case "slow_down": {
          // GitHub 返回的 interval 是建议的新总间隔，不是增量，不能累加。
          const suggested = Number(body.interval) || 0;
          session.interval = Math.max(session.interval + 5, suggested);
          session.nextPollAt = Date.now() + session.interval * 1000;
          return pollResult("pending");
        }
        case "expired_token":
          session.state = "expired";
          return pollResult("expired");
        case "access_denied":
          session.state = "denied";
          return pollResult("denied");
        default:
          session.state = "error";
          return pollResult("error");
      }
    } catch {
      // 网络异常：保持 awaiting，按当前 interval 退避后由调用方再次尝试。
      session.nextPollAt = Date.now() + session.interval * 1000;
      return pollResult("pending");
    } finally {
      pollInFlight = false;
    }
  }

  function disconnect() {
    invalidateIdentity();
    clearCredentials();
    writeConfig({ login: "" });
    return status();
  }

  async function getToken() {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("系统安全存储不可用，请重新登录 GitHub。");
    }
    const creds = readCredentials();
    if (!creds || !creds.accessToken) {
      throw new Error("尚未连接 GitHub，请先登录。");
    }

    const now = Date.now();
    if (!creds.accessTokenExpiresAt || now < creds.accessTokenExpiresAt - TOKEN_EXPIRY_SKEW_MS) {
      return creds.accessToken;
    }
    if ((creds.refreshTokenExpiresAt && now >= creds.refreshTokenExpiresAt) || !creds.refreshToken) {
      disconnect();
      throw new Error("登录已过期，请重新连接 GitHub。");
    }

    if (refreshInFlight) return refreshInFlight;

    refreshInFlight = (async () => {
      try {
        const requestedGeneration = generation;
        const config = readConfig();
        const { response, body } = await requestJson(
          ACCESS_TOKEN_URL,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              client_id: config.clientId,
              grant_type: "refresh_token",
              refresh_token: creds.refreshToken,
            }),
          },
          "刷新令牌",
        );

        // 迟到保护：刷新期间身份已变更（configure/disconnect），丢弃本次响应，
        // 不写回凭据；身份变更时的凭据清理已由 configure()/disconnect() 完成。
        if (generation !== requestedGeneration) {
          throw new Error("登录状态已变更，请重试。");
        }

        const error = body && typeof body.error === "string" ? body.error : null;
        const isFatal = response.status === 401 || (error && FATAL_REFRESH_ERRORS.has(error));
        if (isFatal) {
          disconnect();
          throw new Error("登录已过期，请重新连接 GitHub。");
        }
        if (!response.ok || error || !body || !body.access_token) {
          // 429/5xx 等瞬时错误：保留现有 refresh token，允许下次重试。
          throw new Error("刷新登录状态失败，请稍后重试。");
        }

        const refreshedAt = Date.now();
        persistCredentials({
          accessToken: String(body.access_token),
          refreshToken: body.refresh_token ? String(body.refresh_token) : creds.refreshToken,
          accessTokenExpiresAt: body.expires_in ? refreshedAt + Number(body.expires_in) * 1000 : null,
          refreshTokenExpiresAt: body.refresh_token_expires_in
            ? refreshedAt + Number(body.refresh_token_expires_in) * 1000
            : creds.refreshTokenExpiresAt || null,
          scope: String(body.scope || creds.scope || ""),
        });
        return String(body.access_token);
      } finally {
        refreshInFlight = null;
      }
    })();
    return refreshInFlight;
  }

  async function repository({ owner, repo } = {}) {
    const ownerName = String(owner || "").trim();
    const repoName = String(repo || "").trim();
    if (!isValidOwner(ownerName)) {
      throw new Error("仓库所有者（owner）无效。");
    }
    if (!isValidRepoName(repoName)) {
      throw new Error("仓库名称（repo）无效。");
    }

    const token = await getToken();
    const { response, body } = await requestJson(
      `${API_BASE}/repos/${encodeURIComponent(ownerName)}/${encodeURIComponent(repoName)}`,
      { headers: { Authorization: `Bearer ${token}` } },
      "读取仓库信息",
    );
    if (response.status === 404) {
      throw new Error("未找到仓库，或当前 GitHub App 安装未获得该仓库的访问权限。");
    }
    if (!response.ok || !body) {
      throw new Error(`读取仓库信息失败（HTTP ${response.status}）。`);
    }

    if (body.permissions?.push !== true) {
      throw new Error("当前 GitHub 用户没有该仓库的写入权限。");
    }

    // repo.permissions 只反映当前用户的权限，不代表 App 安装的实际能力；
    // 用 /user/installations + 其 repositories 列表确认绑定关系与 contents:write。
    const config = readConfig();
    const installation = await findBoundInstallation(token, ownerName, repoName, config.appSlug);
    if (!installation) {
      throw new Error("该仓库未被当前 GitHub App 安装授权访问。");
    }
    const contentsPermission = String((installation.permissions || {}).contents || "");
    if (contentsPermission !== "write" && contentsPermission !== "admin") {
      throw new Error("当前 GitHub App 安装缺少仓库内容写权限（contents:write）。");
    }

    return {
      owner: (body.owner && body.owner.login) || ownerName,
      repo: body.name || repoName,
      defaultBranch: body.default_branch || "main",
      private: Boolean(body.private),
      permissions: {
        admin: String((installation.permissions || {}).administration || "") === "write",
        push: true,
        pull: true,
      },
    };
  }

  return {
    status,
    configure,
    start,
    poll,
    cancel,
    disconnect,
    getToken,
    repository,
    repositories,
  };
}

module.exports = { createGitHubAuth, assertAllowedUrl, isAllowedVerificationUri };
