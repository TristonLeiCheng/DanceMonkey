// Real Electron UI + preload + IPC + local disk + a deterministic local model.
// Never reads a real vault, API key or upstream model service.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "dm-outlook-e2e-"));
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

let testControl = { mailVersion: 1, modelFail: false, graphDelay: 0 };
const setControl = (patch) => { testControl = { ...testControl, ...patch }; fs.writeFileSync(path.join(root, "outlook-control.json"), JSON.stringify(testControl)); };
setControl({});
const model = http.createServer(async (req, res) => {
  const bytes = []; for await (const chunk of req) bytes.push(chunk);
  const body = JSON.parse(Buffer.concat(bytes).toString()); requests.push(body);
  const system = body.messages[0].content;
  const evidence = body.messages.slice(1).map((item) => item.content).join("\n");
  const name = evidence.includes("陈老师") ? "陈老师" : "林老师";
  let text;
  if (system.includes("只返回一个 JSON 对象")) {
    text = JSON.stringify({ summary: `${name}的资料分身`, knowledge: "先收集证据再做判断。",
      thinking: "从具体案例中归纳原则。", style: evidence.includes("更简短") ? "用户纠正：回答更简短。" : "先举例，再总结。", boundaries: "资料有限，未知经历不推测。" });
  } else if (system.includes("你是界面中选定的人物助手")) {
    text = `${name}：先列证据，再做判断。[S1]`;
  } else text = `${name}：证据支持先收集事实，表达倾向于具体例子，未知经历不推测。`;
  if (testControl.modelFail || evidence.includes("触发失败请求")) { res.writeHead(503, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "模拟服务暂不可用" } })); return; }
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
  const configDir = path.join(root, "app-data", "DanceMonkey"); fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ notesRootPath: noteRoot, apiKey: "e2e-local-only",
    apiEndpoint: `http://127.0.0.1:${modelPort}/v1/chat/completions`, model: "fixture-model" }));
  start(process.execPath, ["server.mjs"], { PORT: String(serverPort) });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${serverPort}/`)).ok);
  const env = { DM_E2E_ROOT: root, DM_E2E_PORT: String(debugPort), DM_E2E_SERVER_PORT: String(serverPort) };
  const launch = () => start(path.join(cwd, "node_modules/.bin/electron"), ["test/fixtures/outlook-electron.cjs"], env);
  electron = launch(); await openPersonas(debugPort, serverPort);
  await click("new-person"); await fill("new:name", "林老师"); await click("create"); await idle();
  assert.match(await evaluate("document.querySelector('.persona-outlook').textContent"), /Mail.Read/);
  await fill("outlook-config:clientId", "12345678-1234-1234-1234-123456789abc");
  await fill("outlook-config:tenantId", "abcdefab-1234-1234-1234-123456789abc");
  await click("outlook-configure"); await idle();
  assert.match(await evaluate("document.querySelector('.persona-outlook').textContent"), /已连接：reader@example.com/);
  await fill("outlookEmail", "person@example.com"); await fill("outlookRange", "all");
  await click("outlook-import"); await idle();
  assert.equal(await evaluate("Boolean(document.querySelector('[data-persona-field=\"card:summary\"]'))"), true);
  const id = (await evaluate("window.lumen.personas.list()"))[0].id;
  const getPerson = () => evaluate(`window.lumen.personas.get(${JSON.stringify(id)})`);
  let person = await getPerson();
  assert.equal(person.sources.length, 2); assert.equal(person.outlook.lastStats.duplicates, 1);
  assert.equal(person.card, null); assert.equal(person.outlook.since, null);
  assert.doesNotMatch(JSON.stringify(person.sources), /他人的观点/);
  await click("save-card"); await idle();
  await click("tab", "chat"); await fill("question", "判断项目时应考虑什么？"); await click("send"); await idle();
  assert.match(await evaluate("document.querySelector('.persona-messages').textContent"), /先列证据/);
  assert.equal((await getPerson()).conversations[0].messages.length, 2);

  await click("tab", "sources"); setControl({ mailVersion: 2 });
  await click("outlook-import"); await idle();
  person = await getPerson();
  assert.equal(person.sources.length, 3); assert.equal(person.outlook.lastStats.added, 1);
  assert.equal(person.cardVersion, 1);
  await click("save-card"); await idle();
  await click("tab", "sources"); const requestCount = requests.length;
  await click("outlook-import"); await idle();
  assert.equal(requests.length, requestCount, "unchanged updates should not call the model");
  assert.match(await evaluate("document.querySelector('.persona-page').textContent"), /邮件资料没有变化/);

  setControl({ mailVersion: 3, modelFail: true });
  await click("outlook-import"); await idle();
  person = await getPerson(); assert.equal(person.sources.length, 4); assert.equal(person.cardVersion, 2);
  assert.match(await evaluate("document.querySelector('.persona-page').textContent"), /邮件资料已保存在本机/);
  setControl({ modelFail: false }); await click("dismiss-error");
  await click("outlook-import"); await idle(); await click("save-card"); await idle();
  assert.equal((await getPerson()).cardVersion, 3);
  await click("tab", "sources");
  setControl({ graphDelay: 5000 });
  await click("outlook-import");
  await waitFor(() => evaluate("Boolean(document.querySelector('[data-persona-action=\"cancel\"]'))"));
  await click("cancel"); await idle();
  assert.equal((await getPerson()).cardVersion, 3); assert.equal((await getPerson()).sources.length, 4);
  setControl({ graphDelay: 0 }); await click("dismiss-error");

  socket.close(); await stop(electron); electron = launch(); await openPersonas(debugPort, serverPort);
  person = await getPerson(); assert.equal(person.cardVersion, 3); assert.equal(person.sources.length, 4);
  assert.equal(person.outlook.email, "person@example.com");
  assert.equal((await evaluate("window.lumen.outlook.status()")).connected, true);
  assert.match(await evaluate("document.querySelector('.persona-outlook').textContent"), /reader@example.com/);
  const shot = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(process.env.DM_E2E_OUTLOOK_SCREENSHOT || "/tmp/dm-outlook-e2e.png", Buffer.from(shot.result.data, "base64"));
  assert.deepEqual(runtimeErrors, []);
  console.log("Outlook E2E passed: configuration + login, email fetch/clean/dedupe, preview/save/chat, update, unchanged no-model, failure recovery, cancel, app restart and encrypted auth restore.");
} catch (error) {
  console.error(error);
  for (const item of children) console.error(item.output);
  process.exitCode = 1;
} finally {
  socket?.close(); await Promise.all(children.map(stop));
  await new Promise((resolve) => model.close(resolve));
}
