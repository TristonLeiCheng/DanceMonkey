import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const cwd = path.resolve(import.meta.dirname, "..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dm-project-ai-e2e-"));
const children = [];
const sockets = [];
const requests = [];
const screenshots = [];
const screenshotDirectory = process.env.DM_PROJECT_AI_SCREENSHOT_DIR && path.resolve(process.env.DM_PROJECT_AI_SCREENSHOT_DIR);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let mock;

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function start(name, command, args, env = {}) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const record = { name, child, output: "", exited: false };
  const capture = (chunk) => { record.output = `${record.output}${chunk}`.slice(-8000); };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  child.once("exit", (code, signal) => { Object.assign(record, { exited: true, code, signal }); });
  children.push(record);
  return record;
}
async function waitFor(fn, { timeout = 20000, process: watched } = {}) {
  const end = Date.now() + timeout;
  let error;
  while (Date.now() < end) {
    if (watched?.exited) throw new Error(`${watched.name} exited (${watched.code}/${watched.signal})\n${watched.output}`);
    try { const value = await fn(); if (value) return value; } catch (next) { error = next; }
    await sleep(100);
  }
  throw new Error(`timed out${error ? `: ${error.message}` : ""}${watched?.output ? `\n${watched.output}` : ""}`);
}
async function stop(record) {
  if (record.exited) return;
  record.child.kill("SIGTERM");
  await Promise.race([new Promise((resolve) => record.child.once("exit", resolve)), sleep(2000)]);
  if (!record.exited) record.child.kill("SIGKILL");
}
async function connect(url) {
  const socket = new WebSocket(url);
  sockets.push(socket);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let serial = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    pending.get(message.id)?.(message);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 20000);
    pending.set(id, (response) => {
      pending.delete(id); clearTimeout(timeout);
      if (response.error) reject(new Error(`${method}: ${response.error.message}`)); else resolve(response.result);
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  };
  return { send, evaluate };
}
async function screenshot(client, name) {
  if (!screenshotDirectory) return;
  fs.mkdirSync(screenshotDirectory, { recursive: true });
  const capture = await client.send("Page.captureScreenshot", { format: "png" });
  const file = path.join(screenshotDirectory, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(capture.data, "base64"));
  screenshots.push(file);
}

const model = createRequire(import.meta.url)("../src/zen-model.js");
const chatAnswer = ["## 下一步建议", "", "1. **先解决「等待法务审核」**：它是当前唯一受阻任务。", "2. 补上逾期的「首页文案」。", "3. 推进「设计定稿」里程碑验收。"].join("\n");
const actionAnswer = ["先解除阻塞，再补一个跟进任务。", "", "```dm-actions", JSON.stringify({ actions: [
  { type: "create_task", title: "联系法务负责人", dueDate: "2030-01-15", milestoneId: "m1", priority: "High" },
  { type: "update_task", taskId: "t1", status: "In Progress" },
  { type: "update_task", taskId: "does-not-exist", status: "Completed" },
] }), "```"].join("\n");
const briefAnswer = "1. **官网改版**：催办「等待法务审核」，它阻塞了设计定稿。\n2. 补齐逾期的「首页文案」。\n\n整体：1 个项目有风险。";
const portfolioAnswer = "## 本周风险\n\n1. **官网改版**：有受阻和逾期任务，设计定稿 5 天后到期。";
const planAnswer = { milestones: [
  { milestoneId: "m1", tasks: [{ title: "完成首页视觉稿", priority: "High" }] },
  { name: "开发上线", dueDate: "2030-02-01", acceptanceCriteria: "线上可访问", tasks: [{ title: "搭建页面" }, { title: "接入统计" }, { title: "首页文案" }] },
] };
const noteTaskAnswer = { tasks: [
  { title: "把报价发给客户", dueDate: "2030-03-05", priority: "High", excerpt: "张三下周三前把报价发给客户" },
  { title: "更新首页文案", excerpt: "小李负责更新首页文案" },
] };
const reviewAnswer = "整体方向可行（推断）。\n\n1. **缺少回滚方案**：上线前必须准备 [S1]。";
const draft = { health: "At Risk", summary: "本周完成首页线框，设计定稿进入评审。", risks: "法务审核仍未回复，首页文案逾期。", nextAction: "周三前催办法务；补齐首页文案。" };

