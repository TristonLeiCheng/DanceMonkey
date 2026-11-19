// Checks whether the configured real model follows the output formats project AI relies on.
// Usage: npm run verify:project-ai [-- --runs=2]
// Reads the app's AI/network settings read-only and sends only the synthetic project below.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");
const { createLegacyConfig } = require("../electron/legacy-config");
const { configureApplicationProxy } = require("../electron/system-proxy");
const { createAiService } = require("../electron/ai");
const { createZenTaskStore } = require("../electron/zentask");
const { createPersonaService } = require("../electron/personas");
const projectAi = require("../electron/project-ai");
const model = require("../src/zen-model");

const runs = Math.max(1, Number((process.argv.find((arg) => arg.startsWith("--runs=")) || "--runs=1").split("=")[1]) || 1);

function seedVault(root) {
  const now = new Date();
  const day = (offset) => model.localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset));
  const project = model.createProject({ name: "官网改版", goal: "上线新版官网，首页转化率提升 10%", acceptanceCriteria: "新版首页上线并稳定运行两周",
    nextAction: "确认设计稿", dueDate: day(40), milestones: [{ id: "m1", name: "设计定稿", dueDate: day(5), acceptanceCriteria: "评审通过" }] }, "p1");
  const other = model.createProject({ name: "客户培训", goal: "完成 3 场客户培训", dueDate: day(20) }, "p2");
  const tasks = [
    model.createTask({ title: "等待法务审核隐私条款", projectId: "p1", workflowStatus: "Blocked" }, "t1", [project]),
    model.createTask({ title: "首页文案", projectId: "p1", dueDate: day(-2) }, "t2", [project]),
    model.createTask({ title: "首页线框", projectId: "p1", workflowStatus: "Completed", milestoneId: "m1" }, "t3", [project]),
    model.createTask({ title: "准备培训材料", projectId: "p2", dueDate: day(3), workflowStatus: "In Progress" }, "t4", [other]),
  ];
  fs.mkdirSync(path.join(root, "Journal"), { recursive: true });
  fs.writeFileSync(path.join(root, "Journal", "zentask-projects.json"), JSON.stringify({ SchemaVersion: 2, Items: [project, other] }));
  fs.writeFileSync(path.join(root, "Journal", "task-module.json"), JSON.stringify({ SchemaVersion: 2, Items: tasks }));
}

const NOTE = "## 周会记录\n- 张三下周三前把报价发给客户\n结论：方案 A 通过。\n小李负责在月底前更新首页文案\n- [x] 已完成：确认预算";

