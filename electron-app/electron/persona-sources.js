"use strict";

const { createHash } = require("node:crypto");
const { TextDecoder } = require("node:util");
const { EMAIL_LIMITS, normalizeEmailMetadata } = require("./persona-email");

const MAX_SOURCE_CHARS = 80000;
const MAX_IMPORT_BYTES = 1024 * 1024;
const CHUNK_SIZE = 3000;
const KINDS = new Set(["article", "note", "chat", "email"]);
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const CANONICAL_LINE = /^【(目标人物|仅作上下文)：([^】]+)】(?: (.*))?$/;

function assertText(value, label, maxLength = MAX_SOURCE_CHARS) {
  if (typeof value !== "string") throw new Error(`${label}必须是文本`);
  if (value.length > maxLength) throw new Error(`${label}不能超过 ${maxLength} 字符`);
  if (CONTROL_CHARACTERS.test(value)) throw new Error(`${label}包含二进制或控制字符`);
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) {
    throw new Error(`${label}包含无效 Unicode 文本`);
  }
  return value.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

function sourceTitle(value) {
  const title = assertText(value === undefined ? "未命名资料" : value, "资料标题", 1000)
    .replaceAll("\\", "/").split("/").pop().trim();
  if (!title || title === "." || title === ".." || /[\n\t]/.test(title)) {
    throw new Error("资料标题无效");
  }
  if (title.length > 200) throw new Error("资料标题不能超过 200 字符");
  return title;
}

function speakerName(value, label = "目标说话者") {
  const speaker = assertText(value, label, 80).trim();
  if (!speaker || /[\n\t:：【】]/.test(speaker)) throw new Error(`${label}无效`);
  return speaker;
}

function normalizeChat(text, target) {
  const messages = [];
  let current = null;
  let hasTarget = false;
  for (const line of text.split("\n")) {
    const canonical = CANONICAL_LINE.exec(line);
    if (canonical) {
      const speaker = speakerName(canonical[2], "聊天说话者");
      const isTarget = speaker === target;
      if ((canonical[1] === "目标人物") !== isTarget) throw new Error("聊天人物标记与目标说话者不一致");
      current = { speaker, content: canonical[3] || "" };
      messages.push(current);
      hasTarget ||= isTarget && Boolean(current.content.trim());
      continue;
    }
    // A malformed canonical label must never fall through to the permissive
    // "name: content" parser or become a continuation of a target statement.
    if (/^\s*【(?:目标人物|仅作上下文)/.test(line)) throw new Error("聊天人物标记格式无效");
    const named = /^([^:：\n]{1,80})[:：]\s*(.*)$/.exec(line);
    if (named && !/^\s/.test(line)) {
      current = { speaker: speakerName(named[1], "聊天说话者"), content: named[2] };
      messages.push(current);
    } else if (current) {
      current.content += `\n${line}`;
    } else if (line.trim()) {
      throw new Error("聊天记录需使用“姓名：内容”格式，不能有未标明说话者的开头");
    }
    if (current?.speaker === target && current.content.trim()) hasTarget = true;
  }
  if (!hasTarget) throw new Error(`聊天记录中没有找到目标说话者“${target}”的有效发言`);
  return renderMessages(messages, target);
}

function renderMessages(messages, target) {
  const lines = [];
  for (const message of messages) {
    const label = message.speaker === target ? "目标人物" : "仅作上下文";
    for (const line of message.content.split("\n")) {
      lines.push(`【${label}：${message.speaker}】${line ? ` ${line}` : ""}`);
    }
  }
  const text = lines.join("\n");
  if (text.length > MAX_SOURCE_CHARS) throw new Error(`聊天资料整理后不能超过 ${MAX_SOURCE_CHARS} 字符`);
  return text;
}

