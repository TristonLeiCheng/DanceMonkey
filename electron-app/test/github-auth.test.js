const { test, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createGitHubAuth } = require("../electron/github-auth");

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dm-github-auth-test-"));
}

// Fake safeStorage: base64 round-trip so plaintext tokens never appear verbatim
// in the "ciphertext" bytes, letting tests assert the file is not plaintext.
function createFakeSafeStorage({ available = true } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from(Buffer.from(value, "utf8").toString("base64"), "utf8"),
    decryptString: (buffer) => Buffer.from(buffer.toString("utf8"), "base64").toString("utf8"),
  };
}

function jsonResponse(status, body, headers = {}) {
  const headerMap = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headerMap.get(String(name).toLowerCase()) || null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** Builds a fake fetch keyed by URL substring -> queue of responses or functions. */
function createFakeFetch(routes) {
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push({ url: String(url), options });
    // Longest matching key wins, so a specific route (e.g. ".../installations/1/repositories")
    // isn't shadowed by a shorter substring route (e.g. ".../user").
    const key = Object.keys(routes)
      .filter((candidate) => String(url).includes(candidate))
      .sort((a, b) => b.length - a.length)[0];
    if (!key) throw new Error(`No fake route for ${url}`);
    const queue = routes[key];
    const next = Array.isArray(queue) ? queue.shift() : queue;
    if (!next) throw new Error(`No more fake responses for ${url}`);
    if (typeof next === "function") return next(url, options);
    return next;
  };
  fetchFn.calls = calls;
  return fetchFn;
}

const CLIENT_ID = "Iv1.test1234567890";
const CLIENT_ID_2 = "Iv1.anotherapp99999";

const DEVICE_CODE_RESPONSE = jsonResponse(200, {
  device_code: "DEV",
  user_code: "ABCD-1234",
  verification_uri: "https://github.com/login/device",
  expires_in: 900,
  interval: 5,
});

function installationsRoutes({ appSlug = "my-app", contents = "write", installationId = 1, boundRepos = [] } = {}) {
  return {
    "api.github.com/user/installations?": [
      jsonResponse(200, {
        installations: [{ id: installationId, app_slug: appSlug, permissions: { contents, administration: "write" } }],
      }),
    ],
    [`api.github.com/user/installations/${installationId}/repositories?`]: [
      jsonResponse(200, { repositories: boundRepos }),
    ],
  };
}

async function authorize(auth, fetchFn, { clientId = CLIENT_ID, appSlug } = {}) {
  auth.configure({ clientId, appSlug });
  await auth.start();
  mock.timers.tick(5001);
  return auth.poll();
}

test("publisher defaults supply public App identifiers without user configuration", (t) => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const auth = createGitHubAuth({ directory, safeStorage: createFakeSafeStorage(), clientId: CLIENT_ID, appSlug: "notes-app" });
  assert.equal(auth.status().configured, true);
  assert.equal(auth.status().appSlug, "notes-app");
  assert.equal(auth.status().connected, false);
});

test("repository picker only returns private writable repos from this App's active installation", async (t) => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  mock.timers.enable({ apis: ["Date"] }); t.after(() => mock.timers.reset());
  const repo = (name, extra = {}) => ({ name, owner: { login: "octocat" }, private: true, permissions: { push: true }, default_branch: "trunk", ...extra });
  const fetchFn = createFakeFetch({
    "github.com/login/device/code": [DEVICE_CODE_RESPONSE],
    "github.com/login/oauth/access_token": [jsonResponse(200, { access_token: "token-1" })],
    "api.github.com/user": [jsonResponse(200, { login: "octocat" })],
    "api.github.com/user/installations?": [jsonResponse(200, { installations: [
      { id: 1, app_slug: "my-app", permissions: { contents: "write" } },
      { id: 2, app_slug: "other-app", permissions: { contents: "write" } },
      { id: 3, app_slug: "my-app", permissions: { contents: "read" } },
      { id: 4, app_slug: "my-app", permissions: { contents: "write" }, suspended_at: "2026-01-01" },
    ] })],
    "api.github.com/user/installations/1/repositories?": [jsonResponse(200, { repositories: [repo("notes"), repo("public", { private: false }), repo("readonly", { permissions: { push: false } }), repo("archived", { archived: true }), repo("notes")] })],
  });
  const auth = createGitHubAuth({ directory, safeStorage: createFakeSafeStorage(), fetch: fetchFn });
  await authorize(auth, fetchFn, { appSlug: "my-app" });
  assert.deepEqual(await auth.repositories(), [{ owner: "octocat", repo: "notes", fullName: "octocat/notes", defaultBranch: "trunk", private: true }]);
  assert.equal(fetchFn.calls.some(({ options }) => options?.method && options.method !== "POST"), false);
  assert.equal(fetchFn.calls.filter(({ url }) => url.includes("/repositories?")).length, 1);
});