async function main() {
  // DM_VERIFY_APPDATA lets the script itself be tested against a mock endpoint without touching real settings.
  const real = createLegacyConfig(process.env.DM_VERIFY_APPDATA || app.getPath("appData"));
  const settings = real.read();
  if (!String(settings.apiKey || "").trim()) {
    console.error("未配置 API Key：请先在 DM「AI 设置」中填写接口地址、Key 和模型，再运行本脚本。");
    return 2;
  }
  const config = { ...settings };
  const configStore = { read: () => config, write: () => { throw new Error("verify script never writes settings"); } };
  configureApplicationProxy(() => config);
  const ai = createAiService(configStore);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dm-verify-project-ai-"));
  const results = [];
  try {
    seedVault(path.join(root, "vault"));
    const store = createZenTaskStore(path.join(root, "vault"));
    const personas = createPersonaService({ userDataPath: path.join(root, "user-data"), aiService: ai });
    let persona = await personas.create({ name: "严格评审", description: "关注上线风险" });
    persona = await personas.addSources({ id: persona.id, sources: [{ title: "评审笔记", kind: "note", text: "上线前必须准备回滚方案，否则不批准。监控和告警要先就绪。" }] });
    persona = await personas.saveCard({ id: persona.id, baseVersion: persona.cardVersion, sourceRevision: persona.sourceRevision,
      card: { summary: "谨慎的评审者", knowledge: "上线流程", thinking: "先看风险再看收益", style: "直接、简短", boundaries: "资料有限" } });
    const chat = (systemPrompt, messages, extra = {}) => ai.chat({ requestId: `verify-${Date.now()}-${Math.random().toString(36).slice(2)}`, systemPrompt, messages, ...extra });

    const checks = {
      "操作卡片（dm-actions）": async () => {
        const state = store.load();
        const context = projectAi.buildProjectContext(state, "p1");
        const text = await chat(projectAi.projectChatSystemPrompt(context.text), [{ role: "user", content: "法务已经回复了，把受阻的法务审核任务改为进行中；再新建一个任务：周五前跟进上线回滚方案。请给出可应用的操作。" }]);
        const result = projectAi.extractActions(text, state, "p1");
        return { ok: result.actions.length > 0 && !result.display.includes("dm-actions"),
          detail: `有效操作 ${result.actions.length}，略过 ${result.dropped}：${result.actions.map((action) => action.summary).join("；") || "无"}` };
      },
      "普通问答不泄漏代码块": async () => {
        const context = projectAi.buildProjectContext(store.load(), "p1");
        const text = await chat(projectAi.projectChatSystemPrompt(context.text), [{ role: "user", content: "用三句话总结这个项目的现状。" }]);
        const split = projectAi.splitActions(text);
        return { ok: Boolean(split.display.trim()) && !split.display.includes("```dm-actions"), detail: `${split.display.length} 字${split.found ? "，附带了操作块" : ""}` };
      },
      "周报起草（JSON）": async () => {
        const request = projectAi.buildWeeklyDraftRequest(store.load(), "p1");
        const draft = projectAi.parseWeeklyDraft(await chat(request.systemPrompt, request.messages, { temperature: 0.3, maxTokens: 1500 }));
        return { ok: draft.parsed && Boolean(draft.health), detail: draft.parsed ? `健康度 ${draft.health || "无效"}，进展 ${draft.summary.length} 字` : "未按 JSON 返回，已退回全文" };
      },
      "拆解计划（JSON）": async () => {
        const request = projectAi.buildPlanRequest(store.load(), "p1");
        const plan = projectAi.parsePlan(await chat(request.systemPrompt, request.messages, { temperature: 0.4, maxTokens: 4000 }), store.load(), "p1");
        const tasks = plan.groups.reduce((count, group) => count + group.tasks.length, 0);
        const datedMilestones = plan.groups.filter((group) => !group.existingId && group.dueDate).length;
        return { ok: plan.groups.length > 0 && tasks > 0, detail: `${plan.groups.length} 个阶段、${tasks} 项任务，${datedMilestones} 个新阶段带有效日期，略过 ${plan.dropped}` };
      },
      "笔记提取任务（JSON + 原文摘录）": async () => {
        const result = await projectAi.extractNoteTasks(ai, store.load(), { projectId: "p1", text: NOTE, sourcePath: "20_Work/周会.md", requestId: `verify-note-${Date.now()}` });
        const excerpts = result.candidates.filter((item) => item.excerpt).length;
        return { ok: result.candidates.length > 0, detail: `${result.candidates.length} 项（${result.candidates.map((item) => item.title).join("、")}），${excerpts} 项保留了原文摘录` };
      },
      "今日简报": async () => {
        const request = projectAi.buildBriefRequest(store.load());
        const text = await chat(request.systemPrompt, request.messages, { temperature: 0.4, maxTokens: 1200 });
        const headline = projectAi.briefHeadline(text);
        return { ok: Boolean(headline), detail: `${text.length} 字；宠物气泡：${headline || "（空）"}` };
      },
      "跨项目提问": async () => {
        const context = projectAi.buildPortfolioContext(store.load());
        const text = await chat(projectAi.portfolioSystemPrompt(context.text), [{ role: "user", content: "哪些项目本周有风险？" }]);
        const split = projectAi.splitActions(text);
        return { ok: Boolean(split.display.trim()) && !split.found, detail: `${split.display.length} 字${split.found ? "，违规附带了操作块" : ""}` };
      },
      "人物分身审阅（引用标记）": async () => {
        const context = projectAi.buildProjectContext(store.load(), "p1", { withIds: false });
        const result = await personas.review({ id: persona.id, subject: "项目：官网改版", material: context.text, focus: "进度风险、阻塞和应对办法", requestId: `verify-review-${Date.now()}` });
        return { ok: Boolean(result.text.trim()), detail: `${result.text.length} 字，有效引用 ${result.citations.length}${result.text.includes("来源未核实") ? "，含编造的引用标记" : ""}` };
      },
    };

    console.log(`模型：${config.model}　接口：${config.apiEndpoint || "（默认 OpenAI）"}　网络：${config.aiNetworkMode}　每项 ${runs} 次\n`);
    for (const [name, check] of Object.entries(checks)) {
      for (let run = 1; run <= runs; run += 1) {
        const started = Date.now();
        try {
          const { ok, detail } = await check();
          results.push({ name, ok });
          console.log(`${ok ? "✔" : "✖"} ${name}${runs > 1 ? ` #${run}` : ""}（${((Date.now() - started) / 1000).toFixed(1)}s）：${detail}`);
        } catch (error) {
          results.push({ name, ok: false });
          console.log(`✖ ${name}${runs > 1 ? ` #${run}` : ""}：${error.message}`);
        }
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  const passed = results.filter((result) => result.ok).length;
  console.log(`\n通过 ${passed}/${results.length}`);
  return passed === results.length ? 0 : 1;
}

app.whenReady().then(main).then((code) => app.exit(code), (error) => { console.error(error); app.exit(1); });
app.on("window-all-closed", () => {});