/** Normalize one source; this is also safe to call again on a parsed source. */
function normalizeSource(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("资料格式无效");
  const kind = input.kind === undefined ? "note" : input.kind;
  if (!KINDS.has(kind)) throw new Error("资料类型只支持 article、note、chat 或 email");
  const title = sourceTitle(input.title);
  const raw = assertText(input.text, "资料正文").trim();
  if (!raw) throw new Error("资料正文不能为空");
  if (kind === "email") {
    if (raw.length > EMAIL_LIMITS.sourceChars) throw new Error("邮件正文超过容量限制。");
    return { title, kind, text: raw, speaker: "", email: normalizeEmailMetadata(input.email, raw) };
  }
  if (kind !== "chat") return { title, kind, text: raw, speaker: "" };
  const speaker = speakerName(input.speaker);
  if (/^[\[{]/.test(raw)) {
    let messages;
    try {
      messages = JSON.parse(raw);
    } catch {
      try {
        messages = raw.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
      } catch {
        throw new Error("无效的 JSON/JSONL 聊天文本");
      }
    }
    return { title, kind, text: parseMessages(messages, speaker), speaker };
  }
  return { title, kind, text: normalizeChat(raw, speaker), speaker };
}

function messageContent(value) {
  if (typeof value === "string") return assertText(value, "聊天正文");
  if (Array.isArray(value) && value.length > 0) {
    return value.map((part) => {
      if (!part || part.type !== "text" || typeof part.text !== "string") {
        throw new Error("聊天仅支持文本 content，不支持图片、工具调用或其他内容块");
      }
      return assertText(part.text, "聊天正文");
    }).join("\n");
  }
  throw new Error("聊天消息缺少文本 content");
}

function parseMessages(value, target) {
  const items = Array.isArray(value) ? value : value?.messages;
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("JSON 聊天只支持消息数组或 {messages: [...]}，每条需有 speaker/name/role 和 content");
  }
  const messages = items.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("JSON 聊天消息格式无效");
    const speaker = speakerName(item.speaker ?? item.name ?? item.role, "聊天说话者");
    let content = messageContent(item.content);
    const hasContent = Boolean(content.trim());
    if (item.timestamp !== undefined && item.timestamp !== null) {
      if (typeof item.timestamp !== "string" && (typeof item.timestamp !== "number" || !Number.isFinite(item.timestamp))) {
        throw new Error("聊天时间格式无效");
      }
      const timestamp = assertText(String(item.timestamp), "聊天时间", 100);
      if (/[\n\t]/.test(timestamp)) throw new Error("聊天时间格式无效");
      content = `[${timestamp}] ${content}`;
    }
    return { speaker, content, hasContent };
  });
  if (!messages.some((message) => message.speaker === target && message.hasContent)) {
    throw new Error(`聊天记录中没有找到目标说话者“${target}”的有效发言`);
  }
  return renderMessages(messages, target);
}

/** Parse UTF-8 TXT/MD/JSON/JSONL bytes into exactly one normalized source. */
function parseSourceFile({ name, buffer, kind, speaker } = {}) {
  const title = sourceTitle(name);
  const extension = /\.([^.]+)$/.exec(title)?.[1].toLowerCase();
  if (!["txt", "md", "markdown", "json", "jsonl"].includes(extension)) throw new Error("仅支持 UTF-8 TXT、MD、Markdown、JSON、JSONL 文件");
  if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) throw new Error("文件内容必须是字节数据");
  if (buffer.byteLength > MAX_IMPORT_BYTES) throw new Error("单个文件不能超过 1 MiB");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new Error("文件不是有效的 UTF-8 文本，请先转换编码");
  }
  text = assertText(text, "文件正文", MAX_IMPORT_BYTES).trim();
  if (!text) throw new Error("文件内容不能为空");
  if (extension === "json" || extension === "jsonl") {
    if (kind !== undefined && kind !== "chat") throw new Error("JSON/JSONL 仅支持聊天消息，请选择聊天类型");
    const target = speakerName(speaker);
    let value;
    try {
      value = extension === "jsonl"
        ? text.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line))
        : JSON.parse(text);
    } catch {
      throw new Error(`无效的 ${extension.toUpperCase()} 文件`);
    }
    const normalized = parseMessages(value, target);
    return normalizeSource({ title, kind: "chat", speaker: target, text: normalized });
  }
  return normalizeSource({ title, kind, text, speaker });
}

// Prefer paragraph or sentence boundaries, while retaining every character.
function splitText(text, maxChars) {
  const parts = [];
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(text.length, offset + maxChars);
    if (end < text.length) {
      const half = offset + Math.floor(maxChars / 2);
      const newline = text.lastIndexOf("\n", end - 1);
      if (newline >= half) end = newline + 1;
      else {
        for (let index = end - 1; index >= half; index -= 1) {
          if (/[。！？.!?；;]/.test(text[index])) { end = index + 1; break; }
        }
      }
      if (/[\uD800-\uDBFF]/.test(text[end - 1])) end -= 1;
    }
    parts.push(text.slice(offset, end));
    offset = end;
  }
  return parts;
}