test("unavailable secure storage rejects login without making a network request", async (t) => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let requests = 0;
  const auth = createGitHubAuth({ directory, safeStorage: createFakeSafeStorage({ available: false }),
    fetch: async () => { requests += 1; throw new Error("unexpected network"); } });
  auth.configure({ clientId: CLIENT_ID });
  await assert.rejects(auth.start(), /安全存储不可用/);
  await assert.rejects(auth.getToken(), /安全存储不可用/);
  assert.equal(requests, 0);
  assert.equal(fs.existsSync(path.join(directory, "github-auth.credentials")), false);
});

test("status() reports disconnected with appSlug surfaced for UI/IPC", (t) => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const auth = createGitHubAuth({ directory, safeStorage: createFakeSafeStorage(), fetch: async () => {
    throw new Error("should not be called");
  } });
  auth.configure({ clientId: CLIENT_ID, appSlug: "My-App" });
  const result = auth.status();
  assert.equal(result.connected, false);
  assert.equal(result.appSlug, "my-app");
  assert.equal(result.installationUrl, "https://github.com/apps/my-app/installations/new");
});

test("configure() switching clientId wipes old credentials and cancels pending session", async (t) => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  mock.timers.enable({ apis: ["Date"] });
  t.after(() => mock.timers.reset());

  const fetchFn = createFakeFetch({
    "github.com/login/device/code": [DEVICE_CODE_RESPONSE],
    "github.com/login/oauth/access_token": [
      jsonResponse(200, { access_token: "token-1", refresh_token: "refresh-1", expires_in: 28800 }),
    ],
    "api.github.com/user": [jsonResponse(200, { login: "octocat" })],
  });
  const auth = createGitHubAuth({ directory, safeStorage: createFakeSafeStorage(), fetch: fetchFn });
  const authorized = await authorize(auth, fetchFn);
  assert.equal(authorized.status, "authorized");
  assert.equal(auth.status().connected, true);

  // Switching client id must drop the old app's token entirely.
  auth.configure({ clientId: CLIENT_ID_2 });
  const status = auth.status();
  assert.equal(status.connected, false);
  assert.equal(status.login, "");
  assert.equal(status.clientId, CLIENT_ID_2);
  assert.equal(fs.existsSync(path.join(directory, "github-auth.credentials")), false);

  // Any poll on the now-abandoned session must not resurrect it.
  const polled = await auth.poll();
  assert.equal(polled.status, "idle");
});

test("start() late response after disconnect()/configure() is discarded (generation guard)", async (t) => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let resolveDeviceCode;
  const fetchFn = createFakeFetch({
    "github.com/login/device/code": [
      () =>
        new Promise((resolve) => {
          resolveDeviceCode = resolve;
        }),
    ],
  });
  const auth = createGitHubAuth({ directory, safeStorage: createFakeSafeStorage(), fetch: fetchFn });
  auth.configure({ clientId: CLIENT_ID });

  const startPromise = auth.start();
  auth.disconnect();
  resolveDeviceCode(DEVICE_CODE_RESPONSE);

  await assert.rejects(startPromise, /登录配置已变更/);
  assert.equal(auth.status().connected, false);
  const polled = await auth.poll();
  assert.equal(polled.status, "idle");
});

