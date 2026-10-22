const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const tools = require("../src/persona-profile");
const { createPersonaService } = require("../electron/personas");

test("observation scoring handles opposite preferences, ties and unknowns without fabricated certainty", () => {
  assert.equal(tools.assess(Array(12).fill(1)).type, "ESTJ");
  assert.equal(tools.assess(Array(12).fill(-1)).type, "INFP");
  assert.equal(tools.assess(Array(12).fill(0)).type, "XXXX");
  assert.equal(tools.assess([1,-1,0, 1,1,-1, -1,-1,1, 1,0,0]).type, "XSFJ");
  assert.throws(() => tools.assess(Array(12).fill(null)), /12/);
  assert.throws(() => tools.assess([1]), /12/);
});
test("profile validates real calendar dates, limits, explicit zodiac and manual MBTI", () => {
  assert.equal(tools.normalize({ birthDate: "1992-02" }).birthDate, "1992-02");
  assert.equal(tools.normalize({ birthDate: "2000-02-29" }).zodiac, "");
  for (const birthDate of ["1900-02-29", "2023-02-29", "1990-13", "2999-01", "1990-1", "1990-04-31"]) assert.throws(() => tools.normalize({ birthDate }));
  assert.equal(tools.normalize({ mbti: "intj" }).mbti, "INTJ");
  assert.throws(() => tools.normalize({ mbti: "ABCD" }));
  assert.throws(() => tools.normalize({ resume: "x".repeat(12001) }));
  assert.throws(() => tools.normalize({ zodiac: "未知星座" }));
  assert.equal(tools.normalize({ mbtiMode: "assessment", mbti: "INTJ", answers: Array(12).fill(-1) }).mbti, "INFP");
});
test("manual-only profiles persist, generate evidence, invalidate previews, and can be cleared", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dm-profile-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [], card = { summary: "概览", knowledge: "知识", thinking: "思考", style: "表达", boundaries: "边界" };
  const ai = { chat: async (input) => { calls.push(input); return input.systemPrompt.includes("只返回一个 JSON 对象") ? JSON.stringify(card) : "用户提供的事件摘要"; } };
  const service = createPersonaService({ userDataPath: root, aiService: ai });
  let p = await service.create({ name: "人物" });
  p = await service.updateProfile({ id: p.id, baseRevision: 0, profile: { birthDate: "1990-05", resume: "产品设计经历", events: "2024-06：先做小实验。", mbti: "INTJ", zodiac: "金牛座" } });
  assert.equal(p.sourceRevision, 1); assert.equal(p.sources.length, 0);
  const preview = await service.generate({ id: p.id });
  assert.match(calls[0].messages[0].content, /产品设计经历/);
  assert.match(calls[0].messages[0].content, /用户提供/);
  assert.match(calls[0].systemPrompt, /星座仅作资料记录/);
  const reopened = createPersonaService({ userDataPath: root, aiService: ai });
  assert.equal((await reopened.get(p.id)).profile.birthDate, "1990-05");
  await assert.rejects(service.updateProfile({ id: p.id, profile: {}, baseRevision: 0 }), /已变化/);
  await service.updateProfile({ id: p.id, profile: { events: "修改后的事件" }, baseRevision: 1 });
  await assert.rejects(service.saveCard({ id: p.id, ...preview }), /已变化/);
  await service.updateProfile({ id: p.id, profile: {}, baseRevision: 2 });
  await assert.rejects(service.generate({ id: p.id }), /先导入/);
});
