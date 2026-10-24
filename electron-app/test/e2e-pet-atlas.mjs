// Native renderer QA: production pet.html/scripts + real PNG, with a test-only IPC state source.
// No live app settings, vault, global shortcuts or real AI services are opened.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const atlas = createRequire(import.meta.url)('../src/pet-atlas');
const animal=process.env.DM_PET_QA_ANIMAL || 'engineer-fox';
const manifest=atlas.getManifest(animal);
assert.ok(manifest);
const cwd = path.resolve(import.meta.dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-foss-renderer-'));
const output = process.env.DM_PET_QA_OUTPUT || path.join(os.tmpdir(), 'dm-foss-renderer-evidence');
fs.mkdirSync(output, { recursive: true });
const asset = path.join(cwd, manifest.source);
assert.ok(fs.existsSync(asset), 'Install the original 工程师 atlas before running real-asset QA');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const port = await new Promise((resolve, reject) => {
  const server = net.createServer(); server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(error => error ? reject(error) : resolve(value)); });
});
fs.writeFileSync(path.join(root, 'main.cjs'), `
const {app, BrowserWindow, ipcMain} = require('electron');
app.setPath('userData', ${JSON.stringify(path.join(root, 'user-data'))});
app.commandLine.appendSwitch('remote-debugging-port', ${JSON.stringify(String(port))});
let win, state = {animal:${JSON.stringify(animal)},size:128,mood:'normal',serial:0,animation:'',bubble:''};
app.whenReady().then(() => {
  win = new BrowserWindow({width:240,height:264,transparent:true,frame:false,resizable:false,
    webPreferences:{preload:${JSON.stringify(path.join(root, 'preload.cjs'))},sandbox:true,contextIsolation:true,nodeIntegration:false}});
  const own = event => event.sender === win.webContents;
  ipcMain.handle('pet:get', event => own(event) ? state : null);
  ipcMain.handle('test:state', (event, patch) => { if (!own(event)) return;
    state = {...state,...patch}; win.webContents.send('pet:state', state); return state; });
  ipcMain.handle('test:visible', (event, visible) => { if (own(event)) visible ? win.showInactive() : win.hide(); });
  void win.loadFile(${JSON.stringify(path.join(cwd, 'pet.html'))});
});
app.on('window-all-closed', () => app.quit());
`);
fs.writeFileSync(path.join(root, 'preload.cjs'), `
const {contextBridge, ipcRenderer} = require('electron'); let subscriptions = 0;
contextBridge.exposeInMainWorld('desktopPet', {
 get:()=>ipcRenderer.invoke('pet:get'),interactive:()=>{},press:()=>{},release:()=>{},cancel:()=>{},menu:()=>{},tasks:()=>{},
 onState:callback=>{const fn=(_event,state)=>callback(state);subscriptions++;ipcRenderer.on('pet:state',fn);
 return ()=>{subscriptions--;ipcRenderer.removeListener('pet:state',fn);};}
});
contextBridge.exposeInMainWorld('atlasTest', {state:patch=>ipcRenderer.invoke('test:state',patch),
 visible:value=>ipcRenderer.invoke('test:visible',value),subscriptions:()=>subscriptions});
`);
const child = spawn(path.join(cwd, 'node_modules/.bin/electron'), ['--no-proxy-server', path.join(root, 'main.cjs')], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '', exited = false, socket, requestId = 0;
child.stdout.on('data', bytes => log = (log + bytes).slice(-12000));
child.stderr.on('data', bytes => log = (log + bytes).slice(-12000));
child.on('exit', () => exited = true);
const pending = new Map();
async function waitFor(fn, timeout = 15000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) {
    if (exited) throw new Error('Test Electron exited: ' + log);
    try { const result = await fn(); if (result) return result; } catch (error) { last = error; }
    await pause(40);
  }
  throw new Error('Timed out: ' + (last?.message || '') + '\n' + log);
}
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 10000);
    pending.set(id, message => { clearTimeout(timeout); message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result); });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
