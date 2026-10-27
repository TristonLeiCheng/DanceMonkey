const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const profileSource = fs.readFileSync(path.join(__dirname, "../src/persona-profile.js"), "utf8");
const demoSource = fs.readFileSync(path.join(__dirname, "../src/persona-demos.js"), "utf8");
const source = fs.readFileSync(path.join(__dirname, "../src/persona-manager.js"), "utf8");
const clone = (value) => JSON.parse(JSON.stringify(value));
const escape = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const card = { summary: "人物简介", knowledge: "设计", thinking: "先举例", style: "简练", boundaries: "不编造" };
function person(id) { return { id, name: id, description: "", sources: [], card: null, cardVersion: 0, sourceRevision: 0, versions: [], conversations: [], activeConversationId: null }; }
function fixture(overrides = {}, initial = [person("A"), person("B")], outlookService = null) {
  const records = new Map(initial.map((p) => [p.id, clone(p)]));
  const calls = [], fields = new Map(), notes = new Map();
  let root = "/vault-A", html = "", chunks, progress;
  const stream = { textContent: "" };
  const progressNode = { textContent: "" };
  const service = {
    list: async () => [...records.values()].map(clone),
    get: async (id) => clone(records.get(id)),
    create: async ({ name, description }) => { const p = { ...person(name), description }; records.set(name, p); return clone(p); },
    addSources: async ({ id, sources }) => { calls.push(["addSources", id, clone(sources)]); const p = records.get(id); p.sources.push(...sources.map((s) => ({ ...s, id: "source-1" }))); p.sourceRevision++; return clone(p); },
    generate: async (input) => { calls.push(["generate", clone(input)]); return { card: clone(card), baseVersion: records.get(input.id).cardVersion, sourceRevision: records.get(input.id).sourceRevision }; },
    saveCard: async (input) => { calls.push(["saveCard", clone(input)]); const p = records.get(input.id); p.card = clone(input.card); p.cardVersion++; return clone(p); },
    importNotes: async (input) => { calls.push(["importNotes", clone(input)]); return clone(records.get(input.id)); },
    cancel: async (id) => { calls.push(["cancel", id]); return true; },
    onChunk: (cb) => { chunks = cb; }, onProgress: (cb) => { progress = cb; },
    ...overrides,
  };
  const page = {
    querySelector: () => null,
    querySelectorAll: (selector) => selector === "[data-persona-field]" ? [...fields.values()] : selector === "[data-persona-note]" ? [...notes.values()] : [],
  };
  const scope = { querySelector: (selector) => selector === ".persona-page" ? page : selector === "[data-persona-stream]" ? stream : selector === "[data-persona-progress]" ? progressNode : null };
  const context = vm.createContext({ window: {}, Date, Math });
  vm.runInContext(profileSource + "\n" + demoSource + "\n" + source, context);
  const manager = context.window.DMPersonaManager.create({ personas: service, ...(outlookService ? { outlook: outlookService } : {}), workspace: { list: async () => ({ root, tree: [{ type: "file", path: "one.md", name: "One" }] }) } }, { esc: escape, attr: escape, rerender: () => { html = manager.render(); manager.bind(scope); } });
  const set = (key, value, tagName = "INPUT") => {
    const field = { value, tagName, dataset: { personaField: key } };
    fields.set(key, field); manager.bind(scope); (tagName === "SELECT" ? field.onchange : field.oninput)();
  };
  const chooseNote = (file) => { const node = { checked: true, dataset: { personaNote: file } }; notes.set(file, node); manager.bind(scope); node.onchange(); };
  return { manager, service, calls, records, set, fields, chooseNote, html: () => html || manager.render(), setRoot: (value) => { root = value; }, stream, progressNode, chunk: (event) => chunks(event), progress: (event) => progress(event) };
}

