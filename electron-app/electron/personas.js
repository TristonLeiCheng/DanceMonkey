const profileTools = require("../src/persona-profile");
const demoTools = require("../src/persona-demos");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { normalizeSource, chunkSources, retrieveChunks } = require("./persona-sources");
const { ANALYSIS_PROMPT, MERGE_PROMPT, CARD_PROMPT, CHAT_PROMPT } = require("./persona-prompts");
const { EMAIL_LIMITS, emailAddress, sinceDate, emailKeys, validOutlookBinding } = require("./persona-email");

const LIMITS = Object.freeze({
  sources: 40, sourceChars: 120000, batchChars: 12000, batches: 32,
  cardFieldChars: 6000, cardChars: 20000, versions: 20, corrections: 50,
  conversations: 20, conversationMessages: 100, totalMessages: 400,
  inputChars: 4000, responseChars: 16000, fileBytes: 12 * 1024 * 1024,
});
const CARD_KEYS = ["summary", "knowledge", "thinking", "style", "boundaries"];
const ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const clone = (value) => JSON.parse(JSON.stringify(value));
const timestamp = () => new Date().toISOString();
const makeId = () => crypto.randomUUID();

function fail(message, code = "PERSONA_ERROR") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validId(id) {
  if (typeof id !== "string" || !ID_PATTERN.test(id)) throw fail("人物或记录 ID 无效。", "INVALID_ID");
  return id;
}

function textValue(value, label, max, required = true) {
  if (typeof value !== "string" || value.length > max || (required && !value.trim())) {
    throw fail(label + "不能为空且不能超过 " + max + " 个字符。", "INVALID_INPUT");
  }
  return value.trim();
}

function validateCard(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail("人物卡格式无效。", "INVALID_CARD");
  const result = {};
  for (const key of CARD_KEYS) result[key] = textValue(value[key], "人物卡 " + key, LIMITS.cardFieldChars);
  if (CARD_KEYS.reduce((n, key) => n + result[key].length, 0) > LIMITS.cardChars) {
    throw fail("人物卡总长度超过限制。", "INVALID_CARD");
  }
  return result;
}

function parseCard(text) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, "$1");
  let value;
  try { value = JSON.parse(trimmed); } catch { throw fail("模型没有返回有效人物卡 JSON，旧人物卡未更改。", "INVALID_MODEL_OUTPUT"); }
  try { return validateCard(value); } catch (error) {
    throw fail("模型返回的人物卡不完整：" + error.message, "INVALID_MODEL_OUTPUT");
  }
}

