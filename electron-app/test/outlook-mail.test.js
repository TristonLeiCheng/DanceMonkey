const test = require("node:test");
const assert = require("node:assert/strict");
const { createOutlookMailClient, normalizeEmail, cleanMailBody, MAX_MAIL_CHARS } = require("../electron/outlook-mail");

const AUTHOR = "person@example.com";
const SINCE = "2026-01-01T00:00:00.000Z";
function session(overrides = {}) {
  return { accountId: "account-a", username: "owner@example.com", assertCurrent() {}, async getAccessToken() { return "test-access-token"; }, ...overrides };
}
function message(id, extra = {}) {
  return {
    id, parentFolderId: "inbox-id", from: { emailAddress: { address: AUTHOR } }, sender: { emailAddress: { address: AUTHOR } },
    subject: `邮件 ${id}`, internetMessageId: `<${id}@example.com>`, conversationId: "conversation-one",
    receivedDateTime: "2026-10-20T00:00:00Z", sentDateTime: "2026-10-19T23:59:00Z", isDraft: false,
    webLink: "https://outlook.office.com/mail/id/test", uniqueBody: { contentType: "text", content: `这是作者写的正文 ${id}。` },
    ...extra,
  };
}
function json(value, status = 200, headers = {}) { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } }); }
function harness({ pages, details = {}, onFetch, options = {} } = {}) {
  const calls = [];
  let listIndex = 0;
  const fetch = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    const overridden = await onFetch?.(url, init, calls);
    if (overridden) return overridden;
    const folder = /^\/v1\.0\/me\/mailFolders\/([^/]+)$/.exec(url.pathname);
    if (folder) {
      const id = decodeURIComponent(folder[1]);
      if (["deleteditems", "junkemail", "drafts", "outbox"].includes(id)) return json({ id: `${id}-id` });
      if (id === "msgfolderroot") return json({ id: "root-id" });
      if (id === "inbox-id") return json({ id, parentFolderId: "root-id" });
      if (id === "root-id") return json({ id });
      return json({ error: "No mock folder" }, 404);
    }
    if (url.pathname === "/v1.0/me/messages") {
      const page = (pages || [{ value: [] }])[listIndex++];
      assert.ok(page, `unexpected list request ${listIndex}`);
      return json(page);
    }
    const detail = /^\/v1\.0\/me\/messages\/([^/]+)$/.exec(url.pathname);
    if (detail) {
      const id = decodeURIComponent(detail[1]);
      return json(details[id] || message(id));
    }
    assert.fail(`unexpected request ${url}`);
  };
  const client = createOutlookMailClient({ fetch, ...options });
  return { calls, search: (args = {}) => client.search({ session: session(), email: AUTHOR, since: SINCE, ...args }) };
}

test("all-time import uses a bounded historical filter while retaining required sort order", async () => {
  const h = harness(); await h.search({ since: null });
  const query = h.calls.find((item) => item.url.pathname === "/v1.0/me/messages").url;
  assert.match(query.searchParams.get("$filter"), /^receivedDateTime ge 1900-01-01T00:00:00.000Z and from/);
});

test("raw proxy or transport errors never expose credentials to the UI", async () => {
  const h = harness({ onFetch: () => { throw new Error("proxy https://secret-user:secret-password@internal"); } });
  await assert.rejects(h.search(), (error) => /无法连接 Outlook/.test(error.message) && !/secret/.test(error.message));
});

test("email normalization rejects filter injection, malformed domains and header text", () => {
  assert.equal(normalizeEmail(" Person+tag@EXAMPLE.com "), "person+tag@example.com");
  assert.equal(normalizeEmail("o'brien@example.com"), "o'brien@example.com");
  for (const value of ["x@example.com' or true", "Person <x@example.com>", "x\n@example.com", "x@@example.com", ".x@example.com", "x..y@example.com", "x@-example.com", "x@example..com", null]) {
    assert.throws(() => normalizeEmail(value), /邮箱/);
  }
});

test("HTML cleanup decodes entities and drops executable, hidden and quoted content without executing it", () => {
  const result = cleanMailBody({ contentType: "html", content: '<html><head><style>secret-css</style></head><body><div>我的&nbsp;观点 &amp; 方法。</div><img src="https://track.example.com/pixel" onerror="globalThis.ran=true"><script>globalThis.ran=true</script><div hidden>hidden secret</div><p style="display: none">hidden2</p><blockquote><div>他人观点</div></blockquote><p>我的第二段。</p><div class="gmail_signature">电话：1234</div></body></html>' });
  assert.equal(result, "我的 观点 & 方法。\n\n我的第二段。");
  assert.equal(globalThis.ran, undefined);
});