function outlookFixture(overrides = {}, stateOverrides = {}) {
  let state = { configured: true, connected: true, clientId: "client-1", tenantId: "tenant-1", account: { id: "account-1", username: "reader@example.com", name: "Reader" }, secureStorageAvailable: true, ...stateOverrides };
  let progress;
  const calls = [];
  const api = {
    status: async () => clone(state),
    configure: async (input) => { calls.push(["configure", clone(input)]); state = { ...state, ...input, configured: true, connected: false, account: null }; },
    connect: async () => { calls.push(["connect"]); state = { ...state, connected: true, account: { id: "account-1", username: "reader@example.com" } }; },
    disconnect: async () => { calls.push(["disconnect"]); state = { ...state, connected: false, account: null }; },
    cancel: async (id) => { calls.push(["cancel", id]); return true; },
    onProgress: (cb) => { progress = cb; },
    ...overrides,
  };
  return { api, calls, progress: (event) => progress(event), setState: (input) => { state = { ...state, ...input }; } };
}

test("browser preview explicitly requires desktop and does not fabricate a persona", () => {
  const context = vm.createContext({ window: {} }); vm.runInContext(profileSource + "\n" + demoSource + "\n" + source, context);
  const manager = context.window.DMPersonaManager.create({}, { esc: escape, attr: escape, rerender() {} });
  assert.match(manager.render(), /桌面版/);
  assert.doesNotMatch(manager.render(), /data-persona-action="create"/);
});

test("profile editor records manual events, scores observed MBTI, and saves through validated profile API", async () => {
  let saved;
  const f = fixture({ updateProfile: async (input) => {
    saved = clone(input); const p = f.records.get(input.id);
    if (input.profile) { assert.equal(input.baseRevision, p.sourceRevision); p.profile = input.profile; }
    if (input.name) p.name = input.name;
    p.sourceRevision++; return clone(p);
  } });
  await f.manager.load(); await f.manager.handleAction("tab", "profile");
  assert.match(f.html(), /出生年月/); assert.match(f.html(), /人物事件/);
  f.set("profile:birthDate", "1990-05"); f.set("profile:events", "2025-01：带领项目完成验证。");
  await f.manager.handleAction("assess-mbti"); assert.match(f.html(), /完成全部/);
  for (let i=0;i<12;i++) f.set("answer:" + i, "-1", "SELECT");
  await f.manager.handleAction("assess-mbti"); assert.match(f.html(), /INFP/);
  f.set("name", "已修改的名称"); await f.manager.handleAction("save-profile");
  assert.match(f.html(), /项目完成/);
  await f.manager.handleAction("save-details");
  assert.equal(saved.profile.mbti, "INFP"); assert.equal(saved.profile.mbtiMode, "assessment");
  assert.equal(saved.profile.birthDate, "1990-05"); assert.match(saved.profile.events, /项目完成/);
  f.set("profile:events", "2026-01：更新事件。"); await f.manager.handleAction("save-details-generate");
  assert.match(f.records.get("A").profile.events, /更新事件/);
  assert.equal(f.records.get("A").card, null); assert.match(f.html(), /尚未保存/);
  await f.manager.handleAction("select", "B"); await f.manager.handleAction("tab", "profile");
  assert.doesNotMatch(f.html(), /项目完成/);
});

test("chat import requires target speaker and keeps source draft on validation failure", async () => {
  const f = fixture(); await f.manager.load();
  f.set("kind", "chat", "SELECT"); f.set("text", "A: 先举例\nB: 我不同意");
  await f.manager.handleAction("add-source");
  assert.equal(f.calls.length, 0); assert.match(f.html(), /请填写目标说话人/); assert.match(f.html(), /A: 先举例/);
  f.set("speaker", "A"); await f.manager.handleAction("add-source");
  assert.equal(f.calls[0][2][0].speaker, "A");
  assert.equal(f.calls[0][2][0].kind, "chat");
});

test("persona generation is preview-only and edited preview is saved explicitly", async () => {
  const f = fixture(); await f.manager.load();
  f.set("text", "设计观点"); await f.manager.handleAction("add-source");
  await f.manager.handleAction("generate");
  assert.equal(f.records.get("A").card, null); assert.match(f.html(), /尚未保存/);
  f.set("card:style", "<script>恶意样本</script> 保持简练");
  await f.manager.handleAction("tab", "sources"); await f.manager.handleAction("tab", "card");
  assert.match(f.html(), /&lt;script&gt;/); assert.doesNotMatch(f.html(), /<script>/);
  await f.manager.handleAction("save-card");
  assert.equal(f.records.get("A").card.style, "<script>恶意样本</script> 保持简练");
  assert.equal(f.calls.filter(([type]) => type === "saveCard").length, 1);
});