function validStoredPerson(person, id) {
  const string = (value, max) => typeof value === "string" && value.length <= max;
  const validDate = (value) => string(value, 40) && Number.isFinite(Date.parse(value));
  const idList = (items) => items.every((item) => item && ID_PATTERN.test(item.id)) && new Set(items.map((item) => item.id)).size === items.length;
  if (!person || person.id !== id || !string(person.name, 100) || !person.name.trim() ||
      !string(person.description, 2000) || !validDate(person.createdAt) || !validDate(person.updatedAt) ||
      !Number.isInteger(person.cardVersion) || person.cardVersion < 0 ||
      !Number.isInteger(person.sourceRevision) || person.sourceRevision < 0 ||
      !Array.isArray(person.sources) || person.sources.length > LIMITS.sources + EMAIL_LIMITS.sources || !idList(person.sources) ||
      !Array.isArray(person.versions) || person.versions.length > LIMITS.versions ||
      !Array.isArray(person.corrections) || person.corrections.length > LIMITS.corrections ||
      !Array.isArray(person.conversations) || !person.conversations.length || person.conversations.length > LIMITS.conversations ||
      !idList(person.conversations) || !person.conversations.some((item) => item.id === person.activeConversationId)) return false;
  if (!person.sources.every((source) => string(source.title, 200) && string(source.text, 80000) && source.text.trim() &&
      ["article", "note", "chat", "email"].includes(source.kind) && validDate(source.createdAt) &&
      (source.speaker === undefined || string(source.speaker, 80)))) return false;
  if (person.demoId !== undefined && !demoTools.get(person.demoId)) return false;
  if (person.profile !== undefined) { try { profileTools.normalize(person.profile); } catch { return false; } }
  const ordinary = person.sources.filter((source) => source.kind !== "email");
  const emails = person.sources.filter((source) => source.kind === "email");
  if (ordinary.length > LIMITS.sources || ordinary.reduce((n, source) => n + source.text.length, 0) > LIMITS.sourceChars ||
      emails.length > EMAIL_LIMITS.sources || emails.reduce((n, source) => n + source.text.length, 0) > EMAIL_LIMITS.chars) return false;
  if (person.outlook !== undefined && !validOutlookBinding(person.outlook)) return false;
  try {
    for (const source of emails) {
      const normalized = normalizeSource(source);
      if (!person.outlook || normalized.email.accountId !== person.outlook.accountId || normalized.email.from !== person.outlook.email ||
          normalized.email.contentHash !== source.email.contentHash) return false;
    }
  } catch { return false; }
  if (!person.conversations.every((conversation) => string(conversation.title, 100) && Array.isArray(conversation.messages) &&
      conversation.messages.length <= LIMITS.conversationMessages && conversation.messages.every((message) =>
        ["user", "assistant"].includes(message?.role) && string(message.content, LIMITS.responseChars) && validDate(message.date) &&
        Array.isArray(message.citations) && message.citations.length <= 6 && message.citations.every((citation) =>
          citation && ID_PATTERN.test(citation.sourceId) && string(citation.title, 200) &&
          (citation.excerpt === undefined || string(citation.excerpt, 300)))))) return false;
  if (person.conversations.reduce((n, item) => n + item.messages.length, 0) > LIMITS.totalMessages) return false;
  if (!person.corrections.every((item) => item && string(item.text, 2000) && validDate(item.createdAt))) return false;
  try {
    if (person.card !== null) validateCard(person.card);
    for (const version of person.versions) {
      if (!version || !Number.isInteger(version.version) || version.version < 1 || version.version > person.cardVersion ||
          !validDate(version.createdAt)) return false;
      validateCard(version.card);
    }
  } catch { return false; }
  return true;
}

