import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "dm-quick-notes-e2e-"));
const cwd = path.resolve(import.meta.dirname, "..");
const appExecutable = process.env.DM_E2E_EXECUTABLE || path.resolve(cwd, 'node_modules/.bin/electron');
const appArgs = process.env.DM_E2E_EXECUTABLE ? ['--no-proxy-server', '--use-mock-keychain'] : ['--no-proxy-server', '.'];
const children = [];
const firstVault = path.join(root, "documents", "NoteVault");
fs.mkdirSync(firstVault, { recursive: true });
const configDirectory = path.join(root, "app-data", "DanceMonkey");
fs.mkdirSync(configDirectory, { recursive: true });
fs.writeFileSync(path.join(configDirectory, "config.json"), JSON.stringify({
  notesRootPath: fs.realpathSync(firstVault),
  notesVaults: [
    { root: fs.realpathSync(firstVault), name: "工作笔记库" },
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
    return targets.find((item) => item.type === "page" && !item.url.includes("#workspace") && (item.url.includes(`127.0.0.1:${serverPort}`) || item.url.startsWith('file:') && item.url.includes('/index.html')));
  }, { process: electron });

  const runtimeErrors = [];
  let serial = 0;
  const pending = new Map();
  const connect = async (url) => {
    socket = new WebSocket(url);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.method === 'Runtime.exceptionThrown') runtimeErrors.push(message.params.exceptionDetails.text);
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


  await send('Runtime.enable');
  await waitFor(() => evaluate(`Boolean(document.querySelector('[data-act="new"]'))`), { process: electron });
  await evaluate(`window.lumen.setState({ pinned: true })`);
  await evaluate(`window.lumen.setShell('panel')`);
  const labels = () => evaluate(`[...document.querySelectorAll('.note-item')].map(item => item.textContent)`);
  const expectedLabels = ['随手记', '会议要点', '临时想法'];
  assert.deepEqual(await labels(), expectedLabels);
  assert.equal(await evaluate(`document.querySelector('.quick-note-tabs').scrollWidth === document.querySelector('.quick-note-tabs').clientWidth`), true);
  const date = new Date();
  const day = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
  const selectType = async type => {
    await evaluate(`document.querySelector('[data-act="select-note-type"][data-id="${type}"]').click()`);
    await waitFor(() => evaluate(`document.querySelector('[data-act="select-note-type"][data-id="${type}"]')?.getAttribute('aria-current') === 'true' && Boolean(document.querySelector('.body-input'))`), {process:electron});
    await waitFor(() => evaluate(`document.activeElement === document.querySelector('.body-input')`), {process:electron});
  };
  const snapshot = () => evaluate(`window.lumen.getState()`);
  const currentId = () => evaluate(`document.querySelector('.body-input').dataset.id`);
  const setBody = text => evaluate(`(() => { const body=document.querySelector('.body-input'); body.value=${JSON.stringify(text)}; body.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  const waitBody = (id,text) => waitFor(() => evaluate(`window.lumen.getState().then(s => s.notes.find(n => n.id === ${JSON.stringify(id)})?.body === ${JSON.stringify(text)})`), {process:electron});
  const replaceTitle = async text => {
    await evaluate(`document.querySelector('.title-input').focus();document.querySelector('.title-input').select()`);
    for(const character of text) await send('Input.insertText',{text:character});
  };
  const findSaved = async id => (await snapshot()).notes.find(note=>note.id===id);
  const assertFolder = note => assert.equal(path.basename(path.dirname(note.filePath)), ({quick:'随手记',meeting:'会议要点',idea:'临时想法'})[note.noteType]);

  // Type switches create one draft per empty type, then always reopen its latest note.
  await selectType('quick');
  const quickId=await currentId();
  assert.equal(await evaluate(`document.querySelector('.title-input').value`), `随手记 ${day}`);
  assert.equal(await evaluate(`document.querySelector('.body-input').value`),'');
  assert.equal(await evaluate(`document.querySelector('.body-input').matches(':placeholder-shown')`),true);
  assert.equal((await findSaved(quickId)).body,'');
  const quickBody='随手记连续输入正文';
  await evaluate(`(() => { const body=document.querySelector('.body-input'); for(const character of ${JSON.stringify(quickBody)}) {body.value+=character;body.dispatchEvent(new Event('input',{bubbles:true}));} document.querySelector('[data-act="select-note-type"][data-id="meeting"]').click(); })()`);
  await waitFor(() => evaluate(`document.querySelector('[data-id="meeting"][aria-current="true"]') !== null && document.querySelector('.body-input')?.dataset.id !== ${JSON.stringify(quickId)}`),{process:electron});
  const meetingId=await currentId();
  assert.equal((await findSaved(quickId)).body,quickBody);
  assert.equal(await evaluate(`document.querySelector('.title-input').value`),`会议要点 ${day}`);
  await waitFor(() => evaluate(`document.activeElement === document.querySelector('.body-input')`),{process:electron});
  await replaceTitle('项目启动会');
  await waitFor(() => evaluate(`window.lumen.getState().then(s=>s.notes.find(n=>n.id===${JSON.stringify(meetingId)})?.title==='项目启动会')`),{process:electron});
  assert.deepEqual(await labels(),expectedLabels);
  const meetingBody='讨论范围，明确下一步。';
  await setBody(meetingBody);
  await selectType('idea');
  const ideaId=await currentId();
  assert.equal((await findSaved(meetingId)).body,meetingBody);
  assert.equal(await evaluate(`document.querySelector('.title-input').value`),`临时想法 ${day}`);
  const ideaBody='灵感先记下来，稍后展开。';
  await setBody(ideaBody);
  await selectType('quick');
  assert.equal(await currentId(),quickId);
  assert.equal(await evaluate(`document.querySelector('.body-input').value`),quickBody);
  assert.equal((await findSaved(ideaId)).body,ideaBody);
  for(const type of ['meeting','idea','quick','meeting','idea','quick']) await selectType(type);
  let state=await snapshot();
  assert.equal(state.notes.length,3);
  for(const note of state.notes) {
    assertFolder(note);
    assert.equal(fs.readFileSync(path.join(firstVault,note.filePath),'utf8'),`<!-- lumen-quick-note:${note.id} -->\n${note.body}`);
    assert.equal(fs.readdirSync(path.dirname(path.join(firstVault,note.filePath))).filter(name=>name.endsWith('.md')).length,1);
  }

  // Plus creates a new note only in the current category. Same-day filenames stay distinct.
  await evaluate(`document.querySelector('[data-act="new"]').click()`);
  await waitFor(() => evaluate(`document.querySelector('.body-input')?.dataset.id !== ${JSON.stringify(quickId)}`),{process:electron});
  const secondQuickId=await currentId();
  await waitFor(() => evaluate(`document.activeElement === document.querySelector('.body-input')`),{process:electron});
  const secondQuick=await findSaved(secondQuickId);
  assert.equal(secondQuick.noteType,'quick');
  assertFolder(secondQuick);
  assert.notEqual(secondQuick.filePath,(await findSaved(quickId)).filePath);
  assert.equal(secondQuick.body,'');
  assert.deepEqual(await labels(),expectedLabels);
  await setBody('另一则随手记');
  await selectType('meeting');
  await selectType('quick');
  assert.equal(await currentId(),secondQuickId);
  assert.equal(await evaluate(`document.querySelector('.body-input').value`),'另一则随手记');

  // Existing notes remain searchable even though bottom navigation is now fixed types.
  await evaluate(`document.querySelector('[data-act="open-search"]').click()`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('.search-input')) && innerHeight===560`),{process:electron});
  await evaluate(`document.querySelector('[data-act="open-note"][data-id="${quickId}"]').click()`);
  await waitFor(() => evaluate(`document.querySelector('.body-input')?.dataset.id===${JSON.stringify(quickId)} && innerHeight===292`),{process:electron});
  assert.equal(await evaluate(`document.querySelector('.body-input').value`),quickBody);
  assert.deepEqual(await labels(),expectedLabels);

  await selectType('meeting');
  await evaluate(`window.__quickNoteReload=true;location.reload();true`);
  await waitFor(() => evaluate(`!window.__quickNoteReload && document.readyState==='complete' && Boolean(document.querySelector('.collapsed-hit'))`),{process:electron});
  await evaluate(`window.lumen.setShell('panel')`);
  await waitFor(() => evaluate(`document.querySelector('.body-input')?.dataset.id===${JSON.stringify(meetingId)}`),{process:electron});
  assert.equal(await evaluate(`document.querySelector('.title-input').value`),'项目启动会');
  assert.equal(await evaluate(`document.querySelector('.body-input').value`),meetingBody);
  assert.equal(await evaluate(`document.querySelector('[data-id="meeting"][aria-current="true"]') !== null`),true);
  assert.deepEqual(await labels(),expectedLabels);

  await evaluate(`document.querySelector('[data-act="tab-todos"]').click()`);
  await waitFor(() => evaluate(`innerHeight===560 && Boolean(document.querySelector('.zen-input'))`),{process:electron});
  await evaluate(`document.querySelector('[data-act="tab-notes"]').click()`);
  await waitFor(() => evaluate(`innerHeight===292 && Boolean(document.querySelector('.body-input'))`),{process:electron});
  await setBody(meetingBody+'最后补充');
  await evaluate(`document.querySelector('[data-act="complete-note"]').click()`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('.collapsed-hit'))`),{process:electron});
  await evaluate(`window.lumen.setShell('panel')`);
  assert.equal(await evaluate(`document.querySelector('.body-input').value`),meetingBody+'最后补充');
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',modifiers:process.platform==='darwin'?4:2});
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',modifiers:process.platform==='darwin'?4:2});
  await waitFor(() => evaluate(`Boolean(document.querySelector('.collapsed-hit'))`),{process:electron});
  await evaluate(`window.lumen.setShell('panel')`);

  state=await snapshot();
  assert.equal(state.notes.length,4);
  const savedMeeting=state.notes.find(note=>note.id===meetingId);
  const tail='会议笔记退出前最后输入';
  await evaluate(`(() => {const body=document.querySelector('.body-input');body.value=${JSON.stringify(tail)};body.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-act="quit"]').click();})();true`);
  await waitFor(()=>electron.exited,{timeout:15000});
  assert.equal(electron.code,0,electron.output);
  assert.ok(fs.readFileSync(path.join(firstVault,savedMeeting.filePath),'utf8').endsWith(tail));
  assert.deepEqual(runtimeErrors,[]);
  console.log('Quick-note E2E passed: three fixed type tabs, separate folders, date titles, placeholders, no duplicate drafts on switching, renamed titles, same-type new notes, search, reload, compact layout and quit flush.');
} finally {
  try { socket?.close(); } catch {}
  for (const record of children.reverse()) await stop(record);
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
}