test("Outlook and Gmail HTML quote containers are removed", () => {
  assert.equal(cleanMailBody({ contentType: "html", content: '<p>我的新意见。</p><div id="divRplyFwdMsg">From: 他人</div><div>整个原始邮件。</div>' }), "我的新意见。");
  assert.equal(cleanMailBody({ contentType: "html", content: '<p>我的新意见。</p><div class="gmail_quote"><div>其他人</div></div>' }), "我的新意见。");
});

test("Chinese and English reply headers, signatures and disclaimers are stripped", () => {
  for (const tail of [
    "From: Someone\nSent: Monday\nTo: Target\nSubject: Old\n他人正文",
    "发件人：其他人\n发送时间：昨天\n收件人：作者\n主题：历史\n他人正文",
    "On Mon, Oct 20, Someone wrote:\n> quoted text",
    "On Mon, Oct 20, Someone\n<someone@example.com> wrote:\nquoted text",
    "2026年10月20日，其他人写道：\n其他人正文",
    "-----Original Message-----\n他人正文",
    "-- \n姓名\n电话：1234",
    "Sent from my iPhone\n签名",
    "This email and any attachments are confidential.\n免责声明",
    "本邮件可能包含保密信息。\n后续免责声明",
  ]) assert.equal(cleanMailBody({ contentType: "text", content: `这是作者的观点。\n\n${tail}` }), "这是作者的观点。", tail);
  assert.equal(cleanMailBody({ contentType: "text", content: "正文\nRegards,\nPerson\nPhone: 1234" }), "正文\nRegards,");
  assert.equal(cleanMailBody({ contentType: "text", content: "From: a field in this example\n普通内容\n> quoted\n我的追加说明" }), "From: a field in this example\n普通内容\n我的追加说明");
});

test("search uses exact escaped sender filtering, stable IDs and full uniqueBody, never previews", async () => {
  const author = "o'brien@example.com";
  const item = message("one", { from: { emailAddress: { address: author } }, sender: { emailAddress: { address: author } } });
  const full = "完整原创正文".repeat(100);
  const h = harness({ pages: [{ value: [item] }], details: { one: { ...item, uniqueBody: { contentType: "text", content: full }, bodyPreview: "truncated preview", body: { contentType: "text", content: "他人引用" } } } });
  const result = await h.search({ email: author });
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].text, full);
  assert.equal(result.messages[0].externalId, "one");
  assert.equal(result.messages[0].receivedAt, "2026-10-20T00:00:00.000Z");
  assert.match(result.messages[0].contentHash, /^[a-f0-9]{64}$/);
  const list = h.calls.find(({ url }) => url.pathname === "/v1.0/me/messages");
  assert.equal(list.url.searchParams.get("$filter"), `receivedDateTime ge ${SINCE} and from/emailAddress/address eq 'o''brien@example.com'`);
  assert.equal(list.url.searchParams.get("$orderby"), "receivedDateTime desc");
  for (const { init } of h.calls) {
    assert.equal(init.headers.Authorization, "Bearer test-access-token");
    assert.match(init.headers.Prefer, /IdType="ImmutableId"/);
    assert.match(init.headers.Prefer, /outlook.body-content-type="text"/);
    assert.equal(init.redirect, "error");
  }
  assert.ok(h.calls.some(({ url }) => url.searchParams.get("$select")?.includes("uniqueBody")));
});

test("pagination removes duplicate IDs, internet IDs and duplicate content", async () => {
  const next = "https://graph.microsoft.com/v1.0/me/messages?$skip=2";
  const h = harness({ pages: [
    { value: [message("one"), message("two")], "@odata.nextLink": next },
    { value: [message("one"), message("three"), message("four")] },
  ], details: {
    two: message("two", { uniqueBody: { contentType: "text", content: "这是作者写的正文  one。" } }),
    three: message("three", { uniqueBody: { contentType: "text", content: "这是作者写的正文 one。" } }),
    four: message("four", { internetMessageId: "<one@example.com>" }),
  } });
  const progress = [];
  const result = await h.search({ onProgress: (value) => progress.push(value) });
  assert.deepEqual(result.messages.map(({ externalId }) => externalId), ["one"]);
  assert.equal(result.scanned, 5);
  assert.equal(result.skipped.duplicate, 4);
  assert.equal(result.hasMore, false);
  assert.equal(progress.at(-1).scanned, 5);
});

test("limit bounds scanned mail including skipped mail and reports remaining results", async () => {
  const h = harness({ pages: [{ value: [message("one"), message("two", { isDraft: true }), message("three")], "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/messages?$skip=3" }] });
  const result = await h.search({ limit: 2 });
  assert.equal(result.scanned, 2);
  assert.equal(result.messages.length, 1);
  assert.equal(result.skipped.draft, 1);
  assert.equal(result.hasMore, true);
  assert.equal(h.calls.filter(({ url }) => url.pathname === "/v1.0/me/messages").length, 1);
});

