import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const cwd = path.resolve(import.meta.dirname, "..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dm-note-ai-e2e-"));
const children = [];
const sockets = [];
const requests = [];
const screenshots = [];
const screenshotDirectory = process.env.DM_NOTE_AI_SCREENSHOT_DIR && path.resolve(process.env.DM_NOTE_AI_SCREENSHOT_DIR);
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


const original = '---\ntitle: 当前记录\ntags: [测试]\n---\n# 会议记录\n\n待补充方案。\n';
const answer = '## 会议结论\n\n**预算三万元**，周五补迁移计划。[N2]';
try {
  mock = http.createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const payload = JSON.parse(raw); requests.push(payload);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const question = JSON.parse(payload.messages.at(-1).content).question;
    if (question.includes('失败')) { response.end('data: '+JSON.stringify({error:{message:'模拟失败'}})+'\n\n'); return; }
    let offset = 0;
    const timer = setInterval(() => {
      response.write('data: '+JSON.stringify({choices:[{delta:{content:answer.slice(offset,offset+8)}}]})+'\n\n'); offset += 8;
      if (offset >= answer.length) { clearInterval(timer); response.end('data: [DONE]\n\n'); }
    }, question.includes('停止') ? 150 : 20);
    response.once('close', () => clearInterval(timer));
  });
  await new Promise(resolve => mock.listen(0,'127.0.0.1',resolve));
  const mockPort = mock.address().port;
  const [serverPort,debugPort] = await Promise.all([freePort(), freePort()]);
  const vault = path.join(root,'documents','NoteVault'), other = path.join(root,'另一个库');
  const configDirectory = path.join(root,'app-data','DanceMonkey');
  fs.mkdirSync(vault,{recursive:true}); fs.mkdirSync(other); fs.mkdirSync(configDirectory,{recursive:true});
  fs.mkdirSync(path.join(vault,'迁移目标'));
  fs.mkdirSync(path.join(vault,'资料')); fs.mkdirSync(path.join(vault,'70_Finance'));
  fs.writeFileSync(path.join(vault,'当前.md'),original);
  fs.writeFileSync(path.join(vault,'资料','参考.md'),'# 项目方案\n预算三万元，周五完成。');
  fs.writeFileSync(path.join(vault,'未选中.md'),'这篇不应发送');
  fs.writeFileSync(path.join(vault,'70_Finance','秘密.md'),'禁止发送');
  fs.writeFileSync(path.join(other,'参考.md'),'B 库不同内容');
  fs.writeFileSync(path.join(other,'当前.md'),'B 库同名笔记内容');
  fs.writeFileSync(path.join(configDirectory,'config.json'),JSON.stringify({ notesRootPath:vault, notesVaults:[{root:vault,name:'工作库'},{root:other,name:'个人库'}], apiKey:'dm-local-e2e-dummy', apiEndpoint:`http://127.0.0.1:${mockPort}/v1/chat/completions`, model:'local-e2e' }));
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
  const launch = () => start("Electron", path.join(cwd, "node_modules/.bin/electron"), [root], {
    DM_E2E_ROOT: root, DM_E2E_PORT: String(debugPort), DM_E2E_SERVER_PORT: String(serverPort),
    HTTP_PROXY: "", HTTPS_PROXY: "", http_proxy: "", https_proxy: "", ALL_PROXY: "", all_proxy: "",
  });
  let electron = launch();
  const targets = async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).filter((item) => item.type === "page" && item.url.includes(`127.0.0.1:${serverPort}`));
  const target = await waitFor(async () => (await targets())[0], { process: electron });
  const overlay = await connect(target.webSocketDebuggerUrl);
  await waitFor(() => overlay.evaluate("Boolean(window.lumen)"), { process: electron });

  await overlay.evaluate('window.lumen.openWorkspace("notes")');
  const targetWorkspace = await waitFor(async () => (await targets()).find(item => item.url.includes('#workspace')), {process:electron});
  const workspace = await connect(targetWorkspace.webSocketDebuggerUrl);
  let client = workspace;
  const ev = expression => client.evaluate(expression);
  const click = selector => ev(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const wait = fn => waitFor(fn,{process:electron});
  const question = async text => { await wait(() => ev(`document.querySelector("#nai-question") && !document.querySelector("#nai-question").disabled`)); await ev(`(()=>{const input=document.querySelector('#nai-question');input.value=${JSON.stringify(text)};input.dispatchEvent(new Event('input'));document.querySelector('.nai-composer').requestSubmit();})()`); };
  const finish = () => wait(() => ev(`!document.querySelector('[data-nai="stop"]') && !!document.querySelector('[data-nai="preview"]')`));
  await wait(() => ev(`!!document.querySelector('[data-action="home-open"][data-path="当前.md"]')`));
  await click('[data-action="home-open"][data-path="当前.md"]');
  await wait(() => ev(`!!document.querySelector('[data-details-tab="ai"]')`));
  await click('[data-details-tab="ai"]');
  await click('[data-nai="mention"]');
  await wait(() => ev(`!!document.querySelector('[data-nai="pick"]')`));
  assert.doesNotMatch(await ev(`document.querySelector('.nai-picker').textContent`),/秘密/);
  await ev(`(()=>{const input=document.querySelector('#nai-question');input.value='@参考';input.setSelectionRange(3,3);input.dispatchEvent(new Event('input'));})()`);
  await wait(() => ev(`document.querySelector('[data-nai="pick"]')?.textContent.includes('资料/参考.md')`));
  await click('[data-nai="pick"]');
  assert.match(await ev(`document.querySelector('.nai-references').textContent`),/参考/);
  await question('请结合参考资料总结当前笔记'); await finish();
  const context = JSON.parse(requests[0].messages.at(-1).content);
  assert.equal(context.sources.length,2); assert.equal(context.sources[0].text,original);
  assert.equal(context.sources[1].path,'资料/参考.md'); assert.doesNotMatch(JSON.stringify(requests[0]),/这篇不应发送|禁止发送/);
  assert.ok(await ev(`!!document.querySelector('.nai-message.assistant strong')`));
  await screenshot(client,'1-note-ai-answer');
  await click('[data-nai="preview"]');
  await wait(() => ev(`!!document.querySelector('.nai-preview[open]')`));
  assert.match(decodeURI(await ev(`document.querySelector('[data-nai-after]').textContent`)),/参考.*资料\//);
  assert.equal(fs.readFileSync(path.join(vault,'当前.md'),'utf8'),original,'preview does not write');
  await screenshot(client,'2-note-ai-preview');
  await click('[data-nai-cancel]'); assert.equal(fs.readFileSync(path.join(vault,'当前.md'),'utf8'),original);
  await click('[data-nai="preview"]');
  await ev(`document.querySelector('.nai-preview form').requestSubmit()`);
  await wait(() => fs.readFileSync(path.join(vault,'当前.md'),'utf8').includes('会议结论'));
  await wait(() => ev(`document.querySelector('[data-nai-status]')?.textContent.includes('已写入并保存')`));
  const appended = fs.readFileSync(path.join(vault,'当前.md'),'utf8');
  assert.ok(appended.startsWith(original));
  // The editor's native undo / redo treats the AI insertion as one transaction.
  await click('[data-md-command="undo"]');
  await wait(() => fs.readFileSync(path.join(vault,'当前.md'),'utf8') === original);
  await click('[data-md-command="redo"]');
  await wait(() => fs.readFileSync(path.join(vault,'当前.md'),'utf8') === appended);
  await click('[data-nai="undo"]');
  await wait(() => fs.readFileSync(path.join(vault,'当前.md'),'utf8') === original);
  // Replacement preserves frontmatter and is previewed explicitly.
  await click('[data-nai="preview"]');
  await ev(`(()=>{const select=document.querySelector('.nai-preview select');select.value='body';select.dispatchEvent(new Event('change'));document.querySelector('.nai-preview form').requestSubmit();})()`);
  await wait(() => fs.readFileSync(path.join(vault,'当前.md'),'utf8').includes('会议结论'));
  assert.ok(fs.readFileSync(path.join(vault,'当前.md'),'utf8').startsWith('---\ntitle: 当前记录\ntags: [测试]\n---\n'));
  assert.doesNotMatch(fs.readFileSync(path.join(vault,'当前.md'),'utf8'),/待补充/);
  await click('[data-nai="undo"]'); await wait(() => fs.readFileSync(path.join(vault,'当前.md'),'utf8') === original);
  // A disk edit during preview blocks the write without touching either version.
  await click('[data-nai="preview"]'); fs.writeFileSync(path.join(vault,'当前.md'),original+'外部编辑');
  await ev(`document.querySelector('.nai-preview form').requestSubmit()`);
  await wait(() => ev(`document.querySelector('[data-nai-error]')?.textContent.includes('其他位置修改')`));
  assert.equal(fs.readFileSync(path.join(vault,'当前.md'),'utf8'),original+'外部编辑');
  await click('[data-nai-cancel]'); fs.writeFileSync(path.join(vault,'当前.md'),original);
  // Source mode uses the same flow and keeps an unsaved selection in the request.
  await click('[data-action="view"][data-value="edit"]');
  await wait(() => ev(`!!document.querySelector('.ws-editor')`));
  if (!await ev(`!!document.querySelector('#nai-question')`)) await click('[data-details-tab="ai"]');
  const draft = original+'未保存选段';
  await ev(`(()=>{const editor=document.querySelector('.ws-editor');editor.value=${JSON.stringify(draft)};editor.setSelectionRange(${original.length},${draft.length});editor.dispatchEvent(new Event('input'));const input=document.querySelector('#nai-question');input.value='改写选段';input.dispatchEvent(new Event('input'));document.querySelector('.nai-composer').requestSubmit();})()`);
  await wait(() => requests.length === 2); await finish();
  assert.equal(JSON.parse(requests[1].messages.at(-1).content).sources[0].text,draft);
  assert.equal(JSON.parse(requests[1].messages.at(-1).content).selectedText,'未保存选段');
  await ev(`[...document.querySelectorAll('[data-nai="preview"]')].at(-1).click()`);
  await ev(`(()=>{const select=document.querySelector('.nai-preview select');select.value='selection';select.dispatchEvent(new Event('change'));document.querySelector('.nai-preview form').requestSubmit();})()`);
  await wait(() => fs.readFileSync(path.join(vault,'当前.md'),'utf8').includes('会议结论'));
  assert.ok(fs.readFileSync(path.join(vault,'当前.md'),'utf8').startsWith(original));
  await click('[data-nai="undo"]'); await wait(() => fs.readFileSync(path.join(vault,'当前.md'),'utf8') === draft);
  // Stale preview detection retains intervening editor changes.
  await ev(`[...document.querySelectorAll('[data-nai="preview"]')].at(-1).click()`);
  await ev(`(()=>{const editor=document.querySelector('.ws-editor');editor.value+='后续编辑';editor.dispatchEvent(new Event('input'));document.querySelector('.nai-preview form').requestSubmit();})()`);
  await wait(() => ev(`document.querySelector('[data-nai-error]')?.textContent.includes('预览后已变化')`));
  await click('[data-nai-cancel]');
  await question('模拟失败'); await wait(() => ev(`document.querySelector('[data-nai-status]')?.textContent.includes('模拟失败')`));
  assert.equal(await ev(`document.querySelector('#nai-question').value`),'模拟失败');
  await question('请停止这个回答'); await wait(() => ev(`document.querySelector('[data-nai-stream]')?.textContent.startsWith('##') || document.querySelector('[data-nai-stream]')?.textContent.includes('会议')`));
  await click('[data-nai="stop"]'); await wait(() => ev(`!document.querySelector('[data-nai="stop"]')`));
  assert.match(await ev(`document.querySelector('.nai-messages').textContent`), /未完整生成/);
  // Independent windows retain their vault after the main workspace switches.
  await click('[data-action="popout-note"]');
  const docTarget = await wait(async () => (await targets()).find(item => item.url.includes('#document')));
  const doc = await connect(docTarget.webSocketDebuggerUrl); client = doc;
  await wait(() => ev(`!!document.querySelector('[data-details-tab="ai"]')`));
  await click('[data-details-tab="ai"]');
  await wait(() => ev(`!document.querySelector('#nai-question')?.disabled`));
  assert.match(await ev(`document.querySelector('.nai-messages').textContent`), /改写选段/);
  assert.match(await ev(`document.querySelector('.nai-references').textContent`), /参考/);
  await click('[data-nai="remove"]');
  await workspace.evaluate(`window.lumen.vaults.select(${JSON.stringify(other)})`);
  await click('[data-nai="mention"]'); await wait(() => ev(`!!document.querySelector('[data-nai="pick"]')`));
  assert.match(await ev(`document.querySelector('.nai-picker').textContent`),/资料\/参考.md/);
  await ev(`(()=>{const input=document.querySelector('#nai-question');input.value='@参考';input.setSelectionRange(3,3);input.dispatchEvent(new Event('input'));})()`);
  await wait(() => ev(`document.querySelector('[data-nai="pick"]')?.textContent.includes('资料/参考.md')`));
  await click('[data-nai="pick"]');
  const before = requests.length; await question('独立窗口总结'); await wait(() => requests.length > before); await finish();
  assert.match(JSON.stringify(requests.at(-1)),/三万元/); assert.doesNotMatch(JSON.stringify(requests.at(-1)),/B 库不同内容/);
  const docBefore = fs.readFileSync(path.join(vault,'当前.md'),'utf8');
  await click('[data-nai="preview"]'); await ev(`document.querySelector('.nai-preview form').requestSubmit()`);
  await wait(() => fs.readFileSync(path.join(vault,'当前.md'),'utf8') !== docBefore);
  await click('[data-nai="undo"]'); await wait(() => fs.readFileSync(path.join(vault,'当前.md'),'utf8') === docBefore);
  assert.equal(fs.readFileSync(path.join(other,'参考.md'),'utf8'),'B 库不同内容');
  await screenshot(client,'3-independent-note-ai');
  const crlf = await ev(`(()=>{const host=document.createElement('div');document.getElementById('root').append(host);const cm=window.DMMarkdownEditor(host,{content:'前面\\r\\n选中\\r\\n后面',onChange:()=>{},onSave:()=>{}});cm.view.dispatch({selection:{anchor:3,head:5}});const range=cm.selection();cm.applyEdit({base:cm.text(),from:range.from,to:range.to,insert:'替换\\r\\n两行'});const after=cm.text();cm.command('undo');const undone=cm.text();cm.destroy();host.remove();return {range,after,undone};})()`);
  assert.deepEqual(crlf.range,{from:4,to:6}); assert.equal(crlf.after,'前面\r\n替换\r\n两行\r\n后面'); assert.equal(crlf.undone,'前面\r\n选中\r\n后面');
  // Verify the same sidebar and preview remain usable at the minimum document width.
  await client.send('Emulation.setDeviceMetricsOverride',{width:700,height:640,deviceScaleFactor:1,mobile:false});
  await click('[data-nai="preview"]'); await screenshot(client,'4-compact-preview');
  assert.ok(await ev(`(()=>{const rect=document.querySelector('.nai-preview').getBoundingClientRect();return rect.left>=0 && rect.right<=innerWidth && rect.height<=innerHeight;})()`));
  await click('[data-nai-cancel]');


  // Give an identically named note in B a different conversation before restarting.
  const firstRoot = fs.realpathSync(vault), secondRoot = fs.realpathSync(other);
  client = workspace;
  await wait(() => ev(`!!document.querySelector('[data-action="home-open"][data-path="当前.md"]')`));
  await click('[data-action="home-open"][data-path="当前.md"]');
  await wait(() => ev(`!!document.querySelector('[data-details-tab="ai"]')`));
  await click('[data-details-tab="ai"]');
  await wait(() => ev(`document.querySelector('#nai-question') && !document.querySelector('#nai-question').disabled`));
  assert.equal(await ev(`document.querySelectorAll('.nai-message').length`), 0);
  await question('B 库的独立问题'); await finish();
  assert.doesNotMatch(JSON.stringify(requests.at(-1)), /独立窗口总结|改写选段/);
  assert.match(JSON.stringify(requests.at(-1)), /B 库同名笔记内容/);
  async function restartApp(notePath = '当前.md', whileStopped = () => {}) {
    await ev(`setTimeout(()=>void window.lumen.quitApp(),50); true`);
    await waitFor(() => electron.exited, {timeout:20000});
    whileStopped();
    electron = launch();
    const overlayTarget = await wait(async () => (await targets())[0]);
    const boot = await connect(overlayTarget.webSocketDebuggerUrl);
    await wait(() => boot.evaluate('Boolean(window.lumen)'));
    await boot.evaluate('window.lumen.openWorkspace("notes")');
    const target = await wait(async () => (await targets()).find(item => item.url.includes('#workspace')));
    client = await connect(target.webSocketDebuggerUrl);
    const selector = `[data-action="home-open"][data-path=${JSON.stringify(notePath)}]`;
    await wait(() => ev(`!!document.querySelector(${JSON.stringify(selector)})`));
    await click(selector);
    await wait(() => ev(`!!document.querySelector('[data-details-tab="ai"]')`));
    await click('[data-details-tab="ai"]');
    await wait(() => ev(`document.querySelector('#nai-question') && !document.querySelector('#nai-question').disabled`));
  }
  await restartApp();
  assert.match(await ev(`document.querySelector('.nai-messages').textContent`), /B 库的独立问题/);
  assert.doesNotMatch(await ev(`document.querySelector('.nai-messages').textContent`), /改写选段/);
  await ev(`window.lumen.vaults.select(${JSON.stringify(firstRoot)})`);
  await wait(() => ev(`!!document.querySelector('[data-action="home-open"][data-path="当前.md"]')`));
  await click('[data-action="home-open"][data-path="当前.md"]');
  await wait(() => ev(`!!document.querySelector('[data-details-tab="ai"]')`));
  await click('[data-details-tab="ai"]');
  await wait(() => ev(`document.querySelector('#nai-question') && !document.querySelector('#nai-question').disabled`));
  assert.match(await ev(`document.querySelector('.nai-messages').textContent`), /独立窗口总结/);
  assert.match(await ev(`document.querySelector('.nai-messages').textContent`), /未完整生成/);
  assert.doesNotMatch(await ev(`document.querySelector('.nai-messages').textContent`), /B 库的独立问题/);
  assert.match(await ev(`document.querySelector('.nai-references').textContent`), /参考/);
  await question('重启后继续这个话题'); await finish();
  assert.match(JSON.stringify(requests.at(-1).messages.slice(1,-1)), /独立窗口总结/);
  assert.ok(await ev(`(()=>{const box=document.querySelector('.nai-messages');return box.scrollTop+box.clientHeight>=box.scrollHeight-2;})()`), 'restored conversation opens at its latest turn');
  await screenshot(client,'5-restored-conversation');

  // Move through the actual rename dialog, then rename its parent folder.
  async function relocateFromTree(from, name, parent, expected) {
    const selector = `.tree-row[data-path=${JSON.stringify(from)}] [data-action="rename"]`;
    await click(selector);
    await wait(() => ev(`!!document.querySelector('.ws-parent-select')`));
    await ev(`(()=>{document.querySelector('.ws-dialog-input').value=${JSON.stringify(name)};document.querySelector('.ws-parent-select').value=${JSON.stringify(parent)};document.querySelector('[data-dialog="confirm"]').click();})()`);
    await wait(() => ev(`document.querySelector('.note-file-path')?.textContent.endsWith(${JSON.stringify(expected)})`));
    if (!await ev(`!!document.querySelector('#nai-question')`)) await click('[data-details-tab="ai"]');
    await wait(() => ev(`document.querySelector('#nai-question') && !document.querySelector('#nai-question').disabled`));
    assert.match(await ev(`document.querySelector('.nai-messages').textContent`), /重启后继续这个话题/);
  }
  await relocateFromTree('当前.md','新名字.md','迁移目标','迁移目标/新名字.md');
  await relocateFromTree('迁移目标','项目归档','','项目归档/新名字.md');
  await ev(`window.lumen.workspace.createFile('', '当前.md')`);
  const emptyOldPath = await ev(`window.lumen.noteAi.history({root:${JSON.stringify(firstRoot)},path:'当前.md'})`);
  assert.equal(emptyOldPath.messages.length,0,'a new note at the old path must not inherit the moved conversation');
  await question('移动后继续讨论'); await finish();
  assert.match(JSON.stringify(requests.at(-1).messages.slice(1,-1)), /重启后继续这个话题/);
  assert.equal(JSON.parse(requests.at(-1).messages.at(-1).content).sources[0].path,'项目归档/新名字.md');
  await restartApp('项目归档/新名字.md');
  assert.match(await ev(`document.querySelector('.nai-messages').textContent`), /移动后继续讨论/);
  // Simulate Finder / Explorer moves while the application is fully stopped.
  await restartApp('系统移动/新名字.md', () => {
    fs.renameSync(path.join(vault,'项目归档'),path.join(vault,'系统移动'));
    fs.renameSync(path.join(vault,'资料'),path.join(vault,'系统资料'));
  });
  assert.match(await ev(`document.querySelector('.nai-messages').textContent`), /移动后继续讨论/);
  await question('系统移动后续聊'); await finish();
  const relocatedSources = JSON.parse(requests.at(-1).messages.at(-1).content).sources;
  assert.equal(relocatedSources[0].path,'系统移动/新名字.md');
  assert.equal(relocatedSources[1].path,'系统资料/参考.md');
  await screenshot(client,'6-relocated-conversation');
  await click('[data-nai="clear"]');
  await wait(() => ev(`document.querySelectorAll('.nai-message').length === 0 && !document.querySelector('#nai-question').disabled`));
  await restartApp('系统移动/新名字.md');
  assert.equal(await ev(`document.querySelectorAll('.nai-message').length`), 0, 'cleared history stays empty after another app restart');
  await ev(`window.lumen.vaults.select(${JSON.stringify(secondRoot)})`);
  const preserved = await ev(`window.lumen.noteAi.history({root:${JSON.stringify(secondRoot)},path:'当前.md'})`);
  assert.equal(preserved.messages.length, 2, 'clearing A never removes B history');
  console.log('PASS durable note AI history: app/file/folder relocation, external filesystem moves, old-path reuse, four real app restarts, follow-up context, restored references and partial answers, same-name vault isolation, durable clear.');
  console.log('PASS note AI: explicit references, unsaved text, streaming, preview/cancel, append/body/selection, native undo/redo, disk and local conflicts, error/stop, independent window vault isolation.');
} finally {
  for (const socket of sockets) try { socket.close(); } catch {}
  for (const child of children.reverse()) await stop(child);
  mock?.closeAllConnections(); await new Promise(resolve => mock ? mock.close(resolve) : resolve());
  fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
