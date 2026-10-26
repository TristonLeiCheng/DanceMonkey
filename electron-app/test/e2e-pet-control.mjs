// Uses the real service, sandbox preload, renderer and native window. Menu selection
// is driven by a test-only adapter; the app exposes no IPC for enabling control.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
const cwd = path.resolve(import.meta.dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-pet-control-'));
const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); }); });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const qaIcon = process.env.DM_PET_QA_ICON ? 'data:image/png;base64,' + fs.readFileSync(process.env.DM_PET_QA_ICON).toString('base64') : null;
fs.writeFileSync(path.join(root, 'main.cjs'), `
const {app,BrowserWindow,screen,Menu,powerSaveBlocker,ipcMain} = require('electron');
const {createDesktopPet} = require(${JSON.stringify(path.join(cwd, 'electron/desktop-pet'))});
app.setPath('userData', ${JSON.stringify(path.join(root, 'data'))});
app.commandLine.appendSwitch('remote-debugging-port', '${port}');
let config={petModeEnabled:true,petAnimal:'engineer-fox',petDisplaySize:96,petPreventSleepEnabled:false};
let items,closeMenu,pet,other,sceneIcons=[];
app.whenReady().then(()=>{
  pet=createDesktopPet({BrowserWindow,screen,powerSaveBlocker,
    desktopIcons:{read:async()=>({status:'ready',icons:sceneIcons}),getIcon:async()=>${JSON.stringify(qaIcon)}},
    Menu:{buildFromTemplate:template=>({popup:options=>{items=Menu.buildFromTemplate(template).items;closeMenu=options.callback;}})},
    configStore:{read:()=>config,write:patch=>(config={...config,...patch})},getTasks:()=>[],openWorkspace:()=>{},requestQuit:()=>app.quit()});
  pet.registerIpc(ipcMain);pet.sync();
  ipcMain.handle('qa:command',async(_event,command)=>{
    if(command==='menu-toggle'){app.focus({steal:true});pet.window.focus();items.find(i=>i.id==='pet-control').click();closeMenu();return;}
    if(command==='focus'){app.focus({steal:true});pet.window.focus();return;}
    if(command==='blur'){
      other=new BrowserWindow({width:300,height:200});await other.loadURL('data:text/html,Focus test');other.show();other.focus();return;
    }
    if(command==='pixel'){pet.sync({...config,petAnimal:'human'});return;}
    if(command==='icons'){
      const b=pet.window.getBounds(),s=await pet.window.webContents.executeJavaScript('desktopPet.get()');
      const area=screen.getDisplayMatching(b).workArea;
      const x=b.x+s.control.left+96*192/208/2;
      sceneIcons=[{id:'qa-file',name:'图标跳跃验收.md',x:x-30,y:area.y+area.height-280,width:60,height:60}];
      return sceneIcons[0];
    }
    if(command==='remove-icons'){sceneIcons=[];return;}
    if(command==='icons-state'){return sceneIcons;}
    if(command==='restart'){pet.toggle();pet.toggle();return;}
    if(command==='quit'){pet.dispose();app.quit();return;}
    return {bounds:pet.window.getBounds(),area:screen.getDisplayMatching(pet.window.getBounds()).workArea,focused:pet.window.isFocused()};
  });
  // A separate test-only preload retains the production sandbox bridge unchanged.
});
app.on('window-all-closed',()=>app.quit());
`);
// Append the test IPC bridge in an isolated copy of the production preload.
const preload = fs.readFileSync(path.join(cwd, 'electron/pet-preload.js'), 'utf8') + `\ncontextBridge.exposeInMainWorld('controlQA',{command:value=>ipcRenderer.invoke('qa:command',value)});\n`;
fs.writeFileSync(path.join(root, 'preload.cjs'), preload);
// Subclass changes only the preload for this test, preserving service options.
let main = fs.readFileSync(path.join(root, 'main.cjs'), 'utf8');
main = main.replace('pet=createDesktopPet({BrowserWindow,screen,powerSaveBlocker,', `pet=createDesktopPet({BrowserWindow:class extends BrowserWindow {constructor(options){super({...options,webPreferences:{...options.webPreferences,preload:${JSON.stringify(path.join(root, 'preload.cjs'))}}});}},screen,powerSaveBlocker,`);
fs.writeFileSync(path.join(root, 'main.cjs'), main);
const child = spawn(path.join(cwd, 'node_modules/.bin/electron'), [path.join(root, 'main.cjs')], {cwd, stdio:['ignore','pipe','pipe']});
let log = '', exited = false, socket, id = 0;
child.stdout.on('data', b => log = (log + b).slice(-5000)); child.stderr.on('data', b => log = (log + b).slice(-5000)); child.on('exit', () => exited = true);
const pending = new Map();
async function waitFor(fn, timeout = 12000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) { if (exited) throw new Error(log); try { const value = await fn(); if (value) return value; } catch(e) { last=e; } await pause(30); }
  throw new Error('Timed out: ' + (last?.message || '') + '\n' + log);
}
function send(method, params = {}) {
  return new Promise((resolve,reject)=>{const serial=++id;const timer=setTimeout(()=>{pending.delete(serial);reject(new Error(method+' timed out'));},10000);
    pending.set(serial,msg=>{clearTimeout(timer);msg.error?reject(new Error(JSON.stringify(msg.error))):resolve(msg.result);});socket.send(JSON.stringify({id:serial,method,params}));});
}
async function evaluate(expression) {const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value;}
const command = value => evaluate(`controlQA.command(${JSON.stringify(value)})`);
const state = () => evaluate('desktopPet.get()');
const metrics = () => evaluate(`(()=>{const r=document.querySelector('#pet').getBoundingClientRect();return {x:screenX+r.x,y:screenY+r.y,width:r.width,height:r.height,action:document.querySelector('#pet').dataset.action}})()`);
async function key(code, down) { await send('Input.dispatchKeyEvent',{type:down?'keyDown':'keyUp',key:code==='Space'?' ':code==='KeyE'?'e':code,code,windowsVirtualKeyCode:{ArrowLeft:37,ArrowRight:39,Space:32,Escape:27,KeyE:69}[code]}); }
async function toggle() {await evaluate('desktopPet.menu()');await command('menu-toggle');await waitFor(async()=>(await state()).control.active);await waitFor(async()=>(await command('metrics')).focused);}
try {
  const target=await waitFor(async()=>(await(await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t=>t.url.endsWith('/pet.html')));
  socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
  socket.onmessage=({data})=>{const msg=JSON.parse(data);if(pending.has(msg.id)){pending.get(msg.id)(msg);pending.delete(msg.id);}};
  await waitFor(()=>evaluate(`document.querySelector('#pet').dataset.assetStatus==='ready'`));
  assert.equal((await state()).control.active,false);
  await key('KeyE',true);await key('KeyE',false);assert.equal(await evaluate(`document.querySelector('#pet-cargo').hidden`),true);
  await command('focus'); const idle=await metrics();await key('ArrowLeft',true);await pause(150);await key('ArrowLeft',false);
  assert.equal((await metrics()).x,idle.x,'arrows do not move pets outside control');
  await toggle();await waitFor(async()=>(await state()).control.grounded);
  const before=await metrics();await key('ArrowLeft',true);await pause(220);await key('ArrowLeft',false);
  const moved=await metrics();assert.ok(moved.x<before.x-20,'real native window moves left');
  await key('ArrowRight',true);await pause(180);assert.equal((await metrics()).action,'right');await key('ArrowRight',false);
  const ground=await metrics();await key('Space',true);await pause(170);
  const airborne=await metrics();assert.ok(airborne.y<ground.y-30,'native pet rises');assert.equal(airborne.action,'jump');
  await waitFor(async()=>(await state()).control.grounded);await pause(200);
  assert.ok(Math.abs((await metrics()).y-ground.y)<2,'lands and held space does not bounce again');await key('Space',false);
  // Reach right edge, including the transparent bubble margin.
  const {area}=await command('metrics');await key('ArrowRight',true);
  await waitFor(async()=>{const r=await metrics();return Math.abs(r.x+r.width-area.x-area.width)<2;},16000);await key('ArrowRight',false);
  let r=await metrics();assert.ok(Math.abs(r.y+r.height-area.y-area.height)<2,'feet reach work-area bottom');
  const platform=await command('icons');
  await waitFor(async()=>(await state()).control.iconInteraction?.kind==='target');
  await key('KeyE',true);await key('KeyE',false);assert.equal((await state()).control.carry,null,'distant overhead files cannot be picked up');
  await key('Space',true);await pause(120);assert.equal((await state()).control.iconInteraction?.kind,'jumping');await key('Space',false);
  await waitFor(async()=>(await state()).control.iconInteraction?.kind==='standing');
  r=await metrics();assert.ok(Math.abs(r.y+r.height-platform.y)<2,'feet rest on icon top');
  assert.ok(await evaluate(`document.querySelector('#bubble').textContent.includes('图标跳跃验收.md')`));
  await key('KeyE',true);await pause(80);assert.equal((await state()).control.carry?.phase,'picking-up');
  await waitFor(async()=>(await state()).control.carry?.phase==='carrying');
  await waitFor(()=>evaluate(`!document.querySelector('#pet-cargo').hidden && document.querySelector('#pet-cargo-image').complete && document.querySelector('#pet-cargo-image').naturalWidth>0`));
  await pause(200);assert.equal((await state()).control.carry.phase,'carrying','holding E does not put the item down');
  await key('ArrowLeft',true);await pause(130);await key('ArrowLeft',false);
  assert.equal((await state()).control.carry.phase,'carrying');
  await key('Space',true);await pause(120);assert.equal((await state()).control.grounded,false);
  assert.equal((await state()).control.carry.phase,'carrying');await key('Space',false);
  await waitFor(async()=>(await state()).control.grounded);
  const shot=await send('Page.captureScreenshot',{format:'png',omitBackground:true});
  fs.writeFileSync(path.join(os.tmpdir(),'dm-pet-control-e2e.png'),Buffer.from(shot.data,'base64'));
  fs.writeFileSync(path.join(os.tmpdir(),'dm-pet-carry-e2e.png'),Buffer.from(shot.data,'base64'));
  await key('KeyE',false);await key('KeyE',true);await pause(80);
  assert.equal((await state()).control.carry.phase,'putting-down');await key('KeyE',false);
  await waitFor(async()=>(await state()).control.carry===null);
  assert.equal(await evaluate(`document.querySelector('#pet-cargo').hidden`),true);
  assert.deepEqual(await command('icons-state'),[platform],'pickup and put-down never alter source icon layout');
  await key('KeyE',true);await key('KeyE',false);await waitFor(async()=>(await state()).control.carry?.phase==='carrying');
  await command('remove-icons');
  await waitFor(async()=>(await state()).control.iconCount===0);
  await waitFor(async()=>{const r=await metrics();return Math.abs(r.y+r.height-area.y-area.height)<2;});
  assert.equal((await state()).control.carry.phase,'carrying','the captured icon image remains until put down or exit');
  await key('Escape',true);await key('Escape',false);await waitFor(async()=>!(await state()).control.active);
  assert.equal(await evaluate(`document.querySelector('#pet-cargo').hidden`),true);
  await toggle();await key('ArrowLeft',true);await command('blur');await waitFor(async()=>!(await state()).control.active);
  const stopped=await metrics();await pause(180);assert.equal((await metrics()).x,stopped.x,'blur clears held input');
  await command('pixel');await toggle();await waitFor(async()=>(await state()).control.grounded);
  await key('ArrowLeft',true);await pause(150);assert.equal((await metrics()).action,'left');await key('ArrowLeft',false);
  await key('Space',true);await pause(130);assert.equal((await metrics()).action,'jump');await key('Space',false);
  await key('Escape',true);await key('Escape',false);await waitFor(async()=>!(await state()).control.active);
  console.log('PASS: default off, menu enable, native movement/jump/boundary, icon landing/removal, E pickup/carry/walk/jump/put-down/cleanup with unchanged source layout, Esc, blur and legacy pixel skin. Screenshot: ' + path.join(os.tmpdir(), 'dm-pet-carry-e2e.png'));
} finally {
  socket?.close(); if(!exited)child.kill('SIGTERM');
  await Promise.race([new Promise(resolve=>child.once('exit',resolve)),pause(2000)]);
  if(!exited)child.kill('SIGKILL');fs.rmSync(root,{recursive:true,force:true});
}
