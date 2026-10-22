// Test-only launcher: real app/UI/IPC/importer/storage, deterministic external services.
// It is never imported by production main.js. All data lives in DM_E2E_ROOT.
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const crypto = require("node:crypto");
if (!process.env.DM_E2E_ROOT) throw new Error("Outlook E2E requires an isolated data directory");
const root = fs.realpathSync(process.env.DM_E2E_ROOT);
const control = () => JSON.parse(fs.readFileSync(path.join(root, "outlook-control.json"), "utf8"));
const json = (data) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
const key = crypto.createHash("sha256").update(root).digest();
const testStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv); const bytes = Buffer.concat([c.update(text, "utf8"), c.final()]); return Buffer.concat([iv, c.getAuthTag(), bytes]); },
  decryptString: (bytes) => { const d = crypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12)); d.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([d.update(bytes.subarray(28)), d.final()]).toString(); },
};
function fakeMsal(config) {
  let cache = { accounts: [], token: "e2e-outlook-only" };
  const account = { homeAccountId: "e2e-user", tenantId: config.auth.authority.split("/").at(-1), environment: "login.windows.net", username: "reader@example.com", name: "测试账号" };
  return {
    getTokenCache: () => ({ serialize: () => JSON.stringify(cache), deserialize: (value) => { cache = JSON.parse(value); }, getAllAccounts: async () => cache.accounts }),
    acquireTokenInteractive: async (request) => {
      await request.openBrowser(`${config.auth.authority}/oauth2/v2.0/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A42190&state=e2e`);
      cache.accounts = [account]; return { account, accessToken: cache.token };
    },
    acquireTokenSilent: async () => ({ account: cache.accounts[0], accessToken: cache.token }),
  };
}
function mail(id, text) {
  return { id, parentFolderId: "inbox-id", internetMessageId: `<${id}@example.com>`, conversationId: "thread-one",
    subject: "项目判断 " + id, sentDateTime: "2026-10-20T10:00:00Z", receivedDateTime: "2026-10-20T10:01:00Z",
    from: { emailAddress: { address: "person@example.com" } }, sender: { emailAddress: { address: "person@example.com" } },
    isDraft: false, webLink: "https://outlook.office.com/mail/id/" + id, uniqueBody: { contentType: "html", content: text } };
}
async function fakeFetch(input, options = {}) {
  const url = new URL(input);
  if (url.hostname === "127.0.0.1") return globalThis.fetch(input, options);
  if (url.origin !== "https://graph.microsoft.com") throw new Error("E2E blocks all external network traffic");
  if (options.headers?.Authorization !== "Bearer e2e-outlook-only") throw new Error("E2E expected mock token");
  const state = control();
  if (state.graphDelay) await new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); reject(new Error("cancelled")); };
    const timer = setTimeout(() => { options.signal?.removeEventListener("abort", cancel); resolve(); }, state.graphDelay);
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
  });
  const folder = /^\/v1\.0\/me\/mailFolders\/([^/]+)$/.exec(url.pathname);
  if (folder) {
    const id = decodeURIComponent(folder[1]);
    if (id === "msgfolderroot") return json({ id: "root-id" });
    if (id === "inbox-id") return json({ id, parentFolderId: "root-id" });
    if (["deleteditems", "junkemail", "drafts", "outbox"].includes(id)) return json({ id: id + "-id" });
    throw new Error("Unexpected test folder");
  }
  const messages = [mail("m1", "<p>先列证据，再做判断。</p><blockquote>他人的观点不应学入。</blockquote>"),
    mail("m2", "<p>用小实验验证假设，再扩大投入。</p>"), mail("copy", "<p>用小实验验证假设，再扩大投入。</p>")];
  if (state.mailVersion >= 2) messages.unshift(mail("m3", "<p>新的经验：给每个方案设置停止条件。</p>"));
  if (state.mailVersion >= 3) messages.unshift(mail("m4", "<p>失败重试时先检查假设是否变化。</p>"));
  if (url.pathname === "/v1.0/me/messages") {
    if (!url.searchParams.get("$filter")?.includes("from/emailAddress/address eq 'person@example.com'")) throw new Error("Unexpected author query");
    return json({ value: messages });
  }
  const id = decodeURIComponent(url.pathname.split("/").at(-1));
  const item = messages.find((item) => item.id === id);
  if (!item) throw new Error("Unexpected test message");
  return json(item);
}
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  const resolved = Module._resolveFilename(request, parent, isMain);
  const loaded = originalLoad.call(this, request, parent, isMain);
  if (resolved.endsWith("/electron/outlook-auth.js")) return { ...loaded, createOutlookAuth: (options) => loaded.createOutlookAuth({ ...options, safeStorage: testStorage, msalFactory: fakeMsal, openExternal: async () => {} }) };
  if (resolved.endsWith("/electron/system-proxy.js")) return { ...loaded, fetchWithSystemProxy: fakeFetch };
  return loaded;
};
require("../../electron/main.js");
