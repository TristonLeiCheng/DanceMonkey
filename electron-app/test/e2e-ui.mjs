import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "dm-ui-e2e-"));
const cwd = path.resolve(import.meta.dirname, "..");
const children = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}
function start(name, command, args, env = {}) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const record = { name, child, output: "", exited: false, code: null, signal: null };
  const capture = (chunk) => { record.output = `${record.output}${chunk}`.slice(-8000); };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  child.once("exit", (code, signal) => { record.exited = true; record.code = code; record.signal = signal; });
  children.push(record);
  return record;
}
function assertAlive(record) {
  if (record?.exited) throw new Error(`${record.name} exited during startup (code ${record.code}, signal ${record.signal || "none"})\n${record.output || "<no output>"}`);
}
async function waitFor(fn, { timeout = 20000, process: watched } = {}) {
  const end = Date.now() + timeout;
  let error;
  while (Date.now() < end) {
    assertAlive(watched);
    try { const result = await fn(); if (result) return result; } catch (next) { error = next; }
    await sleep(150);
  }
  assertAlive(watched);
  throw new Error(`timed out${error ? `: ${error.message}` : ""}${watched?.output ? `\n${watched.output}` : ""}`);
}
async function stop(record) {
  if (record.exited) return;
  record.child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => record.child.once("exit", resolve)),
    sleep(2000).then(() => { if (!record.exited) record.child.kill("SIGKILL"); }),
  ]);
}

let socket;
try {
  const [serverPort, debugPort] = await Promise.all([freePort(), freePort()]);
  if (serverPort === debugPort) throw new Error("failed to allocate distinct local ports");
  const server = start("preview server", process.execPath, ["server.mjs"], { PORT: String(serverPort) });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${serverPort}/`)).ok, { process: server });

  // All Electron persistence paths point under this disposable root; no user vault is opened.
  const electron = start("Electron", path.resolve(cwd, "node_modules/.bin/electron"), ["."], {
    DM_E2E_ROOT: root,
    DM_E2E_PORT: String(debugPort),
    DM_E2E_SERVER_PORT: String(serverPort),
  });
  const target = await waitFor(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
    return targets.find((item) => item.type === "page" && item.url.includes(`127.0.0.1:${serverPort}`));
  }, { process: electron });

  let serial = 0;
  const pending = new Map();
  const connect = async (url) => {
    socket = new WebSocket(url);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
    };
  };
  await connect(target.webSocketDebuggerUrl);
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++serial;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const response = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.text);
    return response.result?.result?.value;
  };

  await evaluate(`window.lumen.openWorkspace("notes")`);
  const workspace = await waitFor(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
    return targets.find((item) => item.type === "page" && item.id !== target.id && item.url.includes(`127.0.0.1:${serverPort}`) && item.url.includes("#workspace"));
  }, { process: electron });
  socket.close();
  await connect(workspace.webSocketDebuggerUrl);

  await waitFor(() => evaluate(`location.hash.startsWith("#workspace") && document.readyState === "complete"`), { process: electron });
  if (!await evaluate(`Boolean(document.querySelector(".ws-editor"))`)) await evaluate(`window.lumen.workspace.createFile("", "e2e.md").then(() => location.reload())`);
  await waitFor(() => evaluate(`Boolean(document.querySelector(".ws-editor"))`), { process: electron });
  await evaluate(`(async()=>{ await window.lumen.zenTask.addProject({name:"UI 发布",status:"Blocked",lifecycleStatus:"In Progress",milestones:[{id:"ui-stage",name:"UI 验收",dueDate:"2020-01-01"}]}); const editor=document.querySelector(".ws-editor"); editor.value="- [ ] 完成 UI 验收\\n- [ ] 返回来源笔记"; editor.dispatchEvent(new Event("input",{bubbles:true})); editor.setSelectionRange(0,editor.value.length); document.querySelector('[data-action="note-to-tasks"]').click(); })()`);
  await waitFor(() => evaluate(`Boolean(document.querySelector(".ws-note-task-dialog"))`), { process: electron });
  assert.equal(await evaluate(`document.querySelectorAll("[data-candidate]").length`), 2);
  await evaluate(`(()=>{ const stage=document.querySelector('[name="milestoneId"]'); stage.value="ui-stage"; stage.dispatchEvent(new Event("change",{bubbles:true})); document.querySelector(".ws-note-task-dialog").requestSubmit(); })()`);
  await waitFor(() => evaluate(`document.body.textContent.includes("已创建 2 项任务")`), { process: electron });
  await evaluate(`document.querySelector("[data-note-task-project]").click()`);
  await waitFor(() => evaluate(`document.body.textContent.includes("完成 UI 验收")`), { process: electron });
  assert.equal(await evaluate(`document.body.textContent.includes("里程碑 · UI 验收")`), true);
  await evaluate(`document.querySelector('[data-module-action="pm-back"]').click()`);
  await waitFor(() => evaluate(`document.body.textContent.includes("Needs attention")`), { process: electron });
  assert.equal(await evaluate(`document.body.textContent.includes("项目健康度受阻") && document.body.textContent.includes("里程碑已逾期")`), true);
  await evaluate(`document.querySelector('[data-module-action="pm-attention"]').click()`);
  await waitFor(() => evaluate(`document.body.textContent.includes("完成 UI 验收")`), { process: electron });
  await evaluate(`document.querySelector('[data-module-action="pm-open-task-source"]').click()`);
  await waitFor(() => evaluate(`Boolean(document.querySelector(".ws-editor"))`), { process: electron });
  console.log(`UI E2E passed on isolated ports ${serverPort}/${debugPort}: note preview → atomic batch → milestone → attention → source return`);
} finally {
  try { socket?.close(); } catch {}
  for (const record of children.reverse()) await stop(record);
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
}
