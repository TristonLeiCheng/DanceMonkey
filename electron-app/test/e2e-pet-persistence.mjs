// Exercise the packaged application's real file:// renderer and persistent settings.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
const executable=process.env.DM_PET_E2E_EXECUTABLE;
assert.ok(executable,'DM_PET_E2E_EXECUTABLE must point to a packaged Mac executable');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'dm-packaged-pet-persistence-'));
const directory=path.join(root,'app-data/DanceMonkey');fs.mkdirSync(directory,{recursive:true});
const config=path.join(directory,'config.json');
fs.writeFileSync(config,JSON.stringify({petAnimal:'otter',petModeEnabled:true,petDisplaySize:128}));
const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let child,socket,exited=false,log='',serial=0;const pending=new Map();
async function wait(check,timeout=20000){const end=Date.now()+timeout;let error;while(Date.now()<end){try{const result=await check();if(result)return result;}catch(e){error=e;}await pause(80);}throw Error('Persistence test timeout: '+(error?.message||'')+'\n'+log);}
async function targets(){return fetch(`http://127.0.0.1:${port}/json`).then(r=>r.json());}
async function connect(target){socket?.close();socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});socket.onmessage=({data})=>{const m=JSON.parse(data);pending.get(m.id)?.(m);pending.delete(m.id);};}
async function evaluate(expression){const id=++serial;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout'));},10000);pending.set(id,m=>{clearTimeout(timer);if(m.result?.exceptionDetails)reject(Error(m.result.exceptionDetails.text));else resolve(m.result?.result?.value);});socket.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));});}
async function launch(animal){
  exited=false;log='';
  child=spawn(executable,['--no-proxy-server','--use-mock-keychain'],{env:{...process.env,DM_E2E_ROOT:root,DM_E2E_PORT:String(port)},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',b=>log=(log+b).slice(-4000));child.stderr.on('data',b=>log=(log+b).slice(-4000));child.once('exit',()=>exited=true);
  const pet=await wait(async()=>{if(exited)throw Error('Application exited');return(await targets()).find(t=>t.url.endsWith('/pet.html'));});
  await connect(pet);
  await wait(()=>evaluate(`window.desktopPet?.get().then(s=>s?.animal===${JSON.stringify(animal)}&&s.size===128)`));
  await wait(()=>evaluate(`document.querySelector('#pet').dataset.assetStatus===${JSON.stringify(animal==='future-pet'?'unsupported':'ready')}`));
  assert.equal(JSON.parse(fs.readFileSync(config)).petAnimal,animal);
  const overlay=await wait(async()=>(await targets()).find(t=>t.url.includes('/index.html')&&!t.url.includes('#workspace')));
  await connect(overlay);await wait(()=>evaluate('Boolean(window.lumen?.settings)'));
}
async function quit(){await evaluate('window.lumen.quitApp(); true');await wait(()=>exited,20000);socket.close();socket=null;}
try {
  await launch('otter');await quit();
  await launch('otter');
  await evaluate(`window.lumen.settings.save({petAnimal:'future-pet'})`);await quit();
  await launch('future-pet');
  await evaluate(`window.lumen.settings.save({globalChatHotkey:'Ctrl+Alt+Q'})`);
  assert.equal(JSON.parse(fs.readFileSync(config)).petAnimal,'future-pet');
  await evaluate(`window.lumen.settings.save({petAnimal:'fluffy-rabbit'})`);await quit();
  await launch('fluffy-rabbit');await quit();
  console.log('Packaged Mac persistence passed: otter survives restart; unsupported skin survives restart and unrelated saves; fluffy rabbit survives restart. All runs used isolated user data.');
} finally {
  socket?.close();if(child&&!exited){child.kill('SIGKILL');await pause(200);}
  fs.rmSync(root,{recursive:true,force:true});
}