test("a full final page without a continuation does not claim more mail", async () => {
  const h = harness({ pages: [{ value: [message("one")] }] });
  const result = await h.search({ limit: 1 });
  assert.equal(result.hasMore, false);
});

test("drafts, junk, deleted subfolders, automated notifications and delegated senders are excluded", async () => {
  const h = harness({ pages: [{ value: [
    message("draft", { isDraft: true }), message("junk", { parentFolderId: "junkemail-id" }),
    message("deleted", { parentFolderId: "deleted-child" }),
    message("automated", { subject: "自动回复：不在办公室" }),
    message("sender", { sender: { emailAddress: { address: "other@example.com" } } }),
    message("from", { from: { emailAddress: { address: "other@example.com" } } }),
    message("headers"), message("event", { "@odata.type": "#microsoft.graph.eventMessageRequest" }),
  ] }], details: { headers: message("headers", { internetMessageHeaders: [{ name: "Auto-Submitted", value: "auto-replied" }] }) }, onFetch(url) {
    if (url.pathname.endsWith("/mailFolders/deleted-child")) return json({ id: "deleted-child", parentFolderId: "deleteditems-id" });
  } });
  const result = await h.search();
  assert.equal(result.messages.length, 0);
  assert.equal(result.skipped.draft, 1);
  assert.equal(result.skipped.excludedFolder, 2);
  assert.equal(result.skipped.notAuthor, 2);
  assert.equal(result.skipped.automated, 3);
});

test("sender, folder and draft are revalidated on detail after listing", async () => {
  const h = harness({ pages: [{ value: [message("one"), message("two"), message("three")] }], details: {
    one: message("one", { sender: { emailAddress: { address: "attacker@example.com" } } }),
    two: message("two", { parentFolderId: "deleteditems-id" }), three: message("three", { isDraft: true }),
  } });
  const result = await h.search();
  assert.equal(result.messages.length, 0);
  assert.equal(result.skipped.notAuthor, 1);
  assert.equal(result.skipped.excludedFolder, 1);
  assert.equal(result.skipped.draft, 1);
});

test("missing uniqueBody falls back to cleaned full body, while an empty uniqueBody stays empty", async () => {
  const h = harness({ pages: [{ value: [message("one"), message("two"), message("three")] }], details: {
    one: message("one", { uniqueBody: null, body: { contentType: "text", content: "原创正文\n-----Original Message-----\n他人文字" } }),
    two: message("two", { uniqueBody: { contentType: "text", content: "" }, body: { contentType: "text", content: "不应使用引用正文" } }),
    three: message("three", { uniqueBody: null, bodyPreview: "不得使用截断预览" }),
  } });
  const result = await h.search();
  assert.equal(result.messages[0].text, "原创正文");
  assert.equal(result.messages.length, 1);
  assert.equal(result.skipped.empty, 2);
});

test("oversized mail is counted instead of silently truncated", async () => {
  const h = harness({ pages: [{ value: [message("one"), message("two"), message("three")] }], details: {
    one: message("one", { uniqueBody: { contentType: "text", content: "x".repeat(MAX_MAIL_CHARS + 1) } }),
    two: message("two", { uniqueBody: { contentType: "html", content: "x".repeat(512001) } }),
    three: message("three", { uniqueBody: { contentType: "text", content: "y".repeat(MAX_MAIL_CHARS) } }),
  } });
  const result = await h.search();
  assert.equal(result.skipped.tooLong, 2);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].text.length, MAX_MAIL_CHARS);
});

test("malicious external pagination is rejected before any token can reach another host", async () => {
  for (const next of ["https://evil.example.com/v1.0/me/messages", "https://graph.microsoft.com.evil.example/v1.0/me/messages", "https://user:secret@graph.microsoft.com/v1.0/me/messages", "http://graph.microsoft.com/v1.0/me/messages", "https://graph.microsoft.com/v1.0/users/another/messages", "https://graph.microsoft.com/v1.0/me/messages/one", "https://graph.microsoft.com/v1.0/me/messages#fragment"]) {
    const h = harness({ pages: [{ value: [], "@odata.nextLink": next }] });
    await assert.rejects(h.search(), /不受信任/);
    assert.ok(h.calls.every(({ url }) => url.origin === "https://graph.microsoft.com"));
  }
});

test("repeated pages fail instead of cycling forever", async () => {
  const next = "https://graph.microsoft.com/v1.0/me/messages?$skip=1";
  const h = harness({ pages: [{ value: [], "@odata.nextLink": next }, { value: [], "@odata.nextLink": next }] });
  await assert.rejects(h.search(), /分页重复/);
});