test("refresh late response after disconnect() is discarded and never persisted", async (t) => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  mock.timers.enable({ apis: ["Date"] });
  t.after(() => mock.timers.reset());

  let resolveRefresh;
  const fetchFn = createFakeFetch({
    "github.com/login/device/code": [DEVICE_CODE_RESPONSE],
    "github.com/login/oauth/access_token": [
      jsonResponse(200, { access_token: "token-1", refresh_token: "refresh-1", expires_in: 10 }),
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        }),
    ],
    "api.github.com/user": [jsonResponse(200, { login: "octocat" })],
  });
  const auth = createGitHubAuth({ directory, safeStorage: createFakeSafeStorage(), fetch: fetchFn });
  await authorize(auth, fetchFn);

  mock.timers.tick(11000);
  const getTokenPromise = auth.getToken();
  auth.disconnect();
  resolveRefresh(jsonResponse(200, { access_token: "late-token", refresh_token: "late-refresh", expires_in: 28800 }));

  await assert.rejects(getTokenPromise, /登录状态已变更/);
  assert.equal(auth.status().connected, false);
  assert.equal(fs.existsSync(path.join(directory, "github-auth.credentials")), false);
});

test("poll() result shape always carries status/pending/connected/interval", async (t) => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  mock.timers.enable({ apis: ["Date"] });
  t.after(() => mock.timers.reset());

  const fetchFn = createFakeFetch({
    "github.com/login/device/code": [DEVICE_CODE_RESPONSE],
    "github.com/login/oauth/access_token": [jsonResponse(200, { error: "authorization_pending" })],
  });
  const auth = createGitHubAuth({ directory, safeStorage: createFakeSafeStorage(), fetch: fetchFn });
  auth.configure({ clientId: CLIENT_ID });
  await auth.start();

  const immediate = await auth.poll();
  assert.deepEqual(immediate, { status: "pending", pending: true, connected: false, interval: 5 });

  mock.timers.tick(5001);
  const afterNetwork = await auth.poll();
  assert.equal(afterNetwork.status, "pending");
  assert.equal(afterNetwork.pending, true);
  assert.equal(afterNetwork.connected, false);
  assert.equal(typeof afterNetwork.interval, "number");
});

test("poll() handles slow_down using max(current+5, suggested), not cumulative addition", async (t) => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  mock.timers.enable({ apis: ["Date"] });
  t.after(() => mock.timers.reset());

  const fetchFn = createFakeFetch({
    "github.com/login/device/code": [DEVICE_CODE_RESPONSE],
    "github.com/login/oauth/access_token": [
      jsonResponse(200, { error: "slow_down", interval: 6 }), // suggested total < current+5
    ],
  });
  const auth = createGitHubAuth({ directory, safeStorage: createFakeSafeStorage(), fetch: fetchFn });
  auth.configure({ clientId: CLIENT_ID });
  await auth.start();

  mock.timers.tick(5001); // interval was 5
  const result = await auth.poll();
  assert.equal(result.status, "pending");
  // current(5) + 5 = 10, suggested = 6 -> max is 10, not 5+6=11.
  assert.equal(result.interval, 10);
});

test("poll() handles HTTP 429 using retry-after header", async (t) => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  mock.timers.enable({ apis: ["Date"] });
  t.after(() => mock.timers.reset());

  const fetchFn = createFakeFetch({
    "github.com/login/device/code": [DEVICE_CODE_RESPONSE],
    "github.com/login/oauth/access_token": [jsonResponse(429, {}, { "retry-after": "20" })],
  });
  const auth = createGitHubAuth({ directory, safeStorage: createFakeSafeStorage(), fetch: fetchFn });
  auth.configure({ clientId: CLIENT_ID });
  await auth.start();

  mock.timers.tick(5001);
  const result = await auth.poll();
  assert.equal(result.status, "pending");
  assert.equal(result.interval, 20);
});

