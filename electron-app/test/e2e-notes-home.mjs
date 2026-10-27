import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const { createPkb } = createRequire(import.meta.url)("../electron/pkb");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "dm-ui-e2e-"));
const cwd = path.resolve(import.meta.dirname, "..");
const children = [];
const secondVault = path.join(root, "个人笔记库");
fs.mkdirSync(path.join(secondVault, "工作资料/会议记录"), { recursive: true });
fs.mkdirSync(path.join(secondVault, "仅B目录"));
fs.writeFileSync(path.join(secondVault, "工作资料/会议记录/本周计划.md"), "B 库独立内容");
const firstVault = path.join(root, "documents", "NoteVault");
fs.mkdirSync(firstVault, { recursive: true });
const configDirectory = path.join(root, "app-data", "DanceMonkey");
fs.mkdirSync(configDirectory, { recursive: true });
fs.writeFileSync(path.join(configDirectory, "config.json"), JSON.stringify({
  notesRootPath: fs.realpathSync(firstVault),
  notesVaults: [
    { root: fs.realpathSync(firstVault), name: "工作笔记库" },
    { root: fs.realpathSync(secondVault), name: "个人笔记库" },
  ],
}));
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
  const electron = start("Electron", path.resolve(cwd, "node_modules/.bin/electron"), ["--no-proxy-server", "."], {
    DM_E2E_ROOT: root,
    DM_E2E_PORT: String(debugPort),
    DM_E2E_SERVER_PORT: String(serverPort),
  });
  const target = await waitFor(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
    return targets.find((item) => item.type === "page" && !item.url.includes("#workspace") && item.url.includes(`127.0.0.1:${serverPort}`));
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
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP request timed out: ${method}`)); }, 20000);
    pending.set(id, (response) => { clearTimeout(timeout); resolve(response); });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const response = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.text);
    return response.result?.result?.value;
  };

  // The disposable Electron userData directory guarantees first-run (unset) preferences.
  await evaluate(`window.lumen.openWorkspace("notes")`);
  const workspace = await waitFor(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
    return targets.find((item) => item.type === "page" && item.id !== target.id && item.url.includes(`127.0.0.1:${serverPort}`) && item.url.includes("#workspace"));
  }, { process: electron });
  socket.close();
  await connect(workspace.webSocketDebuggerUrl);

  await waitFor(() => evaluate(`location.hash.startsWith("#workspace") && document.readyState === "complete"`), { process: electron });
  await waitFor(() => evaluate(`window.lumen.getAppVersion().then(version => document.querySelector(".ws-brand")?.textContent.includes("v" + version))`), { process: electron });
  await waitFor(() => evaluate(`Boolean(document.querySelector('.notes-home'))`), { process: electron });
  assert.equal(await evaluate(`Boolean(document.querySelector('.ws-editor'))`), false);
  assert.equal(await evaluate(`document.querySelectorAll('[data-action="home-new"]').length`), 6);
  const activeRoot = await evaluate(`window.lumen.workspace.list().then(result=>result.root)`);
  fs.mkdirSync(path.join(activeRoot, 'Templates'), {recursive:true});
  fs.writeFileSync(path.join(activeRoot, 'Templates', 'AAAA-template.md'), '# never open by default');
  fs.writeFileSync(path.join(activeRoot, '历史笔记.md'), '---\ncreated: "2020-01-01T00:00:00Z"\ntitle: "历史回顾"\n---\n# 历史回顾');
  await evaluate(`document.querySelector('[data-action="refresh"]').click()`);
  await waitFor(() => evaluate(`document.querySelector('.notes-home-results')?.textContent.includes('历史回顾')`), {process:electron});
  assert.equal(await evaluate(`document.querySelector('.notes-home-results').textContent.includes('AAAA-template')`), false);
  const paths = [];
  for (const type of ['blank','note','daily','meeting','project','person']) {
    await evaluate(`document.querySelector('[data-action="home-new"][data-value="${type}"]').click()`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('[data-home-create]'))`), {process:electron});
    await evaluate(`(()=>{const form=document.querySelector('[data-home-create]'); form.elements.title.value='主页测试-${type}';form.requestSubmit();})()`);
    await waitFor(() => evaluate(`document.querySelector('.ws-doc-name')?.textContent === '主页测试-${type}.md'`), {process:electron});
    const file = await evaluate(`window.lumen.workspace.list().then(result=>window.DMNotesHome.filesFromTree(result.tree).find(file=>file.name==='主页测试-${type}.md'))`);
    paths.push(file.path);
    assert.equal(file.createdAtSource, 'metadata');
    assert.match(fs.readFileSync(path.join(activeRoot,file.path),'utf8'), new RegExp('主页测试-'+type));
    await evaluate(`(()=>{const editor=document.querySelector('.ws-editor');editor.value+='\\n正文检索专用 home-body-needle-${type}';editor.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-action="notes-home"]').click();})()`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('.notes-home'))`), {process:electron});
    assert.ok(fs.readFileSync(path.join(activeRoot,file.path),'utf8').includes('home-body-needle-'+type));
  }
  assert.equal(fs.existsSync(path.join(activeRoot,'_System/pkb.json')), false);
  await evaluate(`document.querySelector('[data-action="home-sort"][data-value="createdAt"]').click()`);
  assert.equal(await evaluate(`document.querySelector('[data-action="home-open"]').dataset.path`), paths.at(-1));
  await evaluate(`(()=>{const input=document.querySelector('[data-home-search]');input.value='主页测试 meeting';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  assert.equal(await evaluate(`document.querySelectorAll('[data-action="home-open"]').length`), 1);
  assert.equal(await evaluate(`document.activeElement === document.querySelector('[data-home-search]') || document.querySelector('[data-home-search]').value === '主页测试 meeting'`), true);
  await evaluate(`document.querySelector('[data-action="home-open"]').click()`);
  await waitFor(() => evaluate(`document.querySelector('.ws-doc-name')?.textContent==='主页测试-meeting.md'`), {process:electron});
  await evaluate(`document.querySelector('[data-action="notes-home"]').click()`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('.notes-home'))`), {process:electron});
  await evaluate(`(()=>{const input=document.querySelector('[data-home-search]');input.value='home-body-needle-note';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-action="home-fulltext"]').click();})()`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('[data-palette-path]'))`), {process:electron});
  assert.equal(await evaluate(`document.querySelector('.ws-palette-list').textContent.includes('home-body-needle-note')`), true);
  await evaluate(`document.querySelector('[data-palette-path]').click()`);
  await waitFor(() => evaluate(`document.querySelector('.ws-doc-name')?.textContent==='主页测试-note.md'`), {process:electron});
  await evaluate(`location.reload()`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('.notes-home')) && !document.querySelector('.ws-editor')`), {process:electron});
  await evaluate(`document.querySelector('[data-action="section"][data-value="tasks"]').click()`);
  await waitFor(() => evaluate(`!document.querySelector('.notes-home')`), {process:electron});
  await evaluate(`document.querySelector('[data-action="section"][data-value="notes"]').click()`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('.notes-home'))`), {process:electron});
  await evaluate(`(()=>{document.querySelector('.ws-vault-options > summary').click();const select=document.querySelector('.ws-vault-select');select.value=${JSON.stringify(fs.realpathSync(secondVault))};select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await waitFor(() => evaluate(`document.querySelector('.ws-vault-path')?.title===${JSON.stringify(fs.realpathSync(secondVault))} && !document.getElementById('root').inert`), {process:electron});
  assert.equal(await evaluate(`document.querySelector('.notes-home-stats strong').textContent`), '1篇');
  assert.equal(await evaluate(`document.querySelector('.notes-home-results').textContent.includes('主页测试')`), false);
  await evaluate(`(()=>{document.querySelector('.ws-vault-options > summary').click();const select=document.querySelector('.ws-vault-select');select.value=${JSON.stringify(activeRoot)};select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await waitFor(() => evaluate(`document.querySelector('.ws-vault-path')?.title===${JSON.stringify(activeRoot)} && !document.getElementById('root').inert`), {process:electron});
  const output = process.env.DM_HOME_SCREENSHOT_DIR || path.join(os.tmpdir(),'dm-home-preview');
  fs.mkdirSync(output,{recursive:true});
  for(const theme of ['dark','light']) {
    await evaluate(`(()=>{const select=document.querySelector('.ws-theme-select');select.value='${theme}';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    const capture=await send('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(path.join(output,theme+'.png'),Buffer.from(capture.result.data,'base64'));
  }
  await evaluate(`document.querySelector('.ws-vault-options > summary').click()`);
  await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  const optionsCapture=await send('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(path.join(output,'options.png'),Buffer.from(optionsCapture.result.data,'base64'));
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  await send('Emulation.setDeviceMetricsOverride',{width:820,height:900,deviceScaleFactor:1,mobile:false});
  await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  assert.equal(await evaluate(`(()=>{const home=document.querySelector('.notes-home');return home.scrollWidth<=home.clientWidth;})()`),true);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.notes-home-kinds')).gridTemplateColumns.split(' ').length`),2);
  const narrow=await send('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(path.join(output,'narrow.png'),Buffer.from(narrow.result.data,'base64'));
  console.log('PASS notes home: startup, six real-file creation flows, save-before-home, recent sorting, title/full-text search, restart and vault isolation. Screenshots: '+output);
} finally {
  try { socket?.close(); } catch {}
  for (const record of children.reverse()) await stop(record);
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
}