function chatChunks(text) {
  const atoms = [];
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    const match = CANONICAL_LINE.exec(line);
    const prefix = `【${match[1]}：${match[2]}】`;
    const content = match[3] || "";
    const pieces = content ? splitText(content, CHUNK_SIZE - prefix.length - 2) : [""];
    pieces.forEach((piece, pieceIndex) => {
      atoms.push(`${prefix}${piece ? ` ${piece}` : ""}${index < lines.length - 1 && pieceIndex === pieces.length - 1 ? "\n" : ""}`);
    });
  });
  const chunks = [];
  let pending = "";
  for (const atom of atoms) {
    // When a long message spans chunks, repeat its original speaker label.
    if (pending && pending.length + atom.length > CHUNK_SIZE) {
      chunks.push(pending);
      pending = "";
    }
    pending += atom;
  }
  if (pending) chunks.push(pending);
  return chunks;
}

function chunkSources(sources) {
  if (!Array.isArray(sources)) throw new Error("资料列表格式无效");
  const chunks = [];
  const ids = new Set();
  sources.forEach((input, sourceIndex) => {
    const source = normalizeSource(input);
    const sourceId = input.id === undefined
      ? `src-${createHash("sha256").update(JSON.stringify(source)).digest("hex").slice(0, 16)}-${sourceIndex + 1}`
      : input.id;
    if (typeof sourceId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(sourceId)) throw new Error("资料 ID 无效");
    if (ids.has(sourceId)) throw new Error("资料 ID 重复");
    ids.add(sourceId);
    const parts = source.kind === "chat" ? chatChunks(source.text) : splitText(source.text, CHUNK_SIZE);
    parts.forEach((text, index) => chunks.push({ id: `${sourceId}:${index + 1}`, sourceId, title: source.title, text }));
  });
  return chunks;
}

function terms(text) {
  const frequencies = new Map();
  const add = (term) => frequencies.set(term, (frequencies.get(term) || 0) + 1);
  for (const match of String(text).normalize("NFKC").toLowerCase().matchAll(/[\p{Script=Han}]+|[a-z0-9_]+/gu)) {
    const token = match[0];
    if (/^[\p{Script=Han}]+$/u.test(token)) {
      const characters = Array.from(token);
      if (characters.length === 1) add(characters[0]);
      else for (let index = 0; index < characters.length - 1; index += 1) add(characters[index] + characters[index + 1]);
    } else add(token);
  }
  return frequencies;
}

/** Deterministic, local BM25-style retrieval; returned evidence is never cut. */
function retrieveChunks(chunks, query, { limit = 6, maxChars = 12000 } = {}) {
  if (!Array.isArray(chunks)) throw new Error("资料片段格式无效");
  if (typeof query !== "string" || query.length > MAX_SOURCE_CHARS) throw new Error("检索问题格式无效");
  if (!Number.isInteger(limit) || limit < 0 || limit > 100 || !Number.isInteger(maxChars) || maxChars < 0) {
    throw new Error("检索数量或字符预算无效");
  }
  if (!limit || !maxChars || !query.trim() || !chunks.length) return [];
  const queryTerms = [...terms(query).keys()];
  if (!queryTerms.length) return [];
  const documents = chunks.map((chunk, index) => {
    if (!chunk || typeof chunk.text !== "string" || typeof chunk.title !== "string") throw new Error("资料片段格式无效");
    const frequencies = terms(chunk.text);
    return { chunk, index, frequencies, titleTerms: terms(chunk.title), length: [...frequencies.values()].reduce((a, b) => a + b, 0) };
  });
  const averageLength = documents.reduce((sum, document) => sum + document.length, 0) / documents.length || 1;
  const documentFrequencies = new Map(queryTerms.map((term) => [term, documents.filter((document) => document.frequencies.has(term) || document.titleTerms.has(term)).length]));
  const scored = documents.map((document) => {
    let score = 0;
    for (const term of queryTerms) {
      const count = (document.frequencies.get(term) || 0) + 2 * (document.titleTerms.get(term) || 0);
      if (!count) continue;
      const frequency = documentFrequencies.get(term);
      const inverse = Math.log(1 + (documents.length - frequency + 0.5) / (frequency + 0.5));
      score += inverse * count * 2.2 / (count + 1.2 * (0.25 + 0.75 * document.length / averageLength));
    }
    return { ...document, score };
  }).filter((document) => document.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
  let remaining = maxChars;
  const result = [];
  for (const document of scored) {
    if (document.chunk.text.length > remaining) continue;
    result.push(document.chunk);
    remaining -= document.chunk.text.length;
    if (result.length >= limit) break;
  }
  return result;
}

module.exports = { MAX_SOURCE_CHARS, MAX_IMPORT_BYTES, CHUNK_SIZE, normalizeSource, parseSourceFile, chunkSources, retrieveChunks };
