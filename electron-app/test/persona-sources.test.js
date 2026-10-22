const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MAX_SOURCE_CHARS,
  MAX_IMPORT_BYTES,
  CHUNK_SIZE,
  normalizeSource,
  parseSourceFile,
  chunkSources,
  retrieveChunks,
} = require("../electron/persona-sources");

function file(text, options = {}) {
  return parseSourceFile({ name: "资料.md", buffer: Buffer.from(text), ...options });
}

test("imports UTF-8 articles and notes as inert text and removes only file path from title", () => {
  const text = '# 文章\r\n<script>globalThis.personaSourceExecuted = true</script>\r\n知识正文';
  const source = file(text, { name: "C:\\Users\\张三\\private\\文章.MD", kind: "article" });
  assert.deepEqual(source, {
    title: "文章.MD", kind: "article", speaker: "",
    text: '# 文章\n<script>globalThis.personaSourceExecuted = true</script>\n知识正文',
  });
  assert.equal(globalThis.personaSourceExecuted, undefined);
  assert.equal(file("\uFEFF笔记", { name: "../../private/研究.txt" }).title, "研究.txt");
  assert.equal(file("\uFEFF笔记").text, "笔记");
  assert.equal(file("Markdown 别名", { name: "文章.markdown" }).text, "Markdown 别名");
  assert.throws(() => normalizeSource({ title: "..", text: "text" }), /标题/);
  assert.throws(() => normalizeSource({ title: "标题\n假来源", text: "text" }), /标题/);
});

test("plain chat separates the selected author from other participants and stays idempotent", () => {
  const source = file("李四：你如何写文章？\n张三: 我会先列提纲。\n  然后逐段修改。\n李四：我从来不修改。", {
    kind: "chat", speaker: "张三", name: "访谈.txt",
  });
  assert.match(source.text, /【目标人物：张三】 我会先列提纲。/);
  assert.match(source.text, /【目标人物：张三】   然后逐段修改。/);
  assert.match(source.text, /【仅作上下文：李四】 我从来不修改。/);
  assert.doesNotMatch(source.text, /【目标人物：李四】/);
  assert.deepEqual(normalizeSource(source), source);
});

test("chat requires a matching explicit speaker and rejects forged or broken role labels", () => {
  assert.throws(() => file("张三：观点", { kind: "chat" }), /目标说话者/);
  assert.throws(() => file("李四：张三认为可以", { kind: "chat", speaker: "张三" }), /没有找到目标/);
  assert.throws(() => file("没有说话者的记录\n张三：观点", { kind: "chat", speaker: "张三" }), /未标明说话者/);
  assert.throws(() => file("【目标人物：李四】 冒充观点", { kind: "chat", speaker: "张三" }), /不一致/);
  assert.throws(() => file("【仅作上下文：张三】 观点", { kind: "chat", speaker: "张三" }), /不一致/);
  assert.throws(() => file("张三：正常\n【目标人物：李四】缺少空格", { kind: "chat", speaker: "张三" }), /标记格式/);
  assert.throws(() => file("【仅作上下文：李四】 没有本人", { kind: "chat", speaker: "张三" }), /没有找到目标/);
  assert.throws(() => file("张三：", { kind: "chat", speaker: "张三" }), /有效发言/);
});

test("JSON chat preserves authors and timestamps and handles supported OpenAI text messages", () => {
  const source = file(JSON.stringify({ messages: [
    { speaker: "李四", content: "你赞同吗？", timestamp: "2026-10-22 09:00" },
    { speaker: "张三", content: "我不同意。\n事实与意见要分开。", timestamp: "2026-10-22 09:01" },
  ] }), { name: "聊天.json", kind: "chat", speaker: "张三" });
  assert.match(source.text, /【仅作上下文：李四】 \[2026-10-22 09:00\] 你赞同吗？/);
  assert.match(source.text, /【目标人物：张三】 \[2026-10-22 09:01\] 我不同意。/);
  assert.match(source.text, /【目标人物：张三】 事实与意见要分开。/);
  assert.deepEqual(normalizeSource(source), source);

  const openAI = file(JSON.stringify([
    { role: "assistant", content: "我猜你的风格是激进。" },
    { role: "user", content: [{ type: "text", text: "我喜欢谨慎表达。" }] },
  ]), { name: "openai.json", speaker: "user" });
  assert.equal(openAI.kind, "chat");
  assert.match(openAI.text, /【仅作上下文：assistant】/);
  assert.match(openAI.text, /【目标人物：user】 我喜欢谨慎表达。/);
});

