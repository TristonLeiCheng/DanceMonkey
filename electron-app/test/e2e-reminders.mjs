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
const evidence = process.env.DM_REMINDER_QA_OUTPUT || path.join(cwd, 'docs');
fs.mkdirSync(evidence, { recursive: true });
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
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP request timed out: ${method}`)); }, 20000);
    pending.set(id, (response) => { clearTimeout(timeout); resolve(response); });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const response = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }).catch(error => { throw new Error(`${error.message}: ${expression}`); });
    if (response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.text);
    return response.result?.result?.value;
  };

  await evaluate(`window.lumen.openWorkspace("reminders")`);
  const targets = () => fetch(`http://127.0.0.1:${debugPort}/json`).then(result => result.json());
  const workspace = await waitFor(async () => (await targets()).find(item => item.url.includes('#workspace/reminders')), { process: electron });
  socket.close(); await connect(workspace.webSocketDebuggerUrl);
  await waitFor(() => evaluate(`document.querySelectorAll('.reminder-card').length === 2`), { process: electron });
  assert.equal(await evaluate(`document.querySelector('[data-action="section"][data-value="reminders"]').classList.contains('active')`), true);
  assert.equal(await evaluate(`document.querySelector('[name="reminder-default-style"]').value`),'PetBubble');
  assert.equal(await evaluate(`document.querySelector('[name="reminder-default-style"] option[value="PetBubble"]').textContent`),'宠物提醒');
  assert.equal(await evaluate(`document.querySelector('[name="reminder-default-style"]').options.length`),7);
  await evaluate(`document.querySelector('[name="reminder-default-style"]').value='Toast';document.querySelector('[data-reminder-action="settings"]').click()`);
  await waitFor(()=>evaluate(`document.querySelector('[name="reminder-default-style"]').value==='Toast' && document.querySelectorAll('.reminder-meta').length===2 && [...document.querySelectorAll('.reminder-meta')].every(n=>n.textContent.includes('右下角 Toast'))`));
  await evaluate(`document.querySelector('[name="reminder-default-style"]').value='PetBubble';document.querySelector('[data-reminder-action="settings"]').click()`);
  await waitFor(()=>evaluate(`document.querySelector('[name="reminder-default-style"]').value==='PetBubble' && [...document.querySelectorAll('.reminder-meta')].every(n=>n.textContent.includes('宠物提醒'))`));
  await evaluate(`document.querySelector('[data-reminder-action="new"]').click()`);
  await waitFor(() => evaluate(`!!document.querySelector('[data-reminder-form]')`));
  await evaluate(`(() => {const f=document.querySelector('[data-reminder-form]'); f.elements.title.value='桌面弹窗测试'; f.elements.message.value='提醒正文 <script>安全文本</script>'; f.elements.kind.value='Daily'; f.elements.kind.dispatchEvent(new Event('change')); })()`);
  assert.equal(await evaluate(`document.querySelector('[data-reminder-form] [name="title"]').value`), '桌面弹窗测试');
  assert.equal(await evaluate(`document.querySelector('[data-reminder-form] [name="notifyStyle"]').value`),'Default');
  await evaluate(`document.querySelector('[data-reminder-form] [name="times"]').value='09:00, 14:00'; document.querySelector('[data-reminder-form] [name="enabled"]').checked=false; document.querySelector('[data-reminder-action="save"]').click()`);
  await waitFor(() => evaluate(`document.querySelectorAll('.reminder-card').length === 3 && !document.querySelector('[data-reminder-form]')`));
  const id = await evaluate(`window.lumen.reminders.list().then(data=>data.reminders.find(item=>item.title==='桌面弹窗测试').id)`);
  for (const style of ['GlassCard','Circular','DynamicIsland','Toast','Banner','Compact']) {
    await evaluate(`window.lumen.reminders.saveSettings({defaultPopupStyle:${JSON.stringify(style)},acrylic:true})`);
    await evaluate(`window.lumen.reminders.test(${JSON.stringify(id)})`);
    const popup = await waitFor(async () => (await targets()).find(item=>item.url.endsWith('/electron/ui/reminder.html')));
    socket.close(); await connect(popup.webSocketDebuggerUrl);
    await waitFor(() => evaluate(`document.body.classList.contains(${JSON.stringify(style)}) && document.querySelector('h1').textContent.includes('桌面弹窗测试')`));
    assert.equal(await evaluate(`document.querySelector('p').textContent`), '提醒正文 <script>安全文本</script>');
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.card')).borderTopWidth`), '0px');
    assert.equal(await evaluate(`getComputedStyle(document.documentElement).backgroundColor`), 'rgba(0, 0, 0, 0)');
    if (style === 'DynamicIsland') {
      assert.equal(await evaluate(`document.querySelector('.card').classList.contains('collapsed')`), true);
      assert.equal(await evaluate(`document.querySelector('.card').getBoundingClientRect().top`), 0);
      const collapsed = await send('Page.captureScreenshot', {format:'png'});
      fs.writeFileSync(path.join(evidence, 'reminder-dynamicisland-collapsed-preview.png'), Buffer.from(collapsed.result.data, 'base64'));
      await evaluate(`document.querySelector('.card').click()`);
      await waitFor(() => evaluate(`document.querySelector('.card').getAttribute('aria-expanded') === 'true'`));
      assert.equal(await evaluate(`document.querySelector('.card').getBoundingClientRect().top`), 0);
      await evaluate(`document.querySelector('.collapse').click()`);
      await waitFor(() => evaluate(`document.querySelector('.card').getAttribute('aria-expanded') === 'false'`));
      await evaluate(`document.querySelector('.card').click()`);
      await waitFor(() => evaluate(`document.querySelector('.card').getAttribute('aria-expanded') === 'true'`));
    }
    const screenshot = await send('Page.captureScreenshot', {format:'png'});
    fs.writeFileSync(path.join(evidence, `reminder-${style.toLowerCase()}-preview.png`), Buffer.from(screenshot.result.data,'base64'));
    await evaluate(`setTimeout(() => { void window.reminderPopup.act('done'); }, 100); true`);
    await waitFor(async () => !(await targets()).some(item=>item.id===popup.id));
    socket.close(); await connect(workspace.webSocketDebuggerUrl);
  }
  assert.equal(await evaluate(`window.lumen.reminders.list().then(data=>data.reminders.find(item=>item.id===${JSON.stringify(id)}).runtime.todayAckCount)`), 0);
  // Choose the pet delivery mode in the actual editor, then exercise its native journey.
  await evaluate(`window.lumen.settings.save({petModeEnabled:true,petAnimal:'capybara',petDisplaySize:96,petWindowX:180,petWindowY:300,petPreventSleepEnabled:false})`);
  const pet = await waitFor(async () => (await targets()).find(item=>item.url.endsWith('/pet.html')));
  await evaluate(`document.querySelector('[data-reminder-action="new"]').click()`);
  await evaluate(`(() => {const f=document.querySelector('[data-reminder-form]');f.elements.title.value='该喝水啦';f.elements.message.value='起身倒杯水，给自己补充一点水分。 <script>安全文本</script>';f.elements.icon.value='💧';f.elements.notifyStyle.value='PetBubble';f.elements.notifyStyle.dispatchEvent(new Event('change'));})()`);
  assert.equal(await evaluate(`document.querySelector('[name="title"]').value`),'该喝水啦','mode changes retain unsaved fields');
  assert.equal(await evaluate(`document.querySelector('[name="popupStyleOverride"]').closest('label').hidden`),true);
  await evaluate(`document.querySelector('[data-reminder-action="save"]').click()`);
  await waitFor(()=>evaluate(`!document.querySelector('[data-reminder-form]') && document.querySelector('.reminders-page').textContent.includes('宠物提醒')`));
  const petId = await evaluate(`window.lumen.reminders.list().then(data=>data.reminders.find(item=>item.title==='该喝水啦'&&!item.isBuiltIn).id)`);
  socket.close(); await connect(pet.webSocketDebuggerUrl);
  await waitFor(()=>evaluate(`document.querySelector('#pet').dataset.assetStatus==='ready'`));
  const home = await evaluate(`({x:screenX,y:screenY,width:innerWidth,height:innerHeight,size:96})`);
  socket.close(); await connect(workspace.webSocketDebuggerUrl);
  await evaluate(`window.lumen.reminders.test(${JSON.stringify(petId)})`);
  socket.close(); await connect(pet.webSocketDebuggerUrl);
  await waitFor(()=>evaluate(`desktopPet.get().then(s=>s.reminder?.phase==='walking')`));
  const entrySize = await evaluate(`desktopPet.get().then(s=>s.size)`);
  await sleep(1200);
  const enRoute = await evaluate(`desktopPet.get()`);
  assert.equal(enRoute.reminder.phase,'walking'); assert.ok(enRoute.size>entrySize&&enRoute.size<177.6,'pet grows gradually while walking');
  await waitFor(()=>evaluate(`desktopPet.get().then(s=>s.reminder?.phase==='presenting')`));
  await waitFor(()=>evaluate(`!document.querySelector('#pet-reminder').hidden && document.querySelector('#pet-reminder').getAnimations().every(a=>a.playState==='finished')`));
  assert.equal(await evaluate(`document.querySelector('#pet-reminder-title').textContent`),'该喝水啦');
  assert.equal(await evaluate(`document.querySelector('#pet-reminder-message').textContent`),'起身倒杯水，给自己补充一点水分。 <script>安全文本</script>');
  assert.equal(await evaluate(`document.querySelector('#pet-reminder-kind').textContent.includes('测试')`),true);
  const centered = await evaluate(`(() => {const p=document.querySelector('#pet').getBoundingClientRect(),b=document.querySelector('.pet-reminder-board').getBoundingClientRect();return {center:screenX+p.x+p.width/2,target:screen.availLeft+screen.availWidth/2,size:p.height,boardVisible:b.x>=0&&b.y>=0&&b.right<=innerWidth&&b.bottom<=innerHeight};})()`);
  assert.ok(Math.abs(centered.center-centered.target)<2); assert.ok(centered.size>home.size); assert.ok(centered.boardVisible);
  const petShot = await send('Page.captureScreenshot',{format:'png',omitBackground:true});
  fs.writeFileSync(path.join(evidence,'reminder-pet-preview.png'),Buffer.from(petShot.result.data,'base64'));
  await evaluate(`document.querySelector('#pet-reminder-done').click()`);
  await waitFor(()=>evaluate(`desktopPet.get().then(s=>!s.reminder)`));
  assert.deepEqual(await evaluate(`({x:screenX,y:screenY,width:innerWidth,height:innerHeight,size:96})`),home,'native pet returns to its exact original position/size');
  socket.close(); await connect(workspace.webSocketDebuggerUrl);
  assert.equal(await evaluate(`window.lumen.reminders.list().then(data=>data.reminders.find(item=>item.id===${JSON.stringify(petId)}).runtime.todayAckCount)`),0);
  await evaluate(`window.lumen.reminders.list().then(data=>window.lumen.reminders.test({...data.reminders.find(item=>item.id===${JSON.stringify(petId)}),title:'很长的提醒标题'.repeat(20),message:'长提醒正文'.repeat(1000)}))`);
  socket.close(); await connect(pet.webSocketDebuggerUrl);
  await waitFor(()=>evaluate(`desktopPet.get().then(s=>s.reminder?.phase==='presenting')`));
  await waitFor(()=>evaluate(`document.querySelector('#pet-reminder').getAnimations().every(a=>a.playState==='finished')`));
  assert.equal(await evaluate(`document.querySelector('#pet-reminder-message').textContent.length`),4000);
  assert.equal(await evaluate(`(()=>{const p=document.querySelector('#pet-reminder-message'),b=document.querySelector('.pet-reminder-board').getBoundingClientRect();return p.clientHeight>0&&p.scrollHeight>p.clientHeight&&b.top>=0&&b.bottom<=innerHeight})()`),true,'long messages remain readable and scroll inside the sign');
  await evaluate(`document.querySelector('#pet-reminder-done').click()`);
  await waitFor(()=>evaluate(`desktopPet.get().then(s=>!s.reminder)`));
  socket.close(); await connect(workspace.webSocketDebuggerUrl);
  // A real due reminder records an acknowledgement; a second one can be snoozed.
  const schedulePet = () => evaluate(`window.lumen.reminders.list().then(data=>window.lumen.reminders.save({...data.reminders.find(item=>item.id===${JSON.stringify(petId)}),enabled:true,schedule:{kind:'Once',onceAt:new Date(Date.now()+500).toISOString()},trigger:{skipWhenIdle:false}}))`);
  for (const action of ['done','snooze']) {
    await schedulePet();
    socket.close(); await connect(pet.webSocketDebuggerUrl);
    await waitFor(()=>evaluate(`desktopPet.get().then(s=>s.reminder?.phase==='presenting'&&!s.reminder.test)`),{timeout:35000}).catch(async error=>{
      console.error('Due reminder diagnostics',action,await evaluate('desktopPet.get()'),await targets());
      socket.close();await connect(workspace.webSocketDebuggerUrl);console.error('Reminder service state',await evaluate('window.lumen.reminders.list()'));throw error;
    });
    await evaluate(`document.querySelector(${JSON.stringify('#pet-reminder-'+(action==='done'?'done':'later'))}).click()`);
    await waitFor(()=>evaluate(`desktopPet.get().then(s=>!s.reminder)`));
    socket.close(); await connect(workspace.webSocketDebuggerUrl);
    assert.equal(await evaluate(`window.lumen.reminders.list().then(data=>data.reminders.find(item=>item.id===${JSON.stringify(petId)}).runtime.todayAckCount)`),1);
    assert.equal(await evaluate(`window.lumen.reminders.list().then(data=>data.reminders.find(item=>item.id===${JSON.stringify(petId)}).pending)`),false);
    if(action==='snooze')assert.equal(await evaluate(`window.lumen.reminders.list().then(data=>!!data.reminders.find(item=>item.id===${JSON.stringify(petId)}).runtime.snoozeUntil)`),true);
  }
  await evaluate(`(async()=>{await window.lumen.settings.save({petModeEnabled:false});await window.lumen.reminders.test(${JSON.stringify(petId)});})()`);
  const fallback = await waitFor(async ()=>(await targets()).find(item=>item.url.endsWith('/electron/ui/reminder.html')));
  socket.close(); await connect(fallback.webSocketDebuggerUrl);
  await waitFor(()=>evaluate(`document.querySelector('h1')?.textContent.includes('该喝水啦')`));
  await evaluate(`setTimeout(()=>window.reminderPopup.act('done'),100);true`);
  await waitFor(async()=>!(await targets()).some(item=>item.id===fallback.id));
  socket.close(); await connect(workspace.webSocketDebuggerUrl);
  await evaluate(`window.lumen.reminders.list().then(data=>window.lumen.reminders.save({...data.reminders.find(item=>item.id===${JSON.stringify(id)}),enabled:true,schedule:{kind:'Once',onceAt:new Date(Date.now()+500).toISOString()},trigger:{skipWhenIdle:false}}))`);
  const actual = await waitFor(async () => (await targets()).find(item=>item.url.endsWith('/electron/ui/reminder.html')), {timeout:22000});
  socket.close(); await connect(actual.webSocketDebuggerUrl);
  await waitFor(() => evaluate(`document.querySelector('h1').textContent === '桌面弹窗测试'`));
  await evaluate(`setTimeout(() => { void window.reminderPopup.act('done'); }, 100); true`);
  await waitFor(async () => !(await targets()).some(item=>item.id===actual.id));
  socket.close(); await connect(workspace.webSocketDebuggerUrl);
  await waitFor(() => evaluate(`window.lumen.reminders.list().then(data=>{const item=data.reminders.find(item=>item.id===${JSON.stringify(id)});return !item.enabled && item.runtime.todayAckCount===1 && !item.pending})`));
  await evaluate(`location.reload(); true`);
  await waitFor(() => evaluate(`document.querySelectorAll('.reminder-card').length===4`));
  assert.equal(await evaluate(`document.querySelector('.reminders-page').textContent.includes('已暂停')`),true);
  const screenshot = await send('Page.captureScreenshot', {format:'png'});
  fs.writeFileSync(path.join(evidence,'reminders-page-preview.png'),Buffer.from(screenshot.result.data,'base64'));
  console.log('Reminder E2E passed: editor delivery choice, six popup styles, native pet walk/grow/flag/return, safe content, preview isolation, actual timed pet acknowledge/snooze, disabled-pet fallback and persistence. Evidence: '+evidence);
} finally {
  try { socket?.close(); } catch {}
  for (const record of children.reverse()) await stop(record);
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
}
