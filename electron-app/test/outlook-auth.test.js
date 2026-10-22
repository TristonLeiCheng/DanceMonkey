const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { createOutlookAuth } = require("../electron/outlook-auth");

const CLIENT = "12345678-1234-1234-1234-123456789abc";
const TENANT = "abcdefab-1234-1234-1234-123456789abc";
const OTHER_CLIENT = "22345678-1234-1234-1234-123456789abc";
const SETTINGS = { clientId: CLIENT, tenantId: TENANT };
const ACCOUNT = { homeAccountId: "user-id.home-tenant", environment: "login.windows.net", tenantId: TENANT, username: "me@example.com", name: "My Name" };
const TOKEN = "never-send-this-access-token-to-the-renderer";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { resolve, reject, promise };
}

function safeStorage() {
  return {
    available: true,
    backend: "keychain",
    isEncryptionAvailable() { return this.available; },
    getSelectedStorageBackend() { return this.backend; },
    encryptString: (value) => Buffer.from(Buffer.from(value).toString("base64")),
    decryptString: (value) => Buffer.from(value.toString(), "base64").toString(),
  };
}

function fakeMsal() {
  const state = { clients: [], login: null, silent: null, authorizeUrl: null };
  state.factory = (configuration) => {
    let cache = { accounts: [], token: "" };
    const client = {
      configuration, requests: [],
      getTokenCache: () => ({
        serialize: () => JSON.stringify(cache),
        deserialize: (value) => { cache = JSON.parse(value); },
        getAllAccounts: async () => cache.accounts,
      }),
      async acquireTokenInteractive(request) {
        client.requests.push(request);
        const url = state.authorizeUrl || `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A42190&state=test`;
        await request.openBrowser(url);
        const result = state.login ? await state.login(request) : { account: ACCOUNT, accessToken: TOKEN };
        cache = { accounts: [result.account], token: result.accessToken };
        return result;
      },
      async acquireTokenSilent(request) {
        client.requests.push(request);
        const result = state.silent ? await state.silent(request) : { account: cache.accounts[0], accessToken: cache.token };
        cache = { accounts: [result.account], token: result.accessToken };
        return result;
      },
    };
    state.clients.push(client);
    return client;
  };
  return state;
}

function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dm-outlook-auth-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const storage = safeStorage();
  const msal = fakeMsal();
  const opened = [];
  const options = { directory, safeStorage: storage, openExternal: async (value) => { opened.push(value); }, msalFactory: msal.factory, ...overrides };
  const auth = createOutlookAuth(options);
  return { auth, storage, msal, opened, directory, options, credentials: path.join(directory, "outlook-auth.credentials") };
}

async function loggedIn(f) {
  await f.auth.configure(SETTINGS);
  await f.auth.connect();
}

test("Outlook requires company tenant GUIDs and exposes no credentials in status", async (t) => {
  const f = fixture(t);
  assert.equal((await f.auth.status()).configured, false);
  await assert.rejects(f.auth.connect(), /应用 ID/);
  await assert.rejects(f.auth.configure({ clientId: "not-a-guid", tenantId: TENANT }), /GUID/);
  await assert.rejects(f.auth.configure({ clientId: CLIENT, tenantId: "common" }), /公司目录/);
  await assert.rejects(f.auth.configure({ clientId: CLIENT, tenantId: "9188040d-6c67-4c5b-b112-36a304b66dad" }), /公司/);
  await loggedIn(f);
  assert.deepEqual(await f.auth.status(), {
    configured: true, connected: true, ...SETTINGS,
    account: { id: `${TENANT}:${ACCOUNT.homeAccountId}`, username: ACCOUNT.username, name: ACCOUNT.name }, secureStorageAvailable: true,
  });
  assert.equal(JSON.stringify(await f.auth.status()).includes(TOKEN), false);
});