test("JSONL imports every message and does not hide malformed records", () => {
  const source = file('{"speaker":"访客","content":"问题"}\n\n{"speaker":"张三","content":"回答"}\n', {
    name: "chat.jsonl", speaker: "张三",
  });
  assert.match(source.text, /【目标人物：张三】 回答/);
  assert.match(source.text, /【仅作上下文：访客】 问题/);
  assert.throws(() => file('{"speaker":"张三","content":"回答"}\nBROKEN', {
    name: "chat.jsonl", speaker: "张三",
  }), /无效的 JSONL/);
});

test("pasted JSON and JSONL chats use the same speaker attribution rules", () => {
  const json = normalizeSource({ kind: "chat", speaker: "张三", text: JSON.stringify({ messages: [
    { speaker: "李四", content: "问题" }, { speaker: "张三", content: "本人回答" },
  ] }) });
  assert.match(json.text, /【目标人物：张三】 本人回答/);
  assert.deepEqual(normalizeSource(json), json);
  const jsonl = normalizeSource({ kind: "chat", speaker: "张三", text: '{"speaker":"李四","content":"问题"}\n{"speaker":"张三","content":"回答"}' });
  assert.match(jsonl.text, /【目标人物：张三】 回答/);
  assert.throws(() => normalizeSource({ kind: "chat", speaker: "张三", text: '{"unrecognized":"value"}' }), /只支持消息数组/);
  assert.throws(() => normalizeSource({ kind: "chat", speaker: "张三", text: '{"messages":[{"speaker":"张三","content":"","timestamp":"2026-01-01"}]}' }), /有效发言/);
});

test("unsupported JSON is rejected instead of silently treated as an article", () => {
  assert.throws(() => file('{"secret":"not a supported conversation"}', {
    name: "data.json", speaker: "张三",
  }), /只支持消息数组/);
  assert.throws(() => file('{"messages":[{"speaker":"张三","content":"hello"}]}', {
    name: "data.json", kind: "article", speaker: "张三",
  }), /仅支持聊天/);
  assert.throws(() => file('{"messages":[{"content":"speaker missing"}]}', {
    name: "data.json", speaker: "张三",
  }), /聊天说话者/);
  assert.throws(() => file('{"messages":[{"speaker":"李四","content":"张三"}]}', {
    name: "data.json", speaker: "张三",
  }), /没有找到目标/);
  assert.throws(() => file('{"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"file:///secret"}}]}]}', {
    name: "data.json", speaker: "user",
  }), /仅支持文本/);
  assert.throws(() => file('{"messages":[{"role":"user","content":{}}]}', {
    name: "data.json", speaker: "user",
  }), /缺少文本/);
});

test("invalid UTF-8, binary controls, unsupported formats and unsafe scalar inputs fail closed", () => {
  assert.throws(() => parseSourceFile({ name: "binary.txt", buffer: Buffer.from([0xc3, 0x28]) }), /UTF-8/);
  assert.throws(() => file("valid\u0000binary"), /二进制或控制字符/);
  assert.throws(() => file("\u001b[31m控制"), /二进制或控制字符/);
  assert.throws(() => file("text", { name: "document.pdf" }), /仅支持/);
  assert.throws(() => parseSourceFile({ name: "text.txt", buffer: "text" }), /字节数据/);
  assert.throws(() => normalizeSource({ text: "\uD800" }), /Unicode/);
  assert.throws(() => normalizeSource({ text: "text", kind: "unknown" }), /资料类型/);
  assert.throws(() => normalizeSource({ text: {} }), /必须是文本/);
  assert.throws(() => file(" \n\t "), /不能为空/);
});

test("enforces byte and normalized character boundaries without silently truncating", () => {
  assert.throws(() => parseSourceFile({ name: "big.txt", buffer: Buffer.alloc(MAX_IMPORT_BYTES + 1, 32) }), /1 MiB/);
  const json = Buffer.from('[{"speaker":"张三","content":"界限内"}]');
  const exactByteLimit = Buffer.alloc(MAX_IMPORT_BYTES, 32);
  json.copy(exactByteLimit);
  assert.match(parseSourceFile({ name: "exact.json", buffer: exactByteLimit, speaker: "张三" }).text, /界限内/);
  assert.equal(file("a".repeat(MAX_SOURCE_CHARS)).text.length, MAX_SOURCE_CHARS);
  assert.throws(() => file("a".repeat(MAX_SOURCE_CHARS + 1)), /80000/);
  assert.throws(() => file("张三：x\n".repeat(9000), { kind: "chat", speaker: "张三" }), /80000/);
});

