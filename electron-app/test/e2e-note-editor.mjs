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
const appExecutable = process.env.DM_E2E_EXECUTABLE || path.resolve(cwd, "node_modules/.bin/electron");
const appArgs = process.env.DM_E2E_EXECUTABLE ? ["--no-proxy-server", "--use-mock-keychain"] : ["--no-proxy-server", "."];
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
  const electron = start("Electron", appExecutable, appArgs, {
    DM_E2E_ROOT: root,
    DM_E2E_PORT: String(debugPort),
    DM_E2E_SERVER_PORT: String(serverPort),
  });
  const target = await waitFor(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
    return targets.find((item) => item.type === "page" && !item.url.includes("#workspace") && (item.url.includes(`127.0.0.1:${serverPort}`) || item.url.startsWith("file:") && item.url.includes("/index.html")));
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
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP request timed out: ${method} ${String(params.expression || "").slice(0, 160)}`)); }, 20000);
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
    return targets.find((item) => item.type === "page" && item.id !== target.id && (item.url.includes(`127.0.0.1:${serverPort}`) || item.url.startsWith("file:") && item.url.includes("/index.html")) && item.url.includes("#workspace"));
  }, { process: electron });
  socket.close();
  await connect(workspace.webSocketDebuggerUrl);

  await waitFor(() => evaluate(`location.hash.startsWith("#workspace") && document.readyState === "complete"`), { process: electron });
  await waitFor(() => evaluate(`window.lumen.getAppVersion().then(version => document.querySelector(".ws-brand")?.textContent.includes("v" + version))`), { process: electron });
  await waitFor(() => evaluate(`Boolean(document.querySelector('.notes-home'))`), { process: electron });
  const targets = async () => (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
  const documentTarget = async (exclude = []) => (await targets()).find(item => item.url.endsWith('#document') && !exclude.includes(item.id));
  const switchTo = async target => { socket.close(); await connect(target.webSocketDebuggerUrl); };
  const key = async (key, code, modifiers = 0) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers });
  };
  const mod = process.platform === 'darwin' ? 4 : 2;
  const type = async text => send('Input.insertText', { text });
  const replace = async text => { await evaluate(`document.querySelector('.cm-content').focus()`); await key('a', 'KeyA', mod); await type(text); };
  const activeRoot = await evaluate(`window.lumen.workspace.list().then(result=>result.root)`);
  const sample = '# 独立 Markdown 编辑器\n\n## 实时预览\n\n这是 **加粗**、*斜体*、~~删除线~~ 和 `inline code`。\n\n> 保留 Markdown，直接编辑。\n\n- 第一项\n- 第二项\n\n[OpenAI](https://openai.com)\n\n```md\n# 代码中的标题不能隐藏\n```\n';
  fs.writeFileSync(path.join(activeRoot, '编辑器验收.md'), sample);
  await evaluate(`document.querySelector('[data-action="refresh"]').click()`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('[data-action="home-open"][data-path="编辑器验收.md"]'))`), {process:electron});
  await evaluate(`document.querySelector('[data-action="home-open"][data-path="编辑器验收.md"]').click()`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('.ws-live-editor .cm-content'))`), {process:electron});
  assert.equal((await targets()).filter(item => item.url.endsWith('#document')).length, 0);
  assert.equal(await evaluate(`document.querySelectorAll('.md-formatbar button').length`), 14);
  assert.equal(await evaluate(`document.querySelector('[data-action="open-local-md"]').textContent.trim()`), '');
  assert.ok(await evaluate(`document.querySelector('[data-action="open-local-md"]').getBoundingClientRect().width <= 30`));
  await evaluate(`document.querySelector('[data-action="view"][data-value="edit"]').click()`);
  await evaluate(`(()=>{const input=document.querySelector('.ws-editor'); input.value='内嵌工具栏';input.dispatchEvent(new Event('input'));input.focus();input.setSelectionRange(0,input.value.length);document.querySelector('[data-md-command="bold"]').click();})()`);
  assert.equal(await evaluate(`document.querySelector('.ws-editor').value`), '**内嵌工具栏**');
  await evaluate(`document.querySelector('[data-action="view"][data-value="live"]').click()`);
  await evaluate(`document.querySelector('[data-action="view"][data-value="edit"]').click()`);
  const imageBytes = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=';
  const transferImage = async (kind, selector) => evaluate(`(()=>{ const bytes=Uint8Array.from(atob('${imageBytes}'), c=>c.charCodeAt(0));const dt=new DataTransfer();dt.items.add(new File([bytes],'粘贴图片.png',{type:'image/png'}));const host=document.querySelector('${selector}');host.focus();const rect=host.getBoundingClientRect();host.dispatchEvent('${kind}'==='paste'?new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}):new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true,clientX:rect.x+30,clientY:rect.y+40}));return true;})()`);
  await transferImage('paste','.ws-editor');
  await waitFor(()=>fs.readFileSync(path.join(activeRoot,'编辑器验收.md'),'utf8').includes('](<images/'),{process:electron});
  assert.equal(fs.readdirSync(path.join(activeRoot,'images')).length,1);
  await evaluate(`document.querySelector('[data-action="view"][data-value="live"]').click()`);
  await replace(sample);

  await evaluate(`document.querySelector('[data-action="popout-note"]').click()`);
  const doc = await waitFor(documentTarget, {process:electron});
  assert.equal(await evaluate(`Boolean(document.querySelector('.notes-home')) && !document.querySelector('.ws-editor')`), true);
  await evaluate(`window.lumen.note.open('编辑器验收.md')`);
  assert.equal((await targets()).filter(item => item.url.endsWith('#document')).length, 1);
  await switchTo(doc);
  await waitFor(() => evaluate(`Boolean(document.querySelector('.cm-content'))`), {process:electron});
  await send('Runtime.enable');
  const live = await evaluate(`({mode:document.querySelector('.note-body').dataset.mode,h1:document.querySelector('.md-h1')?.textContent,strong:document.querySelector('.md-strong')?.textContent,code:document.querySelector('.md-code-block')?.textContent})`);
  assert.equal(live.mode, 'live'); assert.equal(live.h1, '独立 Markdown 编辑器'); assert.equal(live.strong, '加粗');
  assert.equal(await evaluate(`Boolean(document.querySelector('.note-start-error'))`), false);
  assert.equal(fs.readFileSync(path.join(activeRoot,'编辑器验收.md'),'utf8'), sample);
  assert.equal(await evaluate(`Boolean(document.querySelector('.note-footer .note-file-path')) && !document.querySelector('.note-toolbar [title*="编辑器验收.md"]')`), true);
  await replace('图片粘贴与拖拽');
  await transferImage('paste','.cm-content');
  await waitFor(()=>fs.readdirSync(path.join(activeRoot,'images')).length === 2,{process:electron});
  await waitFor(()=>evaluate(`!document.getElementById('root').inert && document.querySelector('.md-media img')?.naturalWidth > 0`),{process:electron});
  await transferImage('drop','.cm-content');
  await waitFor(()=>fs.readdirSync(path.join(activeRoot,'images')).length === 3,{process:electron});
  await waitFor(()=>evaluate(`!document.getElementById('root').inert`),{process:electron});
  await key('s','KeyS',mod);
  await waitFor(()=>fs.readFileSync(path.join(activeRoot,'编辑器验收.md'),'utf8').match(/images\//g)?.length === 2,{process:electron});
  await evaluate(`document.querySelector('[data-mode="split"]').click()`);
  await waitFor(()=>evaluate(`[...document.querySelectorAll('.note-preview img')].length === 2 && [...document.querySelectorAll('.note-preview img')].every(img=>img.naturalWidth>0)`),{process:electron});
  await evaluate(`document.querySelector('[data-mode="live"]').click()`);
  await replace('格式工具');
  await key('a', 'KeyA', mod);
  await evaluate(`document.querySelector('[data-md-command="bold"]').click()`);
  assert.equal(await evaluate(`document.querySelector('.md-strong')?.textContent`), '格式工具');
  await evaluate(`document.querySelector('[data-md-command="undo"]').click()`);
  assert.equal(await evaluate(`Boolean(document.querySelector('.md-strong'))`), false);
  await evaluate(`document.querySelector('[data-md-command="redo"]').click()`);
  assert.equal(await evaluate(`document.querySelector('.md-strong')?.textContent`), '格式工具');
  await replace('链接'); await key('a','KeyA',mod);
  await evaluate(`document.querySelector('[data-md-command="link"]').click()`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('.md-insert-dialog[open]'))`), {process:electron});
  await evaluate(`(()=>{const form=document.querySelector('.md-insert-dialog form');form.elements.url.value='https://example.com';form.requestSubmit();})()`);
  await key('s','KeyS',mod);
  await waitFor(() => fs.readFileSync(path.join(activeRoot,'编辑器验收.md'),'utf8') === '[链接](<https://example.com>)', {process:electron});
  await evaluate(`document.querySelector('[data-mode="preview"]').click()`);
  assert.equal(await evaluate(`[...document.querySelectorAll('[data-md-command]')].every(b=>b.disabled)`), true);
  await evaluate(`document.querySelector('[data-mode="live"]').click()`);
  const picture = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=', 'base64');
  fs.writeFileSync(path.join(activeRoot, '验收 图片.png'), picture);
  const media = '# 图片与表格\n\n![示例](<验收 图片.png>)\n\n| 名称 | 进度 |\n| --- | --- |\n| 中文 | 待办 |\n';
  await replace(media);
  await waitFor(() => evaluate(`document.querySelector('.md-media img')?.naturalWidth > 0 && document.querySelectorAll('.md-media table input').length === 4`), {process:electron});
  await evaluate(`(()=>{const e=document.querySelector('.md-media table tr:nth-child(2) input');e.value='已修改';e.dispatchEvent(new Event('input'));e.dispatchEvent(new Event('change'));})()`);
  await waitFor(() => fs.readFileSync(path.join(activeRoot, '编辑器验收.md'),'utf8').includes('| 已修改 |'), {process:electron});
  await evaluate(`[...document.querySelectorAll('.md-media button')].find(b=>b.textContent==='＋ 行').click()`);
  assert.equal(await evaluate(`document.querySelectorAll('.md-media table tr').length`), 3);
  await evaluate(`(()=>{const fields=document.querySelectorAll('.md-media details input');fields[0].value='新的替代文字';[...document.querySelectorAll('.md-media button')].find(b=>b.textContent==='应用').click();})()`);
  await waitFor(() => fs.readFileSync(path.join(activeRoot, '编辑器验收.md'),'utf8').includes('![新的替代文字]'), {process:electron});
  for (const light of [false, true]) {
    await evaluate(`document.getElementById('root').classList.toggle('light', ${light})`);
    const colors = await evaluate(`({bg:getComputedStyle(document.getElementById('root')).backgroundColor,fg:getComputedStyle(document.querySelector('.cm-content')).color})`);
    assert.notEqual(colors.bg, 'rgba(0, 0, 0, 0)'); assert.notEqual(colors.bg, colors.fg);
  }
  await replace(''); await type('#');
  await waitFor(() => evaluate(`document.querySelector('.md-h1')?.textContent === ''`), {process:electron});
  await type('一级标题');
  await waitFor(() => evaluate(`document.querySelector('.md-h1')?.textContent === '一级标题'`), {process:electron});
  await evaluate(`document.querySelector('[data-mode="source"]').click()`);
  assert.equal(await evaluate(`document.querySelector('.cm-content').textContent`), '# 一级标题');
  await sleep(600); await type('追加'); await key('z','KeyZ',mod);
  assert.equal(await evaluate(`document.querySelector('.cm-content').textContent`), '# 一级标题');
  await evaluate(`document.querySelector('[data-mode="live"]').click()`);
  await replace(''); await type('#'); await type('#'); await type('连续标题');
  assert.equal(await evaluate(`document.querySelector('.md-h2')?.textContent`), '连续标题');
  await key('Home', 'Home'); await key('Backspace', 'Backspace');
  assert.equal(await evaluate(`Boolean(document.querySelector('.md-heading'))`), false);
  await replace('- [ ] 可勾选任务');
  await evaluate(`document.querySelector('.md-task-checkbox').click()`);
  await key('s', 'KeyS', mod);
  await waitFor(() => fs.readFileSync(path.join(activeRoot, '编辑器验收.md'), 'utf8') === '- [x] 可勾选任务', {process:electron});
  await replace('## 二级标题\n\n中文输入');
  await send('Input.imeSetComposition', {text:'中文组合',selectionStart:4,selectionEnd:4});
  await type('中文组合');
  await key('s','KeyS',mod);
  await waitFor(() => fs.readFileSync(path.join(activeRoot,'编辑器验收.md'),'utf8').includes('中文组合'), {process:electron});
  assert.equal(await evaluate(`document.querySelector('.md-h2')?.textContent`),'二级标题');
  await evaluate(`document.querySelector('[data-mode="split"]').click()`);
  assert.equal(await evaluate(`document.querySelector('.note-preview h2').textContent`),'二级标题');
  await evaluate(`document.querySelector('[data-mode="preview"]').click()`);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.note-editor')).display`),'none');
  await evaluate(`document.querySelector('[data-mode="live"]').click()`);
  await replace(sample);
  await key('s','KeyS',mod);
  await waitFor(() => fs.readFileSync(path.join(activeRoot,'编辑器验收.md'),'utf8') === sample, {process:electron});
  const output = path.join(os.tmpdir(),'dm-note-editor-preview'); fs.mkdirSync(output,{recursive:true});
  await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  const shot = await send('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(path.join(output,'live-dark.png'),Buffer.from(shot.result.data,'base64'));
  await switchTo(workspace);
  await evaluate(`window.lumen.vaults.select(${JSON.stringify(fs.realpathSync(secondVault))})`);
  await switchTo(doc);
  await replace('# 保存到原笔记库');
  await key('s','KeyS',mod);
  await waitFor(() => fs.readFileSync(path.join(activeRoot,'编辑器验收.md'),'utf8') === '# 保存到原笔记库', {process:electron});
  assert.equal(fs.existsSync(path.join(secondVault,'编辑器验收.md')),false);
  fs.writeFileSync(path.join(activeRoot,'编辑器验收.md'),'# 外部修改');
  await replace('# 本地未保存草稿'); await key('s','KeyS',mod);
  await waitFor(() => evaluate(`!document.querySelector('.note-error').hidden`), {process:electron});
  assert.equal(fs.readFileSync(path.join(activeRoot,'编辑器验收.md'),'utf8'),'# 外部修改');
  assert.equal(await evaluate(`document.querySelector('.cm-content').textContent`),'本地未保存草稿');
  // Restore the last baseline so close can flush the draft without a native error dialog.
  fs.writeFileSync(path.join(activeRoot,'编辑器验收.md'),'# 保存到原笔记库');
  await replace('# 关闭前最后一次输入');
  await evaluate(`window.lumen.window.close()`);
  await waitFor(async () => !(await targets()).some(item => item.id === doc.id), {process:electron});
  assert.equal(fs.readFileSync(path.join(activeRoot,'编辑器验收.md'),'utf8'),'# 关闭前最后一次输入');
  await switchTo(workspace);
  await evaluate(`window.lumen.vaults.select(${JSON.stringify(activeRoot)})`);
  fs.writeFileSync(path.join(activeRoot,'关闭中导入.md'),'# 导入后关闭\n');
  await evaluate(`window.lumen.note.open('关闭中导入.md')`);
  const importDoc = await waitFor(documentTarget,{process:electron}); await switchTo(importDoc);
  await waitFor(()=>evaluate(`Boolean(document.querySelector('.cm-content'))`),{process:electron});
  await transferImage('paste','.cm-content');
  await evaluate(`setTimeout(()=>window.lumen.window.close(),0);true`);
  await waitFor(async()=>!(await targets()).some(item=>item.id===importDoc.id),{process:electron});
  const importedOnClose = fs.readFileSync(path.join(activeRoot,'关闭中导入.md'),'utf8').match(/<([^>]+)>/);
  assert.ok(importedOnClose); assert.ok(fs.existsSync(path.join(activeRoot,importedOnClose[1])));
  await switchTo(workspace);
  fs.writeFileSync(path.join(activeRoot,'CRLF.md'),'---\r\ntitle: "属性"\r\n---\r\n# 换行格式\r\n');
  await evaluate(`window.lumen.note.open('CRLF.md')`);
  const crlfDoc = await waitFor(documentTarget,{process:electron}); await switchTo(crlfDoc);
  await waitFor(() => evaluate(`Boolean(document.querySelector('.cm-content'))`),{process:electron});
  assert.equal(await evaluate(`Boolean(document.querySelector('.cm-foldPlaceholder'))`),true);
  await evaluate(`document.querySelector('[data-mode="source"]').click()`);
  assert.ok((await evaluate(`document.querySelector('.cm-content').textContent`)).includes('title: "属性"'));
  await evaluate(`document.querySelector('.cm-content').focus()`); await key('End','End',2); await type('末尾追加\n第二行\n');
  await evaluate(`setTimeout(() => void window.lumen.quitApp(), 50); true`);
  await waitFor(() => electron.exited,{timeout:20000});
  assert.match(fs.readFileSync(path.join(activeRoot,'CRLF.md'),'utf8'),/\r\n/);
  assert.equal(/(?<!\r)\n/.test(fs.readFileSync(path.join(activeRoot,'CRLF.md'),'utf8')), false);
  assert.ok(fs.readFileSync(path.join(activeRoot,'CRLF.md'),'utf8').includes('末尾追加'));
  console.log('PASS separate Markdown windows: deduplication, live headings/inline formatting, source/split/read, Chinese IME, undo, save, vault pinning, disk conflicts, close flush, metadata, CRLF and app quit. Screenshots: '+output);
} finally {
  try { socket?.close(); } catch {}
  for (const record of children.reverse()) await stop(record);
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
}