test("Outlook uses official public client interactive PKCE with Mail.Read and a system browser", async (t) => {
  const f = fixture(t);
  await loggedIn(f);
  const client = f.msal.clients[0];
  assert.deepEqual(client.configuration.auth, { clientId: CLIENT, authority: `https://login.microsoftonline.com/${TENANT}` });
  assert.deepEqual(client.requests[0].scopes, ["https://graph.microsoft.com/Mail.Read"]);
  assert.equal(client.requests[0].prompt, "select_account");
  assert.match(client.requests[0].nonce, /^[0-9a-f-]{36}$/);
  assert.equal("redirectUri" in client.requests[0], false, "MSAL 7 rejects a supplied redirect URI for browser flow");
  assert.equal("clientSecret" in client.configuration.auth, false);
  assert.equal(f.opened.length, 1);
});

test("MSAL cache and account selector persist only encrypted in a 0600 atomic file and restore after restart", async (t) => {
  const f = fixture(t);
  await loggedIn(f);
  const encrypted = fs.readFileSync(f.credentials);
  assert.equal(encrypted.includes(TOKEN), false);
  assert.equal(encrypted.includes(ACCOUNT.username), false);
  if (process.platform !== "win32") assert.equal(fs.statSync(f.credentials).mode & 0o777, 0o600);
  const payload = JSON.parse(f.storage.decryptString(encrypted));
  assert.equal(payload.selector.homeAccountId, ACCOUNT.homeAccountId);
  assert.ok(payload.cache.includes(TOKEN));
  assert.deepEqual(fs.readdirSync(f.directory).sort(), ["outlook-auth.credentials", "outlook-auth.json"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.directory, "outlook-auth.json"))), SETTINGS);
  const restarted = createOutlookAuth(f.options);
  assert.equal((await restarted.status()).connected, true);
  const session = await restarted.session();
  assert.equal(session.accountId, `${TENANT}:${ACCOUNT.homeAccountId}`);
  assert.equal(await session.getAccessToken(), TOKEN);
});

test("unavailable encryption and Linux basic_text never fall back to plaintext", async (t) => {
  const f = fixture(t);
  await f.auth.configure(SETTINGS);
  f.storage.available = false;
  assert.equal((await f.auth.status()).secureStorageAvailable, false);
  await assert.rejects(f.auth.connect(), /系统安全存储不可用/);
  f.storage.available = true;
  f.storage.backend = "basic_text";
  await assert.rejects(f.auth.connect(), /系统安全存储不可用/);
  assert.equal(f.msal.clients.length, 0);
  assert.equal(fs.existsSync(f.credentials), false);
});

test("corrupt encrypted cache, wrong selector or wrong application cannot restore an identity", async (t) => {
  const f = fixture(t);
  await loggedIn(f);
  const payload = JSON.parse(f.storage.decryptString(fs.readFileSync(f.credentials)));
  for (const value of [
    "not-json", JSON.stringify({ ...payload, clientId: OTHER_CLIENT }),
    JSON.stringify({ ...payload, selector: { ...payload.selector, homeAccountId: "different-user" } }),
  ]) {
    fs.writeFileSync(f.credentials, f.storage.encryptString(value));
    const restarted = createOutlookAuth(f.options);
    assert.equal((await restarted.status()).connected, false);
    await assert.rejects(restarted.session(), /先连接/);
  }
});

test("a second interactive login is rejected and a late login cannot undo disconnect", async (t) => {
  const f = fixture(t);
  const gate = deferred();
  const started = deferred();
  f.msal.login = async () => { started.resolve(); return gate.promise; };
  await f.auth.configure(SETTINGS);
  const login = f.auth.connect();
  await started.promise;
  await assert.rejects(f.auth.connect(), /正在进行/);
  await f.auth.disconnect();
  gate.resolve({ account: ACCOUNT, accessToken: TOKEN });
  await assert.rejects(login, /登录状态已变化/);
  assert.equal((await f.auth.status()).connected, false);
  assert.equal(fs.existsSync(f.credentials), false);
});

