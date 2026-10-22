import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const cwd = path.resolve(import.meta.dirname, "..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dm-ai-e2e-"));
const children = [];
const sockets = [];
const requests = [];
const screenshots = [];
const screenshotDirectory = process.env.DM_AI_SCREENSHOT_DIR && path.resolve(process.env.DM_AI_SCREENSHOT_DIR);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const answer = [
  "## 一起把想法变成行动", "", "这是 **本机模拟模型** 的 Markdown 回复，用于验证真实 IPC 与流式渲染。", "",
  "- 明确目标与完成标准", "- 拆成今天可以完成的行动", "- 留出检查和复盘的时间", "",
  "| 阶段 | 交付 | 状态 |", "| --- | --- | --- |", "| 准备 | 收集资料 | 完成 |", "| 执行 | 完成首版 | 进行中 |", "",
  "```javascript", 'const message = "本地测试：不连接外部模型";', "console.log(message);", "```", "",
  "可以先从最小的一步开始。长内容与代码应在各自容器内换行或滚动，不撑宽整个窗口。",
].join("\n");
let retryCount = 0;
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

try {
  mock = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const payload = JSON.parse(raw);
    const prompt = payload.messages?.at(-1)?.content || "";
    requests.push({ payload, authorization: request.headers.authorization });
    if (prompt.includes("[RETRY_TEST]") && retryCount++ === 0) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "模拟服务暂不可用，请重试" } }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const chunk = (content) => response.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
    if (prompt.includes("[STOP_TEST]")) {
      chunk("已生成的片段：这部分在停止后仍应保留。\n\n");
      const timer = setInterval(() => chunk("继续生成中的内容。\n"), 250);
      response.once("close", () => clearInterval(timer));
      return;
    }
    const content = prompt.includes("[RETRY_TEST]") ? "重试成功，用户问题没有重复。" : answer;
    let offset = 0;
    const timer = setInterval(() => {
      chunk(content.slice(offset, offset + 36));
      offset += 36;
      if (offset >= content.length) { clearInterval(timer); response.end("data: [DONE]\n\n"); }
    }, 25);
    response.once("close", () => clearInterval(timer));
  });
  await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const mockPort = mock.address().port;
  const [serverPort, debugPort] = await Promise.all([freePort(), freePort()]);
  assert.notEqual(serverPort, debugPort);
  const vault = path.join(root, "documents", "NoteVault");
  const configDirectory = path.join(root, "app-data", "DanceMonkey");
  fs.mkdirSync(vault, { recursive: true });
  fs.mkdirSync(configDirectory, { recursive: true });
  fs.writeFileSync(path.join(configDirectory, "config.json"), JSON.stringify({
    notesRootPath: vault, apiKey: "dm-local-e2e-dummy-key", apiEndpoint: `http://127.0.0.1:${mockPort}/v1/chat/completions`,
    model: "local-e2e", modelProfiles: [{ name: "本地测试模型", model: "local-e2e" }], globalChatSystemPrompt: "本地测试",
  }));
  // Test-only bootstrap: run the actual application and networking code, while denying external traffic.
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
  await overlay.evaluate('window.lumen.openWorkspace("ai")');
  const workspaceTarget = await waitFor(async () => (await targets()).find((item) => item.url.includes("#workspace")), { process: electron });
  const workspace = await connect(workspaceTarget.webSocketDebuggerUrl);
  const { evaluate, send } = workspace;
  await waitFor(() => evaluate('Boolean(document.querySelector(".ws-ai-input"))'), { process: electron });
  await send("Page.bringToFront");
  await send("Browser.grantPermissions", { origin: `http://127.0.0.1:${serverPort}`, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
  await screenshot(workspace, "empty");
  assert.equal(await evaluate('document.querySelector("[data-module-action=ai-send]").disabled'), true);
  await evaluate('document.querySelector("[data-module-action=ai-prompt]").click()');
  assert.ok(await evaluate('document.querySelector(".ws-ai-input").value.trim()'));
  assert.equal(requests.length, 0, "empty-state suggestions must only fill the composer");
  await evaluate('document.querySelector(".ws-ai-input").dispatchEvent(new KeyboardEvent("keydown", {key:"Enter",isComposing:true,bubbles:true,cancelable:true}))');
  await sleep(150);
  assert.equal(requests.length, 0, "IME confirmation must not send");
  const input = async (text) => evaluate(`(()=>{const input=document.querySelector('.ws-ai-input'); input.value=${JSON.stringify(text)}; input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const click = async (action) => evaluate(`document.querySelector('[data-module-action="${action}"]').click()`);
  const persisted = () => JSON.parse(fs.readFileSync(path.join(root, "user-data", "lumen-store.json"), "utf8")).aiMessages;
  const idle = () => waitFor(() => evaluate('Boolean(document.querySelector("[data-module-action=ai-send]"))'), { process: electron });
  await input("请展示 Markdown [FORMAT_TEST]");
  await click("ai-send");
  await waitFor(() => evaluate('Boolean(document.querySelector(".ws-ai-message.streaming"))'), { process: electron });
  await idle();
  await waitFor(() => persisted().at(-1)?.content === answer, { process: electron });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].authorization, "Bearer dm-local-e2e-dummy-key");
  assert.equal(requests[0].payload.stream, true);
  assert.equal(requests[0].payload.model, "local-e2e");
  assert.equal(await evaluate('Boolean(document.querySelector(".ws-ai-message.assistant pre code") && document.querySelector(".ws-ai-message.assistant ul") && document.querySelector(".ws-ai-message.assistant table"))'), true);
  await click("ai-copy");
  await waitFor(() => evaluate('document.querySelector("[data-module-action=ai-copy]")?.textContent.includes("已复制")'), { process: electron });
  assert.equal(await evaluate("navigator.clipboard.readText()"), answer, "copy must contain the original Markdown");
  await screenshot(workspace, "chat");
  await send("Emulation.setDeviceMetricsOverride", { width: 820, height: 640, deviceScaleFactor: 1, mobile: false });
  for (const theme of ["dark", "light"]) {
    await evaluate(`(()=>{const select=document.querySelector('.ws-theme-select'); select.value=${JSON.stringify(theme)}; select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await sleep(100);
    const overflow = await evaluate(`(()=>{const selectors=['html','body','.workspace-root','.ws-ai-page','.ws-ai-composer','.ws-ai-messages']; return selectors.map(selector=>{const node=document.querySelector(selector);return {selector,width:node?.clientWidth,scroll:node?.scrollWidth};}).filter(item=>item.scroll>item.width+2)})()`);
    assert.deepEqual(overflow, [], `${theme} narrow layout has horizontal overflow: ${JSON.stringify(overflow)}`);
    if (theme === "light") await screenshot(workspace, "light");
  }
  await send("Emulation.clearDeviceMetricsOverride");
  await input("请持续生成 [STOP_TEST]");
  await click("ai-send");
  await waitFor(() => evaluate('document.querySelector(".ws-ai-message.streaming")?.textContent.includes("已生成的片段")'), { process: electron });
  await click("ai-stop");
  await idle();
  assert.match(persisted().at(-1).content, /已生成的片段/);
  assert.equal(persisted().at(-1).role, "assistant");
  await input("模拟失败后重试 [RETRY_TEST]");
  await click("ai-send");
  await waitFor(() => evaluate('Boolean(document.querySelector("[data-module-action=ai-retry]"))'), { process: electron });
  assert.equal(persisted().filter((message) => message.role === "user" && message.content.includes("[RETRY_TEST]")).length, 1);
  await click("ai-retry");
  await idle();
  await waitFor(() => persisted().at(-1)?.content === "重试成功，用户问题没有重复。", { process: electron });
  assert.equal(persisted().filter((message) => message.role === "user" && message.content.includes("[RETRY_TEST]")).length, 1);
  assert.equal(requests.at(-1).payload.messages.filter((message) => message.role === "user" && message.content.includes("[RETRY_TEST]")).length, 1);
  // Show the other real window to verify shared persisted history and its compact layout.
  await overlay.evaluate('window.lumen.setState({pinned:true}).then(()=>window.lumen.setShell("panel"))');
  await overlay.send("Page.bringToFront");
  await waitFor(() => overlay.evaluate('Boolean(document.querySelector("[data-act=tab-ai]"))'), { process: electron });
  await overlay.evaluate('document.querySelector("[data-act=tab-ai]").click()');
  await waitFor(() => overlay.evaluate('document.querySelector(".ai-messages")?.textContent.includes("重试成功")'), { process: electron });
  assert.equal(await overlay.evaluate('document.querySelector(".ai-wrap").scrollWidth <= document.querySelector(".ai-wrap").clientWidth + 2'), true);
  await screenshot(overlay, "overlay");
  console.log(`AI E2E passed: suggestions, IME, real SSE/IPC/persistence, Markdown copy, stop, retry, narrow dark/light layouts and shared overlay (${requests.length} local API requests).`);
  for (const file of screenshots) console.log(`Screenshot: ${file}`);
} finally {
  for (const socket of sockets) { try { socket.close(); } catch {} }
  for (const record of children.reverse()) await stop(record);
  mock?.closeAllConnections();
  if (mock?.listening) await new Promise((resolve) => mock.close(resolve));
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
