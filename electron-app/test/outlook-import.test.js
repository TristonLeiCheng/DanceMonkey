const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPersonaService, LIMITS } = require("../electron/personas");
const { createOutlookImporter } = require("../electron/outlook-import");
const { EMAIL_LIMITS } = require("../electron/persona-email");

const card = { summary: "工作邮件人物", knowledge: "按证据做决定", thinking: "验证假设", style: "简洁", boundaries: "工作场景资料有限" };
const message = (id = "m1", text = "做决定前应该先核实证据。") => ({ externalId: id, internetMessageId: `<${id}@example.com>`,
  conversationId: "thread-1", subject: "项目建议 " + id, sentAt: "2026-01-01T12:00:00Z", receivedAt: "2026-01-01T12:01:00Z",
  webLink: "https://outlook.office.com/mail/id/" + id, from: "person@example.com", text });
const wait = () => new Promise(setImmediate);
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dm-outlook-import-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = { messages: [message()], model: "original", calls: [], cancelled: [], current: true };
  const ai = { chat: async () => { throw new Error("must use captured session"); }, createSession: () => {
    const model = state.model;
    return { getSettings: () => ({ model }), chat: async (input) => {
      state.calls.push({ ...input, capturedModel: model });
      if (state.modelError) throw new Error("模拟模型服务不可用");
      if (state.modelWait) await state.modelWait;
      return input.systemPrompt.includes("只返回一个 JSON 对象") ? JSON.stringify(card) : "邮件中的证据摘要";
    } };
  }, cancel: (id) => state.cancelled.push(id) };
  const personas = createPersonaService({ userDataPath: root, aiService: ai });
  const session = { accountId: "account-1", username: "me@example.com", assertCurrent: () => { if (!state.current) throw new Error("账户已变化"); } };
  const mail = { search: async (input) => {
    state.search = input; state.onSearch?.();
    if (state.searchWait) await state.searchWait;
    return { messages: state.messages, scanned: state.messages.length, skipped: {}, hasMore: Boolean(state.hasMore) };
  } };
  const importer = createOutlookImporter({ auth: { session: async () => session }, mail, personas });
  const input = (id, requestId = "import-1") => ({ id, email: "Person@example.com", since: "2025-10-01", requestId });
  const direct = (id, messages, extra = {}) => personas.importEmails({ id, email: "person@example.com", accountId: "account-1",
    accountUsername: "me@example.com", since: null, messages, stats: { found: messages.length }, ...extra });
  return { root, personas, importer, state, session, input, direct, ai };
}

test("email import persists metadata, generates preview, and only saves card when explicitly saved", async (t) => {
  const h = fixture(t), person = await h.personas.create({ name: "人物" });
  const result = await h.importer.importAndGenerate(h.input(person.id));
  assert.equal(result.stats.added, 1); assert.deepEqual(result.preview.card, card);
  assert.equal(result.persona.card, null); assert.equal(result.persona.sources[0].kind, "email");
  assert.equal(result.persona.sources[0].email.accountId, "account-1");
  assert.equal(result.persona.outlook.email, "person@example.com");
  const evidence = JSON.parse(h.state.calls[0].messages[0].content).sourceBatch[0];
  assert.equal(evidence.emailFrom, "person@example.com"); assert.equal(evidence.sentAt, "2026-01-01T12:00:00.000Z");
  const saved = await h.personas.saveCard({ id: person.id, ...result.preview });
  const reopened = createPersonaService({ userDataPath: h.root, aiService: h.ai });
  assert.deepEqual((await reopened.get(person.id)).outlook, saved.outlook);
  const count = h.state.calls.length;
  const again = await h.importer.importAndGenerate(h.input(person.id));
  assert.equal(again.unchanged, true); assert.equal(again.preview, null); assert.equal(again.stats.duplicates, 1);
  assert.equal(h.state.calls.length, count, "unchanged update must not spend another model call");
});

test("updates retain IDs, deduplicate changed provider IDs, and preserve corrections and prior versions", async (t) => {
  const h = fixture(t), person = await h.personas.create({ name: "人物" });
  const first = await h.importer.importAndGenerate(h.input(person.id));
  await h.personas.saveCard({ id: person.id, ...first.preview, correction: "语气再简短些" });
  h.state.messages = [{ ...message("provider-new", "新的项目知识。"), internetMessageId: "<m1@example.com>" }, message("m2", "另一封独立经验。")];
  const updated = await h.importer.importAndGenerate(h.input(person.id));
  assert.equal(updated.stats.updated, 1); assert.equal(updated.stats.added, 1);
  assert.equal(updated.persona.sources[0].id, first.persona.sources[0].id);
  assert.equal(updated.persona.sources.length, 2); assert.equal(updated.persona.cardVersion, 1);
  assert.equal(updated.persona.corrections[0].text, "语气再简短些");
  await h.personas.saveCard({ id: person.id, ...updated.preview });
  assert.equal((await h.personas.get(person.id)).versions.length, 2);
});

test("same body is deduplicated and manually removed mail stays excluded on updates", async (t) => {
  const h = fixture(t), person = await h.personas.create({ name: "人物" });
  const first = await h.direct(person.id, [message(), message("copy")]);
  assert.equal(first.stats.duplicates, 1); assert.equal(first.persona.sources.length, 1);
  await h.personas.removeSource({ id: person.id, sourceId: first.persona.sources[0].id });
  const update = await h.direct(person.id, [message(), message("copy")]);
  assert.equal(update.stats.skipped, 2); assert.equal(update.persona.sources.length, 0);
});