test("a timed-out browser login cannot later save credentials", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t);
  const gate = deferred();
  const started = deferred();
  f.msal.login = async () => { started.resolve(); return gate.promise; };
  await f.auth.configure(SETTINGS);
  const login = f.auth.connect();
  await started.promise;
  t.mock.timers.tick(5 * 60 * 1000);
  gate.resolve({ account: ACCOUNT, accessToken: TOKEN });
  await assert.rejects(login, /登录已超时/);
  assert.equal((await f.auth.status()).connected, false);
  assert.equal(fs.existsSync(f.credentials), false);
});

test("changing config invalidates active sessions and discards pending login results", async (t) => {
  const f = fixture(t);
  await loggedIn(f);
  const session = await f.auth.session();
  const gate = deferred();
  const started = deferred();
  f.msal.login = async () => { started.resolve(); return gate.promise; };
  const login = f.auth.connect();
  await started.promise;
  await f.auth.configure({ ...SETTINGS, clientId: OTHER_CLIENT });
  assert.throws(session.assertCurrent, /配置已变化/);
  gate.resolve({ account: ACCOUNT, accessToken: TOKEN });
  await assert.rejects(login, /登录状态已变化/);
  assert.equal((await f.auth.status()).clientId, OTHER_CLIENT);
  assert.equal((await f.auth.status()).connected, false);
  assert.equal(fs.existsSync(f.credentials), false);
});

test("saving unchanged config preserves login; a successful account switch invalidates old sessions", async (t) => {
  const f = fixture(t);
  await loggedIn(f);
  const old = await f.auth.session();
  await f.auth.configure(SETTINGS);
  assert.doesNotThrow(old.assertCurrent);
  f.msal.login = async () => ({ account: { ...ACCOUNT, homeAccountId: "another-user", username: "other@example.com" }, accessToken: "second-token" });
  await f.auth.connect();
  assert.throws(old.assertCurrent, /账号或配置已变化/);
  assert.equal((await f.auth.session()).accountId, `${TENANT}:another-user`);
});

test("late silent refresh after disconnect cannot restore credentials or return a token", async (t) => {
  const f = fixture(t);
  await loggedIn(f);
  const session = await f.auth.session();
  const gate = deferred();
  f.msal.silent = () => gate.promise;
  const refreshing = session.getAccessToken();
  await f.auth.disconnect();
  gate.resolve({ account: ACCOUNT, accessToken: "new-token" });
  await assert.rejects(refreshing, /账号或配置已变化/);
  assert.equal(fs.existsSync(f.credentials), false);
});

test("silent refresh is coalesced and its renewed cache is encrypted", async (t) => {
  const f = fixture(t);
  await loggedIn(f);
  const session = await f.auth.session();
  const gate = deferred();
  let calls = 0;
  f.msal.silent = () => { calls += 1; return gate.promise; };
  const first = session.getAccessToken();
  const second = session.getAccessToken();
  gate.resolve({ account: ACCOUNT, accessToken: "renewed-token" });
  assert.deepEqual(await Promise.all([first, second]), ["renewed-token", "renewed-token"]);
  assert.equal(calls, 1);
  assert.ok(f.storage.decryptString(fs.readFileSync(f.credentials)).includes("renewed-token"));
});

test("transient token failures preserve credentials and sanitize secrets in error messages", async (t) => {
  const f = fixture(t);
  await loggedIn(f);
  const session = await f.auth.session();
  f.msal.silent = async () => { throw new Error(`proxy https://user:password@host token=${TOKEN}`); };
  await assert.rejects(session.getAccessToken(), (cause) => {
    assert.equal(cause.message.includes(TOKEN), false);
    assert.equal(cause.message.includes("password"), false);
    return /Outlook 连接失败/.test(cause.message);
  });
  assert.equal((await f.auth.status()).connected, true);
  assert.equal(fs.existsSync(f.credentials), true);
  assert.doesNotThrow(session.assertCurrent);
});