test("poll() surfaces expired_token and access_denied as terminal statuses", async (t) => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  mock.timers.enable({ apis: ["Date"] });
  t.after(() => mock.timers.reset());

  const fetchFn = createFakeFetch({
    "github.com/login/device/code": [DEVICE_CODE_RESPONSE],
    "github.com/login/oauth/access_token": [jsonResponse(200, { error: "access_denied" })],
  });
  const auth = createGitHubAuth({ directory, safeStorage: createFakeSafeStorage(), fetch: fetchFn });
  auth.configure({ clientId: CLIENT_ID });
  await auth.start();

  mock.timers.tick(5001);
  const result = await auth.poll();
  assert.equal(result.status, "denied");
  assert.equal((await auth.poll()).status, "denied");
});

test("cancel() then poll() never resurrects a disconnected/cancelled session with a late success", async (t) => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  mock.timers.enable({ apis: ["Date"] });
  t.after(() => mock.timers.reset());

  let resolveAccessToken;
  const fetchFn = createFakeFetch({
    "github.com/login/device/code": [DEVICE_CODE_RESPONSE],
    "github.com/login/oauth/access_token": [
      () =>
        new Promise((resolve) => {
          resolveAccessToken = resolve;
        }),
    ],
  });
  const auth = createGitHubAuth({ directory, safeStorage: createFakeSafeStorage(), fetch: fetchFn });
  auth.configure({ clientId: CLIENT_ID });
  await auth.start();

  mock.timers.tick(5001);
  const pollPromise = auth.poll();
  auth.cancel();
  resolveAccessToken(jsonResponse(200, { access_token: "late-token" }));
  const result = await pollPromise;

  assert.equal(result.status, "cancelled");
  assert.equal(auth.status().connected, false);
  assert.equal(fs.existsSync(path.join(directory, "github-auth.credentials")), false);
});

test("successful poll() persists encrypted credentials to a 0600 file and never plaintext", async (t) => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  mock.timers.enable({ apis: ["Date"] });
  t.after(() => mock.timers.reset());

  const fetchFn = createFakeFetch({
    "github.com/login/device/code": [DEVICE_CODE_RESPONSE],
    "github.com/login/oauth/access_token": [
      jsonResponse(200, {
        access_token: "secret-access-token",
        refresh_token: "secret-refresh-token",
        expires_in: 28800,
        refresh_token_expires_in: 15897600,
      }),
    ],
    "api.github.com/user": [jsonResponse(200, { login: "octocat" })],
  });
  const auth = createGitHubAuth({ directory, safeStorage: createFakeSafeStorage(), fetch: fetchFn });
  const result = await authorize(auth, fetchFn);
  assert.equal(result.status, "authorized");
  assert.equal(result.login, "octocat");

  const raw = fs.readFileSync(path.join(directory, "github-auth.credentials"));
  assert.equal(raw.toString("utf8").includes("secret-access-token"), false);
  assert.equal(raw.toString("utf8").includes("secret-refresh-token"), false);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.join(directory, "github-auth.credentials")).mode & 0o777, 0o600);
  }
});

test("openExternal is only invoked for the exact GitHub device verification page", async (t) => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const opened = [];

  // A malicious/odd verification_uri must never be auto-opened.
  const fetchFn = createFakeFetch({
    "github.com/login/device/code": [
      jsonResponse(200, {
        device_code: "DEV",
        user_code: "ABCD-1234",
        verification_uri: "https://evil.example.com/phish",
        expires_in: 900,
        interval: 5,
      }),
    ],
  });
  const auth = createGitHubAuth({
    directory,
    safeStorage: createFakeSafeStorage(),
    fetch: fetchFn,
    openExternal: async (url) => opened.push(url),
  });
  auth.configure({ clientId: CLIENT_ID });
  await auth.start();
  assert.deepEqual(opened, []);
});

test("openExternal is invoked for https://github.com/login/device (trailing slash allowed)", async (t) => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const opened = [];
  const fetchFn = createFakeFetch({
    "github.com/login/device/code": [
      jsonResponse(200, {
        device_code: "DEV",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device/",
        expires_in: 900,
        interval: 5,
      }),
    ],
  });
  const auth = createGitHubAuth({
    directory,
    safeStorage: createFakeSafeStorage(),
    fetch: fetchFn,
    openExternal: async (url) => opened.push(url),
  });
  auth.configure({ clientId: CLIENT_ID });
  await auth.start();
  assert.deepEqual(opened, ["https://github.com/login/device/"]);
});

