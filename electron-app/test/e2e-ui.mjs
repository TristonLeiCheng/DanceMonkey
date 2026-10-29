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
  const electron = start("Electron", path.resolve(cwd, "node_modules/.bin/electron"), ["--no-proxy-server", "."], {
    DM_E2E_ROOT: root,
    DM_E2E_PORT: String(debugPort),
    DM_E2E_SERVER_PORT: String(serverPort),
  });
  const target = await waitFor(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
    return targets.find((item) => item.type === "page" && !item.url.includes("#workspace") && item.url.includes(`127.0.0.1:${serverPort}`));
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
    if (response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.text);
    return response.result?.result?.value;
  };

  // The disposable Electron userData directory guarantees first-run (unset) preferences.
  await evaluate(`window.lumen.openWorkspace("notes")`);
  const workspace = await waitFor(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
    return targets.find((item) => item.type === "page" && item.id !== target.id && item.url.includes(`127.0.0.1:${serverPort}`) && item.url.includes("#workspace"));
  }, { process: electron });
  socket.close();
  await connect(workspace.webSocketDebuggerUrl);

  await waitFor(() => evaluate(`location.hash.startsWith("#workspace") && document.readyState === "complete"`), { process: electron });
  await waitFor(() => evaluate(`window.lumen.getAppVersion().then(version => document.querySelector(".ws-brand")?.textContent.includes("v" + version))`), { process: electron });
  assert.equal(await evaluate(`localStorage.getItem("lumen-workspace-opacity") === null && document.querySelector(".ws-opacity")?.value === "82"`), true);
  assert.equal(await evaluate(`document.querySelectorAll(".ws-theme-select option").length >= 6`), true);
  assert.equal(await evaluate(`(()=>{const button=document.querySelector('.tree-expander'); return button?.tagName === 'BUTTON' && button.getAttribute('aria-expanded') === 'true' && button.getAttribute('aria-label').includes('折叠文件夹')})()`), true);
  await evaluate(`document.querySelector('.tree-expander').click()`);
  assert.equal(await evaluate(`JSON.parse(localStorage.getItem(window.DMTreeState.storageKey(document.querySelector('.ws-vault-path').title))).length === 0 && document.querySelector('.tree-expander').getAttribute('aria-expanded') === 'false'`), true);
  await evaluate(`window.__e2eBeforeReload = true; location.reload()`);
  await waitFor(() => evaluate(`!window.__e2eBeforeReload && document.readyState === "complete" && document.querySelector('.tree-expander')?.getAttribute('aria-expanded') === 'false'`), { process: electron });
  await evaluate(`(()=>{const button=document.querySelector('.tree-expander'); button.focus(); button.click()})()`);
  assert.equal(await evaluate(`document.querySelector('.tree-expander').getAttribute('aria-expanded') === 'true' && JSON.parse(localStorage.getItem(window.DMTreeState.storageKey(document.querySelector('.ws-vault-path').title))).length === 1`), true);
  assert.equal(await evaluate(`Boolean(document.querySelector('.tree-name[data-action="tree-open"]'))`), true);
  assert.equal(await evaluate(`Boolean(document.querySelector('.tree-expander svg')) && getComputedStyle(document.querySelector('.tree-expander')).borderTopWidth === '0px'`), true);
  // A selected nested folder must not prevent explicit creation at the vault root.
  await evaluate(`document.querySelector('.tree-row[data-type="folder"] .tree-name').click(); document.querySelector('[data-action="new-root-folder"]').click()`);
  assert.equal(await evaluate(`document.querySelector('.ws-parent-select').value`), "");
  await evaluate(`document.querySelector('.ws-dialog-input').value = '工作资料'; document.querySelector('[data-dialog="confirm"]').click()`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('.tree-row[data-path="工作资料"]'))`), { process: electron });
  await evaluate(`document.querySelector('[data-action="new-folder"]').click()`);
  assert.equal(await evaluate(`document.querySelector('.ws-parent-select').value`), "工作资料");
  await evaluate(`document.querySelector('.ws-dialog-input').value = '会议记录'; document.querySelector('[data-dialog="confirm"]').click()`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('.tree-row[data-path="工作资料/会议记录"]'))`), { process: electron });
  await evaluate(`document.querySelector('[data-action="new-file"]').click(); document.querySelector('.ws-dialog-input').value = '本周计划'; document.querySelector('[data-dialog="confirm"]').click()`);
  await waitFor(() => evaluate(`document.querySelector('.ws-doc-name')?.textContent === '本周计划.md'`), { process: electron });
  await evaluate(`document.querySelector('[data-action="select-root"]').click(); document.querySelector('[data-action="new-folder"]').click()`);
  assert.equal(await evaluate(`document.querySelector('.ws-parent-select').value`), "");
  await evaluate(`document.querySelector('[data-dialog="cancel"]').click()`);
  if (process.env.DM_E2E_NOTES_SCREENSHOT) {
    const capture = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(process.env.DM_E2E_NOTES_SCREENSHOT, Buffer.from(capture.result.data, "base64"));
  }
  await evaluate(`(()=>{ const select=document.querySelector(".ws-theme-select"); select.value="frost-green"; select.dispatchEvent(new Event("change",{bubbles:true})); const opacity=document.querySelector(".ws-opacity"); opacity.value="67"; opacity.dispatchEvent(new Event("input",{bubbles:true})); opacity.dispatchEvent(new Event("change",{bubbles:true})); })()`);
  assert.equal(await evaluate(`localStorage.getItem("lumen-workspace-theme") === "frost-green" && localStorage.getItem("lumen-workspace-opacity") === "67"`), true);
  if (process.env.DM_E2E_NOTES_LIGHT_SCREENSHOT) {
    const capture = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(process.env.DM_E2E_NOTES_LIGHT_SCREENSHOT, Buffer.from(capture.result.data, "base64"));
  }
  await evaluate(`document.querySelector('[data-action="maximize"]').click()`);
  await waitFor(() => evaluate(`document.querySelector(".workspace-root").classList.contains("maximized")`), { process: electron });
  assert.equal(await evaluate(`getComputedStyle(document.querySelector(".workspace-root")).padding === "0px"`), true);
  for (const effect of ["solid", "paper"]) {
    await evaluate(`document.querySelector('[data-action="effect"][data-value="${effect}"]').click()`);
    const surfaceColors = await evaluate(`(()=>({root:getComputedStyle(document.querySelector(".workspace-root")).backgroundColor,frame:getComputedStyle(document.querySelector(".workspace-frame")).backgroundColor}))()`);
    assert.equal(surfaceColors.root, surfaceColors.frame, `${effect} maximized surfaces differ: ${JSON.stringify(surfaceColors)}`);
  }
  await evaluate(`document.querySelector('[data-action="maximize"]').click()`);
  await waitFor(() => evaluate(`!document.querySelector(".workspace-root").classList.contains("maximized")`), { process: electron });
  if (!await evaluate(`Boolean(document.querySelector(".ws-editor"))`)) await evaluate(`window.lumen.workspace.createFile("", "e2e.md").then(() => location.reload())`);
  await waitFor(() => evaluate(`Boolean(document.querySelector(".ws-editor"))`), { process: electron });
  await evaluate(`(async()=>{ await window.lumen.zenTask.addProject({name:"UI 发布",status:"Blocked",lifecycleStatus:"In Progress",milestones:[{id:"ui-stage",name:"UI 验收",dueDate:"2020-01-01"}]}); const editor=document.querySelector(".ws-editor"); editor.value="- [ ] 完成 UI 验收\\n- [ ] 返回来源笔记"; editor.dispatchEvent(new Event("input",{bubbles:true})); editor.setSelectionRange(0,editor.value.length); document.querySelector('[data-action="note-to-tasks"]').click(); })()`);
  await waitFor(() => evaluate(`Boolean(document.querySelector(".ws-note-task-dialog"))`), { process: electron });
  assert.equal(await evaluate(`document.querySelectorAll("[data-candidate]").length`), 2);
  await evaluate(`(()=>{ const stage=document.querySelector('[name="milestoneId"]'); stage.value="ui-stage"; stage.dispatchEvent(new Event("change",{bubbles:true})); document.querySelector(".ws-note-task-dialog").requestSubmit(); })()`);
  await waitFor(() => evaluate(`document.body.textContent.includes("已创建 2 项任务")`), { process: electron });
  await evaluate(`document.querySelector("[data-note-task-project]").click()`);
  await waitFor(() => evaluate(`document.body.textContent.includes("完成 UI 验收") && document.body.textContent.includes("里程碑 · UI 验收")`), { process: electron });
  await evaluate(`document.querySelector('[data-module-action="pm-back"]').click()`);
  await waitFor(() => evaluate(`document.body.textContent.includes("Needs attention")`), { process: electron });
  assert.equal(await evaluate(`document.body.textContent.includes("项目健康度受阻") && document.body.textContent.includes("里程碑已逾期")`), true);
  await evaluate(`document.querySelector('[data-module-action="pm-attention"]').click()`);
  await waitFor(() => evaluate(`document.body.textContent.includes("完成 UI 验收")`), { process: electron });
  await evaluate(`document.querySelector('[data-module-action="pm-open-task-source"]').click()`);
  await waitFor(() => evaluate(`Boolean(document.querySelector(".ws-editor"))`), { process: electron });
  // Exercise the real IPC editor handshake without GitHub credentials or any network sync.
  const githubState = await evaluate(`window.lumen.githubSync.status()`);
  assert.equal(githubState.success, true);
  assert.equal(githubState.auth.connected, false);
  assert.equal(githubState.root.startsWith(fs.realpathSync(root)), true);
  const syncWithoutBinding = await evaluate(`(async()=>{ const editor=document.querySelector('.ws-editor'); editor.value='GitHub flush test'; editor.dispatchEvent(new Event('input',{bubbles:true})); return window.lumen.githubSync.preview(); })()`);
  assert.equal(syncWithoutBinding.success, false);
  assert.match(syncWithoutBinding.error, /绑定/);
  assert.equal(await evaluate(`document.getElementById('root').inert`), false);
  assert.equal(await evaluate(`document.querySelector('.ws-editor').value`), "GitHub flush test");
  assert.equal(await evaluate(`document.querySelector('.ws-save-state').textContent`), "已保存");
  // Model downloaded JSON on disk, then run the real editor resume handshake.
  // The unbound preview still prepares/resumes both windows without contacting GitHub.
  await evaluate(`document.querySelector('[data-action="section"][data-value="projects"]').click()`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('.pm-task-title'))`), { process: electron });
  const syncedTaskFile = path.join(githubState.root, "Journal", "task-module.json");
  const syncedProjectFile = path.join(githubState.root, "Journal", "zentask-projects.json");
  const syncedTasks = JSON.parse(fs.readFileSync(syncedTaskFile, "utf8"));
  const syncedProjects = JSON.parse(fs.readFileSync(syncedProjectFile, "utf8"));
  syncedTasks.Items[0].Title = "另一设备更新的任务";
  syncedProjects.Items[0].Name = "另一设备更新的项目";
  fs.writeFileSync(syncedTaskFile, JSON.stringify(syncedTasks));
  fs.writeFileSync(syncedProjectFile, JSON.stringify(syncedProjects));
  const refreshedTasks = await evaluate(`window.lumen.githubSync.preview()`);
  assert.match(refreshedTasks.error, /绑定/);
  assert.equal(await evaluate(`document.body.textContent.includes('另一设备更新的项目') && document.body.textContent.includes('另一设备更新的任务') && Boolean(document.querySelector('.pm-task-title'))`), true);

  // A sync requested while a task form is open must preserve its unsaved DOM draft.
  await evaluate(`document.querySelector('.pm-task-title').click()`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('form.module-modal input[name="title"]'))`), { process: electron });
  await evaluate(`window.__taskDraftInput = document.querySelector('form.module-modal input[name="title"]'); window.__taskDraftInput.value = '尚未保存的任务草稿'; window.__taskDraftInput.dispatchEvent(new Event('input',{bubbles:true}));`);
  const blockedTaskDraft = await evaluate(`window.lumen.githubSync.preview()`);
  assert.equal(blockedTaskDraft.success, false);
  assert.match(blockedTaskDraft.error, /任务\/项目编辑/);
  assert.equal(await evaluate(`document.querySelector('form.module-modal input[name="title"]') === window.__taskDraftInput && window.__taskDraftInput.value === '尚未保存的任务草稿' && !document.getElementById('root').inert`), true);
  assert.equal(fs.readFileSync(syncedTaskFile, "utf8").includes("尚未保存的任务草稿"), false);
  await evaluate(`document.querySelector('[data-module-action="close-modal"]').click()`);
  await evaluate(`document.querySelector('[data-action="section"][data-value="settings"]').click()`);
  await waitFor(() => evaluate(`document.body.textContent.includes('GitHub 笔记同步')`), { process: electron });
  assert.equal(await evaluate(`Boolean(document.querySelector('[data-app-update-slot="settings"]')) && !document.querySelector('[name="updateManifestUrl"], [name="updateGitHubRepo"], [name="updateAssetKeyword"]')`), true);
  assert.equal(await evaluate(`!document.querySelector('[data-app-update-slot="settings"]').textContent.match(/安装目录|更新目录|GitHub|URL|UNC/)`), true);
  // Settings tabs retain the same DOM drafts, support keyboard navigation and save hidden fields.
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('[data-settings-tab]'), tab => tab.dataset.settingsTab)`), ['shortcuts', 'pet', 'sync', 'network', 'about']);
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('[data-settings-panel]')).filter(panel => getComputedStyle(panel).display !== 'none').map(panel => panel.dataset.settingsPanel)`), ['shortcuts']);
  await evaluate(`(() => {
    window.__settingsDraft = document.querySelector('[name="globalChatHotkey"]');
    window.__settingsDraft.value = 'Ctrl+Alt+K';
    document.querySelector('[data-settings-tab="pet"]').click();
    document.querySelector('[name="petDisplaySize"]').value = '128';
    document.querySelector('[name="todoReminderEnabled"]').checked = true;
  })()`);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('[name="petModeEnabled"]').closest('label')).flexDirection`), 'row');
  await evaluate(`document.querySelector('[data-settings-tab="pet"]').dispatchEvent(new KeyboardEvent('keydown', {key:'End', bubbles:true}))`);
  assert.equal(await evaluate(`document.activeElement.dataset.settingsTab === 'about' && document.querySelector('[data-settings-actions]').hidden && getComputedStyle(document.querySelector('[data-settings-panel="about"]')).display !== 'none'`), true);
  await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'Home', bubbles:true})); document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowRight', bubbles:true}))`);
  assert.equal(await evaluate(`document.activeElement.dataset.settingsTab`), 'pet');
  await evaluate(`document.querySelector('[data-settings-tab="sync"]').click(); window.__githubDraft = document.querySelector('[data-github-field="clientId"]'); window.__githubOriginal = window.__githubDraft.value; window.__githubDraft.value='unsaved-tab-draft'; document.querySelector('[data-settings-tab="shortcuts"]').click()`);
  assert.equal(await evaluate(`document.querySelector('[name="globalChatHotkey"]') === window.__settingsDraft && window.__settingsDraft.value === 'Ctrl+Alt+K' && document.querySelector('[name="petDisplaySize"]').value === '128' && document.querySelector('[data-github-field="clientId"]') === window.__githubDraft && window.__githubDraft.value === 'unsaved-tab-draft'`), true);
  await evaluate(`document.querySelector('[data-module-action="settings-save"]').click()`);
  await waitFor(() => evaluate(`document.querySelector('.ws-settings-page > .ws-settings-ok')?.textContent.includes('已保存')`), {process:electron});
  const tabSettings = await evaluate(`window.lumen.settings.get()`);
  assert.equal(tabSettings.globalChatHotkey, 'Ctrl+Alt+K'); assert.equal(tabSettings.petDisplaySize, 128); assert.equal(tabSettings.todoReminderEnabled, true);
  assert.equal(await evaluate(`document.querySelector('[data-github-field="clientId"]').value === 'unsaved-tab-draft' && document.querySelector('[data-settings-tab="shortcuts"]').getAttribute('aria-selected') === 'true'`), true);
  // A validation error must keep the user's drafts, including fields in other tabs.
  await evaluate(`document.querySelector('[name="globalChatHotkey"]').value='Q'; document.querySelector('[data-module-action="settings-save"]').click()`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('.ws-settings-page > .module-error'))`), {process:electron});
  assert.equal(await evaluate(`document.querySelector('[name="globalChatHotkey"]').value === 'Q' && document.querySelector('[name="petDisplaySize"]').value === '128'`), true);
  await evaluate(`document.querySelector('[data-module-action="settings-reload"]').click()`);
  await waitFor(() => evaluate(`document.querySelector('[name="globalChatHotkey"]').value === 'Ctrl+Alt+K'`), {process:electron});
  await evaluate(`document.querySelector('[data-github-field="clientId"]').value=window.__githubOriginal`);
  if (process.env.DM_E2E_SETTINGS_OUTPUT) {
    fs.mkdirSync(process.env.DM_E2E_SETTINGS_OUTPUT, { recursive: true });
    for (const tab of ['shortcuts', 'pet', 'sync', 'about']) {
      await evaluate(`document.querySelector('[data-settings-tab="${tab}"]').click()`);
      const capture = await send('Page.captureScreenshot', {format: 'png'});
      fs.writeFileSync(path.join(process.env.DM_E2E_SETTINGS_OUTPUT, `${tab}.png`), Buffer.from(capture.result.data, 'base64'));
    }
    await send('Emulation.setDeviceMetricsOverride', {width:820,height:600,deviceScaleFactor:1,mobile:false});
    await evaluate(`document.querySelector('[data-settings-tab="pet"]').click()`);
    assert.equal(await evaluate(`Array.from(document.querySelectorAll('[data-settings-tab]')).every(tab => { const r=tab.getBoundingClientRect(); return r.x >= 0 && r.right <= innerWidth; })`), true);
    const capture = await send('Page.captureScreenshot', {format: 'png'});
    fs.writeFileSync(path.join(process.env.DM_E2E_SETTINGS_OUTPUT, 'pet-compact.png'), Buffer.from(capture.result.data, 'base64'));
    await send('Emulation.clearDeviceMetricsOverride');
    await evaluate(`document.querySelector('[data-settings-tab="shortcuts"]').click()`);
  }
  // Simulate a background notification in the real slots and retain unrelated form inputs.
  await evaluate(`(() => {
    window.__updateDraft = document.querySelector('[name="globalChatHotkey"]');
    window.__updateDraft.value = 'Ctrl+Alt+K';
    window.__updateUI = window.DMAppUpdateUI.create({appUpdate: {
      onState: cb => { window.__updateNotify = cb; },
      apply: async () => ({success:false,error:'请等待当前任务完成后再更新。'})
    }}, {esc: value => String(value).replaceAll('<','&lt;')});
    window.__updateNotify({supported:true,phase:'ready',latestVersion:'3.6.0',currentVersion:'3.5.0',message:'更新已准备好'});
  })()`);
  assert.equal(await evaluate(`document.querySelector('.ws-update-restart')?.textContent === '更新并重启' && document.querySelector('[name="globalChatHotkey"]') === window.__updateDraft && window.__updateDraft.value === 'Ctrl+Alt+K'`), true);
  await send("Emulation.setDeviceMetricsOverride", {width:820,height:600,deviceScaleFactor:1,mobile:false});
  assert.equal(await evaluate(`(() => {const b=document.querySelector('.ws-update-restart').getBoundingClientRect(); const c=document.querySelector('[data-action="close-window"]').getBoundingClientRect();return b.x>=0 && b.right<=c.x && c.right<=innerWidth})()`), true);
  if (process.env.DM_E2E_UPDATE_SCREENSHOT) {
    const capture = await send("Page.captureScreenshot", {format:"png"});
    fs.writeFileSync(process.env.DM_E2E_UPDATE_SCREENSHOT, Buffer.from(capture.result.data,"base64"));
  }
  await send("Emulation.clearDeviceMetricsOverride");
  await evaluate(`window.__updateUI.handleAction('app-update-apply')`);
  assert.equal(await evaluate(`document.querySelector('.ws-update-notice')?.textContent.includes('请等待')`), true);
  await evaluate(`document.querySelector('[data-action="section"][data-value="settings"]').click()`);
  await waitFor(() => evaluate(`!document.querySelector('.ws-update-restart')`), {process:electron});
  await evaluate(`document.querySelector('[data-settings-tab="sync"]').click()`);
  assert.equal(await evaluate(`document.body.textContent.includes('Client ID')`), true);
  assert.equal(await evaluate(`document.querySelector('[data-github-advanced]').open`), false);
  assert.equal(await evaluate(`document.querySelectorAll('.github-step').length`), 3);
  assert.equal(await evaluate(`document.querySelector('[data-module-action="github-create"]').disabled`), true);
  if (process.env.DM_E2E_SCREENSHOT) {
    await evaluate(`document.querySelector('.ws-github-sync')?.scrollIntoView({block:'start'})`);
    const capture = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(process.env.DM_E2E_SCREENSHOT, Buffer.from(capture.result.data, "base64"));
  }
  // Release builds have real public App identifiers. Never start live authorization in E2E.
  assert.equal(await evaluate(`typeof window.lumen.githubSync.startAuth`), "function");
  await evaluate(`document.querySelector('[data-github-advanced]').open = true`);
  await evaluate(`(()=>{ const client=document.querySelector('[data-github-field="clientId"]'); client.value='bad'; document.querySelector('[data-module-action="github-configure"]').click(); })()`);
  await waitFor(() => evaluate(`document.querySelector('.ws-github-sync .module-error')?.textContent.includes('Client ID')`), { process: electron });
  await evaluate(`(()=>{ document.querySelector('[data-github-field="clientId"]').value='Iv1.e2e-fake-client'; document.querySelector('[data-github-field="appSlug"]').value='e2e-notes-app'; document.querySelector('[data-module-action="github-configure"]').click(); })()`);
  await waitFor(() => evaluate(`document.querySelector('.ws-github-sync .ws-settings-ok')?.textContent.includes('已保存')`), { process: electron });
  const configured = await evaluate(`window.lumen.githubSync.status()`);
  assert.equal(configured.auth.clientId, "Iv1.e2e-fake-client");
  assert.equal(configured.auth.connected, false);
  assert.equal(await evaluate(`document.querySelector('[data-module-action="github-connect"]').disabled`), false);
  assert.equal(await evaluate(`document.querySelector('[data-module-action="github-preview"]').disabled`), true);
  // Switch through the real dropdown; same relative names must never carry content or tree state across vaults.
  await evaluate(`document.querySelector('[data-action="section"][data-value="notes"]').click()`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('.ws-vault-select'))`), { process: electron });
  const vaultList = await evaluate(`window.lumen.vaults.list()`);
  const originalRoot = vaultList.activeRoot;
  const otherRoot = vaultList.vaults.find((vault) => vault.root !== originalRoot)?.root;
  assert.ok(otherRoot, "the isolated fixture must register a second vault");
  const notePath = "工作资料/会议记录/本周计划.md";
  await evaluate(`document.querySelector(${JSON.stringify(`.tree-row[data-path="${notePath}"] .tree-name`)}).click()`);
  await evaluate(`window.lumen.setState({ notes: [{ id: 'vault-a-quick-note', notebookId: 'inbox', title: 'A 库便签', body: '只属于 A 库', updatedAt: Date.now() }], activeNoteId: 'vault-a-quick-note' })`);
  await waitFor(() => evaluate(`document.querySelector('.ws-doc-name')?.textContent === '本周计划.md' && Boolean(document.querySelector('.tree-row[data-path="Journal"]'))`), { process: electron });
  const originalExpanded = await evaluate(`localStorage.getItem(window.DMTreeState.storageKey(${JSON.stringify(originalRoot)}))`);
  await evaluate(`(()=>{ const editor=document.querySelector('.ws-editor'); editor.value='A 库切换前未保存的内容'; editor.dispatchEvent(new Event('input',{bubbles:true})); const select=document.querySelector('.ws-vault-select'); select.value=${JSON.stringify(otherRoot)}; select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await waitFor(() => evaluate(`document.querySelector('.ws-vault-path')?.title === ${JSON.stringify(otherRoot)} && !document.getElementById('root').inert`), { process: electron });
  assert.equal(fs.readFileSync(path.join(originalRoot, notePath), "utf8"), "A 库切换前未保存的内容");
  assert.equal(await evaluate(`Boolean(document.querySelector('.ws-editor'))`), false);
  assert.equal(await evaluate(`Boolean(document.querySelector('.tree-row[data-path="仅B目录"]'))`), true);
  const otherState = await evaluate(`window.lumen.githubSync.status()`);
  assert.equal(otherState.root, otherRoot);
  assert.equal(otherState.sync.binding, null);
  assert.equal((await evaluate(`window.lumen.zenTask.load()`)).tasks.length, 0);
  assert.equal((await evaluate(`window.lumen.getState()`)).notes.length, 0);
  await evaluate(`document.querySelector('.tree-row[data-path="工作资料/会议记录"] .tree-expander').click()`);
  await evaluate(`document.querySelector(${JSON.stringify(`.tree-row[data-path="${notePath}"] .tree-name`)}).click()`);
  await waitFor(() => evaluate(`document.querySelector('.ws-editor')?.value === 'B 库独立内容'`), { process: electron });
  await evaluate(`document.querySelector('.tree-row[data-path="工作资料"] .tree-expander').click()`);
  const otherExpanded = await evaluate(`localStorage.getItem(window.DMTreeState.storageKey(${JSON.stringify(otherRoot)}))`);
  await evaluate(`(()=>{const select=document.querySelector('.ws-vault-select'); select.value=${JSON.stringify(originalRoot)}; select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await waitFor(() => evaluate(`document.querySelector('.ws-vault-path')?.title === ${JSON.stringify(originalRoot)} && !document.getElementById('root').inert`), { process: electron });
  assert.equal(await evaluate(`localStorage.getItem(window.DMTreeState.storageKey(${JSON.stringify(originalRoot)}))`), originalExpanded);
  assert.equal(await evaluate(`Boolean(document.querySelector('.tree-row[data-path="仅B目录"]'))`), false);
  assert.equal((await evaluate(`window.lumen.zenTask.load()`)).tasks.length, 2);
  const restoredNotes = (await evaluate(`window.lumen.getState()`)).notes;
  assert.equal(restoredNotes.length, 1);
  assert.equal(restoredNotes[0].body, "只属于 A 库");
  await evaluate(`document.querySelector(${JSON.stringify(`.tree-row[data-path="${notePath}"] .tree-name`)}).click()`);
  await waitFor(() => evaluate(`document.querySelector('.ws-editor')?.value === 'A 库切换前未保存的内容'`), { process: electron });
  await evaluate(`(()=>{const select=document.querySelector('.ws-vault-select'); select.value=${JSON.stringify(otherRoot)}; select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await waitFor(() => evaluate(`document.querySelector('.ws-vault-path')?.title === ${JSON.stringify(otherRoot)} && !document.getElementById('root').inert`), { process: electron });
  assert.equal(await evaluate(`localStorage.getItem(window.DMTreeState.storageKey(${JSON.stringify(otherRoot)}))`), otherExpanded);
  assert.equal(await evaluate(`document.querySelector('.tree-row[data-path="工作资料"] .tree-expander').getAttribute('aria-expanded')`), "false");
  assert.equal(fs.readFileSync(path.join(otherRoot, notePath), "utf8"), "B 库独立内容");
  await evaluate(`window.__vaultReload = true; location.reload()`);
  await waitFor(() => evaluate(`!window.__vaultReload && document.querySelector('.ws-vault-path')?.title === ${JSON.stringify(otherRoot)}`), { process: electron });
  assert.equal(await evaluate(`document.querySelector('.tree-row[data-path="工作资料"] .tree-expander').getAttribute('aria-expanded')`), "false");
  // PKB setup preview is non-mutating. Seed only the isolated fixture, never bypass production confirmation.
  await evaluate(`document.querySelector('[data-action="pkb-setup"]').click()`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('[data-pkb="initialize"]'))`), { process: electron });
  assert.equal(fs.existsSync(path.join(otherRoot, "_System/pkb.json")), false);
  await evaluate(`document.querySelector('[data-pkb="cancel"]').click()`);
  createPkb(otherRoot).initialize();
  await evaluate(`document.querySelector('[data-action="refresh"]').click()`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('.tree-row[data-path="30_Knowledge"]'))`), { process: electron });
  await evaluate(`document.querySelector('[data-action="pkb-note"]').click()`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('.ws-pkb-type'))`), { process: electron });
  await evaluate(`(()=>{document.querySelector('.ws-dialog-input').value='PKB 验收';document.querySelector('[data-pkb="create"]').click();})()`);
  await waitFor(() => evaluate(`document.querySelector('.ws-editor')?.value.includes('PKB 验收')`), { process: electron });
  const createdText = await evaluate(`document.querySelector('.ws-editor').value`);
  assert.match(createdText, /id:/);
  assert.match(createdText, /sensitivity:/);
  await evaluate(`(()=>{const e=document.querySelector('.ws-editor');e.value+='\\n正文唯一检索词 pkb-body-needle';e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'s',ctrlKey:true,bubbles:true}))`);
  await waitFor(() => evaluate(`document.querySelector('.ws-save-state')?.textContent === '已保存'`), { process: electron });
  await evaluate(`document.querySelector('[data-action="pkb-search"]').click()`);
  await evaluate(`(()=>{const e=document.querySelector('.ws-palette-input');e.value='pkb-body-needle';e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('[data-palette-path]'))`), { process: electron });
  assert.equal(await evaluate(`document.querySelector('.ws-palette-list').textContent.includes('pkb-body-needle')`), true);
  await evaluate(`document.querySelector('[data-palette-path]').click()`);
  await waitFor(() => evaluate(`!document.querySelector('.ws-palette-backdrop') && document.querySelector('.ws-editor')?.value.includes('pkb-body-needle')`), { process: electron });
  if (process.env.DM_E2E_PKB_SCREENSHOT) {
    const capture = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(process.env.DM_E2E_PKB_SCREENSHOT, Buffer.from(capture.result.data, "base64"));
  }
  // A single click must terminate the whole Electron application after saving dirty notes.
  const quitRoot = await evaluate(`window.lumen.workspace.list().then(result => result.root)`);
  const quitPath = await evaluate(`document.querySelector('.ws-current-path').textContent`);
  assert.equal(await evaluate(`document.querySelector('[data-action="quit-app"]')?.textContent`), "退出");
  await evaluate(`(() => { const editor=document.querySelector('.ws-editor'); editor.value+='\\n退出前立即保存 e2e-quit-save'; editor.dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('[data-action="quit-app"]').click(); return true; })()`);
  await waitFor(() => electron.exited, {timeout:15000});
  assert.equal(electron.code, 0, electron.output);
  assert.equal(fs.readFileSync(path.join(quitRoot, quitPath), "utf8").includes('e2e-quit-save'), true);
  // Relaunch and verify the compact panel's power button also exits with one click.
  const panelRun = start("Electron panel quit", path.resolve(cwd, "node_modules/.bin/electron"), ["--no-proxy-server", "."], {
    DM_E2E_ROOT:root, DM_E2E_PORT:String(debugPort), DM_E2E_SERVER_PORT:String(serverPort),
  });
  const panelTarget = await waitFor(async () => {
    const targets=await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
    return targets.find(item=>item.type==='page' && !item.url.includes('#workspace') && item.url.includes(`127.0.0.1:${serverPort}`));
  }, {process:panelRun});
  socket.close(); await connect(panelTarget.webSocketDebuggerUrl);
  await waitFor(() => evaluate(`Boolean(document.querySelector('[data-act="quit"]'))`), {process:panelRun});
  await evaluate(`document.querySelector('[data-act="quit"]').click(); true`);
  await waitFor(() => panelRun.exited, {timeout:15000});
  assert.equal(panelRun.code, 0, panelRun.output);
  console.log(`UI E2E passed on isolated ports ${serverPort}/${debugPort}: settings tabs and drafts, root creation, notes/projects, per-vault state, GitHub settings, PKB preview/templates/full-text search, complete app exit with dirty-note save, single-click panel exit (no remote access)`);
} finally {
  try { socket?.close(); } catch {}
  for (const record of children.reverse()) await stop(record);
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
}