test("switching people preserves separate source and question drafts", async () => {
  const f = fixture(); await f.manager.load();
  f.set("text", "A 的未提交资料"); f.set("question", "A 的问题");
  await f.manager.handleAction("select", "B");
  assert.doesNotMatch(f.html(), /A 的未提交资料/);
  f.set("text", "B 的未提交资料");
  await f.manager.handleAction("select", "A"); assert.match(f.html(), /A 的未提交资料/);
  await f.manager.handleAction("tab", "chat"); assert.match(f.html(), /A 的问题/); assert.doesNotMatch(f.html(), /B 的未提交资料/);
});

test("import notes refuses a changed vault and passes original root on success", async () => {
  const f = fixture(); await f.manager.load(); await f.manager.handleAction("pick-notes"); f.chooseNote("one.md");
  f.setRoot("/vault-B"); await f.manager.handleAction("import-notes");
  assert.equal(f.calls.length, 0); assert.match(f.html(), /笔记库已切换/);
  await f.manager.handleAction("pick-notes"); f.chooseNote("one.md"); await f.manager.handleAction("import-notes");
  assert.equal(f.calls[0][1].root, "/vault-B"); assert.deepEqual(f.calls[0][1].paths, ["one.md"]);
});

test("only matching chat chunks render, busy switching is blocked, cancel keeps failed prompt", async () => {
  let reject, sent;
  const p = person("A"); p.card = clone(card); p.cardVersion = 1;
  const f = fixture({ chat: (input) => { sent = input; return new Promise((_resolve, no) => { reject = no; }); } }, [p, person("B")]);
  await f.manager.load(); await f.manager.handleAction("tab", "chat"); f.set("question", "请举例");
  const pending = f.manager.handleAction("send");
  f.chunk({ requestId: "other", chunk: "串话" }); assert.equal(f.stream.textContent, "");
  f.chunk({ requestId: sent.requestId, chunk: "正确回复" }); assert.equal(f.stream.textContent, "正确回复");
  await f.manager.handleAction("select", "B"); assert.match(f.html(), /data-id="A" class="persona-person selected"/);
  await f.manager.handleAction("cancel"); assert.equal(f.calls.at(-1)[1], sent.requestId);
  reject(new Error("已停止")); await pending;
  assert.match(f.html(), /请举例/); assert.match(f.html(), /已停止/);
  f.chunk({ requestId: sent.requestId, chunk: "迟到" }); assert.equal(f.stream.textContent, "正确回复");
});

test("failed save retains editable preview and correction draft", async () => {
  const p = person("A"); p.card = clone(card); p.cardVersion = 1;
  const f = fixture({ saveCard: async () => { throw new Error("资料已变更"); } }, [p]);
  await f.manager.load(); f.set("correction", "使用生活化例子"); await f.manager.handleAction("correct");
  f.set("card:thinking", "先举例再归纳"); await f.manager.handleAction("save-card");
  assert.match(f.html(), /资料已变更/); assert.match(f.html(), /先举例再归纳/); assert.match(f.html(), /使用生活化例子/); assert.match(f.html(), /尚未保存/);
});

test("Chinese composition does not submit on Ctrl+Enter or keyCode 229", async () => {
  let sends = 0;
  const p = person("A"); p.card = clone(card);
  const f = fixture({ chat: async () => { sends++; return { persona: clone(p), text: "回复" }; } }, [p]);
  await f.manager.load(); f.set("question", "中文输入中");
  const input = f.fields.get("question");
  const event = { key: "Enter", ctrlKey: true, preventDefault() {} };
  input.onkeydown({ ...event, isComposing: true });
  input.onkeydown({ ...event, keyCode: 229 });
  assert.equal(sends, 0);
  input.onkeydown(event);
  assert.equal(sends, 1);
});