test("requestJson forces redirect:'error' and an AbortSignal timeout on every call", async (t) => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fetchFn = createFakeFetch({ "github.com/login/device/code": [DEVICE_CODE_RESPONSE] });
  const auth = createGitHubAuth({ directory, safeStorage: createFakeSafeStorage(), fetch: fetchFn });
  auth.configure({ clientId: CLIENT_ID });
  await auth.start();

  const call = fetchFn.calls[0];
  assert.equal(call.options.redirect, "error");
  assert.ok(call.options.signal instanceof AbortSignal);
});

test("URLs with userinfo or a custom port are rejected before any fetch", async (t) => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let fetchCalled = false;
  const auth = createGitHubAuth({
    directory,
    safeStorage: createFakeSafeStorage(),
    fetch: async () => {
      fetchCalled = true;
      throw new Error("unexpected");
    },
  });
  const { assertAllowedUrl } = require("../electron/github-auth");
  assert.throws(() => assertAllowedUrl("https://user:pass@api.github.com/user"), /用户信息/);
  assert.throws(() => assertAllowedUrl("https://api.github.com:8443/user"), /端口/);
  assert.doesNotThrow(() => assertAllowedUrl("https://api.github.com/user"));
  assert.equal(fetchCalled, false);
});

test("getToken() returns the cached token when not near expiry", async (t) => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  mock.timers.enable({ apis: ["Date"] });
  t.after(() => mock.timers.reset());

  const fetchFn = createFakeFetch({
    "github.com/login/device/code": [DEVICE_CODE_RESPONSE],
    "github.com/login/oauth/access_token": [
      jsonResponse(200, { access_token: "token-1", refresh_token: "refresh-1", expires_in: 28800 }),
    ],
    "api.github.com/user": [jsonResponse(200, { login: "octocat" })],
  });
  const auth = createGitHubAuth({ directory, safeStorage: createFakeSafeStorage(), fetch: fetchFn });
  await authorize(auth, fetchFn);

  const token = await auth.getToken();
  assert.equal(token, "token-1");
  assert.equal(fetchFn.calls.filter((c) => c.url.includes("oauth/access_token")).length, 1);
});

test("getToken() refreshes an expiring token using refresh_token grant, no client secret", async (t) => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  mock.timers.enable({ apis: ["Date"] });
  t.after(() => mock.timers.reset());

  const refreshCalls = [];
  const fetchFn = createFakeFetch({
    "github.com/login/device/code": [DEVICE_CODE_RESPONSE],
    "github.com/login/oauth/access_token": [
      jsonResponse(200, { access_token: "token-1", refresh_token: "refresh-1", expires_in: 10 }),
      (url, options) => {
        refreshCalls.push(JSON.parse(options.body));
        return jsonResponse(200, { access_token: "token-2", refresh_token: "refresh-2", expires_in: 28800 });
      },
    ],
    "api.github.com/user": [jsonResponse(200, { login: "octocat" })],
  });
  const auth = createGitHubAuth({ directory, safeStorage: createFakeSafeStorage(), fetch: fetchFn });
  await authorize(auth, fetchFn);

  mock.timers.tick(11000);
  const token = await auth.getToken();
  assert.equal(token, "token-2");
  assert.equal(refreshCalls.length, 1);
  assert.equal(refreshCalls[0].grant_type, "refresh_token");
  assert.equal(refreshCalls[0].refresh_token, "refresh-1");
  assert.equal("client_secret" in refreshCalls[0], false);
});

