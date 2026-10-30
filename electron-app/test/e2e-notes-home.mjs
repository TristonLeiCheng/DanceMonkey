import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const { createPkb } = createRequire(import.meta.url)("../electron/pkb");
const detailsModel = createRequire(import.meta.url)('../src/note-details-model');

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
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP request timed out: ${method} ${params.expression || ''}`)); }, 20000);
    pending.set(id, (response) => { clearTimeout(timeout); resolve(response); });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const response = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.exception?.description || response.result.exceptionDetails.text);
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
  assert.equal(await evaluate(`Boolean(document.querySelector('.ws-editor'))`), false);
  assert.equal(await evaluate(`document.querySelectorAll('[data-action="home-new"]').length`), 6);
  // Drag the actual splitter, then verify every subsequent redraw retains its width.
  const splitter = await evaluate(`(()=>{const rect=document.querySelector('.ws-resizer').getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2,width:document.querySelector('.ws-sidebar').getBoundingClientRect().width};})()`);
  await send('Input.dispatchMouseEvent', {type:'mouseMoved',x:splitter.x,y:splitter.y,buttons:0});
  await send('Input.dispatchMouseEvent', {type:'mousePressed',x:splitter.x,y:splitter.y,button:'left',buttons:1,clickCount:1});
  await send('Input.dispatchMouseEvent', {type:'mouseMoved',x:splitter.x+334-splitter.width,y:splitter.y,buttons:1});
  await send('Input.dispatchMouseEvent', {type:'mouseReleased',x:splitter.x+334-splitter.width,y:splitter.y,button:'left',buttons:0,clickCount:1});
  const checkSidebar = async (width = 334) => assert.equal(await evaluate(`Math.round(document.querySelector('.ws-sidebar').getBoundingClientRect().width)`), width);
  await checkSidebar();
  assert.equal(await evaluate(`localStorage.getItem('lumen-workspace-sidebar-width')`), '334');
  await evaluate(`document.querySelector('.ws-resizer').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))`);
  await checkSidebar(350);
  await evaluate(`document.querySelector('.ws-resizer').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}))`);
  await checkSidebar();
  const activeRoot = await evaluate(`window.lumen.workspace.list().then(result=>result.root)`);
  fs.mkdirSync(path.join(activeRoot, '工作资料/会议记录'), { recursive: true });
  fs.writeFileSync(path.join(activeRoot, '工作资料/会议记录/本周计划.md'), '# 外观测试\n\n正文保持原样');
  fs.mkdirSync(path.join(activeRoot, 'Templates'), {recursive:true});
  fs.writeFileSync(path.join(activeRoot, 'Templates', 'AAAA-template.md'), '# never open by default');
  fs.writeFileSync(path.join(activeRoot, '历史笔记.md'), '---\ncreated: "2020-01-01T00:00:00Z"\ntitle: "历史回顾"\n---\n# 历史回顾');
  const detailsBody = '\r\n# 主文档\r\n原始正文保持原样\r\n[[关联笔记|下一篇]]\r\n[普通链接](关联笔记.md)\r\n[[尚未创建]]\r\n`[[代码示例]]`\r\n';
  fs.writeFileSync(path.join(activeRoot, '双链主笔记.md'), '\uFEFF---\r\ntitle: "双链主笔记"\r\n# 自定义注释\r\ncustom:\r\n  owner: 团队\r\n---\r\n' + detailsBody);
  fs.writeFileSync(path.join(activeRoot, '关联笔记.md'), '---\n标签: [关联]\n---\n# 关联笔记\n');
  fs.writeFileSync(path.join(activeRoot, '引用来源.md'), '[[双链主笔记]]\n[回链](双链主笔记.md#说明)\n');
  await evaluate(`document.querySelector('[data-action="refresh"]').click()`);
  await waitFor(() => evaluate(`document.querySelector('.notes-home-results')?.textContent.includes('历史回顾')`), {process:electron});
  assert.equal(await evaluate(`document.querySelector('.notes-home-results').textContent.includes('AAAA-template')`), false);
  const appearancePath = '工作资料/会议记录/本周计划.md';
  const appearanceRow = file => `[...document.querySelectorAll('.tree-row')].find(row=>row.dataset.path===${JSON.stringify(file)})`;
  const openAppearance = async file => {
    await evaluate(`${appearanceRow(file)}.querySelector('[data-action="appearance"]').click()`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('.ws-appearance-dialog'))`), { process: electron });
  };
  const saveAppearance = async () => {
    await evaluate(`document.querySelector('.ws-appearance-dialog').requestSubmit()`);
    await waitFor(() => evaluate(`!document.querySelector('.ws-appearance-dialog')`), { process: electron });
  };
  await openAppearance('工作资料');
  assert.equal(await evaluate(`document.querySelectorAll('[data-appearance-template]').length`), 8);
  await evaluate(`document.querySelector('[data-appearance-template="work"]').click()`);
  assert.equal(await evaluate(`document.querySelector('[data-color-input="backgroundColor"]').value`), '#e6effb');
  assert.equal(await evaluate(`document.querySelector('.ws-appearance-preview').style.getPropertyValue('--note-accent')`), '#285c9b');
  await evaluate(`document.querySelector('[data-appearance-color="#639ce0"]').click();document.querySelector('[data-appearance-emoji="💼"]').click()`);
  await saveAppearance();
  assert.equal(await evaluate(`${appearanceRow('工作资料')}.querySelector('.tree-icon').textContent`), '💼');
  assert.equal(await evaluate(`${appearanceRow('工作资料')}.style.getPropertyValue('--note-bg')`), '#e6effb');
  await checkSidebar();
  await evaluate(`${appearanceRow('工作资料')}.querySelector('[data-action="tree-toggle"]').click()`);
  await evaluate(`${appearanceRow('工作资料/会议记录')}.querySelector('[data-action="tree-toggle"]').click()`);
  await openAppearance(appearancePath);
  await evaluate(`(()=>{const select=document.querySelector('[aria-label="表情分类"]');select.value='animals';select.dispatchEvent(new Event('change'));})()`);
  assert.equal(await evaluate(`document.querySelectorAll('[data-appearance-emoji]').length`), 25);
  await evaluate(`(()=>{const search=document.querySelector('[aria-label="搜索表情"]');search.value='蝴蝶';search.dispatchEvent(new Event('input'));})()`);
  assert.equal(await evaluate(`document.querySelectorAll('[data-appearance-emoji]').length`), 2);
  await evaluate(`document.querySelector('[data-appearance-emoji="🦋"]').click()`);
  assert.equal(await evaluate(`document.querySelector('[data-appearance-preview-icon]').textContent`), '🦋');
  await evaluate(`(()=>{const search=document.querySelector('[aria-label="搜索表情"]');search.value='不存在的表情';search.dispatchEvent(new Event('input'));})()`);
  assert.equal(await evaluate(`document.querySelector('.ws-appearance-emoji-status').textContent.includes('没有匹配')`), true);
  await evaluate(`(()=>{const input=document.querySelector('[aria-label="自定义 emoji"]');input.value='👩🏽‍💻';input.dispatchEvent(new Event('input'));const color=document.querySelector('[aria-label="自定义文字颜色"]');color.value='#bb77cc';color.dispatchEvent(new Event('input'));const background=document.querySelector('[aria-label="自定义背景颜色"]');background.value='#f4e9dd';background.dispatchEvent(new Event('input'));})()`);
  await saveAppearance();
  assert.equal(await evaluate(`${appearanceRow(appearancePath)}.querySelector('.tree-icon').textContent`), '👩🏽‍💻');
  assert.equal(await evaluate(`${appearanceRow('工作资料')}.style.getPropertyValue('--note-accent')`), '#639ce0');
  assert.equal(await evaluate(`${appearanceRow(appearancePath)}.style.getPropertyValue('--note-accent')`), '#bb77cc');
  assert.equal(await evaluate(`${appearanceRow(appearancePath)}.style.getPropertyValue('--note-bg')`), '#f4e9dd');
  assert.equal(fs.readFileSync(path.join(activeRoot, appearancePath), 'utf8'), '# 外观测试\n\n正文保持原样');
  await openAppearance(appearancePath);
  await evaluate(`document.querySelector('[data-appearance-reset]').click();document.querySelector('[data-appearance-cancel]').click()`);
  assert.equal(await evaluate(`${appearanceRow(appearancePath)}.querySelector('.tree-icon').textContent`), '👩🏽‍💻');
  await openAppearance(appearancePath);
  await evaluate(`(()=>{const input=document.querySelector('[aria-label="自定义 emoji"]');input.value='两个😀😀';input.dispatchEvent(new Event('input'));document.querySelector('.ws-appearance-dialog').requestSubmit();})()`);
  await waitFor(() => evaluate(`document.querySelector('.ws-appearance-error')?.textContent.includes('一个 emoji')`), {process:electron});
  await evaluate(`document.querySelector('[data-appearance-cancel]').click()`);
  // Renaming a decorated parent must keep every descendant's individual appearance.
  for (const [from,to] of [['工作资料','工作归档'],['工作归档','工作资料']]) {
    await evaluate(`${appearanceRow(from)}.querySelector('[data-action="rename"]').click();document.querySelector('.ws-dialog-input').value=${JSON.stringify(to)};document.querySelector('[data-dialog="confirm"]').click()`);
    await waitFor(() => evaluate(`Boolean(${appearanceRow(to)})`), {process:electron});
    assert.equal(await evaluate(`${appearanceRow(to+'/会议记录/本周计划.md')}.querySelector('.tree-icon').textContent`), '👩🏽‍💻');
  }
  await evaluate(`${appearanceRow(appearancePath)}.querySelector('[data-action="tree-open"]').click()`);
  await waitFor(() => evaluate(`document.querySelector('.ws-note-appearance-button')?.textContent==='👩🏽‍💻'`), {process:electron});
  await checkSidebar();
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.ws-editor-area .cm-content')).backgroundColor`), 'rgb(244, 233, 221)');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.ws-editor-area .cm-content')).color`), 'rgb(187, 119, 204)');
  await evaluate(`document.querySelector('[data-action="view"][data-value="preview"]').click()`);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.ws-preview h1')).color`), 'rgb(187, 119, 204)');
  await checkSidebar();
  await evaluate(`document.querySelector('[data-action="view"][data-value="live"]').click()`);
  await evaluate(`document.querySelector('[data-action="notes-home"]').click()`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('.notes-home'))`), {process:electron});
  const documentTarget = async name => {
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
    return targets.find(item => item.url.endsWith('#document') && item.title.includes(name));
  };
  const switchTo = async target => { socket.close(); await connect(target.webSocketDebuggerUrl); };
  const popout = async () => { await waitFor(() => evaluate(`Boolean(document.querySelector('[data-action="popout-note"]'))`), {process:electron}); await evaluate(`document.querySelector('[data-action="popout-note"]').click()`); };
  const closeDocument = async name => {
    const target = await waitFor(() => documentTarget(name), {process:electron});
    await switchTo(target);
    await waitFor(() => evaluate(`Boolean(document.querySelector('.cm-content'))`), {process:electron});
    await evaluate(`setTimeout(() => void window.lumen.window.close(), 30); true`);
    await waitFor(async () => !await documentTarget(name), {process:electron});
    await switchTo(workspace);
  };
  const paths = [];
  await evaluate(`${appearanceRow(appearancePath)}.querySelector('[data-action="tree-open"]').click()`);
  await popout();
  const decoratedDocument = await waitFor(() => documentTarget('本周计划.md'), {process:electron});
  await switchTo(decoratedDocument);
  await waitFor(() => evaluate(`document.querySelector('.note-mark')?.textContent==='👩🏽‍💻'`), {process:electron});
  assert.equal(await evaluate(`document.querySelector('.note-identity').style.getPropertyValue('--note-accent')`), '#bb77cc');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.note-body .cm-content')).backgroundColor`), 'rgb(244, 233, 221)');
  await evaluate(`document.querySelector('[data-mode="preview"]').click()`);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.note-preview h1')).color`), 'rgb(187, 119, 204)');
  await closeDocument('本周计划.md');
  await evaluate(`${appearanceRow('双链主笔记.md')}.querySelector('[data-action="tree-open"]').click()`);
  await waitFor(() => evaluate(`document.querySelectorAll('.note-details-rail button').length===2`), {process:electron});
  assert.equal(await evaluate(`Math.round(document.querySelector('.note-details-rail').getBoundingClientRect().width)`), 44);
  assert.equal(await evaluate(`document.querySelector('.note-details-panel').hidden`), true);
  await evaluate(`document.querySelector('[data-details-tab="metadata"]').click()`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('[data-details-yaml]'))`), {process:electron});
  await evaluate(`(()=>{const input=document.querySelector('[data-details-yaml]');input.value=input.value.replace('双链主笔记','更新后的标题')+${JSON.stringify('\naliases: [我的笔记]\ntags: [工作, 学习]')};input.dispatchEvent(new Event('input'));})()`);
  await evaluate(`document.querySelector('[data-action="view"][data-value="preview"]').click()`);
  assert.equal(await evaluate(`document.querySelector('[data-details-yaml]').value.includes('更新后的标题')`), true);
  await evaluate(`document.querySelector('.note-metadata-form').requestSubmit()`);
  await waitFor(() => fs.readFileSync(path.join(activeRoot,'双链主笔记.md'),'utf8').includes('更新后的标题'), {process:electron});
  assert.equal(detailsModel.splitMetadata(fs.readFileSync(path.join(activeRoot,'双链主笔记.md'),'utf8')).body, detailsBody);
  assert.match(fs.readFileSync(path.join(activeRoot,'双链主笔记.md'),'utf8'), /# 自定义注释\r\ncustom:\r\n  owner: 团队/);
  await evaluate(`document.querySelector('[data-action="view"][data-value="live"]').click();document.querySelector('.cm-content').focus()`);
  await send('Input.dispatchKeyEvent', process.platform === 'darwin' ? {type:'keyDown',key:'ArrowDown',code:'ArrowDown',modifiers:4} : {type:'keyDown',key:'End',code:'End',modifiers:2});
  await send('Input.insertText', {text:'正文追加验证'});
  await evaluate(`(()=>{const input=document.querySelector('[data-details-yaml]');input.value+=${JSON.stringify('\nreview: planned')};input.dispatchEvent(new Event('input'));document.querySelector('.note-metadata-form').requestSubmit();})()`);
  await waitFor(() => fs.readFileSync(path.join(activeRoot,'双链主笔记.md'),'utf8').includes('review: planned'), {process:electron});
  const detailsEditedBody = detailsModel.splitMetadata(fs.readFileSync(path.join(activeRoot,'双链主笔记.md'),'utf8')).body;
  assert.equal(detailsEditedBody, detailsBody + '正文追加验证');
  assert.equal(detailsModel.validateMetadata(detailsModel.splitMetadata(fs.readFileSync(path.join(activeRoot,'双链主笔记.md'),'utf8')).yaml).title, '更新后的标题');
  // Invalid YAML stays visible and never replaces a saved document.
  const validDetails = fs.readFileSync(path.join(activeRoot,'双链主笔记.md'),'utf8');
  await evaluate(`(()=>{const input=document.querySelector('[data-details-yaml]');input.value='tags: [未闭合';input.dispatchEvent(new Event('input'));document.querySelector('.note-metadata-form').requestSubmit();})()`);
  await waitFor(() => evaluate(`document.querySelector('.note-details-message').textContent.includes('YAML')`), {process:electron});
  assert.equal(fs.readFileSync(path.join(activeRoot,'双链主笔记.md'),'utf8'), validDetails);
  await evaluate(`document.querySelector('[data-details-reload]').click()`);
  await evaluate(`document.querySelector('[data-details-tab="links"]').click()`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('[data-details-path="引用来源.md"]'))`), {process:electron});
  assert.equal(await evaluate(`document.querySelector('[data-details-path="引用来源.md"]').textContent.includes('2 处引用')`), true);
  assert.equal(await evaluate(`document.querySelector('[data-details-path="关联笔记.md"]').textContent.includes('2 处引用')`), true);
  assert.equal(await evaluate(`document.querySelector('.note-details-content').textContent.includes('目标笔记尚未创建')`), true);
  assert.equal(await evaluate(`document.querySelector('.note-details-content').textContent.includes('代码示例')`), false);
  const detailsOutput = process.env.DM_HOME_SCREENSHOT_DIR || path.join(os.tmpdir(),'dm-home-preview');
  fs.mkdirSync(detailsOutput,{recursive:true});
  const linksCapture = await send('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(path.join(detailsOutput,'details-links.png'),Buffer.from(linksCapture.result.data,'base64'));
  await evaluate(`document.querySelector('[data-details-tab="metadata"]').click()`);
  const metadataCapture = await send('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(path.join(detailsOutput,'details-metadata.png'),Buffer.from(metadataCapture.result.data,'base64'));
  await evaluate(`(()=>{const theme=document.querySelector('.ws-theme-select');theme.value='light';theme.dispatchEvent(new Event('change'));})()`);
  const lightDetailsCapture = await send('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(path.join(detailsOutput,'details-metadata-light.png'),Buffer.from(lightDetailsCapture.result.data,'base64'));
  await send('Emulation.setDeviceMetricsOverride',{width:820,height:900,deviceScaleFactor:1,mobile:false});
  assert.equal(await evaluate(`(()=>{const panel=document.querySelector('.note-details-panel');const host=document.querySelector('.note-workarea');return panel.getBoundingClientRect().right<=host.getBoundingClientRect().right && panel.querySelector('.note-details-content').scrollWidth<=panel.querySelector('.note-details-content').clientWidth;})()`),true);
  await send('Emulation.clearDeviceMetricsOverride');
  await evaluate(`(()=>{const theme=document.querySelector('.ws-theme-select');theme.value='dark';theme.dispatchEvent(new Event('change'));})()`);
  await evaluate(`document.querySelector('[data-details-tab="links"]').click();document.querySelector('[data-details-path="关联笔记.md"]').click()`);
  await waitFor(() => evaluate(`document.querySelector('.ws-doc-name')?.textContent==='关联笔记.md'`), {process:electron});
  assert.equal(await evaluate(`document.querySelector('.ws-note-metadata')?.textContent.includes('标签')`), true);
  await checkSidebar();
  await evaluate(`${appearanceRow('双链主笔记.md')}.querySelector('[data-action="tree-open"]').click()`);
  await popout();
  const detailsDocument = await waitFor(() => documentTarget('双链主笔记.md'), {process:electron});
  await switchTo(detailsDocument);
  await waitFor(() => evaluate(`document.querySelectorAll('.note-details-rail button').length===2`), {process:electron});
  await evaluate(`document.querySelector('[data-details-tab="metadata"]').click()`);
  await evaluate(`(()=>{const input=document.querySelector('[data-details-yaml]');input.value+=${JSON.stringify('\nstatus: reviewing')};input.dispatchEvent(new Event('input'));})()`);
  await waitFor(() => fs.readFileSync(path.join(activeRoot,'双链主笔记.md'),'utf8').includes('status: reviewing'), {process:electron});
  assert.equal(detailsModel.splitMetadata(fs.readFileSync(path.join(activeRoot,'双链主笔记.md'),'utf8')).body, detailsEditedBody);
  await evaluate(`document.querySelector('[data-details-tab="links"]').click()`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('[data-details-path="关联笔记.md"]'))`), {process:electron});
  await evaluate(`document.querySelector('[data-details-path="关联笔记.md"]').click()`);
  await waitFor(() => documentTarget('关联笔记.md'), {process:electron});
  await closeDocument('关联笔记.md');
  await closeDocument('双链主笔记.md');
  for (const type of ['blank','note','daily','meeting','project','person']) {
    await evaluate(`document.querySelector('[data-action="home-new"][data-value="${type}"]').click()`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('[data-home-create]'))`), {process:electron});
    await evaluate(`(()=>{const form=document.querySelector('[data-home-create]'); form.elements.title.value='主页测试-${type}';form.requestSubmit();})()`);
    await popout();
    const doc = await waitFor(() => documentTarget('主页测试-'+type+'.md'), {process:electron});
    const file = await evaluate(`window.lumen.workspace.list().then(result=>window.DMNotesHome.filesFromTree(result.tree).find(file=>file.name==='主页测试-${type}.md'))`);
    paths.push(file.path);
    assert.equal(file.createdAtSource, 'metadata');
    assert.match(fs.readFileSync(path.join(activeRoot,file.path),'utf8'), new RegExp('主页测试-'+type));
    await switchTo(doc);
    await waitFor(() => evaluate(`Boolean(document.querySelector('.cm-content'))`), {process:electron});
    await evaluate(`document.querySelector('[data-mode="source"]').click();document.querySelector('.cm-content').focus()`);
    await send('Input.dispatchKeyEvent', {type:'keyDown',key:'End',code:'End',modifiers:2});
    await send('Input.insertText', {text:'\n正文检索专用 home-body-needle-'+type+'\n'});
    await closeDocument('主页测试-'+type+'.md');
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
  await popout();
  await closeDocument('主页测试-meeting.md');
  await evaluate(`document.querySelector('[data-action="notes-home"]').click()`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('.notes-home'))`), {process:electron});
  await evaluate(`(()=>{const input=document.querySelector('[data-home-search]');input.value='home-body-needle-note';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-action="home-fulltext"]').click();})()`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('[data-palette-path]'))`), {process:electron});
  assert.equal(await evaluate(`document.querySelector('.ws-palette-list').textContent.includes('home-body-needle-note')`), true);
  await evaluate(`document.querySelector('[data-palette-path]').click()`);
  await popout();
  await closeDocument('主页测试-note.md');
  await evaluate(`location.reload()`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('.notes-home')) && !document.querySelector('.ws-editor')`), {process:electron});
  await checkSidebar();
  assert.equal(await evaluate(`${appearanceRow(appearancePath)}.querySelector('.tree-icon').textContent`), '👩🏽‍💻');
  assert.equal(await evaluate(`${appearanceRow(appearancePath)}.style.getPropertyValue('--note-bg')`), '#f4e9dd');
  assert.equal(await evaluate(`document.querySelector('[data-action="home-open"][data-path="${appearancePath}"] .notes-home-note-icon').textContent`), '👩🏽‍💻');
  await evaluate(`document.querySelector('[data-action="section"][data-value="tasks"]').click()`);
  await waitFor(() => evaluate(`!document.querySelector('.notes-home')`), {process:electron});
  await evaluate(`document.querySelector('[data-action="section"][data-value="notes"]').click()`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('.notes-home'))`), {process:electron});
  await checkSidebar();
  await evaluate(`(()=>{document.querySelector('.ws-vault-options > summary').click();const select=document.querySelector('.ws-vault-select');select.value=${JSON.stringify(fs.realpathSync(secondVault))};select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await waitFor(() => evaluate(`document.querySelector('.ws-vault-path')?.title===${JSON.stringify(fs.realpathSync(secondVault))} && !document.getElementById('root').inert`), {process:electron});
  assert.equal(await evaluate(`document.querySelector('.notes-home-stats strong').textContent`), '1篇');
  assert.equal(await evaluate(`document.querySelector('.notes-home-results').textContent.includes('主页测试')`), false);
  assert.equal(await evaluate(`${appearanceRow('工作资料')}.style.getPropertyValue('--note-accent')`), '');
  await checkSidebar();
  await evaluate(`(()=>{document.querySelector('.ws-vault-options > summary').click();const select=document.querySelector('.ws-vault-select');select.value=${JSON.stringify(activeRoot)};select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await waitFor(() => evaluate(`document.querySelector('.ws-vault-path')?.title===${JSON.stringify(activeRoot)} && !document.getElementById('root').inert`), {process:electron});
  await checkSidebar();
  const output = process.env.DM_HOME_SCREENSHOT_DIR || path.join(os.tmpdir(),'dm-home-preview');
  fs.mkdirSync(output,{recursive:true});
  for(const theme of ['dark','light']) {
    await evaluate(`(()=>{const select=document.querySelector('.ws-theme-select');select.value='${theme}';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    await checkSidebar();
    const capture=await send('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(path.join(output,theme+'.png'),Buffer.from(capture.result.data,'base64'));
    await openAppearance(appearancePath);
    const appearanceCapture = await send('Page.captureScreenshot', {format:'png'});
    fs.writeFileSync(path.join(output, 'appearance-'+theme+'.png'), Buffer.from(appearanceCapture.result.data,'base64'));
    await evaluate(`document.querySelector('[data-appearance-cancel]').click()`);
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
  await openAppearance(appearancePath);
  assert.equal(await evaluate(`(()=>{const form=document.querySelector('.ws-appearance-dialog');const rect=form.getBoundingClientRect();return rect.left>=0 && rect.right<=innerWidth && form.scrollWidth<=form.clientWidth;})()`), true);
  await evaluate(`document.querySelector('[data-appearance-reset]').click()`);
  await saveAppearance();
  assert.equal(await evaluate(`${appearanceRow(appearancePath)}.querySelector('.tree-icon').textContent`), '');
  assert.equal(await evaluate(`${appearanceRow(appearancePath)}.style.getPropertyValue('--note-accent')`), '');
  assert.equal(await evaluate(`${appearanceRow(appearancePath)}.style.getPropertyValue('--note-bg')`), '');
  assert.equal(await evaluate(`${appearanceRow('工作资料')}.querySelector('.tree-icon').textContent`), '💼');
  // Restart the real process with the same userData, beyond a renderer reload.
  socket.close();
  await stop(electron);
  const restarted = start('Electron restart', appExecutable, appArgs, {
    DM_E2E_ROOT: root, DM_E2E_PORT: String(debugPort), DM_E2E_SERVER_PORT: String(serverPort),
  });
  const reopened = await waitFor(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
    return targets.find(item => item.type === 'page' && !item.url.includes('#workspace') && (item.url.includes(`127.0.0.1:${serverPort}`) || item.url.startsWith('file:') && item.url.includes('/index.html')));
  }, {process:restarted});
  await connect(reopened.webSocketDebuggerUrl);
  await waitFor(() => evaluate(`Boolean(window.lumen)`), {process:restarted});
  await evaluate(`window.lumen.openWorkspace('notes')`);
  const reopenedWorkspace = await waitFor(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
    return targets.find(item => item.type === 'page' && item.url.includes('#workspace'));
  }, {process:restarted});
  await switchTo(reopenedWorkspace);
  await waitFor(() => evaluate(`Boolean(document.querySelector('.notes-home'))`), {process:restarted});
  await checkSidebar();
  assert.equal(await evaluate(`${appearanceRow('工作资料')}.style.getPropertyValue('--note-bg')`), '#e6effb');
  assert.equal(await evaluate(`${appearanceRow(appearancePath)}.style.getPropertyValue('--note-bg')`), '');
  console.log('PASS notes home, document details and appearance: metadata auto-save, body/BOM/CRLF preservation, invalid YAML, draft retention, incoming/outgoing links and navigation in both editors; sidebar resizing, themes, vault switching and process restart. Screenshots: '+output);
} finally {
  try { socket?.close(); } catch {}
  for (const record of children.reverse()) await stop(record);
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
}
