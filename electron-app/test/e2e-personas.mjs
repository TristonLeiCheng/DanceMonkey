// Real Electron UI + preload + IPC + local disk + a deterministic local model.
// Never reads a real vault, API key or upstream model service.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import demoTools from "../src/persona-demos.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "dm-personas-e2e-"));
const cwd = path.resolve(import.meta.dirname, "..");
const children = [], requests = [], runtimeErrors = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer(); server.once("error", reject);
  server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => resolve(port)); });
});
function start(command, args, env = {}) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const record = { child, output: "", exited: false };
  child.stdout.on("data", (chunk) => { record.output = (record.output + chunk).slice(-6000); });
  child.stderr.on("data", (chunk) => { record.output = (record.output + chunk).slice(-6000); });
  child.once("exit", () => { record.exited = true; }); children.push(record); return record;
}
async function stop(record) {
  if (!record || record.exited) return;
  record.child.kill("SIGTERM");
  await Promise.race([new Promise((resolve) => record.child.once("exit", resolve)), sleep(2000)]);
  if (!record.exited) record.child.kill("SIGKILL");
}
async function waitFor(fn, timeout = 20000) {
  const until = Date.now() + timeout; let last;
  while (Date.now() < until) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await sleep(100);
  }
  throw new Error(`Timed out: ${last?.message || "condition not met"}`);
}

const model = http.createServer(async (req, res) => {
  const bytes = []; for await (const chunk of req) bytes.push(chunk);
  const body = JSON.parse(Buffer.concat(bytes).toString()); requests.push(body);
  const system = body.messages[0].content;
  const evidence = body.messages.slice(1).map((item) => item.content).join("\n");
  const demo = demoTools.demos.find(item => evidence.includes(item.name));
  const name = demo ? demo.name + " · AI 模拟" : evidence.includes("陈老师") ? "陈老师" : "林老师";
  let text;
  if (system.includes("只返回一个 JSON 对象")) {
    text = JSON.stringify({ summary: `${name}的资料分身`, knowledge: "先收集证据再做判断。",
      thinking: "从具体案例中归纳原则。", style: evidence.includes("更简短") ? "用户纠正：回答更简短。" : "先举例，再总结。", boundaries: "资料有限，未知经历不推测。" });
  } else if (system.includes("你是界面中选定的人物助手")) {
    text = `${name}：先列证据，再做判断。[S1]`;
  } else text = `${name}：证据支持先收集事实，表达倾向于具体例子，未知经历不推测。`;
  if (evidence.includes("触发失败请求")) { res.writeHead(503, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "模拟服务暂不可用" } })); return; }
  res.writeHead(200, { "content-type": "text/event-stream" });
  const emit = (content) => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
  emit(text.slice(0, 8));
  const timer = setTimeout(() => { if (!res.destroyed) { emit(text.slice(8)); res.end("data: [DONE]\n\n"); } }, evidence.includes("取消请求") ? 5000 : 80);
  res.on("close", () => clearTimeout(timer));
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
const modelPort = model.address().port;
let socket, electron, serial = 0;
const pending = new Map();
async function connect(url) {
  socket?.close(); socket = new WebSocket(url);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = ({ data }) => {
    const item = JSON.parse(data);
    if (item.method === "Runtime.exceptionThrown") runtimeErrors.push(item.params.exceptionDetails.text);
    if (pending.has(item.id)) { pending.get(item.id)(item); pending.delete(item.id); }
  };
  await send("Runtime.enable");
}
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
    pending.set(id, (result) => { clearTimeout(timer); result.error ? reject(new Error(result.error.message)) : resolve(result); });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.result.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails));
  return result.result.result?.value;
}
const click = (action, id) => evaluate(`document.querySelector(${JSON.stringify(`[data-persona-action="${action}"]${id ? `[data-id="${id}"]` : ""}`)}).click()`);
const fill = (field, value) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(`[data-persona-field="${field}"]`)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`);
const idle = () => waitFor(() => evaluate(`!document.querySelector('.persona-progress')`));
async function openPersonas(debugPort, serverPort) {
  const pages = () => fetch(`http://127.0.0.1:${debugPort}/json`).then((r) => r.json());
  const overlay = await waitFor(async () => (await pages()).find((item) => item.type === "page" && item.url.includes(`127.0.0.1:${serverPort}`)));
  await connect(overlay.webSocketDebuggerUrl);
  await evaluate('window.lumen.openWorkspace("personas")');
  const workspace = await waitFor(async () => (await pages()).find((item) => item.type === "page" && item.url.includes("#workspace/personas")));
  await connect(workspace.webSocketDebuggerUrl);
  await waitFor(() => evaluate(`Boolean(document.querySelector('[data-persona-action="new-person"]'))`));
}