try {
  mock = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const payload = JSON.parse(raw);
    requests.push(payload);
    const system = payload.messages?.[0]?.content || "";
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const chunk = (content) => response.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
    const last = payload.messages?.at(-1)?.content || "";
    const content = system.includes("项目周报助手") ? "```json\n" + JSON.stringify(draft) + "\n```"
      : system.includes("今日简报") ? briefAnswer
      : system.includes("项目组合助理") ? portfolioAnswer
      : system.includes("项目规划助手") ? JSON.stringify(planAnswer)
      : system.includes("从用户的笔记中提取") ? JSON.stringify(noteTaskAnswer)
      : system.includes("审阅用户提供的项目资料") ? reviewAnswer
      : last.includes("[ACTIONS]") ? actionAnswer : chatAnswer;
    let offset = 0;
    const timer = setInterval(() => {
      chunk(content.slice(offset, offset + 24));
      offset += 24;
      if (offset >= content.length) { clearInterval(timer); response.end("data: [DONE]\n\n"); }
    }, 25);
    response.once("close", () => clearInterval(timer));
  });
  await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const mockPort = mock.address().port;
  const [serverPort, debugPort] = await Promise.all([freePort(), freePort()]);
  const vault = path.join(root, "documents", "NoteVault");
  const configDirectory = path.join(root, "app-data", "DanceMonkey");
  fs.mkdirSync(path.join(vault, "Journal"), { recursive: true });
  fs.mkdirSync(configDirectory, { recursive: true });
  const now = new Date();
  const day = (offset) => model.localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset));
  const project = model.createProject({ name: "官网改版", goal: "上线新版官网，提升转化", acceptanceCriteria: "首页转化率提升 10%", nextAction: "确认设计稿",
    dueDate: day(40), linkedNotes: ["20_Work/官网方案.md", "70_Finance/预算.md"], milestones: [{ id: "m1", name: "设计定稿", dueDate: day(5), acceptanceCriteria: "评审通过" }] }, "p1");
  const tasks = [
    model.createTask({ title: "等待法务审核", projectId: "p1", workflowStatus: "Blocked" }, "t1", [project]),
    model.createTask({ title: "首页文案", projectId: "p1", dueDate: day(-2) }, "t2", [project]),
    model.createTask({ title: "首页线框", projectId: "p1", workflowStatus: "Completed", milestoneId: "m1" }, "t3", [project]),
  ];
  fs.writeFileSync(path.join(vault, "Journal", "zentask-projects.json"), JSON.stringify({ SchemaVersion: 2, Items: [project] }));
  fs.writeFileSync(path.join(vault, "Journal", "task-module.json"), JSON.stringify({ SchemaVersion: 2, Items: tasks }));
  fs.writeFileSync(path.join(configDirectory, "config.json"), JSON.stringify({
    notesRootPath: vault, apiKey: "dm-local-e2e-dummy-key", apiEndpoint: `http://127.0.0.1:${mockPort}/v1/chat/completions`, model: "local-e2e",
  }));
  const bootstrap = path.join(root, "bootstrap.cjs");
  const packageInfo = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: packageInfo.name, version: packageInfo.version, main: "bootstrap.cjs" }));
  fs.writeFileSync(bootstrap, `
    const { app, session } = require('electron');
    const requireApp = require('node:module').createRequire(${JSON.stringify(path.join(cwd, "package.json"))});
    const undici = requireApp('undici');
    const originalFetch = undici.fetch;
    const local = url => ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(String(url)).hostname);
    undici.fetch = (url, options) => { if (!local(url)) throw new Error('E2E blocks external requests'); return originalFetch(url, options); };
    app.whenReady().then(async () => {
      await session.defaultSession.setProxy({ mode: 'direct' });
      session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/.test(details.url) && !local(details.url) }));
    });
    require(${JSON.stringify(path.join(cwd, "electron/main.js"))});
  `);
  const server = start("preview server", process.execPath, ["server.mjs"], { PORT: String(serverPort) });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${serverPort}/`)).ok, { process: server });
  const electron = start("Electron", path.join(cwd, "node_modules/.bin/electron"), [root], {
    DM_E2E_ROOT: root, DM_E2E_PORT: String(debugPort), DM_E2E_SERVER_PORT: String(serverPort),
    HTTP_PROXY: "", HTTPS_PROXY: "", http_proxy: "", https_proxy: "", ALL_PROXY: "", all_proxy: "",
  });
  const targets = async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).filter((item) => item.type === "page" && item.url.includes(`127.0.0.1:${serverPort}`));
  const target = await waitFor(async () => (await targets())[0], { process: electron });
  const overlay = await connect(target.webSocketDebuggerUrl);
  await waitFor(() => overlay.evaluate("Boolean(window.lumen)"), { process: electron });
  await overlay.evaluate('window.lumen.openWorkspace("projects")');
  const workspaceTarget = await waitFor(async () => (await targets()).find((item) => item.url.includes("#workspace")), { process: electron });
  const workspace = await connect(workspaceTarget.webSocketDebuggerUrl);
  const { evaluate, send } = workspace;
  await send("Page.bringToFront");
  const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await waitFor(() => evaluate('Boolean(document.querySelector("[data-module-action=pm-open][data-id=p1]"))'), { process: electron });
  await click("[data-module-action=pm-open][data-id=p1]");
  await waitFor(() => evaluate('Boolean(document.querySelector("#pm-tab-ai"))'), { process: electron });
  await click("#pm-tab-ai");
  await waitFor(() => evaluate('Boolean(document.querySelector(".pm-ai-prompt"))'), { process: electron });
  assert.match(await evaluate('document.querySelector(".pm-ai-context").textContent'), /任务 · 2.*笔记标题 · 2/s);
  await screenshot(workspace, "1-ai-empty");
  await click(".pm-ai-prompt[data-id='1']");
  await waitFor(() => evaluate('Boolean(document.querySelector(".pm-ai-message.streaming"))'), { process: electron });
  await waitFor(() => evaluate('Boolean(document.querySelector("[data-module-action=pm-ai-send]")) && document.querySelectorAll(".pm-ai-message.assistant").length === 1'), { process: electron });
  const system = requests[0].messages[0].content;
  assert.match(system, /<project>/);
  assert.match(system, /上线新版官网，提升转化/);
  assert.match(system, /\[受阻\] 等待法务审核/);
  assert.match(system, /\[待办·逾期\] 首页文案/);
  assert.match(system, /官网方案/);
  assert.doesNotMatch(system, /预算/, "protected note titles are not sent");
  assert.equal(requests[0].messages.at(-1).role, "user");
  assert.equal(await evaluate('Boolean(document.querySelector(".pm-ai-message.assistant ol strong"))'), true, "Markdown answer is rendered");
  assert.match(await evaluate('document.querySelector(".pm-ai-privacy").textContent'), /已排除 1 篇受保护目录笔记/);
  const chats = JSON.parse(fs.readFileSync(path.join(root, "user-data", "project-ai-chats.json"), "utf8")).chats;
  const saved = Object.values(chats)[0].messages;
  assert.deepEqual(saved.map((message) => message.role), ["user", "assistant"]);
  assert.equal(saved[1].content, chatAnswer);
  await screenshot(workspace, "2-ai-answer");
  await evaluate(`(()=>{const input=document.querySelector('.pm-ai-input'); input.value='第二个问题'; input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));})()`);
  await waitFor(() => evaluate('document.querySelectorAll(".pm-ai-message.assistant").length === 2 && Boolean(document.querySelector("[data-module-action=pm-ai-send]"))'), { process: electron });
  assert.deepEqual(requests[1].messages.slice(1).map((message) => message.role), ["user", "assistant", "user"], "follow-up carries the conversation");

  await click("[data-module-action=pm-ai-clear]");
  await waitFor(() => evaluate('Boolean(document.querySelector("[data-module-action=pm-weekly-draft]"))'), { process: electron });
  await click("[data-module-action=pm-weekly-draft]");
  await waitFor(() => evaluate('document.querySelector("[name=summary]")?.value === ' + JSON.stringify(draft.summary)), { process: electron });
  const weekly = requests.at(-1);
  assert.match(weekly.messages[0].content, /项目周报助手/);
  assert.match(weekly.messages[1].content, /受阻的任务（1）：\n- 等待法务审核/);
  assert.equal(weekly.temperature, 0.3);
  assert.equal(await evaluate('document.querySelector("[name=health]").value'), "At Risk");
  assert.equal(await evaluate('document.querySelector("[name=risks]").value'), draft.risks);
  assert.match(await evaluate('document.querySelector(".pm-draft-notice").textContent'), /受阻 1 项、逾期 1 项/);
  await screenshot(workspace, "3-weekly-draft");
  await evaluate(`(()=>{const field=document.querySelector('[name=nextAction]'); field.value='用户修改后的下一步'; field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await evaluate('document.querySelector("[data-pm-dialog-form]").requestSubmit()');
  await waitFor(() => JSON.parse(fs.readFileSync(path.join(vault, "Journal", "zentask-projects.json"), "utf8")).Items[0].Updates?.length === 1, { process: electron });
  const stored = JSON.parse(fs.readFileSync(path.join(vault, "Journal", "zentask-projects.json"), "utf8")).Items[0];
  assert.equal(stored.Updates[0].Summary, draft.summary);
  assert.equal(stored.Updates[0].NextAction, "用户修改后的下一步");
  assert.equal(stored.Status, "At Risk");

  await click("#pm-tab-ai");
  await waitFor(() => evaluate('Boolean(document.querySelector(".pm-ai-input"))'), { process: electron });
  await evaluate(`(()=>{const input=document.querySelector('.pm-ai-input'); input.value='[ACTIONS] 帮我调整任务'; input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await click("[data-module-action=pm-ai-send]");
  await waitFor(() => evaluate('document.querySelectorAll(".pm-ai-action").length === 2'), { process: electron });
  assert.doesNotMatch(await evaluate('document.querySelector(".pm-ai-message.assistant .pm-ai-body").textContent'), /dm-actions|create_task/, "the action block is not shown as text");
  assert.match(await evaluate('document.querySelector(".pm-ai-proposals").textContent'), /另有 1 项建议与当前项目数据不符/);
  await screenshot(workspace, "5-action-cards");
  const tasksFile = () => JSON.parse(fs.readFileSync(path.join(vault, "Journal", "task-module.json"), "utf8")).Items;
  await click("[data-module-action=pm-ai-apply][data-id='1:0']");
  await waitFor(() => tasksFile().some((task) => task.Title === "联系法务负责人"), { process: electron });
  const createdTask = tasksFile().find((task) => task.Title === "联系法务负责人");
  assert.equal(createdTask.ProjectId, "p1");
  assert.equal(createdTask.MilestoneId, "m1");
  assert.equal(createdTask.DueDate, "2030-01-15");
  assert.equal(createdTask.Tags, "AI 建议");
  await click("[data-module-action=pm-ai-apply][data-id='1:1']");
  await waitFor(() => tasksFile().find((task) => task.Id === "t1").WorkflowStatus === "In Progress", { process: electron });
  await waitFor(() => evaluate('document.querySelectorAll(".pm-ai-action.state-applied").length === 2'), { process: electron });
  await screenshot(workspace, "6-actions-applied");
  await click("[data-module-action=pm-ai-undo][data-id='1:1']");
  await waitFor(() => tasksFile().find((task) => task.Id === "t1").WorkflowStatus === "Blocked", { process: electron });
  await waitFor(() => evaluate('Boolean(document.querySelector(".pm-ai-action.state-undone"))'), { process: electron });
  const storedCards = Object.values(JSON.parse(fs.readFileSync(path.join(root, "user-data", "project-ai-chats.json"), "utf8")).chats)[0].messages[1].actions;
  assert.deepEqual(storedCards.map((action) => action.state), ["applied", "undone"]);
  assert.match(requests.at(-1).messages[0].content, /ID t1/, "task IDs are in the context so actions can reference them");
  await click("#pm-tab-tasks");
  await waitFor(() => evaluate('document.querySelector(".pm-task-list")?.textContent.includes("联系法务负责人")'), { process: electron });

  await click("[data-module-action=pm-back]");
  await waitFor(() => evaluate('Boolean(document.querySelector("[data-module-action=pm-ai-brief]"))'), { process: electron });
  await click("[data-module-action=pm-ai-brief]");
  await waitFor(() => evaluate('document.querySelector(".pm-brief-body")?.textContent.includes("整体：1 个项目有风险") && Boolean(document.querySelector("[data-module-action=pm-ai-brief]"))'), { process: electron });
  const briefRequest = requests.at(-1);
  assert.match(briefRequest.messages[0].content, /今日简报/);
  assert.match(briefRequest.messages[1].content, /\[任务受阻\] 官网改版：等待法务审核/);
  assert.match(await evaluate('document.querySelector(".pm-brief").textContent'), /今天 \d\d:\d\d 生成/);
  const briefs = JSON.parse(fs.readFileSync(path.join(root, "user-data", "project-ai-chats.json"), "utf8")).briefs;
  assert.equal(Object.values(briefs)[0].text, briefAnswer);
  await screenshot(workspace, "7-brief");
  await click("[data-module-action=pm-ai-brief-save]");
  await waitFor(() => evaluate('Boolean(document.querySelector(".pm-brief [data-module-action=pm-ai-open-note]"))'), { process: electron });
  const notesIn = (folder) => fs.existsSync(path.join(vault, folder)) ? fs.readdirSync(path.join(vault, folder)) : [];
  assert.ok(notesIn("AI 输出").some((name) => name.startsWith("今日简报")), "brief saved as a note");

  await click(".pm-portfolio .pm-ai-prompt[data-id='0']");
  await waitFor(() => evaluate('document.querySelector(".pm-portfolio .pm-ai-message.assistant")?.textContent.includes("设计定稿 5 天后到期") && Boolean(document.querySelector(".pm-portfolio [data-module-action=pm-ai-send]"))'), { process: electron });
  const portfolioRequest = requests.at(-1);
  assert.match(portfolioRequest.messages[0].content, /<portfolio>/);
  assert.match(portfolioRequest.messages[0].content, /## 官网改版/);
  assert.doesNotMatch(portfolioRequest.messages[0].content, /dm-actions/);
  await click(".pm-portfolio [data-module-action=pm-ai-save-note]");
  await waitFor(() => notesIn("AI 输出").some((name) => name.startsWith("项目组合：")), { process: electron });
  await waitFor(() => evaluate('Boolean(document.querySelector(".pm-portfolio [data-module-action=pm-ai-open-note]"))'), { process: electron });
  await evaluate('document.querySelector(".pm-portfolio").scrollIntoView({block:"end"})');
  await screenshot(workspace, "8-portfolio");

  await click("[data-module-action=pm-open][data-id=p1]");
  await waitFor(() => evaluate('Boolean(document.querySelector("#pm-tab-ai"))'), { process: electron });
  await click("#pm-tab-ai");
  await waitFor(() => evaluate('Boolean(document.querySelector(".pm-ai-proposals"))'), { process: electron });
  const projectsFile = () => JSON.parse(fs.readFileSync(path.join(vault, "Journal", "zentask-projects.json"), "utf8")).Items[0];
  await click(".pm-ai-message.assistant [data-module-action=pm-ai-save-note]");
  await waitFor(() => projectsFile().LinkedNotes.some((note) => note.startsWith("AI 输出/官网改版：")), { process: electron });
  const savedPath = projectsFile().LinkedNotes.find((note) => note.startsWith("AI 输出/官网改版："));
  assert.match(fs.readFileSync(path.join(vault, savedPath), "utf8"), /project: "官网改版"[\s\S]*先解除阻塞/);

  await click("#pm-tab-milestones");
  await waitFor(() => evaluate('Boolean(document.querySelector("[data-module-action=pm-plan-open]"))'), { process: electron });
  await click("[data-module-action=pm-plan-open]");
  await waitFor(() => evaluate('Boolean(document.querySelector("[data-plan-notes]"))'), { process: electron });
  await evaluate(`(()=>{const notes=document.querySelector('[data-plan-notes]'); notes.value='两个人，每周 10 小时'; notes.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await click("[data-module-action=pm-plan-generate]");
  await waitFor(() => evaluate('Boolean(document.querySelector("[data-plan-summary]"))'), { process: electron });
  const planRequest = requests.at(-1);
  assert.match(planRequest.messages[0].content, /项目规划助手/);
  assert.match(planRequest.messages[1].content, /两个人，每周 10 小时/);
  assert.equal(await evaluate('document.querySelector("[data-plan-summary]").textContent'), "将创建 1 个里程碑、3 项任务");
  assert.match(await evaluate('document.querySelector(".pm-plan-task.is-duplicate").textContent'), /已有同名任务/);
  await evaluate(`(()=>{const box=document.querySelector('[data-plan-task="1:1"][data-plan-field="selected"]'); box.checked=false; box.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await waitFor(() => evaluate('document.querySelector("[data-plan-summary]").textContent === "将创建 1 个里程碑、2 项任务"'), { process: electron });
  await evaluate(`(()=>{const title=document.querySelector('[data-plan-task="1:0"][data-plan-field="title"]'); title.value='搭建首页和列表页'; title.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await screenshot(workspace, "9-plan-preview");
  const overflowPlan = await evaluate('(()=>{const node=document.querySelector(".pm-plan-dialog");return node.scrollWidth - node.clientWidth})()');
  assert.ok(overflowPlan <= 2, `plan dialog overflows horizontally by ${overflowPlan}px`);
  await click("[data-module-action=pm-plan-create]");
  await waitFor(() => projectsFile().Milestones.length === 2, { process: electron });
  await waitFor(() => evaluate('!document.querySelector(".pm-plan-dialog")'), { process: electron });
  const planTasks = tasksFile().filter((task) => task.Tags === "AI 计划");
  assert.deepEqual(planTasks.map((task) => task.Title).sort(), ["完成首页视觉稿", "搭建首页和列表页"].sort());
  const launch = projectsFile().Milestones.find((stage) => stage.Name === "开发上线");
  assert.equal(launch.DueDate, "2030-02-01");
  assert.equal(planTasks.find((task) => task.Title === "搭建首页和列表页").MilestoneId, launch.Id);
  assert.equal(planTasks.find((task) => task.Title === "完成首页视觉稿").MilestoneId, "m1");
  assert.equal(await evaluate('document.querySelector("#pm-tab-milestones").getAttribute("aria-selected")'), "true");
  await screenshot(workspace, "10-plan-created");

  const openNoteTasks = (sourcePath) => evaluate(`(()=>{
    const esc=(value)=>String(value??"").replace(/[&<>"]/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"})[c]);
    const api={...window.lumen.zenTask, aiExtract:(payload)=>window.lumen.projectAi.extractNoteTasks(payload), aiCancel:(id)=>window.lumen.projectAi.cancel(id)};
    window.DMNoteTasks.open({ root: document.getElementById("root"), text: "## 周会\\n张三下周三前把报价发给客户\\n结论：方案 A 通过。\\n小李负责更新首页文案", sourcePath: ${JSON.stringify(sourcePath)}, selected: false, api, esc, attr: esc, onProjects: async () => {} });
  })()`);
  await openNoteTasks("70_Finance/周会.md");
  await waitFor(() => evaluate('Boolean(document.querySelector("[data-note-task-mode=ai]"))'), { process: electron });
  await click("[data-note-task-mode=ai]");
  await waitFor(() => evaluate('document.querySelector(".ws-note-task-error")?.textContent.includes("受保护目录")'), { process: electron });
  const requestsBefore = requests.length;
  await click("[data-note-task-cancel]");
  await openNoteTasks("20_Work/周会.md");
  await waitFor(() => evaluate('Boolean(document.querySelector("[data-note-task-mode=ai]"))'), { process: electron });
  await click("[data-note-task-mode=ai]");
  await waitFor(() => evaluate('document.querySelectorAll("[data-candidate]").length === 2'), { process: electron });
  assert.equal(requests.length, requestsBefore + 1, "the protected note was never sent");
  assert.match(requests.at(-1).messages[1].content, /<note>\n## 周会/);
  assert.equal(await evaluate(`document.querySelector('[data-due="0"]').value`), "2030-03-05");
  await screenshot(workspace, "11-note-tasks-ai");
  await evaluate('document.querySelector(".ws-note-task-dialog").requestSubmit()');
  await waitFor(() => evaluate('document.body.textContent.includes("已创建 2 项任务")'), { process: electron });
  await evaluate('document.querySelector(".ws-note-task-backdrop").remove()');
  const extracted = tasksFile().find((task) => task.Title === "把报价发给客户");
  assert.equal(extracted.Tags, "AI 提取");
  assert.equal(extracted.DueDate, "2030-03-05");
  assert.equal(extracted.SourceNotePath, "20_Work/周会.md");
  assert.equal(extracted.SourceExcerpt, "张三下周三前把报价发给客户");

  await evaluate(`(async()=>{
    const created = await window.lumen.personas.create({ name: "严格评审", description: "关注上线风险" });
    const withSource = await window.lumen.personas.addSources({ id: created.id, sources: [{ title: "评审笔记", kind: "note", text: "上线前必须准备回滚方案，否则不批准。" }] });
    await window.lumen.personas.saveCard({ id: withSource.id, baseVersion: withSource.cardVersion, sourceRevision: withSource.sourceRevision,
      card: { summary: "谨慎的评审者", knowledge: "上线流程", thinking: "先看风险", style: "直接", boundaries: "资料有限" } });
  })()`);
  await click("#pm-tab-ai");
  await waitFor(() => evaluate('Boolean(document.querySelector("[data-module-action=pm-ai-review-open]"))'), { process: electron });
  await click("[data-module-action=pm-ai-review-open]");
  await waitFor(() => evaluate('Boolean(document.querySelector("[data-module-action=pm-ai-review-start]"))'), { process: electron });
  assert.match(await evaluate('document.querySelector("[data-pm-review=persona]").textContent'), /严格评审/);
  await evaluate(`(()=>{const focus=document.querySelector('[data-pm-review="focus"]'); focus.value='1'; focus.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await screenshot(workspace, "12-review-picker");
  await click("[data-module-action=pm-ai-review-start]");
  await waitFor(() => evaluate('document.querySelector(".pm-ai-messages")?.textContent.includes("严格评审 · 人物分身审阅（AI 模拟）") && Boolean(document.querySelector("[data-module-action=pm-ai-send]"))'), { process: electron });
  const reviewRequest = JSON.parse(requests.at(-1).messages[1].content);
  assert.equal(reviewRequest.task, "review");
  assert.equal(reviewRequest.reviewFocus, "进度风险、阻塞和应对办法");
  assert.match(reviewRequest.projectMaterial, /# 项目：官网改版/);
  assert.match(JSON.stringify(reviewRequest.retrievedEvidence), /回滚方案/);
  assert.match(await evaluate('[...document.querySelectorAll(".pm-ai-citations")].at(-1).textContent'), /引用的人物资料 · 1/);
  const personaDirectory = path.join(root, "user-data", "personas");
  const personaData = JSON.parse(fs.readFileSync(path.join(personaDirectory, fs.readdirSync(personaDirectory).find((name) => name.endsWith(".json"))), "utf8"));
  assert.equal(personaData.conversations.reduce((count, item) => count + item.messages.length, 0), 0, "the review is not written into persona chats");
  await evaluate('document.querySelector(".pm-ai-messages").scrollTop = 1e6');
  await screenshot(workspace, "13-review");
  await send("Emulation.setDeviceMetricsOverride", { width: 640, height: 720, deviceScaleFactor: 1, mobile: false });
  for (const theme of ["dark", "light"]) {
    await evaluate(`(()=>{localStorage.setItem('lumen-workspace-theme',${JSON.stringify(theme)});window.dispatchEvent(new StorageEvent('storage',{key:'lumen-workspace-theme',storageArea:localStorage}));})()`);
    await sleep(150);
    const overflow = await evaluate(`(()=>{const selectors=['html','body','.pm-ai','.pm-ai-composer','.pm-ai-context','.pm-ai-proposals']; return selectors.map(selector=>{const node=document.querySelector(selector);return {selector,width:node?.clientWidth,scroll:node?.scrollWidth};}).filter(item=>item.scroll>item.width+2)})()`);
    assert.deepEqual(overflow, [], `${theme} narrow layout overflows: ${JSON.stringify(overflow)}`);
    await screenshot(workspace, `4-narrow-${theme}`);
  }
  console.log(`Project AI E2E passed: project-scoped context, protected note filtering, streaming Markdown, per-project history, follow-up turns, weekly draft review and save, action cards apply/undo, daily brief, portfolio chat, notes saved and linked, plan breakdown, AI note tasks with protected-folder refusal, persona review, narrow layouts (${requests.length} local API requests).`);
  for (const file of screenshots) console.log(`Screenshot: ${file}`);
} finally {
  for (const socket of sockets) { try { socket.close(); } catch {} }
  for (const record of children.reverse()) await stop(record);
  mock?.closeAllConnections();
  if (mock?.listening) await new Promise((resolve) => mock.close(resolve));
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