test("requests retry throttling and transient errors within bounded attempts", async () => {
  let tries = 0;
  const h = harness({ onFetch(url) {
    if (url.pathname.endsWith("/deleteditems") && ++tries < 3) return json({}, tries === 1 ? 429 : 503, { "retry-after": "0" });
  } });
  const result = await h.search();
  assert.equal(tries, 3);
  assert.equal(result.messages.length, 0);
  const stuck = harness({ onFetch() { return json({}, 504, { "retry-after": "0" }); } });
  await assert.rejects(stuck.search(), /HTTP 504/);
  assert.equal(stuck.calls.length, 3);
});

test("long Retry-After is respected by stopping instead of retrying early", async () => {
  const h = harness({ onFetch() { return json({}, 429, { "retry-after": "120" }); } });
  await assert.rejects(h.search(), /过于频繁/);
  assert.equal(h.calls.length, 1);
});

test("cancel interrupts retry backoff and in-flight fetch", async () => {
  const retryController = new AbortController();
  const h = harness({ onFetch() { setTimeout(() => retryController.abort(), 5); return json({}, 429, { "retry-after": "30" }); } });
  await assert.rejects(h.search({ signal: retryController.signal }), { name: "AbortError" });
  assert.equal(h.calls.length, 1);
  const fetchController = new AbortController();
  const blocked = harness({ onFetch() { setTimeout(() => fetchController.abort(), 5); return new Promise(() => {}); } });
  await assert.rejects(blocked.search({ signal: fetchController.signal }), { name: "AbortError" });
});

test("token acquisition, request and overall import all have cancellable deadlines", async () => {
  const token = harness({ options: { requestTimeoutMs: 10 } });
  await assert.rejects(token.search({ session: session({ getAccessToken: () => new Promise(() => {}) }) }), /请求超时/);
  assert.equal(token.calls.length, 0);
  const overall = harness({ options: { overallTimeoutMs: 10 }, onFetch() { return new Promise(() => {}); } });
  await assert.rejects(overall.search(), /导入超时/);
});

test("account disconnection before and after token retrieval prevents requests", async () => {
  const h = harness();
  await assert.rejects(h.search({ session: session({ assertCurrent() { throw new Error("账号已断开"); } }) }), /账号已断开/);
  assert.equal(h.calls.length, 0);
  let disconnected = false;
  await assert.rejects(h.search({ session: session({
    assertCurrent() { if (disconnected) throw new Error("账号已切换"); },
    async getAccessToken() { disconnected = true; return "old-account-token"; },
  }) }), /账号已切换/);
  assert.equal(h.calls.length, 0);
});

test("account disconnection during a response prevents returning mail", async () => {
  let disconnected = false;
  const h = harness({ onFetch() { disconnected = true; return json({ id: "deleted-id" }); } });
  await assert.rejects(h.search({ session: session({ assertCurrent() { if (disconnected) throw new Error("账号已切换"); } }) }), /账号已切换/);
  assert.equal(h.calls.length, 1);
});

test("missing messages are counted, permission failures remain actionable and do not expose remote bodies", async () => {
  const missing = harness({ pages: [{ value: [message("one")] }], onFetch(url) {
    if (url.pathname.endsWith("/messages/one")) return json({}, 404);
  } });
  assert.equal((await missing.search()).skipped.unavailable, 1);
  const denied = harness({ onFetch() { return json({ error: "secret server body and token" }, 403); } });
  await assert.rejects(denied.search(), (error) => /Mail.Read/.test(error.message) && !error.message.includes("secret"));
});

test("malformed and oversized Graph responses fail safely", async () => {
  const malformed = harness({ pages: [{ value: "bad" }] });
  await assert.rejects(malformed.search(), /列表格式无效/);
  const invalid = harness({ onFetch() { return new Response("not json"); } });
  await assert.rejects(invalid.search(), /数据格式无效/);
  const tooBig = harness({ onFetch() { return json({}, 200, { "content-length": String(5 * 1024 * 1024) }); } });
  await assert.rejects(tooBig.search(), /数据过大/);
});

test("unsafe source links are omitted and invalid input never starts a request", async () => {
  const h = harness({ pages: [{ value: [message("one")] }], details: { one: message("one", { webLink: "javascript:alert(1)" }) } });
  assert.equal((await h.search()).messages[0].webLink, "");
  const invalid = harness();
  await assert.rejects(invalid.search({ limit: 201 }), /200/);
  await assert.rejects(invalid.search({ since: "not a date" }), /起始日期/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(invalid.search({ signal: controller.signal }), { name: "AbortError" });
  assert.equal(invalid.calls.length, 0);
});
