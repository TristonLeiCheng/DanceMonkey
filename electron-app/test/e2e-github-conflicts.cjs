// Isolated Electron renderer smoke test. Uses the production conflict UI and
// deterministic API responses; backend Git round-trips are covered separately.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(require('electron'), [__filename], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow } = require('electron');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-conflict-ui-'));
const screenshot = path.join(os.tmpdir(), 'dm-sync-conflicts.png');
app.setPath('userData', directory);
let win;
(async () => {
  await app.whenReady();
  win = new BrowserWindow({ width: 1100, height: 1000, show: false, webPreferences: { contextIsolation: true, sandbox: true } });
  const runtimeErrors = [];
  win.webContents.on('console-message', event => { if (event.level === 'error') runtimeErrors.push(event.message); });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><html><meta charset="utf-8"><body style="margin:0;background:#17181b;font:14px system-ui"><main class="workspace-root" style="box-sizing:border-box;padding:24px"><div id="mount"></div></main></body></html>'));
  const cwd = path.join(__dirname, '..');
  for (const file of ['src/workspace.css', 'src/github-sync.css']) await win.webContents.insertCSS(fs.readFileSync(path.join(cwd, file), 'utf8'));
  await win.webContents.executeJavaScript(fs.readFileSync(path.join(cwd, 'src/github-sync-ui.js'), 'utf8'));
  await win.webContents.executeJavaScript(`(async () => {
    const paths = ['Notes/项目计划.md', 'Notes/旧记录.md'];
    window.effects = []; window.failures = []; window.cancelSync = true;
    const api = { githubSync: {
      status: async () => ({ success:true, root:'/测试笔记库', auth:{connected:true,login:'demo'}, sync:{binding:{owner:'demo',repo:'notes',branch:'main'}} }),
      preview: async () => ({success:true,id:'original',conflicts:paths,uploads:[],downloads:[],deletions:[],conflictDetails:[
        {path:paths[0], options:['local','remote','both','combine']},
        {path:paths[1], options:['local','remote','both'],remoteDeleted:true}
      ]}),
      inspectConflict: async ({path}) => ({success:true,path,local:{bytes:45,text:'# 项目计划\\n\\n周一：整理资料\\n周二：检查功能\\n<script>不执行</script>'},remote:{bytes:38,text:'# 项目计划\\n\\n周一：整理资料\\n周三：团队验收'}}),
      resolveConflicts: async input => { effects.push(['resolve',input]); return {success:true,id:'resolved',conflicts:[],uploads:[paths[0]],downloads:['Notes/项目计划.remote-abcd1234.md'],deletions:[{path:paths[1],side:'local'}],resolutions:input.resolutions.map(item=>({...item,...(item.strategy==='both'?{copyPath:'Notes/项目计划.remote-abcd1234.md'}:{})}))}; },
      sync: async input => { effects.push(['sync',input]); return {success:true,cancelled:cancelSync}; }
    }};
    const escape = value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
    window.ui = DMGitHubSyncUI.create(api,{esc:escape,attr:escape});
    await ui.load(); document.getElementById('mount').innerHTML=ui.render();
    document.addEventListener('click', event => {
      const button=event.target.closest('[data-module-action]');
      if (button && !button.disabled) { window.actionDone=ui.handleAction(button.dataset.moduleAction,button.dataset.id).catch(error=>failures.push(error.message)); }
    });
  })()`);
  const evaluate = code => win.webContents.executeJavaScript(code);
  const click = async (action, index = 0) => {
    await evaluate(`document.querySelectorAll('[data-module-action="${action}"]')[${index}].click();`);
    await evaluate('window.actionDone');
  };
  await click('github-preview');
  assert.equal(await evaluate('document.querySelector("[data-module-action=github-resolve]").disabled'), true);
  await click('github-conflict-both');
  await click('github-conflict-remote', 1);
  assert.equal(await evaluate('document.querySelectorAll("[aria-pressed=true]").length'), 2);
  assert.equal(await evaluate('document.querySelector("[data-module-action=github-resolve]").disabled'), false);
  await click('github-compare');
  assert.equal(await evaluate('document.querySelectorAll(".github-comparison pre").length'), 2);
  assert.equal(await evaluate('document.querySelectorAll(".github-comparison script").length'), 0);
  await evaluate('document.querySelector("[data-github-sync-step]").scrollIntoView()');
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  fs.writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());
  win.setSize(600, 1000);
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".github-comparison")).gridTemplateColumns.split(" ").length'), 1);
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
  await click('github-resolve');
  assert.equal(await evaluate('effects.filter(e=>e[0]==="sync").length'), 0);
  assert.equal(await evaluate('document.querySelector("[data-module-action=github-sync]").disabled'), false);
  await click('github-sync');
  assert.equal(await evaluate('effects.at(-1)[1].previewId'), 'resolved');
  assert.equal(await evaluate('document.body.textContent.includes("已取消，未执行同步")'), true);
  await evaluate('window.cancelSync=false'); await click('github-sync');
  assert.equal(await evaluate('document.body.textContent.includes("手动同步完成")'), true);
  assert.deepEqual(await evaluate('failures'), []); assert.deepEqual(runtimeErrors, []);
  console.log(`PASS: Electron clicks, escaped comparison, responsive layout, plan preview, cancellation and sync. Screenshot: ${screenshot}`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  win?.destroy(); app.quit(); fs.rmSync(directory, { recursive:true, force:true });
});