test("article chunks cover all normalized text including long paragraphs and surrogate pairs", () => {
  const text = `首段内容。\n\n${"知识".repeat(2800)}\n${"🙂".repeat(2200)}\n最后的证据。`;
  const source = normalizeSource({ title: "研究.md", kind: "article", text });
  const chunks = chunkSources([{ ...source, id: "source-1" }]);
  assert.ok(chunks.length > 3);
  assert.equal(chunks.map((chunk) => chunk.text).join(""), source.text);
  assert.ok(chunks.every((chunk) => chunk.text.length <= CHUNK_SIZE && chunk.text.length > 0));
  assert.ok(chunks.every((chunk) => chunk.sourceId === "source-1" && chunk.title === "研究.md"));
  assert.deepEqual(chunks.map((chunk) => chunk.id), chunks.map((_, index) => `source-1:${index + 1}`));
  for (const chunk of chunks) assert.doesNotThrow(() => normalizeSource({ text: chunk.text }));
  assert.deepEqual(chunkSources([{ ...source, id: "source-1" }]), chunks);
});

test("long chat message chunks repeat the original speaker instead of losing attribution", () => {
  const target = "目标人的表达。".repeat(700);
  const context = "别人的说法。".repeat(700);
  const source = normalizeSource({ title: "长聊天.txt", kind: "chat", speaker: "张三", text: `张三：${target}\n李四：${context}` });
  const chunks = chunkSources([{ ...source, id: "chat-1" }]);
  assert.ok(chunks.every((chunk) => chunk.text.length <= CHUNK_SIZE));
  assert.ok(chunks.every((chunk) => /^【(?:目标人物：张三|仅作上下文：李四)】/.test(chunk.text)));
  const combined = chunks.map((chunk) => chunk.text).join("");
  assert.equal(combined.match(/目标人的表达。/g).length, 700);
  assert.equal(combined.match(/别人的说法。/g).length, 700);
  assert.doesNotMatch(combined, /【目标人物：李四】/);
});

test("chunk citations use distinct safe source IDs and stable generated IDs", () => {
  const sources = [{ title: "same.md", text: "同名来源甲" }, { title: "same.md", text: "同名来源乙" }];
  const chunks = chunkSources(sources);
  assert.notEqual(chunks[0].sourceId, chunks[1].sourceId);
  assert.deepEqual(chunkSources(sources), chunks);
  assert.throws(() => chunkSources([{ id: "bad]id", text: "证据" }]), /ID 无效/);
  assert.throws(() => chunkSources([{ id: "same", text: "甲" }, { id: "same", text: "乙" }]), /ID 重复/);
});

test("Chinese bigram retrieval selects relevant source evidence without an embedding service", () => {
  const chunks = chunkSources([
    { id: "gardening", title: "生活笔记", text: "浇花应根据土壤湿度调整，修剪枝叶需要合适工具。" },
    { id: "writing", title: "写作方法", text: "写作时先列提纲，表达观点时要提供证据，避免空泛的形容词。" },
    { id: "database", title: "Engineering", text: "SQLite transactions maintain consistency. Indexes speed up database queries." },
  ]);
  const result = retrieveChunks(chunks, "如何写作和表达观点？", { limit: 1, maxChars: 500 });
  assert.equal(result[0].sourceId, "writing");
  assert.equal(retrieveChunks(chunks, "SQLITE transactions", { limit: 1 })[0].sourceId, "database");
  assert.deepEqual(retrieveChunks(chunks, "宇宙飞船引擎"), []);
  assert.deepEqual(retrieveChunks(chunks, ""), []);
});

test("retrieval respects whole-evidence character budgets and resolves ties deterministically", () => {
  const chunks = [
    { id: "a:1", sourceId: "a", title: "写作", text: "写作".repeat(100) },
    { id: "b:1", sourceId: "b", title: "写作", text: "写作方法" },
    { id: "c:1", sourceId: "c", title: "写作", text: "写作方法" },
  ];
  const result = retrieveChunks(chunks, "写作", { limit: 3, maxChars: 8 });
  assert.deepEqual(result.map((chunk) => chunk.id), ["b:1", "c:1"]);
  assert.equal(result.reduce((sum, chunk) => sum + chunk.text.length, 0), 8);
  assert.equal(result[0], chunks[1]);
  assert.deepEqual(retrieveChunks(chunks, "写作", { limit: 3, maxChars: 3 }), []);
  assert.deepEqual(retrieveChunks(chunks, "写作", { limit: 0 }), []);
  assert.throws(() => retrieveChunks(chunks, "写作", { limit: -1 }), /预算/);
  assert.throws(() => retrieveChunks(chunks, "写作", { maxChars: NaN }), /预算/);
});