test("email quotas are independent from article quotas and capacity skips are reported", async (t) => {
  const h = fixture(t), person = await h.personas.create({ name: "人物" });
  await h.personas.addSources({ id: person.id, sources: Array.from({ length: LIMITS.sources }, (_, i) => ({ title: String(i), text: "资料" })) });
  const mails = Array.from({ length: EMAIL_LIMITS.sources }, (_, i) => message("m" + i, "邮件" + i));
  const first = await h.direct(person.id, mails);
  assert.equal(first.stats.added, EMAIL_LIMITS.sources); assert.equal(first.persona.sources.length, 240);
  const extra = await h.direct(person.id, [message("overflow", "额外邮件")]);
  assert.equal(extra.stats.capacitySkipped, 1);
  const second = await h.personas.create({ name: "字数限制" });
  const long = Array.from({ length: 20 }, (_, i) => message("long" + i, String(i).padStart(2, "0") + "文".repeat(15998)));
  const filled = await h.direct(second.id, long);
  assert.equal(filled.stats.added, 15); assert.equal(filled.stats.capacitySkipped, 5);
  assert.equal((await h.personas.get(second.id)).sources.length, 15);
});

test("mail provenance cannot be forged through generic source import and cross-person/author mixing is rejected", async (t) => {
  const h = fixture(t), person = await h.personas.create({ name: "人物" });
  await assert.rejects(h.personas.addSources({ id: person.id, sources: [{ kind: "email", title: "伪造", text: "伪造" }] }), /Outlook/);
  await assert.rejects(h.direct(person.id, [{ ...message(), from: "other@example.com" }]), /作者/);
  assert.equal((await h.personas.get(person.id)).sources.length, 0);
  await h.direct(person.id, [message()]);
  await assert.rejects(h.direct(person.id, [message()], { accountId: "account-2" }), /其他邮箱或账户/);
  await assert.rejects(h.importer.importAndGenerate({ ...h.input(person.id), email: "other@example.com" }), /其他邮箱或账户/);
});

test("AI failure retains imported mail and the prior card; retry deduplicates and generates again", async (t) => {
  const h = fixture(t), person = await h.personas.create({ name: "人物" });
  h.state.modelError = true;
  await assert.rejects(h.importer.importAndGenerate(h.input(person.id)), /邮件资料已保存在本机/);
  assert.equal((await h.personas.get(person.id)).sources.length, 1);
  assert.equal((await h.personas.get(person.id)).card, null);
  h.state.modelError = false;
  const retry = await h.importer.importAndGenerate(h.input(person.id));
  assert.equal(retry.stats.duplicates, 1); assert.deepEqual(retry.preview.card, card);
});

test("cancel before storage, account change, empty search and concurrent import do not write partial data", async (t) => {
  const h = fixture(t), person = await h.personas.create({ name: "人物" });
  let finish; h.state.searchWait = new Promise((resolve) => { finish = resolve; });
  const running = h.importer.importAndGenerate(h.input(person.id));
  await wait();
  await assert.rejects(h.importer.importAndGenerate(h.input(person.id, "second")), /正在导入/);
  assert.equal(h.importer.cancel("import-1"), true); finish();
  await assert.rejects(running, /已停止/);
  assert.equal((await h.personas.get(person.id)).sources.length, 0);
  h.state.current = false;
  await assert.rejects(h.importer.importAndGenerate(h.input(person.id)), /账户已变化/);
  h.state.current = true; h.state.messages = [];
  await assert.rejects(h.importer.importAndGenerate(h.input(person.id)), /没有找到/);
  assert.equal((await h.personas.get(person.id)).outlook, undefined);
});

test("cancellation while generating keeps mail but never commits a card; model endpoint is frozen before mail fetch", async (t) => {
  const h = fixture(t), person = await h.personas.create({ name: "人物" });
  h.state.onSearch = () => { h.state.model = "changed-after-click"; };
  let finish; h.state.modelWait = new Promise((resolve) => { finish = resolve; });
  const running = h.importer.importAndGenerate(h.input(person.id));
  while (!h.state.calls.length) await wait();
  assert.equal(h.state.calls[0].capturedModel, "original");
  h.importer.cancelAll(); await assert.rejects(running, /邮件资料已保存在本机/); finish();
  assert.equal((await h.personas.get(person.id)).card, null);
  assert.equal((await h.personas.get(person.id)).sources.length, 1);
});

test("mail data validation rejects unsafe links and tampered metadata after restart", async (t) => {
  const h = fixture(t), person = await h.personas.create({ name: "人物" });
  await assert.rejects(h.direct(person.id, [{ ...message(), webLink: "https://evil.example/mail" }]), /链接/);
  await h.direct(person.id, [message()]);
  const file = path.join(h.root, "personas", person.id + ".json");
  const stored = JSON.parse(fs.readFileSync(file)); stored.sources[0].email.from = "other@example.com";
  fs.writeFileSync(file, JSON.stringify(stored));
  await assert.rejects(h.personas.get(person.id), /结构无效/);
});