function batchesOf(items, maxChars) {
  const batches = [];
  let batch = [], chars = 0;
  for (const item of items) {
    const size = JSON.stringify(item).length;
    if (size > maxChars) throw fail("资料片段过长，请拆分后重试。", "SOURCE_LIMIT");
    if (batch.length && chars + size > maxChars) { batches.push(batch); batch = []; chars = 0; }
    batch.push(item); chars += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

function createPersonaService({ userDataPath, aiService }) {
  if (!userDataPath || !aiService || typeof aiService.chat !== "function") throw new Error("人物服务缺少存储目录或 AI 服务。");
  const directory = path.join(path.resolve(userDataPath), "personas");
  const locks = new Map();
  const requests = new Map();
  let demoCreation = Promise.resolve();

  function ensureDirectory() {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail("人物存储目录无效。", "INVALID_STORAGE");
  }
  ensureDirectory();

  function personPath(id) { return path.join(directory, validId(id) + ".json"); }

  function read(id) {
    ensureDirectory();
    const filename = personPath(id);
    let stat;
    try { stat = fs.lstatSync(filename); } catch (error) {
      if (error.code === "ENOENT") throw fail("人物不存在或已删除。", "NOT_FOUND");
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMITS.fileBytes) throw fail("人物档案文件无效。", "INVALID_STORAGE");
    let person;
    try { person = JSON.parse(fs.readFileSync(filename, "utf8")); } catch { throw fail("人物档案 " + id + " 损坏，未覆盖原文件。", "INVALID_STORAGE"); }
    if (!validStoredPerson(person, id)) {
      throw fail("人物档案 " + id + " 结构无效，未覆盖原文件。", "INVALID_STORAGE");
    }
    return person;
  }

  function write(person) {
    ensureDirectory();
    const filename = personPath(person.id);
    const bytes = JSON.stringify(person, null, 2);
    if (Buffer.byteLength(bytes, "utf8") > LIMITS.fileBytes) throw fail("人物档案已达到存储上限，请先减少资料或对话。", "STORAGE_LIMIT");
    const temporary = filename + "." + makeId() + ".tmp";
    let fd;
    try {
      fd = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(fd, bytes, "utf8");
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      fs.renameSync(temporary, filename);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    return clone(person);
  }

  function locked(id, operation) {
    validId(id);
    const previous = locks.get(id) || Promise.resolve();
    const result = previous.catch(() => {}).then(operation);
    const tail = result.catch(() => {});
    locks.set(id, tail);
    tail.then(() => { if (locks.get(id) === tail) locks.delete(id); });
    return result;
  }

  function mutate(id, fn) {
    return locked(id, () => {
      const person = read(id);
      fn(person);
      person.updatedAt = timestamp();
      return write(person);
    });
  }

  function captureModel() { return typeof aiService.createSession === "function" ? aiService.createSession() : aiService; }

  function startRequest(requestId, personId, capturedClient) {
    const id = requestId === undefined ? makeId() : requestId;
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw fail("请求 ID 无效。", "INVALID_REQUEST");
    if (requests.has(id)) throw fail("该请求正在执行，请勿重复提交。", "REQUEST_BUSY");
    let rejectCancellation;
    const cancelledPromise = new Promise((resolve, reject) => { rejectCancellation = reject; });
    cancelledPromise.catch(() => {});
    const client = capturedClient || captureModel();
    const selectedModel = typeof client.getSettings === "function" ? client.getSettings().model : undefined;
    const state = { id, personId, client, selectedModel, cancelled: false, activeId: null, count: 0, cancelledPromise, rejectCancellation };
    requests.set(id, state);
    return state;
  }

  function checkRequest(state) {
    if (state.cancelled) throw fail("已停止生成，原有内容未更改。", "CANCELLED");
  }

  function cancel(requestId) {
    const state = requests.get(requestId);
    if (!state || state.cancelled) return false;
    state.cancelled = true;
    state.rejectCancellation(fail("已停止生成，原有内容未更改。", "CANCELLED"));
    if (state.activeId && typeof aiService.cancel === "function") {
      try { aiService.cancel(state.activeId); } catch { /* The local cancellation remains authoritative. */ }
    }
    return true;
  }

  async function model(state, systemPrompt, messages, { onChunk, maxChars = LIMITS.responseChars, maxTokens = 4096 } = {}) {
    checkRequest(state);
    const activeId = "persona-" + state.id + "-" + (++state.count);
    state.activeId = activeId;
    const request = state.client.chat({ systemPrompt, messages, requestId: activeId, model: state.selectedModel,
      temperature: 0.35, maxTokens, timeoutMs: 180000 }, (chunk) => {
      if (!state.cancelled && typeof onChunk === "function") onChunk(chunk);
    });
    let output;
    try { output = await Promise.race([request, state.cancelledPromise]); }
    finally { if (state.activeId === activeId) state.activeId = null; }
    checkRequest(state);
    if (typeof output !== "string" || !output.trim()) throw fail("模型返回了空内容，原有内容未更改。", "EMPTY_MODEL_OUTPUT");
    if (output.length > maxChars) throw fail("模型输出过长，请精简资料后重试。", "INVALID_MODEL_OUTPUT");
    return output.trim();
  }

  function allSources(person) {
    const text = profileTools.evidence(person.profile);
    return text ? person.sources.concat({ id: person.id, title: "手动人物档案（用户提供，未独立核实）", kind: "note", text }) : person.sources;
  }

  function evidence(chunks, person) {
    const sources = new Map(allSources(person).map((source) => [source.id, source]));
    return chunks.map((chunk) => ({
      chunkId: chunk.id, sourceId: chunk.sourceId, title: chunk.title,
      kind: sources.get(chunk.sourceId)?.kind, targetSpeaker: sources.get(chunk.sourceId)?.speaker || person.name,
      ...(sources.get(chunk.sourceId)?.kind === "email" ? { emailFrom: sources.get(chunk.sourceId).email.from,
        sentAt: sources.get(chunk.sourceId).email.sentAt } : {}),
      text: chunk.text,
    }));
  }

  async function list() {
    ensureDirectory();
    return fs.readdirSync(directory).filter((name) => name.endsWith(".json") && ID_PATTERN.test(name.slice(0, -5)))
      .map((name) => read(name.slice(0, -5)))
      .map((person) => ({ id: person.id, name: person.name, description: person.description,
        ...(person.demoId ? { demoId: person.demoId } : {}),
        summary: person.card?.summary || "", sourceCount: person.sources.length, hasCard: Boolean(person.card),
        cardVersion: person.cardVersion, sourceRevision: person.sourceRevision,
        createdAt: person.createdAt, updatedAt: person.updatedAt }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async function create({ name, description = "", demoId } = {}) {
    if (demoId !== undefined) {
      const demo = demoTools.get(demoId);
      if (!demo) throw fail("名人示范不存在，请重新选择。", "INVALID_INPUT");
      // Serialize catalogue imports across renderer windows. A single atomic write
      // creates the source, initial card and conversation; never a half-ready profile.
      const result = demoCreation.catch(() => {}).then(async () => {
        const existing = (await list()).find(item => item.demoId === demoId);
        if (existing) return get(existing.id);
        return createRecord(demo.name, demo.bio, demo);
      });
      demoCreation = result;
      return result;
    }
    return createRecord(name, description);
  }

  function createRecord(name, description, demo) {
    const date = timestamp(), conversationId = makeId();
    const person = { id: makeId(), name: textValue(name, "人物名称", 100),
      description: textValue(description, "人物简介", 2000, false), sources: [], card: null,
      cardVersion: 0, sourceRevision: 0, versions: [], corrections: [],
      conversations: [{ id: conversationId, title: "新对话", messages: [], createdAt: date }],
      activeConversationId: conversationId, createdAt: date, updatedAt: date };
    if (demo) {
      person.demoId = demo.id;
      person.sources = [{ id: makeId(), kind: "note", title: demo.name + " · 示范编辑说明（非本人原文）",
        text: [demo.bio, demoTools.disclosure, demoTools.rules, ...Object.values(demo.card)].join("\n"), createdAt: date }];
      person.sourceRevision = 1;
      appendCard(person, validateCard(demo.card));
    }
    return locked(person.id, () => write(person));
  }

  function get(id) { return locked(id, () => clone(read(id))); }

  function updateProfile({ id, name, description, profile, baseRevision }) {
    return mutate(id, (person) => {
      if (profile !== undefined) {
        if (!Number.isInteger(baseRevision) || baseRevision !== person.sourceRevision) throw fail("人物资料已变化，请重新打开人物档案后编辑。", "VERSION_CONFLICT");
        const next = profileTools.normalize(profile);
        if (JSON.stringify(next) !== JSON.stringify(profileTools.normalize(person.profile))) person.sourceRevision++;
        person.profile = next;
      }
      const nextName = name === undefined ? person.name : textValue(name, "人物名称", 100);
      const nextDescription = description === undefined ? person.description : textValue(description, "人物简介", 2000, false);
      if (person.name !== nextName || person.description !== nextDescription) person.sourceRevision++;
      person.name = nextName; person.description = nextDescription;
    });
  }

  function addSources({ id, sources }) {
    return mutate(id, (person) => {
      const ordinary = person.sources.filter((source) => source.kind !== "email");
      if (!Array.isArray(sources) || !sources.length || sources.length + ordinary.length > LIMITS.sources) {
        throw fail("每个人物最多导入 " + LIMITS.sources + " 份资料。", "SOURCE_LIMIT");
      }
      if (sources.some((source) => source?.kind === "email")) throw fail("邮件请通过 Outlook 导入。", "INVALID_INPUT");
      const additions = sources.map((input) => ({ ...normalizeSource(input), id: makeId(), createdAt: timestamp() }));
      if (ordinary.concat(additions).reduce((n, source) => n + source.text.length, 0) > LIMITS.sourceChars) {
        throw fail("每个人物资料总量最多 " + LIMITS.sourceChars + " 个字符，请分批精选。", "SOURCE_LIMIT");
      }
      person.sources.push(...additions); person.sourceRevision++;
    });
  }

  // Only called from the main-process Outlook importer. Never exposed as raw IPC.
  async function importEmails({ id, accountId, accountUsername, email, since, messages, stats: searchStats = {} }, assertCurrent = () => {}) {
    email = emailAddress(email); accountUsername = emailAddress(accountUsername); since = sinceDate(since);
    if (typeof accountId !== "string" || !accountId || accountId.length > 256 || !Array.isArray(messages) || messages.length > EMAIL_LIMITS.sources) {
      throw fail("邮件导入数据无效。", "INVALID_INPUT");
    }
    const stats = { found: searchStats.found || 0, added: 0, updated: 0, duplicates: searchStats.duplicates || 0,
      skipped: searchStats.skipped || 0, hasMore: Boolean(searchStats.hasMore), capacitySkipped: 0,
      skipReasons: searchStats.skipReasons || {} };
    const persona = await mutate(id, (person) => {
      assertCurrent();
      if (person.outlook && (person.outlook.email !== email || person.outlook.accountId !== accountId)) {
        throw fail("此人物已关联其他邮箱或账户，请连接原账户；其他人物请新建分身。", "MAILBOX_MISMATCH");
      }
      const excludedKeys = person.outlook?.excludedKeys || [];
      const excluded = new Set(excludedKeys);
      let emails = person.sources.filter((source) => source.kind === "email");
      let totalChars = emails.reduce((n, source) => n + source.text.length, 0);
      for (const message of messages) {
        const title = `${String(message.sentAt).slice(0, 10)} · ${String(message.subject || "无主题").replace(/[\r\n\t]/g, " ")}`.slice(0, 200);
        const source = normalizeSource({ title, text: message.text, kind: "email", email: { ...message, accountId, accountUsername } });
        if (source.email.from !== email) throw fail("邮件作者与人物邮箱不符。", "AUTHOR_MISMATCH");
        if (emailKeys(source.email).some((key) => excluded.has(key))) { stats.skipped++; continue; }
        const existing = emails.find((item) => item.email.externalId === source.email.externalId ||
          (source.email.internetMessageId && item.email.internetMessageId === source.email.internetMessageId));
        const duplicateBody = emails.some((item) => item !== existing && item.email.contentHash === source.email.contentHash);
        if (!existing && duplicateBody) { stats.duplicates++; continue; }
        if (existing && existing.email.contentHash === source.email.contentHash && existing.title === source.title) {
          // A stable Message-ID can survive a changed provider identifier.
          existing.email = source.email; stats.duplicates++; continue;
        }
        const nextChars = totalChars - (existing?.text.length || 0) + source.text.length;
        if ((!existing && emails.length >= EMAIL_LIMITS.sources) || nextChars > EMAIL_LIMITS.chars) { stats.capacitySkipped++; continue; }
        if (existing) { Object.assign(existing, source); stats.updated++; }
        else {
          const added = { ...source, id: makeId(), createdAt: timestamp() };
          person.sources.push(added); emails.push(added); stats.added++;
        }
        totalChars = nextChars;
      }
      person.outlook = { email, since, accountId, accountUsername, lastImportedAt: timestamp(), excludedKeys, lastStats: stats };
      if (stats.added || stats.updated) person.sourceRevision++;
      assertCurrent();
    });
    return { persona, stats };
  }

  function removeSource({ id, sourceId }) {
    validId(sourceId);
    return mutate(id, (person) => {
      const index = person.sources.findIndex((source) => source.id === sourceId);
      if (index < 0) throw fail("资料不存在。", "NOT_FOUND");
      if (person.sources[index].kind === "email" && person.outlook) {
        const keys = [...new Set(person.outlook.excludedKeys.concat(emailKeys(person.sources[index].email)))];
        if (keys.length > EMAIL_LIMITS.exclusions) throw fail("邮件排除记录已满，请新建人物分身整理资料。", "SOURCE_LIMIT");
        person.outlook.excludedKeys = keys;
      }
      person.sources.splice(index, 1); person.sourceRevision++;
    });
  }

  async function generate({ id, correction = "", requestId }, onProgress = () => {}, { client } = {}) {
    validId(id);
    correction = textValue(correction, "纠正内容", 2000, false);
    const state = startRequest(requestId, id, client);
    try {
      return await locked(id, async () => {
        checkRequest(state);
        const person = read(id);
        if (!allSources(person).length) throw fail("请先导入此人物的资料。", "NO_SOURCES");
        const chunks = chunkSources(allSources(person));
        if (!chunks.length) throw fail("资料没有可分析的文本。", "NO_SOURCES");
        const batches = batchesOf(evidence(chunks, person), LIMITS.batchChars);
        const maxBatches = person.sources.some((source) => source.kind === "email") ? 96 : LIMITS.batches + (person.profile ? 12 : 0);
        if (batches.length > maxBatches) throw fail("资料分块过多，请减少资料后重试。", "SOURCE_LIMIT");
        let reports = [];
        for (let index = 0; index < batches.length; index++) {
          checkRequest(state);
          onProgress("正在提取资料 " + (index + 1) + "/" + batches.length);
          const report = await model(state, ANALYSIS_PROMPT, [{ role: "user", content: JSON.stringify({
            person: { name: person.name, description: person.description }, sourceBatch: batches[index],
          }) }], { maxChars: 6000, maxTokens: 2600 });
          reports.push(report);
        }
        let round = 0;
        while (JSON.stringify(reports).length > 12000) {
          if (++round > 4) throw fail("摘要无法收敛，请减少资料后重试。", "INVALID_MODEL_OUTPUT");
          const merged = [];
          for (const group of batchesOf(reports, LIMITS.batchChars)) {
            checkRequest(state); onProgress("正在整合各批资料（第 " + round + " 轮）");
            merged.push(await model(state, MERGE_PROMPT, [{ role: "user", content: JSON.stringify({ reports: group }) }],
              { maxChars: 6000, maxTokens: 2800 }));
          }
          reports = merged;
        }
        checkRequest(state); onProgress("正在生成可编辑的人物卡");
        const corrections = [];
        let correctionChars = correction.length;
        for (const entry of person.corrections.slice(-10).reverse()) {
          if (correctionChars + entry.text.length > 4000) break;
          corrections.unshift(entry); correctionChars += entry.text.length;
        }
        const previousCard = person.card && Object.fromEntries(CARD_KEYS.map((key) => [key, person.card[key].slice(0, 700)]));
        const output = await model(state, CARD_PROMPT + (person.demoId ? "\n" + demoTools.disclosure + demoTools.rules : ""), [{ role: "user", content: JSON.stringify({
          person: { name: person.name, description: person.description }, reports,
          previousCard, corrections, newCorrection: correction,
        }) }], { maxChars: 24000, maxTokens: 6500 });
        checkRequest(state);
        return { card: parseCard(output), baseVersion: person.cardVersion, sourceRevision: person.sourceRevision };
      });
    } finally { requests.delete(state.id); }
  }

  function appendCard(person, card, extra = {}) {
    person.cardVersion++;
    person.card = card;
    person.cardSourceRevision = person.sourceRevision;
    person.versions.push({ version: person.cardVersion, card: clone(card), sourceRevision: person.sourceRevision, createdAt: timestamp(), ...extra });
    person.versions = person.versions.slice(-LIMITS.versions);
  }

  function saveCard({ id, card, baseVersion, sourceRevision, correction = "" }) {
    const validated = validateCard(card);
    correction = textValue(correction, "纠正内容", 2000, false);
    return mutate(id, (person) => {
      if (!Number.isInteger(baseVersion) || !Number.isInteger(sourceRevision) ||
          person.cardVersion !== baseVersion || person.sourceRevision !== sourceRevision) {
        throw fail("人物卡或资料已变化，请重新生成或刷新后保存。", "VERSION_CONFLICT");
      }
      appendCard(person, validated);
      if (correction) {
        person.corrections.push({ id: makeId(), text: correction, createdAt: timestamp(), cardVersion: person.cardVersion });
        person.corrections = person.corrections.slice(-LIMITS.corrections);
      }
    });
  }

  async function chat({ id, message, requestId }, onChunk = () => {}) {
    validId(id);
    message = textValue(message, "消息", LIMITS.inputChars);
    const state = startRequest(requestId, id);
    try {
      return await locked(id, async () => {
        checkRequest(state);
        const person = read(id);
        if (!person.card) throw fail("请先生成并保存人物卡。", "NO_CARD");
        const conversation = person.conversations.find((item) => item.id === person.activeConversationId);
        if (!conversation) throw fail("当前人物会话不存在。", "NOT_FOUND");
        if (conversation.messages.length + 2 > LIMITS.conversationMessages) {
          throw fail("当前会话已达到 " + LIMITS.conversationMessages + " 条消息，请新建会话。", "CONVERSATION_LIMIT");
        }
        if (person.conversations.reduce((n, item) => n + item.messages.length, 0) + 2 > LIMITS.totalMessages) {
          throw fail("此人物的历史消息已达到 " + LIMITS.totalMessages + " 条，请删除不再需要的旧会话。", "CONVERSATION_LIMIT");
        }
        const chunks = retrieveChunks(chunkSources(allSources(person)), message, { limit: 6, maxChars: 12000 });
        const selected = evidence(chunks, person).map((chunk, index) => ({ ...chunk, marker: "S" + (index + 1) }));
        const citations = selected.map((chunk) => ({ id: chunk.marker, sourceId: chunk.sourceId, title: chunk.title,
          excerpt: chunk.text.slice(0, 300), chunkId: chunk.chunkId }));
        const history = [];
        let historyChars = 0;
        for (const entry of conversation.messages.slice(-12).reverse()) {
          if (historyChars + entry.content.length > 16000) break;
          // S-labels are local to a single retrieval. An old S1 must never become
          // a citation to the new turn's S1, which can refer to another source.
          history.unshift({ role: entry.role, content: entry.content.replace(/\[S\d+\]/g, "") });
          historyChars += entry.content.length;
        }
        const currentQuestion = JSON.stringify({ userQuestion: message, person: { name: person.name, description: person.description },
          card: person.card, cardMayBeOutdated: person.cardSourceRevision !== person.sourceRevision,
          retrievedEvidence: selected });
        const rawText = await model(state, CHAT_PROMPT + (person.demoId ? "\n" + demoTools.disclosure + demoTools.rules : ""), history.concat({ role: "user", content: currentQuestion }), { onChunk });
        const text = rawText.replace(/\[S(\d+)\]/g, (_match, index) => citations[Number(index) - 1]
          ? "[S" + Number(index) + "]" : "（来源未核实）");
        const used = citations.filter((citation) => text.includes("[" + citation.id + "]"));
        checkRequest(state);
        const date = timestamp();
        conversation.messages.push({ role: "user", content: message, citations: [], date },
          { role: "assistant", content: text, citations: used, date });
        if (conversation.messages.length === 2) conversation.title = message.slice(0, 32);
        person.updatedAt = date;
        return { persona: write(person), text, citations: used };
      });
    } finally { requests.delete(state.id); }
  }

  function newConversation({ id }) {
    return mutate(id, (person) => {
      if (person.conversations.length >= LIMITS.conversations) throw fail("最多保留 " + LIMITS.conversations + " 个会话，请删除不再需要的旧会话。", "CONVERSATION_LIMIT");
      const conversation = { id: makeId(), title: "新对话", messages: [], createdAt: timestamp() };
      person.conversations.push(conversation); person.activeConversationId = conversation.id;
    });
  }

  function selectConversation({ id, conversationId }) {
    validId(conversationId);
    return mutate(id, (person) => {
      if (!person.conversations.some((item) => item.id === conversationId)) throw fail("会话不属于此人物或已不存在。", "NOT_FOUND");
      person.activeConversationId = conversationId;
    });
  }

  function deleteConversation({ id, conversationId }) {
    validId(conversationId);
    return mutate(id, (person) => {
      const index = person.conversations.findIndex((item) => item.id === conversationId);
      if (index < 0) throw fail("会话不属于此人物或已不存在。", "NOT_FOUND");
      person.conversations.splice(index, 1);
      if (!person.conversations.length) person.conversations.push({ id: makeId(), title: "新对话", messages: [], createdAt: timestamp() });
      if (person.activeConversationId === conversationId) person.activeConversationId = person.conversations[person.conversations.length - 1].id;
    });
  }

  function restoreCard({ id, version }) {
    return mutate(id, (person) => {
      if (!Number.isInteger(version) || version < 1) throw fail("版本号无效。", "INVALID_INPUT");
      const saved = person.versions.find((item) => item.version === version);
      if (!saved) throw fail("该人物卡版本不存在。", "NOT_FOUND");
      appendCard(person, validateCard(saved.card), { restoredFrom: version });
      // Restored cards keep their original evidence revision for stale-card disclosure.
      person.cardSourceRevision = saved.sourceRevision;
      person.versions[person.versions.length - 1].sourceRevision = saved.sourceRevision;
    });
  }

  function remove(input) {
    const id = typeof input === "string" ? input : input?.id;
    validId(id);
    for (const state of requests.values()) if (state.personId === id) cancel(state.id);
    return locked(id, () => { read(id); fs.unlinkSync(personPath(id)); return true; });
  }

  return { list, create, get, updateProfile, addSources, importEmails, captureModel, removeSource, generate, saveCard, chat,
    newConversation, selectConversation, deleteConversation, restoreCard, remove, cancel, cancelAll: () => { for (const id of requests.keys()) cancel(id); } };
}

module.exports = { createPersonaService, LIMITS };