test("conversation deletion needs two clicks and cancellation keeps conversation", async () => {
  let deletes = 0;
  const p = person("A"); p.card = clone(card); p.activeConversationId = "c1";
  p.conversations = [{ id: "c1", title: "旧对话", messages: [] }];
  const f = fixture({ deleteConversation: async (input) => { deletes++; assert.equal(input.id, "A"); assert.equal(input.conversationId, "c1"); return { ...p, activeConversationId: "c2", conversations: [{ id: "c2", title: "新对话", messages: [] }] }; } }, [p]);
  await f.manager.load(); await f.manager.handleAction("tab", "chat");
  await f.manager.handleAction("delete-conversation"); assert.equal(deletes, 0); assert.match(f.html(), /确认删除当前会话/);
  await f.manager.handleAction("keep-conversation"); assert.equal(deletes, 0); assert.doesNotMatch(f.html(), /确认删除当前会话/);
  await f.manager.handleAction("delete-conversation"); await f.manager.handleAction("delete-conversation");
  assert.equal(deletes, 1); assert.doesNotMatch(f.html(), /旧对话/); assert.match(f.html(), /新对话/);
});

test("updated sources or restored old card show a refresh hint", async () => {
  const p = person("A"); p.card = clone(card); p.sourceRevision = 4; p.cardSourceRevision = 2;
  const f = fixture({}, [p]); await f.manager.load(); assert.match(f.html(), /资料已更新/);
});

test("Outlook setup explains delegated permissions and connects with IDs without a client secret", async () => {
  const outlook = outlookFixture({}, { configured: false, connected: false, account: null, clientId: "", tenantId: "" });
  const f = fixture({}, [person("A")], outlook.api); await f.manager.load();
  assert.match(f.html(), /Mail.Read/); assert.match(f.html(), /http:\/\/localhost/);
  assert.doesNotMatch(f.html(), /type="password"/);
  await f.manager.handleAction("outlook-configure"); assert.equal(outlook.calls.length, 0); assert.match(f.html(), /请填写微软应用/);
  f.set("outlook-config:clientId", " client-id "); f.set("outlook-config:tenantId", " tenant-id ");
  await f.manager.handleAction("outlook-configure");
  assert.deepEqual(outlook.calls, [["configure", { clientId: "client-id", tenantId: "tenant-id" }], ["connect"]]);
  assert.match(f.html(), /已连接：reader@example.com/);
  assert.doesNotMatch(f.html(), /data-persona-field="outlook-config:clientId"/);
  await f.manager.handleAction("outlook-config"); assert.match(f.html(), /value="client-id"/);
});

test("Outlook import normalizes the sender, defaults to one year, and previews before explicit save", async () => {
  let received, f;
  const outlook = outlookFixture({ importAndGenerate: async (input) => {
    received = clone(input);
    const p = f.records.get(input.id);
    p.sourceRevision++;
    p.sources.push({ id: "email-1", kind: "email", title: "<img src=x>", text: "邮件正文 <script>", email: { from: "author@example.com", sentAt: "2026-10-20T00:00:00Z" } });
    p.outlook = { email: input.email, since: input.since, accountId: "account-1", accountUsername: "reader@example.com" };
    return { persona: clone(p), preview: { card: clone(card), baseVersion: 0, sourceRevision: 1 }, stats: { found: 4, added: 1, updated: 0, duplicates: 2, skipped: 1, capacitySkipped: 0 } };
  } });
  f = fixture({}, [person("A")], outlook.api); await f.manager.load();
  f.set("outlookEmail", "not-an-email"); await f.manager.handleAction("outlook-import"); assert.equal(received, undefined);
  f.set("outlookEmail", " Author@Example.com "); await f.manager.handleAction("outlook-import");
  assert.equal(received.email, "author@example.com");
  assert.equal(new Date(received.since).getUTCFullYear(), new Date().getUTCFullYear() - 1);
  assert.match(received.requestId, /^persona-/);
  assert.equal(f.records.get("A").card, null); assert.match(f.html(), /尚未保存/); assert.match(f.html(), /本次检查 4 封/);
  f.set("card:style", "邮件风格"); await f.manager.handleAction("save-card"); assert.equal(f.records.get("A").card.style, "邮件风格");
  await f.manager.handleAction("tab", "sources");
  assert.match(f.html(), /更新邮件并生成/); assert.match(f.html(), /readonly/);
  assert.match(f.html(), /&lt;img src=x&gt;/); assert.match(f.html(), /邮件正文 &lt;script&gt;/); assert.doesNotMatch(f.html(), /<img src=x>/);
});