test("getToken() keeps credentials on transient refresh failures (429/5xx/network)", async (t) => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  mock.timers.enable({ apis: ["Date"] });
  t.after(() => mock.timers.reset());

  const fetchFn = createFakeFetch({
    "github.com/login/device/code": [DEVICE_CODE_RESPONSE],
    "github.com/login/oauth/access_token": [
      jsonResponse(200, { access_token: "token-1", refresh_token: "refresh-1", expires_in: 10 }),
      jsonResponse(500, { error: "server_error" }),
    ],
    "api.github.com/user": [jsonResponse(200, { login: "octocat" })],
  });
  const auth = createGitHubAuth({ directory, safeStorage: createFakeSafeStorage(), fetch: fetchFn });
  await authorize(auth, fetchFn);

  mock.timers.tick(11000);
  await assert.rejects(() => auth.getToken(), /刷新登录状态失败/);
  // Credentials must still exist and still be connected: a transient failure
  // is not grounds for disconnect().
  assert.equal(auth.status().connected, true);
  assert.equal(fs.existsSync(path.join(directory, "github-auth.credentials")), true);
});

test("getToken() disconnects only on fatal refresh errors (401/invalid_grant)", async (t) => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  mock.timers.enable({ apis: ["Date"] });
  t.after(() => mock.timers.reset());

  const fetchFn = createFakeFetch({
    "github.com/login/device/code": [DEVICE_CODE_RESPONSE],
    "github.com/login/oauth/access_token": [
      jsonResponse(200, { access_token: "token-1", refresh_token: "refresh-1", expires_in: 10 }),
      jsonResponse(401, { error: "invalid_grant" }),
    ],
    "api.github.com/user": [jsonResponse(200, { login: "octocat" })],
  });
  const auth = createGitHubAuth({ directory, safeStorage: createFakeSafeStorage(), fetch: fetchFn });
  await authorize(auth, fetchFn);

  mock.timers.tick(11000);
  await assert.rejects(() => auth.getToken(), /重新连接/);
  assert.equal(auth.status().connected, false);
  assert.equal(fs.existsSync(path.join(directory, "github-auth.credentials")), false);
});

test("getToken() disconnects once refreshTokenExpiresAt has passed, without calling the network", async (t) => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  mock.timers.enable({ apis: ["Date"] });
  t.after(() => mock.timers.reset());

  const fetchFn = createFakeFetch({
    "github.com/login/device/code": [DEVICE_CODE_RESPONSE],
    "github.com/login/oauth/access_token": [
      jsonResponse(200, {
        access_token: "token-1",
        refresh_token: "refresh-1",
        expires_in: 10,
        refresh_token_expires_in: 20,
      }),
    ],
    "api.github.com/user": [jsonResponse(200, { login: "octocat" })],
  });
  const auth = createGitHubAuth({ directory, safeStorage: createFakeSafeStorage(), fetch: fetchFn });
  await authorize(auth, fetchFn);

  mock.timers.tick(21000); // past both access and refresh token expiry
  await assert.rejects(() => auth.getToken(), /重新连接/);
  assert.equal(auth.status().connected, false);
  assert.equal(fetchFn.calls.filter((c) => c.url.includes("oauth/access_token")).length, 1); // only the initial grant
});

test("getToken() throws without a fallback when not connected", async (t) => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const auth = createGitHubAuth({ directory, safeStorage: createFakeSafeStorage(), fetch: async () => {
    throw new Error("should not be called");
  } });
  await assert.rejects(() => auth.getToken(), /尚未连接|重新/);
});

test("disconnect() removes credentials and resets login, independent of config", (t) => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const storage = createFakeSafeStorage();
  const auth = createGitHubAuth({ directory, safeStorage: storage, fetch: async () => {
    throw new Error("should not be called");
  } });
  auth.configure({ clientId: CLIENT_ID });
  fs.writeFileSync(
    path.join(directory, "github-auth.credentials"),
    storage.encryptString(JSON.stringify({ accessToken: "x", refreshToken: "y" })),
    { mode: 0o600 },
  );

  const result = auth.disconnect();
  assert.equal(result.connected, false);
  assert.equal(result.login, "");
  assert.equal(result.clientId, CLIENT_ID);
  assert.equal(fs.existsSync(path.join(directory, "github-auth.credentials")), false);
});

