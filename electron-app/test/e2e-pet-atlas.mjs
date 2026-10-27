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
const animal = process.env.DM_PET_QA_ANIMAL || 'engineer-fox';
const manifest = atlas.getManifest(animal);
assert.ok(manifest, 'Unknown atlas skin: ' + animal);
const cwd = path.resolve(import.meta.dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-foss-renderer-'));
const output = process.env.DM_PET_QA_OUTPUT || path.join(os.tmpdir(), 'dm-' + animal + '-renderer-evidence');
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
  const moods = ['capybara','koala','hamster','liangzi'].includes(animal) ? ['normal','eating','reading','failed','sleepy'] : ['normal','working','reading','failed','bored'];
  for (const mood of moods) {
    const action = atlas.baseAction(mood, animal);
    const {row,frames} = manifest.actions[action];
    await setState({ mood, serial: ++serial, animation: '', bubble: '' }); await drawAction(action);
    await evaluate('qaDraws.length=0');
    await pause(1500);
    const draws = await evaluate('qaDraws');
    assert.ok(draws.length >= frames, action + ' actually draws at its configured FPS');
    assert.ok(draws.every(d => manifest.frames
      ? manifest.frames[row].some(([x,y,w,h]) => d.x===x && d.y===y && d.w===w && d.h===h)
      : d.y === row*manifest.cellHeight && d.w === manifest.cellWidth && d.h === manifest.cellHeight && d.x >= 0 && d.x < frames*manifest.cellWidth));
    assert.equal(new Set(draws.map(d => d.x)).size, frames, action + ' visits every real source frame');
    await screenshot('action-' + action);
  }
  for (const action of ['right', 'left']) {
    const {row, frames} = manifest.actions[action];
    await setState({control:{active:true,action},animation:'',serial:++serial}); await drawAction(action);
    await evaluate('qaDraws.length=0'); await pause(1500);
    const draws=await evaluate('qaDraws');
    assert.equal(new Set(draws.map(d=>d.x)).size,frames,action+' visits every walking frame');
    assert.ok(draws.every(d=>manifest.frames
      ? manifest.frames[row].some(([x,y,w,h])=>d.x===x&&d.y===y&&d.w===w&&d.h===h)
      : d.y===row*manifest.cellHeight));
    await screenshot('action-'+action);
  }
  await setState({control:{active:false}});
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
  // Geometry regression: measure painted pixels, not transparent sprite cells.
  await send('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  let bubbleCases = 0;
  for (const skin of [animal, 'human']) for (const dpr of [1, 2]) for (const size of [48,68,96,128]) {
    const spec = atlas.getManifest(skin), width = size * (spec ? spec.cellWidth / spec.cellHeight : 1);
    for (const pose of ['idle', 'left', 'right', 'ceiling', 'expanded']) {
      const viewport = pose === 'expanded' ? {width:400,height:360} : {width:240,height:size+136};
      await send('Emulation.setDeviceMetricsOverride', {...viewport,deviceScaleFactor:dpr,mobile:false});
      const control = pose === 'idle' ? {active:false} : {active:true,action:'idle',facing:'right',
        left:pose === 'left' || pose === 'ceiling' ? 0 : pose === 'right' ? viewport.width-width : 260,
        top:pose === 'ceiling' ? 0 : 100};
      await setState({animal:skin,size,mood:'normal',serial:++serial,animation:'',control,
        bubble:'💧 喝水提醒\n喝杯水，活动一下。\n点击处理提醒'});
      await waitFor(() => evaluate(`document.querySelector('#pet').dataset.renderer === ${JSON.stringify(spec ? 'atlas' : 'pixel')}`));
      const geometry = await evaluate(`(() => {
        const c=document.querySelector('canvas'),r=c.getBoundingClientRect(),b=document.querySelector('#bubble'),br=b.getBoundingClientRect();
        const data=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
        let left=c.width,top=c.height,right=0,bottom=0;
        for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++)if(data[(y*c.width+x)*4+3]>=20){left=Math.min(left,x);right=Math.max(right,x+1);top=Math.min(top,y);bottom=Math.max(bottom,y+1);}
        return {bubble:{left:br.left,top:br.top,right:br.right,bottom:br.bottom,width:br.width},placement:b.dataset.placement,
          shape:{left:r.left+left/c.width*r.width,right:r.left+right/c.width*r.width,top:r.top+top/c.height*r.height,bottom:r.top+bottom/c.height*r.height}};
      })()`);
      const label = `${skin}/${size}/DPR ${dpr}/${pose}`, {bubble:b,shape:s,placement} = geometry;
      assert.ok(b.left>=7.9 && b.top>=7.9 && b.right<=viewport.width-7.9 && b.bottom<=viewport.height-7.9, label+' stays in viewport');
      const gap = placement === 'above' ? s.top-b.bottom : b.top-s.bottom;
      assert.ok(Math.abs(gap-8)<=1.1, label+` attaches to painted character: ${JSON.stringify(geometry)}`);
      const center = Math.max(8+b.width/2,Math.min((s.left+s.right)/2,viewport.width-8-b.width/2));
      assert.ok(Math.abs((b.left+b.right)/2-center)<1,label+' centers over character subject to edge clamping');
      if(pose==='ceiling')assert.equal(placement,'below',label+' flips below at top edge');
      if(skin===animal && size===128 && dpr===1 && ['idle','ceiling','expanded'].includes(pose))await screenshot('bubble-'+pose);
      bubbleCases++;
    }
  }
  await send('Emulation.setDeviceMetricsOverride', {width:240,height:264,deviceScaleFactor:1,mobile:false});
  await send('Emulation.setEmulatedMedia',{features:[]});
  await setState({animal,size:128,control:{active:false},bubble:'',mood:'working',serial:++serial}); await drawAction(atlas.baseAction('working', animal));
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
  if(animal==='koala') {
    await send('Emulation.setDeviceMetricsOverride',{width:1000,height:900,deviceScaleFactor:1,mobile:false});
    await send('Page.navigate',{url:'file://'+path.join(cwd,'docs/koala-preview.html')});
    await waitFor(()=>evaluate('window.previewReady===true'));
    await evaluate("document.querySelector('[data-action=idle]').click();document.querySelector('#pause').click()");
    await screenshot('koala-preview');
    await evaluate("document.querySelector('#background').click()");
    await screenshot('koala-preview-dark');
  }
  if(animal==='liangzi') {
    await send('Emulation.setDeviceMetricsOverride',{width:1000,height:900,deviceScaleFactor:1,mobile:false});
    await send('Page.navigate',{url:'file://'+path.join(cwd,'docs/liangzi-preview.html')});
    await waitFor(()=>evaluate('window.previewReady===true'));
    await evaluate("document.querySelector('[data-action=idle]').click();document.querySelector('#pause').click()");
    await screenshot('liangzi-preview');
    await evaluate("document.querySelector('#background').click()");
    await screenshot('liangzi-preview-dark');
    await evaluate("document.querySelector('[data-action=working]').click()");
    await screenshot('liangzi-eating');
  }
  if(['hamster','seal'].includes(animal)) {
    await send('Emulation.setDeviceMetricsOverride',{width:1200,height:900,deviceScaleFactor:1,mobile:false});
    await send('Page.navigate',{url:'file://'+path.join(cwd,'docs/hamster-seal-preview.html')});
    await waitFor(()=>evaluate('window.previewReady===true'));
    assert.equal(await evaluate("document.querySelectorAll('.cards canvas').length"),2);
    await evaluate("document.querySelector('[data-action=idle]').click();document.querySelector('#pause').click()");
    await screenshot('hamster-seal-preview');
    await evaluate("document.querySelector('#background').click()");
    await screenshot('hamster-seal-preview-dark');
    await evaluate("document.querySelector('[data-action=working]').click()");
    await screenshot('hamster-seal-actions');
  }
  if(animal==='realistic-cockroach') {
    await send('Emulation.setDeviceMetricsOverride',{width:1200,height:900,deviceScaleFactor:1,mobile:false});
    await send('Page.navigate',{url:'file://'+path.join(cwd,'docs/realistic-insects-preview.html')});
    await waitFor(()=>evaluate('window.previewReady===true'));
    assert.equal(await evaluate("document.querySelectorAll('.cards canvas').length"),2);
    await evaluate("document.querySelector('[data-action=idle]').click();document.querySelector('#pause').click()");
    await screenshot('realistic-insects-preview');
    await evaluate("document.querySelector('#background').click()");
    await screenshot('realistic-insects-preview-dark');
    await evaluate("document.querySelector('[data-action=working]').click()");
    await screenshot('realistic-insects-grooming');
  }
  fs.writeFileSync(path.join(output,'metrics.json'),JSON.stringify({scales,bubbleCases,actions:['idle','right','left','working','review','failed','waiting','wave','jump'],hiddenPause:true,reducedMotion:true,unloadCleanup:true},null,2)+'\n');
  console.log('Real ' + animal + ' renderer E2E passed: all active action frames, one-shot transitions, repeated broadcasts, sizes 48/68/96/128 at DPR 1/2, transparency, centering, native hide/show, reduced motion and unload. Evidence: '+output);
} finally {
  socket?.close();
  if (!exited) { child.kill('SIGTERM'); await Promise.race([new Promise(resolve=>child.once('exit',resolve)),pause(2000).then(()=>{if(!exited)child.kill('SIGKILL');})]); }
  fs.rmSync(root,{recursive:true,force:true});
}