test("Outlook updates preserve linked email and since and explain duplicate and capacity outcomes", async () => {
  const p = person("A"); p.card = clone(card); p.outlook = { email: "author@example.com", since: "2025-01-02T03:04:05.000Z", accountId: "account-1" };
  let received;
  const outlook = outlookFixture({ importAndGenerate: async (input) => {
    received = clone(input);
    return { persona: clone(p), preview: null, unchanged: true, stats: { found: 200, duplicates: 198, skipped: 2, capacitySkipped: 2, hasMore: true } };
  } });
  const f = fixture({}, [p], outlook.api); await f.manager.load(); f.set("outlookEmail", "different@example.com");
  await f.manager.handleAction("outlook-import");
  assert.equal(received.email, p.outlook.email); assert.equal(received.since, p.outlook.since);
  assert.match(f.html(), /当前人物卡可继续使用/); assert.match(f.html(), /2 封因资料容量限制未导入/); assert.match(f.html(), /仍有更多邮件未检查/);
  assert.match(f.html(), /缩小时间范围不会删除已导入资料/);
  f.set("outlookRange", "all", "SELECT"); await f.manager.handleAction("outlook-import"); assert.equal(received.since, null);
});

test("Outlook import cannot overwrite an unsaved preview", async () => {
  let imports = 0;
  const outlook = outlookFixture({ importAndGenerate: async () => { imports++; } });
  const f = fixture({}, [person("A")], outlook.api); await f.manager.load(); await f.manager.handleAction("generate");
  await f.manager.handleAction("tab", "sources"); await f.manager.handleAction("outlook-import");
  assert.equal(imports, 0); assert.match(f.html(), /请先保存或放弃/); assert.match(f.html(), /尚未保存/);
});

test("Outlook account mismatch blocks updates and disconnect keeps imported sources", async () => {
  let imports = 0;
  const p = person("A"); p.sources = [{ id: "e1", kind: "email", text: "已导入资料" }];
  p.outlook = { email: "author@example.com", accountId: "other-account", accountUsername: "original@example.com", since: null };
  const outlook = outlookFixture({ importAndGenerate: async () => { imports++; } });
  const f = fixture({}, [p], outlook.api); await f.manager.load();
  assert.match(f.html(), /original@example.com/);
  await f.manager.handleAction("outlook-import"); assert.equal(imports, 0); assert.match(f.html(), /原先关联/);
  await f.manager.handleAction("outlook-disconnect");
  assert.equal(outlook.calls[0][0], "disconnect"); assert.match(f.html(), /尚未连接/); assert.match(f.html(), /已导入资料/);
  await f.manager.handleAction("outlook-import"); assert.equal(imports, 0); assert.match(f.html(), /请先连接/);
});

test("Outlook progress and cancel are scoped to import and generation failure reloads persisted email", async () => {
  let reject, received;
  const outlook = outlookFixture({ importAndGenerate: (input) => { received = input; return new Promise((_yes, no) => { reject = no; }); } });
  const f = fixture({}, [person("A"), person("B")], outlook.api); await f.manager.load(); f.set("outlookEmail", "author@example.com");
  const pending = f.manager.handleAction("outlook-import");
  outlook.progress({ requestId: "other", message: "别的请求" }); assert.equal(f.progressNode.textContent, "");
  outlook.progress({ requestId: received.requestId, message: "正在清理邮件" }); assert.equal(f.progressNode.textContent, "正在清理邮件");
  await f.manager.handleAction("select", "B"); assert.match(f.html(), /data-id="A" class="persona-person selected"/);
  await f.manager.handleAction("cancel"); assert.deepEqual(outlook.calls, [["cancel", received.requestId]]); assert.equal(f.calls.length, 0);
  const p = f.records.get("A"); p.sources = [{ id: "email-1", kind: "email", title: "已导入邮件", text: "实际正文" }]; p.sourceRevision = 1;
  p.outlook = { email: "author@example.com", since: received.since, accountId: "account-1", lastImportedAt: "2026-10-23T00:00:00Z" };
  reject(new Error("生成已停止")); await pending;
  assert.match(f.html(), /生成已停止/); assert.match(f.html(), /邮件资料已保存在本机/); assert.match(f.html(), /已导入邮件/);
  outlook.progress({ requestId: received.requestId, message: "迟到更新" }); assert.notEqual(f.progressNode.textContent, "迟到更新");
});