test("repository() validates owner/repo input before any network call", async (t) => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const auth = createGitHubAuth({ directory, safeStorage: createFakeSafeStorage(), fetch: async () => {
    throw new Error("should not be called");
  } });
  await assert.rejects(() => auth.repository({ owner: "bad owner!", repo: "repo" }), /owner/);
  await assert.rejects(() => auth.repository({ owner: "owner", repo: "" }), /repo/);
});

test("repository() also requires the user's write permission", async (t) => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  mock.timers.enable({ apis: ["Date"] });
  t.after(() => mock.timers.reset());
  const fetchFn = createFakeFetch({
    "github.com/login/device/code": [DEVICE_CODE_RESPONSE],
    "github.com/login/oauth/access_token": [jsonResponse(200, { access_token: "token-1" })],
    "api.github.com/user": [jsonResponse(200, { login: "octocat" })],
    "api.github.com/repos/octo-org/read-only": [jsonResponse(200, { private: true, permissions: { push: false } })],
  });
  const auth = createGitHubAuth({ directory, safeStorage: createFakeSafeStorage(), fetch: fetchFn });
  await authorize(auth, fetchFn);
  await assert.rejects(auth.repository({ owner: "octo-org", repo: "read-only" }), /用户没有.*写入权限/);
});

test("repository() confirms the repo is bound to this App's installation with contents:write", async (t) => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  mock.timers.enable({ apis: ["Date"] });
  t.after(() => mock.timers.reset());

  const fetchFn = createFakeFetch({
    "github.com/login/device/code": [DEVICE_CODE_RESPONSE],
    "github.com/login/oauth/access_token": [
      jsonResponse(200, { access_token: "token-1", refresh_token: "refresh-1", expires_in: 28800 }),
    ],
    "api.github.com/user": [jsonResponse(200, { login: "octocat" })],
    "api.github.com/repos/octo-org/good-repo": [
      jsonResponse(200, {
        name: "good-repo",
        owner: { login: "octo-org" },
        default_branch: "trunk",
        private: true,
        permissions: { pull: true, push: true, admin: false },
      }),
    ],
    ...installationsRoutes({ appSlug: "my-app", contents: "write", boundRepos: [{ full_name: "octo-org/good-repo" }] }),
  });
  const auth = createGitHubAuth({ directory, safeStorage: createFakeSafeStorage(), fetch: fetchFn });
  await authorize(auth, fetchFn, { appSlug: "my-app" });

  const good = await auth.repository({ owner: "octo-org", repo: "good-repo" });
  assert.deepEqual(good, {
    owner: "octo-org",
    repo: "good-repo",
    defaultBranch: "trunk",
    private: true,
    permissions: { admin: true, push: true, pull: true },
  });
});

test("repository() rejects when the repo is not bound to any installation of this App", async (t) => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  mock.timers.enable({ apis: ["Date"] });
  t.after(() => mock.timers.reset());

  const fetchFn = createFakeFetch({
    "github.com/login/device/code": [DEVICE_CODE_RESPONSE],
    "github.com/login/oauth/access_token": [
      jsonResponse(200, { access_token: "token-1", refresh_token: "refresh-1", expires_in: 28800 }),
    ],
    "api.github.com/user": [jsonResponse(200, { login: "octocat" })],
    "api.github.com/repos/octo-org/unbound-repo": [
      jsonResponse(200, {
        name: "unbound-repo",
        owner: { login: "octo-org" },
        default_branch: "main",
        private: false,
        permissions: { pull: true, push: true, admin: true }, // user has push, but App isn't installed on it
      }),
    ],
    ...installationsRoutes({ appSlug: "my-app", contents: "write", boundRepos: [{ full_name: "octo-org/other-repo" }] }),
  });
  const auth = createGitHubAuth({ directory, safeStorage: createFakeSafeStorage(), fetch: fetchFn });
  await authorize(auth, fetchFn, { appSlug: "my-app" });

  await assert.rejects(
    () => auth.repository({ owner: "octo-org", repo: "unbound-repo" }),
    /未被当前 GitHub App 安装授权/,
  );
});

