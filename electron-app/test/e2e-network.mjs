import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const cwd = path.resolve(import.meta.dirname, "..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dm-network-e2e-"));
const children = [];
const sockets = [];
const requests = [];
const screenshots = [];
const screenshotDirectory = process.env.DM_NETWORK_SCREENSHOT_DIR && path.resolve(process.env.DM_NETWORK_SCREENSHOT_DIR);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let mock, proxy, pac;
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

try {
  const tunnels = [], liveSockets = new Set(), proxiedPorts = new Set(), deliveries = []; let slow = false;
  const track = server => server.on('connection', socket => { liveSockets.add(socket); socket.once('close', () => liveSockets.delete(socket)); });
  mock = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    deliveries.push(proxiedPorts.has(req.socket.remotePort) ? 'proxy' : 'direct');
    const respond = () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] })); };
    if (slow) { const timer = setTimeout(respond, 10000); res.once('close', () => clearTimeout(timer)); }
    else respond();
  });
  track(mock); await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const modelPort = mock.address().port;
  proxy = http.createServer(); track(proxy);
  proxy.on('connect', (req, socket, head) => {
    const url = new URL(`http://${req.url}`); assert.equal(Number(url.port), modelPort);
    assert.ok(['model.test', '127.0.0.1'].includes(url.hostname)); tunnels.push(req.url);
    const upstream = net.connect({ host: '127.0.0.1', port: modelPort }, () => {
      proxiedPorts.add(upstream.localPort);
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head);
      upstream.pipe(socket); socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy()); socket.on('close', () => upstream.destroy());
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const proxyPort = proxy.address().port, deadPort = await freePort();
  pac = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/x-ns-proxy-autoconfig' }); res.end(`function FindProxyForURL(url, host) { return host === 'model.test' ? 'PROXY 127.0.0.1:${deadPort}; PROXY 127.0.0.1:${proxyPort}' : 'DIRECT'; }`); });
  track(pac); await new Promise(resolve => pac.listen(0, '127.0.0.1', resolve));
  const sourceRoot = process.env.DM_NETWORK_ASAR || cwd;
  const configDirectory = path.join(root, 'app-data', 'DanceMonkey'), vault = path.join(root, 'documents', 'NoteVault');
  fs.mkdirSync(configDirectory, { recursive: true }); fs.mkdirSync(vault, { recursive: true });
  fs.writeFileSync(path.join(configDirectory, 'config.json'), JSON.stringify({ notesRootPath: vault, apiKey: 'fixture-network-only', apiEndpoint: `http://127.0.0.1:${modelPort}/v1`, model: 'local-network-fixture', petAnimal: 'capybara', petDisplaySize: 128, defaultReminderNotifyStyle: 1, defaultReminderPopupStyle: 3 }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'dance-monkey-network-qa', version: '3.12.1', main: 'bootstrap.cjs' }));
  const metrics = path.join(root, 'resolutions.json'); fs.writeFileSync(metrics, '[]');
  fs.writeFileSync(path.join(root, 'bootstrap.cjs'), `
    const { app, session } = require('electron'), fs = require('node:fs');
    Object.defineProperty(app, 'isPackaged', { get: () => true });
    app.getAppPath = () => ${JSON.stringify(sourceRoot)};
    const requireApp = require('node:module').createRequire(${JSON.stringify(path.join(sourceRoot, 'package.json'))});
    const undici = requireApp('undici'), originalFetch = undici.fetch;
    undici.fetch = (url, options) => { if (!['127.0.0.1', 'localhost', 'model.test'].includes(new URL(String(url)).hostname)) throw Error('QA blocks external traffic'); return originalFetch(url, options); };
    app.whenReady().then(async () => {
      const ses = session.defaultSession, resolve = ses.resolveProxy.bind(ses), resolutions = [];
      ses.resolveProxy = url => { resolutions.push(url); fs.writeFileSync(${JSON.stringify(metrics)}, JSON.stringify(resolutions)); return resolve(url); };
      await ses.setProxy({ mode: 'pac_script', pacScript: 'http://127.0.0.1:${pac.address().port}/proxy.pac' });
      ses.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/.test(details.url) && !['127.0.0.1', 'localhost'].includes(new URL(details.url).hostname) }));
    });
    require(${JSON.stringify(path.join(sourceRoot, 'electron/main.js'))});
  `);
  const debugPort = await freePort();
  const launch = () => start('Network QA Electron', path.join(cwd, 'node_modules/.bin/electron'), ['--use-mock-keychain', root], { DM_E2E_ROOT: root, DM_E2E_PORT: String(debugPort), DM_FILE_MODE: '1', HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '' });
  async function workspace(run) {
    const targets = async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).filter(item => item.type === 'page');
    const first = await waitFor(async () => (await targets()).find(item => item.url.includes('index.html')), { process: run });
    const overlay = await connect(first.webSocketDebuggerUrl);
    await waitFor(() => overlay.evaluate('Boolean(window.lumen)'), { process: run });
    await overlay.evaluate('window.lumen.openWorkspace("settings")');
    const target = await waitFor(async () => (await targets()).find(item => item.url.includes('#workspace/settings')), { process: run });
    const client = await connect(target.webSocketDebuggerUrl);
    try { await waitFor(() => client.evaluate('Boolean(document.querySelector("[data-settings-tab=network]"))'), { process: run }); }
    catch (error) { console.error(await client.evaluate('JSON.stringify({url:location.href,body:document.body.textContent.slice(-2500),lumen:Boolean(window.lumen),modules:Boolean(window.DMWorkspaceModules)})')); await screenshot(client, 'startup-failure'); throw error; }
    await client.evaluate('document.querySelector("[data-settings-tab=network]").click()');
    return client;
  }
  let run = launch(), client = await workspace(run), evaluate = client.evaluate;
  assert.equal(await evaluate('document.querySelector("[name=networkProxyMode]").value'), 'system');
  assert.equal(await evaluate('document.querySelector("[name=aiNetworkMode]").value'), 'direct');
  assert.equal(await evaluate('document.querySelector(".ws-proxy-advanced") === null'), true, 'Mac never offers Windows registry maintenance');
  await screenshot(client, 'network-mac-company-default');
  await evaluate(`document.querySelector('[name=aiNetworkMode]').value='manual'; document.querySelector('[name=aiNetworkMode]').dispatchEvent(new Event('change')); document.querySelector('[name=manualProxyHost]').value='127.0.0.1'; document.querySelector('[name=manualProxyPort]').value='0'; document.querySelector('[data-module-action=settings-save]').click();`);
  await waitFor(() => evaluate('Boolean(document.querySelector(".module-error"))'), { process: run });
  assert.equal(requests.length, 0);
  await evaluate(`document.querySelector('[name=manualProxyPort]').value='${proxyPort}'; document.querySelector('[data-module-action=network-test]').click(); document.querySelector('[data-module-action=network-test]').click();`);
  await waitFor(() => evaluate('document.querySelector(".ws-settings-ok")?.textContent.includes("连接测试成功")'), { process: run });
  assert.equal(requests.length, 1); assert.equal(tunnels.length, 1); assert.equal(JSON.parse(fs.readFileSync(metrics)).length, 0, 'manual ignores company PAC');
  await screenshot(client, 'network-mac-fixed-proxy');
  await evaluate(`document.querySelector('[name=networkProxyMode]').value='manual'; document.querySelector('[name=aiNetworkMode]').value='inherit'; document.querySelector('[data-module-action=network-test]').click();`);
  await waitFor(async () => requests.length === 2 && await evaluate('document.querySelector(".ws-settings-ok")?.textContent.includes("手动代理") && !document.querySelector("[data-module-action=network-test]").disabled'), { process: run });
  assert.equal(requests.length, 2); assert.deepEqual(deliveries, ['proxy', 'proxy']); assert.equal(JSON.parse(fs.readFileSync(metrics)).length, 0, 'AI inherits the application fixed proxy');
  const aiSettings = await evaluate('window.lumen.ai.getSettings()');
  await evaluate(`window.lumen.ai.saveSettings(${JSON.stringify({ ...aiSettings, apiEndpoint: `http://model.test:${modelPort}/v1` })})`);
  await evaluate(`document.querySelector('[name=aiNetworkMode]').value='inherit'; document.querySelector('[name=networkProxyMode]').value='system'; document.querySelector('[data-module-action=network-test]').click();`);
  await waitFor(() => evaluate('document.querySelector(".ws-settings-ok")?.textContent.includes("公司 / 系统默认")'), { process: run });
  assert.equal(requests.length, 3); assert.equal(deliveries[2], 'proxy'); assert.ok(tunnels.includes(`model.test:${modelPort}`)); assert.ok(JSON.parse(fs.readFileSync(metrics)).some(url => url.includes('model.test')), 'actual Electron PAC resolver used');
  await evaluate(`window.lumen.ai.saveSettings(${JSON.stringify({ ...aiSettings, apiEndpoint: `http://127.0.0.1:${modelPort}/v1` })})`);
  const beforeDirect = JSON.parse(fs.readFileSync(metrics)).length;
  const tunnelsBeforeDirect = tunnels.length;
  await evaluate(`document.querySelector('[name=aiNetworkMode]').value='direct'; document.querySelector('[data-module-action=network-test]').click();`);
  await waitFor(() => evaluate('document.querySelector(".ws-settings-ok")?.textContent.includes("直连")'), { process: run });
  assert.equal(requests.length, 4); assert.equal(deliveries[3], 'direct'); assert.equal(tunnels.length, tunnelsBeforeDirect); assert.equal(JSON.parse(fs.readFileSync(metrics)).length, beforeDirect);
  slow = true;
  await evaluate('document.querySelector("[data-module-action=network-test]").click()');
  await waitFor(() => requests.length === 5, { process: run });
  await evaluate('document.querySelector("[name=manualProxyHost]").value="192.0.2.4"; document.querySelector("[data-module-action=network-test-stop]").click()');
  await waitFor(() => evaluate('document.querySelector(".module-error")?.textContent.includes("已取消")'), { process: run });
  assert.equal(await evaluate('document.querySelector("[name=manualProxyHost]").value'), '192.0.2.4', 'cancel keeps edits made during the test');
  await evaluate('document.querySelector("[name=manualProxyHost]").value="127.0.0.1"'); slow = false;
  const windowsHtml = await evaluate(`(async () => { const module=window.DMWorkspaceModules.create({...window.lumen,platform:'win32'}, {esc:s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;'),attr:s=>String(s??'').replaceAll('"','&quot;'),rerender:()=>{}}); await module.loadAll(); return module.render('settings'); })()`);
  assert.match(windowsHtml, /Windows 系统代理自动维护/); assert.match(windowsHtml, /name="manualProxyHost"/); assert.match(windowsHtml, /data-settings-tab="network"/);
  await evaluate('document.querySelector("[name=aiNetworkMode]").value="manual"; document.querySelector("[name=aiNetworkMode]").dispatchEvent(new Event("change")); document.querySelector("[data-module-action=settings-save]").click()');
  await waitFor(() => evaluate('document.querySelector(".ws-settings-ok")?.textContent.includes("保存")'), { process: run });
  await screenshot(client, 'network-mac-manual-saved');
  await client.send('Emulation.setDeviceMetricsOverride', { width: 820, height: 650, deviceScaleFactor: 1, mobile: false });
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll(".ws-network-panel input,.ws-network-panel select")].filter(e=>e.getBoundingClientRect().width).every(e=>e.getBoundingClientRect().right <= innerWidth)'), true);
  await screenshot(client, 'network-compact');
  await client.send('Emulation.clearDeviceMetricsOverride');
  await evaluate('const theme=document.querySelector("select[aria-label=工作区主题]"); if(theme){theme.value="light";theme.dispatchEvent(new Event("change",{bubbles:true}));}');
  await screenshot(client, 'network-light');
  const persisted = await evaluate('window.lumen.settings.get()'); assert.equal(persisted.aiNetworkMode, 'manual'); assert.equal(persisted.petAnimal, 'capybara'); assert.equal(persisted.petDisplaySize, 128);
  assert.equal((await evaluate('window.lumen.reminders.list()')).settings.defaultNotifyStyle, 'PetBubble');
  await evaluate('window.lumen.quitApp()'); await waitFor(() => run.exited, { timeout: 20000 }); assert.equal(run.code, 0);
  for (const socket of sockets) socket.close();
  run = launch(); client = await workspace(run); evaluate = client.evaluate;
  const restarted = await evaluate('window.lumen.settings.get()'); assert.equal(restarted.aiNetworkMode, 'manual'); assert.equal(restarted.manualProxyPort, proxyPort); assert.equal(restarted.networkProxyMode, 'system');
  assert.equal(await evaluate('document.querySelector("[name=aiNetworkMode]").value'), 'manual');
  assert.equal((await evaluate('window.lumen.reminders.list()')).settings.defaultNotifyStyle, 'PetBubble');
  await evaluate('window.lumen.quitApp()'); await waitFor(() => run.exited, { timeout: 20000 }); assert.equal(run.code, 0);
  for (const socket of liveSockets) socket.destroy();
  console.log(`Network E2E passed: Mac/Windows settings, manual CONNECT, actual company PAC fallback, isolated direct, duplicate prevention, cancellation with draft protection, validation, restart, pet and reminder preservation (${requests.length} local-only API requests).`);
} finally {
  for (const socket of sockets) socket.close();
  for (const record of children.reverse()) await stop(record);
  for (const server of [mock, proxy, pac]) { server?.closeAllConnections?.(); server?.close(); }
  fs.rmSync(root, { recursive: true, force: true });
}