test("Outlook status failure leaves personas usable and insecure storage is explained", async () => {
  let fail = true;
  const outlook = outlookFixture({ status: async () => { if (fail) throw new Error("连接读取失败"); return { configured: true, connected: false, secureStorageAvailable: false, clientId: "saved-client", tenantId: "saved-tenant" }; } });
  const f = fixture({}, [person("A")], outlook.api); await f.manager.load();
  assert.match(f.html(), /连接读取失败/); f.set("text", "普通资料"); await f.manager.handleAction("add-source"); assert.equal(f.records.get("A").sources.length, 1);
  fail = false; await f.manager.handleAction("outlook-refresh");
  assert.match(f.html(), /本机安全存储不可用/); assert.doesNotMatch(f.html(), /连接读取失败/);
});

const demos = require("../src/persona-demos").demos;

test("gallery previews all six demos, cancels without persistence and uses existing create API", async () => {
  let creates = 0, chats = 0, f;
  f = fixture({ create: async ({ demoId }) => {
    creates++;
    const demo = demos.find(d => d.id === demoId);
    const p = { ...person(demoId), name: demo.name, demoId, card: clone(demo.card) };
    f.records.set(demoId, p); return p;
  }, chat: async () => { chats++; } }, []);
  await f.manager.load();
  assert.equal((f.html().match(/class="persona-demo-card"/g) || []).length, 6);
  assert.match(f.html(), /名人示范/);
  for (const demo of demos) {
    await f.manager.handleAction("preview-demo", demo.id);
    assert.match(f.html(), new RegExp(demo.name + " · 示范预览"));
    for (const prompt of demo.starters) assert.ok(f.html().includes(prompt));
    await f.manager.handleAction("close-demo");
    await f.manager.handleAction("use-demo", demo.id);
    assert.equal(creates, demos.indexOf(demo));
    await f.manager.handleAction("preview-demo", demo.id);
    await f.manager.handleAction("use-demo", demo.id);
    assert.match(f.html(), /点击填入，可编辑后发送/);
    for (let index = 0; index < demo.starters.length; index++) {
      await f.manager.handleAction("starter", String(index));
      assert.ok(f.html().includes(`>${demo.starters[index]}</textarea>`));
    }
    assert.match(f.html(), /并非本人、官方账号或背书/);
  }
  assert.equal(creates, 6); assert.equal(chats, 0);
  assert.equal(f.records.size, 6);
});

test("demo repeated clicks are guarded while busy and failures keep preview available for retry", async () => {
  let resolve, reject, calls = 0;
  const f = fixture({ create: () => { calls++; return new Promise((yes, no) => { resolve = yes; reject = no; }); } }, []);
  await f.manager.load(); await f.manager.handleAction("preview-demo", "jobs");
  const pending = f.manager.handleAction("use-demo", "jobs");
  await f.manager.handleAction("use-demo", "jobs");
  await f.manager.handleAction("preview-demo", "musk");
  assert.equal(calls, 1);
  reject(new Error("磁盘写入失败")); await pending;
  assert.match(f.html(), /磁盘写入失败/); assert.match(f.html(), /乔布斯 · 示范预览/);
  const retry = f.manager.handleAction("use-demo", "jobs");
  resolve({ ...person("jobs"), demoId: "jobs", card: clone(demos.find(d => d.id === "jobs").card) }); await retry;
  assert.equal(calls, 2); assert.doesNotMatch(f.html(), /磁盘写入失败/);
  assert.match(f.html(), /示范已就绪/);
});


test("saved demos open in chat after renderer restart and preserve edited labels", async () => {
  const demo = demos[0];
  const p = { ...person("saved-demo"), name: "我的学习伙伴", demoId: demo.id, card: clone(demo.card) };
  const f = fixture({}, [p]); await f.manager.load();
  assert.match(f.html(), /我的学习伙伴/);
  assert.match(f.html(), /点击填入，可编辑后发送/);
  assert.match(f.html(), /并非本人、官方账号或背书/);
});