const setState = patch => evaluate(`atlasTest.state(${JSON.stringify(patch)})`);
const drawAction = action => waitFor(() => evaluate(`document.querySelector('#pet').dataset.action === ${JSON.stringify(action)}`));
async function screenshot(name) {
  const result = await send('Page.captureScreenshot', { format: 'png', omitBackground: true });
  fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(result.data, 'base64'));
}
try {
  const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.url.endsWith('/pet.html')));
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = ({data}) => { const message = JSON.parse(data); if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); } };
  await waitFor(() => evaluate(`document.querySelector('#pet').dataset.assetStatus === 'ready'`));
  assert.equal(await evaluate(`typeof require`), 'undefined');
  await evaluate(`(() => { const ctx=document.querySelector('canvas').getContext('2d'), original=ctx.drawImage.bind(ctx); window.qaDraws=[];
    ctx.drawImage=(...args)=>{qaDraws.push({x:args[1],y:args[2],w:args[3],h:args[4],time:performance.now()}); return original(...args);}; })()`);
  let serial = 0;
  for (const mood of ['normal','working','reading','failed','bored']) {
    const action=atlas.baseAction(mood), {row,frames}=manifest.actions[action];
    await setState({ mood, serial: ++serial, animation: '', bubble: '' }); await drawAction(action);
    await evaluate('qaDraws.length=0');
    await pause(1500);
    const draws = await evaluate('qaDraws');
    assert.ok(draws.length >= frames, action + ' actually draws at its configured FPS');
    assert.ok(draws.every(d => manifest.frames ? manifest.frames[row].some(([x,y,w,h])=>d.x===x&&d.y===y&&d.w===w&&d.h===h) : d.y === row*manifest.cellHeight && d.w === manifest.cellWidth && d.h === manifest.cellHeight && d.x >= 0 && d.x < frames*manifest.cellWidth));
    assert.equal(new Set(draws.map(d => d.x)).size, frames, action + ' visits every real source frame');
    await screenshot('action-' + action);
  }
  for (const [animation, action] of [['pop','wave'], ['jump','jump']]) {
    const patch = { mood:'normal', serial:++serial, animation, bubble:manifest.name };
    await setState(patch); await drawAction(action); await pause(140);
    await screenshot('action-' + action);
    // Repeat the same broadcast while the gesture runs; it must still finish on time.
    await setState(patch); await pause(140); await setState(patch);
    await drawAction('idle');
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('#pet')).animationName`), 'none');
    await setState(patch); assert.equal(await evaluate(`document.querySelector('#pet').dataset.action`), 'idle');
  }
  const scales = [];
  for (const dpr of [1, 2]) {
    await send('Emulation.setDeviceMetricsOverride', { width:240,height:264,deviceScaleFactor:dpr,mobile:false });
    for (const size of [48,68,96,128]) {
      await setState({ mood:'normal',serial:++serial,animation:'',bubble:'',size });
      await waitFor(() => evaluate(`document.querySelector('canvas').height === ${size*dpr}`));
      const metrics = await evaluate(`(() => {const p=document.querySelector('#pet'),c=p.querySelector('canvas'),r=p.getBoundingClientRect(), data=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
        return {width:r.width,height:r.height,center:r.x+r.width/2,bottom:r.bottom,cw:c.width,ch:c.height,css:getComputedStyle(c).imageRendering,
          visible:data.some((v,i)=>i%4===3&&v>0),transparent:data.some((v,i)=>i%4===3&&v===0)};})()`);
      assert.ok(Math.abs(metrics.width-size*manifest.cellWidth/manifest.cellHeight)<.1); assert.equal(metrics.height,size);
      assert.ok(Math.abs(metrics.center-120)<.1); assert.equal(metrics.bottom,256);
      assert.equal(metrics.cw,Math.round(size*manifest.cellWidth/manifest.cellHeight*dpr)); assert.equal(metrics.ch,size*dpr);
      assert.equal(metrics.css,'auto'); assert.ok(metrics.visible && metrics.transparent);
      scales.push({size,dpr,...metrics}); await screenshot(`size-${size}-dpr-${dpr}`);
    }
  }
  await setState({mood:'working',serial:++serial}); await drawAction('working');
  await evaluate('atlasTest.visible(false)'); await waitFor(() => evaluate('document.hidden'));
  const hiddenCount = await evaluate('qaDraws.length'); await pause(450);
  assert.equal(await evaluate('qaDraws.length'), hiddenCount, 'hidden native window stops drawing');
  await evaluate('atlasTest.visible(true)'); await waitFor(() => evaluate('!document.hidden'));
  await waitFor(() => evaluate(`qaDraws.length > ${hiddenCount}`));
  await send('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await pause(150); const reducedCount=await evaluate('qaDraws.length'); await pause(350);
  assert.equal(await evaluate('qaDraws.length'),reducedCount,'reduced motion stops the native renderer timer');
  await send('Emulation.setEmulatedMedia',{features:[]}); await pause(200);
  await evaluate(`window.dispatchEvent(new Event('unload'))`);
  assert.equal(await evaluate('atlasTest.subscriptions()'),0);
  const closedCount=await evaluate('qaDraws.length'); await pause(350);
  assert.equal(await evaluate('qaDraws.length'),closedCount,'unload stops drawing and unsubscribes');
  if(animal==='operator-rabbit') {
    await send('Emulation.setDeviceMetricsOverride',{width:1200,height:920,deviceScaleFactor:1,mobile:false});
    await send('Page.navigate',{url:'file://'+path.join(cwd,'docs/operator-rabbit-preview.html')});
    await waitFor(()=>evaluate('window.previewReady===true'));
    assert.equal(await evaluate("document.querySelectorAll('#frames canvas').length"),36);
    await screenshot('operator-rabbit-preview');
  }
  fs.writeFileSync(path.join(output,'metrics.json'),JSON.stringify({scales,actions:['idle','working','review','failed','waiting','wave','jump'],hiddenPause:true,reducedMotion:true,unloadCleanup:true},null,2)+'\n');
  console.log('Real '+animal+' renderer E2E passed: all active action frames, one-shot transitions, repeated broadcasts, sizes 48/68/96/128 at DPR 1/2, transparency, centering, native hide/show, reduced motion and unload. Evidence: '+output);
} finally {
  socket?.close();
  if (!exited) { child.kill('SIGTERM'); await Promise.race([new Promise(resolve=>child.once('exit',resolve)),pause(2000).then(()=>{if(!exited)child.kill('SIGKILL');})]); }
  fs.rmSync(root,{recursive:true,force:true});
}