try {
  const [serverPort, debugPort] = await Promise.all([freePort(), freePort()]);
  const noteRoot = path.join(root, "documents", "NoteVault"); fs.mkdirSync(noteRoot, { recursive: true });
  fs.writeFileSync(path.join(noteRoot, "判断原则.md"), "# 林老师的判断原则\n先列出证据，再讨论结论。");
  const configDir = path.join(root, "app-data", "DanceMonkey"); fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ notesRootPath: noteRoot, apiKey: "e2e-local-only",
    apiEndpoint: `http://127.0.0.1:${modelPort}/v1/chat/completions`, model: "fixture-model" }));
  start(process.execPath, ["server.mjs"], { PORT: String(serverPort) });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${serverPort}/`)).ok);
  const env = { DM_E2E_ROOT: root, DM_E2E_PORT: String(debugPort), DM_E2E_SERVER_PORT: String(serverPort) };
  electron = start(path.join(cwd, "node_modules/.bin/electron"), ["."], env);
  await openPersonas(debugPort, serverPort);
  assert.equal(await evaluate(`document.querySelectorAll('.persona-demo-card').length`), 6);
  assert.equal((await evaluate("window.lumen.personas.list()")).length, 0, "gallery must not seed profiles");
  const screenshot = async name => {
    if (!process.env.DM_E2E_DEMO_SCREENSHOT_DIR) return;
    fs.mkdirSync(process.env.DM_E2E_DEMO_SCREENSHOT_DIR, { recursive: true });
    const shot = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(process.env.DM_E2E_DEMO_SCREENSHOT_DIR, name + ".png"), Buffer.from(shot.result.data, "base64"));
  };
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await screenshot("01-gallery");
  await send("Emulation.setDeviceMetricsOverride", { width: 520, height: 1000, deviceScaleFactor: 1, mobile: false });
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.persona-demo-grid')).gridTemplateColumns.split(' ').length`), 1);
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= window.innerWidth`), true, "narrow viewport must not overflow");
  await screenshot("02-narrow-gallery");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  const demoIds = new Map();
  for (const demo of demoTools.demos) {
    await evaluate(`document.querySelector('.persona-demos').open=true`);
    await click("preview-demo", demo.id);
    assert.match(await evaluate(`document.activeElement.getAttribute('aria-label')`), new RegExp(demo.name));
    await click("close-demo");
    assert.equal((await evaluate("window.lumen.personas.list()")).length, demoIds.size);
    await click("preview-demo", demo.id);
    if (demo.id === "confucius") await screenshot("03-preview");
    await evaluate(`(()=>{const button=document.querySelector('[data-persona-action="use-demo"]');button.click();button.click();})()`);
    await idle();
    const people = await evaluate("window.lumen.personas.list()");
    assert.equal(people.filter(p => p.demoId === demo.id).length, 1);
    const id = people.find(p => p.demoId === demo.id).id; demoIds.set(demo.id, id);
    let person = await evaluate(`window.lumen.personas.get(${JSON.stringify(id)})`);
    assert.deepEqual(person.card, demo.card); assert.equal(person.cardVersion, 1);
    assert.equal(person.conversations[0].messages.length, 0);
    for (let i = 0; i < demo.starters.length; i++) {
      await click("starter", String(i));
      assert.equal(await evaluate(`document.querySelector('[data-persona-field="question"]').value`), demo.starters[i]);
    }
    assert.equal(requests.length, demoIds.size - 1, "preview, create and starters must not invoke model");
    await fill("question", demo.starters[0] + " 请给一个小练习。");
    await click("send"); await idle();
    person = await evaluate(`window.lumen.personas.get(${JSON.stringify(id)})`);
    assert.equal(person.conversations[0].messages.length, 2);
    assert.match(await evaluate(`document.querySelector('.persona-demo-disclosure').textContent`), /并非本人、官方账号或背书/);
    const sent = requests.at(-1);
    assert.match(sent.messages[0].content, /不得编造或冒充真实引语/);
    const context = JSON.parse(sent.messages.at(-1).content);
    assert.equal(context.person.name, demo.name);
    assert.ok(context.retrievedEvidence.every(item => item.title.includes(demo.name)));
    if (demo.id === "musk") await screenshot("04-demo-chat");
    const before = JSON.stringify(person);
    await evaluate(`document.querySelector('.persona-demos').open=true`);
    await click("preview-demo", demo.id); await click("use-demo", demo.id); await idle();
    assert.equal(JSON.stringify(await evaluate(`window.lumen.personas.get(${JSON.stringify(id)})`)), before);
  }
  assert.equal(requests.length, 6);
  // Customization must survive catalogue re-entry and the full app restart below.
  await evaluate(`window.lumen.personas.updateProfile({id:${JSON.stringify(demoIds.get("musk"))},name:"我的工程助手",description:"保留自定义资料"})`);
  await click("new-person"); await fill("new:name", "林老师"); await fill("new:description", "测试人物，仅使用虚构资料"); await click("create"); await idle();
  await click("tab", "profile");
  await fill("profile:birthDate", "1990-05"); await fill("profile:zodiac", "金牛座");
  await fill("profile:resume", "2015 年起从事教学，关注证据与判断。");
  await fill("profile:events", "2020-09：组织案例讨论，鼓励学生先核对事实。");
  for (let i = 0; i < 12; i++) await fill(`answer:${i}`, "-1");
  await click("assess-mbti"); await click("save-details"); await idle();
  assert.equal(await evaluate(`document.querySelector('[data-persona-field="profile:mbti"]').value`), "INFP");
  if (process.env.DM_E2E_PROFILE_SCREENSHOT) {
    const shot = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(process.env.DM_E2E_PROFILE_SCREENSHOT, Buffer.from(shot.result.data, "base64"));
  }
  await click("tab", "sources");
  await fill("title", "关于判断的文章"); await fill("text", "林老师的观点：先列证据，再做判断。喜欢先举具体例子。"); await click("add-source"); await idle();
  await click("pick-notes"); await idle();
  await evaluate(`document.querySelector('[data-persona-note="判断原则.md"]').click()`);
  await click("import-notes"); await idle();
  await fill("kind", "chat"); await fill("speaker", "林老师"); await fill("title", "讨论记录");
  await fill("text", "学生：我喜欢直接凭直觉下结论。\n林老师：先研究证据，再判断。"); await click("add-source"); await idle();
  let people = await evaluate("window.lumen.personas.list()"); const firstId = people[0].id;
  assert.equal((await evaluate(`window.lumen.personas.get(${JSON.stringify(firstId)})`)).sources.length, 3);
  await click("generate"); await idle();
  assert.ok(await evaluate(`Boolean(document.querySelector('[data-persona-field="card:summary"]'))`));
  assert.equal((await evaluate(`window.lumen.personas.get(${JSON.stringify(firstId)})`)).card, null, "preview must not write the active card");
  await fill("card:summary", "林老师 · 经我检查的人物卡"); await click("save-card"); await idle();
  await click("tab", "chat"); await fill("question", "你会如何作判断？"); await click("send"); await idle();
  assert.match(await evaluate("document.querySelector('.persona-messages').textContent"), /先列证据/);
  let first = await evaluate(`window.lumen.personas.get(${JSON.stringify(firstId)})`);
  const firstConversation = first.activeConversationId;
  assert.equal(first.conversations.find((c) => c.id === firstConversation).messages.length, 2);
  await fill("question", "取消请求"); await click("send");
  await waitFor(() => evaluate(`Boolean(document.querySelector('[data-persona-action="cancel"]'))`));
  await click("cancel"); await idle();
  first = await evaluate(`window.lumen.personas.get(${JSON.stringify(firstId)})`);
  assert.equal(first.conversations.find((c) => c.id === firstConversation).messages.length, 2, "cancel must not save partial turns");
  await click("tab", "card"); await fill("correction", "回答应该更简短"); await click("correct"); await idle();
  await click("save-card"); await idle();
  first = await evaluate(`window.lumen.personas.get(${JSON.stringify(firstId)})`);
  assert.equal(first.cardVersion, 2); assert.match(first.card.style, /更简短/);
  await click("tab", "versions"); await click("restore", "1"); await idle();
  first = await evaluate(`window.lumen.personas.get(${JSON.stringify(firstId)})`);
  assert.equal(first.cardVersion, 3); assert.equal(first.card.summary, "林老师 · 经我检查的人物卡");
  await click("tab", "chat"); await click("new-conversation"); await idle();
  assert.doesNotMatch(await evaluate("document.querySelector('.persona-messages').textContent"), /你会如何/);
  await fill("conversation", firstConversation); await idle();
  assert.match(await evaluate("document.querySelector('.persona-messages').textContent"), /你会如何/);

  await click("new-person"); await fill("new:name", "陈老师"); await click("create"); await idle();
  await fill("title", "陈老师笔记"); await fill("text", "陈老师：写作要先讲故事。用故事解释问题。"); await click("add-source"); await idle();
  await click("generate"); await idle(); await click("save-card"); await idle();
  await click("tab", "chat"); await fill("question", "写作时会如何开始？"); await click("send"); await idle();
  const lastChat = requests.filter((r) => r.messages[0].content.includes("你是界面中选定的人物助手")).at(-1);
  assert.doesNotMatch(JSON.stringify(lastChat), /林老师|学生：/);
  assert.match(JSON.stringify(lastChat), /陈老师/);
  assert.equal((await evaluate("window.lumen.getState()")).aiMessages.length, 0);
  await fill("question", "触发失败请求"); await click("send"); await idle();
  assert.match(await evaluate("document.querySelector('.persona-page').textContent"), /模拟服务暂不可用/);
  if (process.env.DM_E2E_PERSONA_SCREENSHOT) {
    await click("dismiss-error");
    const shot = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(process.env.DM_E2E_PERSONA_SCREENSHOT, Buffer.from(shot.result.data, "base64"));
  }
  socket.close(); await stop(electron);
  electron = start(path.join(cwd, "node_modules/.bin/electron"), ["."], env);
  await openPersonas(debugPort, serverPort);
  assert.equal((await evaluate("window.lumen.personas.list()")).length, 8);
  for (const [demoId, id] of demoIds) {
    await evaluate(`document.querySelector('.persona-demos').open=true`);
    await click("preview-demo", demoId); await click("use-demo", demoId); await idle();
    const restored = await evaluate(`window.lumen.personas.get(${JSON.stringify(id)})`);
    assert.equal(restored.demoId, demoId); assert.equal(restored.conversations[0].messages.length, 2);
    assert.equal(restored.cardVersion, 1);
    if (demoId === "musk") { assert.equal(restored.name, "我的工程助手"); assert.equal(restored.description, "保留自定义资料"); }
  }
  assert.equal((await evaluate("window.lumen.personas.list()")).length, 8);
  await click("select", firstId); await idle();
  await click("tab", "chat");
  assert.match(await evaluate("document.querySelector('.persona-messages').textContent"), /你会如何/);
  assert.equal((await evaluate(`window.lumen.personas.get(${JSON.stringify(firstId)})`)).cardVersion, 3);
  const restoredProfile = (await evaluate(`window.lumen.personas.get(${JSON.stringify(firstId)})`)).profile;
  assert.equal(restoredProfile.birthDate, "1990-05"); assert.equal(restoredProfile.zodiac, "金牛座");
  assert.equal(restoredProfile.mbti, "INFP"); assert.match(restoredProfile.events, /2020-09/);
  assert.ok(requests.some(r => JSON.stringify(r).includes("sourceBatch") && JSON.stringify(r).includes("2015 年起从事教学")));
  assert.equal(fs.readdirSync(noteRoot).some((name) => name.includes("persona")), false);
  assert.deepEqual(runtimeErrors, []);
  console.log("Persona E2E passed: six demo cards + preview/cancel/repeated creation + all 12 starters + isolated chat + customized restart/deduplication + responsive gallery, manual profile + MBTI, article + note + chat import, preview/save, streaming, cancel, correction, rollback, conversation/person isolation, API failure and full app restart.");
} catch (error) {
  console.error(error);
  for (const item of children) console.error(item.output);
  process.exitCode = 1;
} finally {
  socket?.close();
  await Promise.all(children.map(stop));
  model.closeAllConnections(); await new Promise((resolve) => model.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}