test("expired consent invalidates login and requires reconnect; another account's token is rejected", async (t) => {
  const f = fixture(t);
  await loggedIn(f);
  let session = await f.auth.session();
  f.msal.silent = async () => { throw Object.assign(new Error("secret server body"), { errorCode: "invalid_grant" }); };
  await assert.rejects(session.getAccessToken(), /重新连接/);
  assert.equal((await f.auth.status()).connected, false);
  assert.equal(fs.existsSync(f.credentials), false);
  await f.auth.connect();
  session = await f.auth.session();
  f.msal.silent = async () => ({ account: { ...ACCOUNT, homeAccountId: "wrong-account" }, accessToken: "wrong-token" });
  await assert.rejects(session.getAccessToken(), /账号不匹配/);
  assert.equal((await f.auth.status()).connected, false);
});

test("interactive login cannot persist an account from a different tenant", async (t) => {
  const f = fixture(t);
  await f.auth.configure(SETTINGS);
  f.msal.login = async () => ({ account: { ...ACCOUNT, tenantId: OTHER_CLIENT }, accessToken: TOKEN });
  await assert.rejects(f.auth.connect(), /公司租户账号/);
  assert.equal(fs.existsSync(f.credentials), false);
});

test("browser URLs and loopback callbacks are validated before opening externally", async (t) => {
  const f = fixture(t);
  await f.auth.configure(SETTINGS);
  for (const value of [
    "https://evil.example/authorize", "https://user:pass@login.microsoftonline.com/authorize",
    `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize?redirect_uri=https://evil.example`,
    `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize?redirect_uri=http://localhost:445/path`,
  ]) {
    f.msal.authorizeUrl = value;
    await assert.rejects(f.auth.connect(), /地址/);
  }
  assert.deepEqual(f.opened, []);
});

test("MSAL network adapter honors supplied proxy fetch, HTTPS allowlist, redirect refusal and timeout", async (t) => {
  const calls = [];
  const f = fixture(t, { fetch: async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ test: true }), { headers: { "request-id": "request-id" } });
  } });
  await loggedIn(f);
  const network = f.msal.clients[0].configuration.system.networkClient;
  const response = await network.sendPostRequestAsync(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, { body: "secret-form", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  assert.equal(calls[0].options.redirect, "error");
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(calls[0].options.body, "secret-form");
  assert.deepEqual(response.body, { test: true });
  assert.equal(response.headers["request-id"], "request-id");
  for (const value of ["https://evil.example/token", "http://login.microsoftonline.com/token", "https://login.microsoftonline.com:8443/token"]) {
    await assert.rejects(network.sendPostRequestAsync(value, { body: "secret" }), /地址/);
  }
  assert.equal(calls.length, 1);
});

test("real MSAL 7 browser flow uses PKCE and disconnect closes its loopback server without real authentication", async (t) => {
  const started = deferred();
  let callback;
  const f = fixture(t, {
    msalFactory: (configuration) => new (require("@azure/msal-node").PublicClientApplication)(configuration),
    openExternal: async (value) => {
      const authorize = new URL(value);
      assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
      assert.ok(authorize.searchParams.get("code_challenge"));
      assert.equal(authorize.searchParams.get("response_mode"), "form_post");
      callback = new URL(authorize.searchParams.get("redirect_uri"));
      started.resolve();
    },
    fetch: async () => new Response(JSON.stringify({
      issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`,
      authorization_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`,
      token_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
      jwks_uri: `https://login.microsoftonline.com/${TENANT}/discovery/v2.0/keys`,
      end_session_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/logout`,
    })),
  });
  await f.auth.configure(SETTINGS);
  const login = f.auth.connect();
  // Ensure a failure before the callback does not leave this test waiting forever.
  await Promise.race([started.promise, login]);
  assert.ok(callback);
  await f.auth.disconnect();
  await assert.rejects(login, /登录状态已变化/);
  await new Promise((resolve, reject) => {
    const req = http.get({ hostname: "127.0.0.1", port: Number(callback.port), path: "/" }, (response) => {
      response.resume();
      reject(new Error("MSAL loopback server is still listening after disconnect"));
    });
    req.on("error", (cause) => cause.code === "ECONNREFUSED" ? resolve() : reject(cause));
    req.setTimeout(2000, () => { req.destroy(); reject(new Error("Loopback close check timed out")); });
  });
  assert.equal(fs.existsSync(f.credentials), false);
});