test("repository() rejects when the App installation lacks contents:write even if bound", async (t) => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  mock.timers.enable({ apis: ["Date"] });
  t.after(() => mock.timers.reset());

  const fetchFn = createFakeFetch({
    "github.com/login/device/code": [DEVICE_CODE_RESPONSE],
    "github.com/login/oauth/access_token": [
      jsonResponse(200, { access_token: "token-1", refresh_token: "refresh-1", expires_in: 28800 }),
    ],
    "api.github.com/user": [jsonResponse(200, { login: "octocat" })],
    "api.github.com/repos/octo-org/read-only-repo": [
      jsonResponse(200, {
        name: "read-only-repo",
        owner: { login: "octo-org" },
        default_branch: "main",
        private: false,
        permissions: { pull: true, push: true, admin: false },
      }),
    ],
    ...installationsRoutes({ appSlug: "my-app", contents: "read", boundRepos: [{ full_name: "octo-org/read-only-repo" }] }),
  });
  const auth = createGitHubAuth({ directory, safeStorage: createFakeSafeStorage(), fetch: fetchFn });
  await authorize(auth, fetchFn, { appSlug: "my-app" });

  await assert.rejects(
    () => auth.repository({ owner: "octo-org", repo: "read-only-repo" }),
    /contents:write/,
  );
});

test("repository() surfaces a 404 from GitHub as an access problem", async (t) => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  mock.timers.enable({ apis: ["Date"] });
  t.after(() => mock.timers.reset());

  const fetchFn = createFakeFetch({
    "github.com/login/device/code": [DEVICE_CODE_RESPONSE],
    "github.com/login/oauth/access_token": [
      jsonResponse(200, { access_token: "token-1", refresh_token: "refresh-1", expires_in: 28800 }),
    ],
    "api.github.com/user": [jsonResponse(200, { login: "octocat" })],
    "api.github.com/repos/octo-org/missing-repo": [jsonResponse(404, { message: "Not Found" })],
  });
  const auth = createGitHubAuth({ directory, safeStorage: createFakeSafeStorage(), fetch: fetchFn });
  await authorize(auth, fetchFn);

  await assert.rejects(() => auth.repository({ owner: "octo-org", repo: "missing-repo" }), /安装未获得|未找到/);
});

test("every outbound request stays within the github.com/login and api.github.com allowlist", async (t) => {
  const directory = temporaryDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  mock.timers.enable({ apis: ["Date"] });
  t.after(() => mock.timers.reset());

  const fetchFn = createFakeFetch({
    "github.com/login/device/code": [DEVICE_CODE_RESPONSE],
    "github.com/login/oauth/access_token": [
      jsonResponse(200, { access_token: "token-1", refresh_token: "refresh-1", expires_in: 28800 }),
    ],
    "api.github.com/user": [jsonResponse(200, { login: "octocat" })],
    "api.github.com/repos/octo-org/good-repo": [
      jsonResponse(200, {
        name: "good-repo",
        owner: { login: "octo-org" },
        default_branch: "main",
        private: false,
        permissions: { pull: true, push: true, admin: true },
      }),
    ],
    ...installationsRoutes({ appSlug: "my-app", contents: "write", boundRepos: [{ full_name: "octo-org/good-repo" }] }),
  });
  const auth = createGitHubAuth({ directory, safeStorage: createFakeSafeStorage(), fetch: fetchFn });
  await authorize(auth, fetchFn, { appSlug: "my-app" });
  await auth.repository({ owner: "octo-org", repo: "good-repo" });

  for (const call of fetchFn.calls) {
    const parsed = new URL(call.url);
    assert.equal(parsed.protocol, "https:");
    const allowed =
      parsed.hostname === "api.github.com" ||
      (parsed.hostname === "github.com" && parsed.pathname.startsWith("/login/"));
    assert.ok(allowed, `unexpected host for ${call.url}`);
    assert.equal(call.options.headers["X-GitHub-Api-Version"], "2022-11-28");
    assert.ok(String(call.options.headers["User-Agent"] || "").length > 0);
    assert.equal(call.options.redirect, "error");
  }
});
