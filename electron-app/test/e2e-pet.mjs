import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const { createPkb } = createRequire(import.meta.url)("../electron/pkb");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "dm-pet-e2e-"));
const cwd = path.resolve(import.meta.dirname, "..");
const children = [];
const appExecutable = process.env.DM_PET_E2E_EXECUTABLE || path.resolve(cwd, "node_modules/.bin/electron");
const appArgs = process.env.DM_PET_E2E_EXECUTABLE ? ["--no-proxy-server", "--use-mock-keychain"] : ["--no-proxy-server", "."];
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

  await waitFor(() => evaluate(`location.hash.startsWith("#workspace") && Boolean(document.querySelector('[data-action="section"][data-value="settings"]'))`), { process: electron });
  await evaluate(`document.querySelector('[data-action="section"][data-value="settings"]').click()`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('[name="petModeEnabled"]'))`), { process: electron });
  await evaluate(`document.querySelector('[data-settings-tab="pet"]').click()`);
  assert.equal(await evaluate(`document.querySelectorAll('[name="petAnimal"] option').length`), 19);
  assert.equal(await evaluate(`document.querySelectorAll('[data-pet-choice]').length`),19);
  // Preview draft choices without enabling or changing the desktop pet.
  await evaluate(`document.querySelector('[data-pet-group="animated"]').click(); document.querySelector('[data-pet-choice="otter"]').click()`);
  await waitFor(()=>evaluate(`['fluffy-rabbit','otter','red-panda'].every(id=>document.querySelector('[data-pet-choice="'+id+'"] canvas').dataset.status==='ready')`));
  assert.equal(await evaluate(`document.querySelector('[name="petAnimal"]').value`),'otter');
  assert.equal(await evaluate(`document.querySelector('[data-pet-choice="otter"]').getAttribute('aria-checked')`),'true');
  assert.equal(await evaluate(`document.querySelectorAll('[data-pet-choice]:not([hidden])').length`),9);
  assert.equal(await evaluate(`window.lumen.settings.get().then(s=>s.petModeEnabled)`),false);
  await evaluate(`document.querySelector('[data-pet-preview-animal="otter"][data-pet-preview-action="working"]').click()`);
  await evaluate(`document.querySelector('[data-pet-preview-animal="fluffy-rabbit"][data-pet-preview-action="wave"]').click(); document.querySelector('[data-pet-preview-animal="red-panda"][data-pet-preview-action="review"]').click()`);
  await waitFor(()=>evaluate(`document.querySelector('[data-pet-choice="otter"] canvas').dataset.action==='working' && document.querySelector('[data-pet-choice="fluffy-rabbit"] canvas').dataset.action==='wave' && document.querySelector('[data-pet-choice="red-panda"] canvas').dataset.action==='review'`));
  assert.equal(await evaluate(`document.querySelector('[name="petAnimal"]').value`),'otter','per-card action buttons do not select another pet');
  assert.equal(await evaluate(`document.querySelectorAll('button button').length`),0,'selection buttons never contain interactive action buttons');
  assert.equal(await evaluate(`document.querySelector('[data-pet-preview-animal="fluffy-rabbit"][data-pet-preview-action="working"]').textContent`),'洗脸');
  assert.ok(await evaluate(`Array.from(document.querySelectorAll('.pet-picker-card:not([hidden])')).every(c=>c.getBoundingClientRect().width<=261)`),'cards stay compact');
  const previewFrames=new Set();
  for(let i=0;i<8;i++){previewFrames.add(await evaluate(`document.querySelector('[data-pet-choice="otter"] canvas').dataset.frame`));await sleep(160);}
  assert.ok(previewFrames.size>=3,'visible previews animate through multiple frames');
  await evaluate(`document.querySelector('[data-pet-preview-pause]').click()`);
  const frozen=await evaluate(`document.querySelector('[data-pet-choice="otter"] canvas').dataset.frame`);
  await sleep(350);assert.equal(await evaluate(`document.querySelector('[data-pet-choice="otter"] canvas').dataset.frame`),frozen);
  await evaluate(`document.querySelector('[data-pet-preview-background]').click()`);
  assert.equal(await evaluate(`document.querySelector('[data-pet-picker]').classList.contains('pet-picker-dark')`),true);
  await evaluate(`document.querySelector('[data-settings-tab="shortcuts"]').click(); document.querySelector('[data-settings-tab="pet"]').click()`);
  assert.equal(await evaluate(`document.querySelector('[name="petAnimal"]').value`),'otter','tab switching preserves the draft choice');
  await evaluate(`document.querySelector('[data-pet-group="pixel"]').click(); document.querySelector('[data-pet-choice="human"]').click()`);
  await waitFor(()=>evaluate(`document.querySelector('[data-pet-choice="human"] canvas').classList.contains('pet-picker-pixel')`));
  assert.equal(await evaluate(`document.querySelectorAll('[data-pet-choice]:not([hidden])').length`),10);
  await evaluate(`document.querySelector('[data-pet-choice="human"]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))`);
  assert.equal(await evaluate(`document.querySelector('[name="petAnimal"]').value`),'rabbit','arrow keys select the next visible card');
  // Leaving settings while paused must disconnect the observer and event listeners too.
  await evaluate(`window.__previewObserverDisconnected=0; const original=IntersectionObserver.prototype.disconnect; IntersectionObserver.prototype.disconnect=function(){window.__previewObserverDisconnected++;return original.call(this)}; document.querySelector('[data-action="section"][data-value="notes"]').click()`);
  await waitFor(()=>evaluate(`location.hash === '#workspace'`));
  assert.ok(await evaluate(`window.__previewObserverDisconnected>=1`));
  await evaluate(`document.querySelector('[data-action="section"][data-value="settings"]').click()`);
  await waitFor(()=>evaluate(`Boolean(document.querySelector('[data-pet-group="animated"]'))`));
  await evaluate(`document.querySelector('[data-settings-tab="pet"]').click()`);
  await evaluate(`document.querySelector('[data-pet-group="animated"]').click(); document.querySelector('[data-pet-choice="cat"]').click()`);

  await evaluate(`(() => {
    document.querySelector('[name="petModeEnabled"]').checked = true;
    document.querySelector('[name="petAnimal"]').value = 'cat';
    document.querySelector('[name="petDisplaySize"]').value = '96';
    document.querySelector('[name="petPreventSleepEnabled"]').checked = false;
    document.querySelector('[data-module-action="settings-save"]').click();
  })()`);
  await waitFor(() => evaluate(`document.querySelector('.ws-settings-ok')?.textContent.includes('已保存')`), { process: electron });
  const targets = () => fetch(`http://127.0.0.1:${debugPort}/json`).then(response => response.json());
  const petTarget = await waitFor(async () => (await targets()).find(item => item.url.endsWith('/pet.html')), { process: electron });
  socket.close(); await connect(petTarget.webSocketDebuggerUrl);
  await waitFor(() => evaluate(`window.desktopPet?.get().then(state => state?.animal === 'cat' && state?.size === 96)`), { process: electron });
  assert.equal(await evaluate(`typeof window.lumen === 'undefined' && typeof require === 'undefined'`), true, 'pet uses its own restricted sandbox preload');
  await waitFor(() => evaluate(`(() => { const c=document.querySelector('canvas'); return c.getContext('2d').getImageData(0,0,c.width,c.height).data.some((value,index) => index % 4 === 3 && value > 0); })()`));
  await waitFor(() => evaluate(`document.querySelector('#pet').dataset.assetStatus === 'ready'`));
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('canvas')).imageRendering`), 'auto');
  assert.equal(await evaluate(`getComputedStyle(document.body).backgroundColor`), 'rgba(0, 0, 0, 0)');
  const rect = await evaluate(`(()=>{const r=document.querySelector('#pet').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2,width:r.width}})()`);
  assert.equal(rect.width, 96);
  for (let count = 0; count < 5; count++) {
    if (count) await sleep(450);
    await send('Input.dispatchMouseEvent', {type:'mousePressed', x:rect.x, y:rect.y, button:'left', clickCount:1});
    await send('Input.dispatchMouseEvent', {type:'mouseReleased', x:rect.x, y:rect.y, button:'left', clickCount:1});
  }
  await waitFor(() => evaluate(`window.desktopPet.get().then(state => state.mood === 'happy')`));
  assert.equal(await evaluate(`!document.querySelector('#bubble').hidden && Boolean(document.querySelector('#bubble').textContent)`), true);
  const screenshot = await send('Page.captureScreenshot', {format:'png', omitBackground:true});
  const preview = path.join(os.tmpdir(), 'dm-desktop-pet-preview.png');
  fs.writeFileSync(preview, Buffer.from(screenshot.result.data, 'base64'));
  await evaluate(`document.querySelector('#bubble').click()`);
  socket.close(); await connect(workspace.webSocketDebuggerUrl);
  await waitFor(() => evaluate(`document.querySelector('[data-action="section"][data-value="tasks"]').classList.contains('active') || Boolean(document.querySelector('.pm-task-list, .pm-task-board'))`));
  // Two native renderer clicks use the existing double-tap route back to notes.
  socket.close(); await connect(petTarget.webSocketDebuggerUrl);
  for (let count = 0; count < 2; count++) {
    await send('Input.dispatchMouseEvent', {type:'mousePressed', x:rect.x, y:rect.y, button:'left', clickCount:count+1});
    await send('Input.dispatchMouseEvent', {type:'mouseReleased', x:rect.x, y:rect.y, button:'left', clickCount:count+1});
  }
  socket.close(); await connect(workspace.webSocketDebuggerUrl);
  await waitFor(() => evaluate(`location.hash === '#workspace' || location.hash === '#workspace/notes'`));
  // Switching back and saving keeps preferences unrelated to pets intact.
  await evaluate(`document.querySelector('[data-action="section"][data-value="settings"]').click()`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('[name="petModeEnabled"]'))`));
  await evaluate(`document.querySelector('[data-settings-tab="pet"]').click()`);
  assert.equal(await evaluate(`document.querySelector('[name="petModeEnabled"]').checked`), true);
  await evaluate(`document.querySelector('[name="petAnimal"]').value='engineer-fox'; document.querySelector('[name="petDisplaySize"]').value='128'; document.querySelector('[data-module-action="settings-save"]').click()`);
  socket.close(); await connect(petTarget.webSocketDebuggerUrl);
  await waitFor(() => evaluate(`window.desktopPet.get().then(state => state.animal === 'engineer-fox' && state.size === 128)`));
  await waitFor(() => evaluate(`['ready', 'failed'].includes(document.querySelector('#pet').dataset.assetStatus)`));
  const assetPresent = fs.existsSync(path.join(cwd, 'assets/pets/foss/spritesheet-extended.png'));
  const rendering = await evaluate(`(() => {
    const pet = document.querySelector('#pet'), c = pet.querySelector('canvas'), r = pet.getBoundingClientRect();
    return { status: pet.dataset.assetStatus, renderer: pet.dataset.renderer, width:r.width, height:r.height,
      canvasWidth:c.width, canvasHeight:c.height, dpr:Math.min(4, Math.max(1, devicePixelRatio)),
      smoothing:getComputedStyle(c).imageRendering, animation:getComputedStyle(pet).animationName,
      pixels:c.getContext('2d').getImageData(0,0,c.width,c.height).data.some((v,i) => i%4 === 3 && v>0) };
  })()`);
  assert.equal(rendering.status, assetPresent ? 'ready' : 'failed');
  assert.equal(rendering.renderer, assetPresent ? 'atlas' : 'pixel');
  assert.equal(rendering.pixels, true); assert.equal(rendering.height, 128);
  assert.equal(rendering.animation, 'none', '工程师 never adds a CSS gesture over the atlas');
  if (assetPresent) {
    assert.ok(Math.abs(rendering.width - 128 * 192 / 208) < .1);
    assert.equal(rendering.canvasHeight, Math.round(128 * rendering.dpr));
    assert.equal(rendering.smoothing, 'auto');
  } else {
    assert.equal(rendering.canvasWidth, 32); assert.equal(rendering.smoothing, 'pixelated');
  }
  const fossPreview = path.join(os.tmpdir(), assetPresent ? 'dm-foss-atlas-preview.png' : 'dm-foss-fallback-preview.png');
  const fossShot = await send('Page.captureScreenshot', {format:'png', omitBackground:true});
  fs.writeFileSync(fossPreview, Buffer.from(fossShot.result.data, 'base64'));
  socket.close(); await connect(workspace.webSocketDebuggerUrl);
  await evaluate(`document.querySelector('[name="petAnimal"]').value='operator-rabbit'; document.querySelector('[data-module-action="settings-save"]').click()`);
  socket.close(); await connect(petTarget.webSocketDebuggerUrl);
  await waitFor(()=>evaluate(`window.desktopPet.get().then(s=>s.animal==='operator-rabbit' && document.querySelector('#pet').dataset.assetStatus==='ready')`));
  assert.equal(await evaluate(`document.querySelector('#pet').dataset.renderer`),'atlas');
  assert.equal(await evaluate(`document.querySelector('#pet').getBoundingClientRect().width`),128);
  const operatorShot=await send('Page.captureScreenshot',{format:'png',omitBackground:true});
  fs.writeFileSync(path.join(os.tmpdir(),'dm-operator-rabbit-settings-preview.png'),Buffer.from(operatorShot.result.data,'base64'));
  for (const animal of ['fluffy-rabbit','otter','red-panda','baby-dragon']) {
    socket.close(); await connect(workspace.webSocketDebuggerUrl);
    await evaluate(`document.querySelector('[name="petAnimal"]').value=${JSON.stringify(animal)}; document.querySelector('[data-module-action="settings-save"]').click()`);
    socket.close(); await connect(petTarget.webSocketDebuggerUrl);
    await waitFor(()=>evaluate(`window.desktopPet.get().then(s=>s.animal===${JSON.stringify(animal)} && document.querySelector('#pet').dataset.assetStatus==='ready')`));
    assert.equal(await evaluate(`document.querySelector('#pet').dataset.renderer`),'atlas');
    assert.equal(JSON.parse(fs.readFileSync(path.join(configDirectory,'config.json'))).petAnimal,animal);
  }
  socket.close(); await connect(workspace.webSocketDebuggerUrl);
  await evaluate(`window.lumen.settings.save({petAnimal:'future-pet',petModeEnabled:true,petDisplaySize:128})`);
  await waitFor(()=>evaluate(`document.querySelector('[name="petAnimal"]').value==='future-pet'`));
  await evaluate(`document.querySelector('[data-module-action="settings-reload"]').click()`);
  await waitFor(()=>evaluate(`document.querySelector('[name="petAnimal"]').value==='future-pet'`));
  assert.match(await evaluate(`document.querySelector('.pet-picker-selection').textContent`),/已保留/);
  await evaluate(`document.querySelector('[data-module-action="settings-save"]').click()`);
  await waitFor(()=>evaluate(`document.querySelector('.ws-settings-ok')?.textContent.includes('已保存')`));
  assert.equal(JSON.parse(fs.readFileSync(path.join(configDirectory,'config.json'))).petAnimal,'future-pet','saving unrelated settings cannot replace an unsupported pet');
  socket.close(); await connect(petTarget.webSocketDebuggerUrl);
  await waitFor(()=>evaluate(`document.querySelector('#pet').dataset.assetStatus==='unsupported'`));
  socket.close(); await connect(workspace.webSocketDebuggerUrl);
  await evaluate(`document.querySelector('[name="petAnimal"]').value='otter'; document.querySelector('[data-module-action="settings-save"]').click()`);
  socket.close(); await connect(workspace.webSocketDebuggerUrl);
  await evaluate(`document.querySelector('[name="petModeEnabled"]').checked=false; document.querySelector('[data-module-action="settings-save"]').click()`);
  await waitFor(async () => !(await targets()).some(item => item.url.endsWith('/pet.html')));
  await evaluate(`document.querySelector('[name="petModeEnabled"]').checked=true; document.querySelector('[data-module-action="settings-save"]').click()`);
  await waitFor(async () => (await targets()).some(item => item.url.endsWith('/pet.html')));
  const configFile = path.join(configDirectory, 'config.json');
  assert.equal(JSON.parse(fs.readFileSync(configFile)).petAnimal, 'otter');
  // Exit while the pet is enabled; it must not join the editor flush handshake or keep Electron alive.
  await evaluate(`window.lumen.quitApp(); true`);
  await waitFor(() => electron.exited, { timeout: 15000 });
  assert.equal(electron.code, 0, electron.output);
  const restart = start('Electron pet restart', appExecutable, appArgs, {
    DM_E2E_ROOT: root, DM_E2E_PORT: String(debugPort), DM_E2E_SERVER_PORT: String(serverPort),
  });
  const restored = await waitFor(async () => (await targets()).find(item => item.url.endsWith('/pet.html')), { process: restart });
  socket.close(); await connect(restored.webSocketDebuggerUrl);
  await waitFor(() => evaluate(`window.desktopPet?.get().then(state => state.animal === 'otter' && state.size === 128)`), { process: restart });
  console.log(`Pet E2E passed: settings, sandbox, transparent window, canvas sprites, affection, double-click, task navigation, 工程师 ${assetPresent ? "atlas" : "missing-asset fallback"}, disable/re-enable, exit and restart. Previews: ${preview}, ${fossPreview}`);
} finally {
  try { socket?.close(); } catch {}
  for (const record of children.reverse()) await stop(record);
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
}
