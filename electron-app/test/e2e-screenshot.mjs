import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const cwd = path.resolve(import.meta.dirname, "..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dm-screenshot-e2e-"));
const vault = path.join(root, "documents", "NoteVault");
const children = [], sockets = [];
const controlToken = randomUUID();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let electron, controlPort, restorationConfirmed = false, retainProcess = false;

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
  child.stdout.on("data", capture); child.stderr.on("data", capture);
  child.once("exit", (code, signal) => Object.assign(record, { exited: true, code, signal }));
  children.push(record);
  return record;
}
async function waitFor(fn, { timeout = 20000, process: watched } = {}) {
  const end = Date.now() + timeout;
  let error;
  while (Date.now() < end) {
    if (watched?.exited) throw new Error(`${watched.name} exited (${watched.code}/${watched.signal})\n${watched.output}`);
    try { const result = await fn(); if (result) return result; } catch (next) { error = next; }
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
async function control(action, payload = {}) {
  const response = await fetch(`http://127.0.0.1:${controlPort}/${action}`, {
    method: "POST", headers: { "content-type": "application/json", "x-dm-test-token": controlToken },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(15000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Screenshot test control failed");
  return result;
}
async function connect(url) {
  const socket = new WebSocket(url);
  sockets.push(socket);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let serial = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => { const message = JSON.parse(data); pending.get(message.id)?.(message); };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 20000);
    pending.set(id, (response) => {
      pending.delete(id); clearTimeout(timer);
      if (response.error) reject(new Error(`${method}: ${response.error.message}`)); else resolve(response.result);
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    try {
      const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result?.value;
    } catch (error) { throw new Error(`${error.message}; expression: ${expression.slice(0, 140)}`); }
  };
  return { send, evaluate };
}
function assertPng(file) {
  assert.ok(fs.existsSync(file), "capture success is reported only after the PNG exists");
  assert.ok(fs.realpathSync(file).startsWith(`${fs.realpathSync(vault)}${path.sep}`), "screenshots stay inside the disposable vault");
  assert.equal(fs.readFileSync(file).subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
}

try {
  const ports = new Set();
  while (ports.size < 3) ports.add(await freePort());
  const [serverPort, debugPort, clipboardPort] = [...ports];
  controlPort = clipboardPort;
  const configDirectory = path.join(root, "app-data", "DanceMonkey");
  fs.mkdirSync(vault, { recursive: true }); fs.mkdirSync(configDirectory, { recursive: true });
  fs.writeFileSync(path.join(configDirectory, "config.json"), JSON.stringify({ notesRootPath: vault, petModeEnabled: true, petPreventSleepEnabled: false }));
  const packageInfo = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: packageInfo.name, version: packageInfo.version, main: "bootstrap.cjs" }));
  // The one test Electron process owns every clipboard operation. All original
  // payloads are materialized in memory before application code can write anything.
  // Only capture source pixels are mocked; PNG conversion, ClipboardItem, the
  // system clipboard, windows, preload bridges and screenshot IPC remain real.
  fs.writeFileSync(path.join(root, "bootstrap.cjs"), `
    const { app, BrowserWindow, clipboard, ClipboardItem, desktopCapturer, nativeImage, screen, session } = require('electron');
    const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
    const { Blob } = require('node:buffer');
    const root = ${JSON.stringify(root)}, vault = fs.realpathSync(${JSON.stringify(vault)});
    app.setPath('appData', path.join(root, 'app-data'));
    app.setPath('userData', path.join(root, 'user-data'));
    app.setPath('documents', path.join(root, 'documents'));
    app.commandLine.appendSwitch('remote-debugging-port', ${JSON.stringify(String(debugPort))});
    let originals, restorePromise, restored = false, captures = 0, captureSize = null, petHiddenDuringCapture = true, bootstrapStage = 'clipboard API';
    const petWindow = () => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('/pet.html'));
    async function restoreClipboard() {
      if (restored) return { restored: true };
      if (!originals) throw new Error('Clipboard snapshot not ready');
      if (!restorePromise) restorePromise = (async () => {
        if (originals.length) await clipboard.write(originals); else clipboard.clear();
        restored = true;
        fs.writeFileSync(path.join(root, 'clipboard-restored.json'), JSON.stringify({ restored: true }));
        return { restored: true };
      })().catch(error => { restorePromise = null; throw error; });
      return restorePromise;
    }
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
      if (!originals) return app.exit(0);
      restoreClipboard().then(() => app.exit(0), () => console.error('Clipboard restoration failed; test process retained.'));
    });
    app.on('before-quit', event => {
      if (!originals || restored) return;
      event.preventDefault();
      restoreClipboard().then(() => app.exit(0), () => console.error('Clipboard restoration failed; test process retained.'));
    });
    app.whenReady().then(async () => {
      if (typeof ClipboardItem !== 'function' || typeof clipboard.read !== 'function' || typeof clipboard.write !== 'function') {
        throw new Error('This test requires the current Electron ClipboardItem API');
      }
      bootstrapStage = 'clipboard snapshot';
      const current = await clipboard.read();
      bootstrapStage = 'clipboard snapshot materialization';
      const materialized = [];
      for (const item of current) {
        const entries = await Promise.all(item.types.map(async type => {
          const payload = await item.getType(type);
          return [type, type === 'electron application/bookmark' ? { ...payload } : new Blob([await payload.arrayBuffer()], { type: payload.type || type })];
        }));
        materialized.push(new ClipboardItem(Object.fromEntries(entries)));
      }
      originals = materialized;
      bootstrapStage = 'capture and test control setup';
      fs.writeFileSync(path.join(root, 'clipboard-ready.json'), JSON.stringify({ ready: true }));
      desktopCapturer.getSources = async ({ thumbnailSize }) => {
        petHiddenDuringCapture = petHiddenDuringCapture && Boolean(petWindow()) && !petWindow().isVisible();
        const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
        const { width, height } = thumbnailSize;
        const pixels = Buffer.alloc(width * height * 4, Buffer.from([64, 128, 192, 255]));
        const thumbnail = nativeImage.createFromBitmap(pixels, { width, height, scaleFactor: 1 });
        captures += 1; captureSize = { width, height, scale: display.scaleFactor || 1 };
        return [{ id: 'screen:synthetic:0', name: 'Synthetic test display', display_id: String(display.id), thumbnail }];
      };
      await session.defaultSession.setProxy({ mode: 'direct' });
      session.defaultSession.webRequest.onBeforeRequest((details, done) => {
        const external = /^https?:/.test(details.url) && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(details.url).hostname);
        done({ cancel: external });
      });
      const server = http.createServer(async (request, response) => {
        response.setHeader('content-type', 'application/json');
        if (request.headers['x-dm-test-token'] !== ${JSON.stringify(controlToken)}) { response.writeHead(403); response.end('{}'); return; }
        try {
          let raw = ''; for await (const chunk of request) raw += chunk;
          const payload = JSON.parse(raw || '{}');
          if (request.url === '/status') return response.end(JSON.stringify({ ready: true, restored, captures, captureSize, petHiddenDuringCapture, petVisible: Boolean(petWindow()?.isVisible()), electron: process.versions.electron }));
          if (request.url === '/restore') return response.end(JSON.stringify(await restoreClipboard()));
          if (request.url === '/compare') {
            const items = await clipboard.read();
            const item = items.find(entry => entry.types.includes('image/png'));
            if (!item) throw new Error('System clipboard has no image/png item');
            const blob = await item.getType('image/png');
            const png = Buffer.from(await blob.arrayBuffer());
            let expected;
            if (payload.file) {
              const file = path.resolve(payload.file);
              if (!file.startsWith(vault + path.sep)) throw new Error('Test file is outside disposable vault');
              expected = fs.readFileSync(file);
            } else expected = Buffer.from(String(payload.dataUrl).split(',')[1], 'base64');
            const actualImage = nativeImage.createFromBuffer(png), expectedImage = nativeImage.createFromBuffer(expected);
            response.end(JSON.stringify({ png: png.subarray(0, 8).toString('hex') === '89504e470d0a1a0a',
              matches: actualImage.toBitmap().equals(expectedImage.toBitmap()), size: actualImage.getSize() }));
            return;
          }
          response.writeHead(404); response.end('{}');
        } catch (error) {
          response.writeHead(500); response.end(JSON.stringify({ error: error.message }));
        }
      });
      await new Promise(resolve => server.listen(${clipboardPort}, '127.0.0.1', resolve));
      bootstrapStage = 'application startup';
      require(${JSON.stringify(path.join(cwd, "electron/main.js"))});
    }).catch(error => { console.error('Screenshot test bootstrap failed at ' + bootstrapStage + ' (' + error.name + ').'); app.exit(1); });
  `);

  const server = start("preview server", process.execPath, ["server.mjs"], { PORT: String(serverPort) });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${serverPort}/`)).ok, { process: server });
  electron = start("Electron", path.join(cwd, "node_modules/.bin/electron"), [root], {
    DM_E2E_ROOT: root, DM_E2E_PORT: String(debugPort), DM_E2E_SERVER_PORT: String(serverPort),
    HTTP_PROXY: "", HTTPS_PROXY: "", http_proxy: "", https_proxy: "", ALL_PROXY: "", all_proxy: "",
  });
  await waitFor(async () => (await control("status")).ready, { process: electron });
  const targets = async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).filter(item => item.type === "page");
  const findWindow = (part) => waitFor(async () => (await targets()).find(item => item.url.includes(part)), { process: electron });
  const overlay = await connect((await findWindow(`127.0.0.1:${serverPort}`)).webSocketDebuggerUrl);
  await waitFor(() => overlay.evaluate('document.readyState === "complete" && typeof window.lumen?.openWorkspace === "function"'), { process: electron });
  await overlay.evaluate('window.lumen.openWorkspace("ai")');
  const workspace = await connect((await findWindow("#workspace/ai")).webSocketDebuggerUrl);
  await waitFor(() => workspace.evaluate('Boolean(document.querySelector("[data-module-action=screenshot-quick]"))'), { process: electron });
  await waitFor(async () => (await control("status")).petVisible, { process: electron });

  // Exercise the actual camera button that originally returned writeImage errors.
  await workspace.evaluate('document.querySelector("[data-module-action=screenshot-quick]").click()');
  let choice = await connect((await findWindow("screenshot-choice.html")).webSocketDebuggerUrl);
  await waitFor(() => choice.evaluate('document.querySelector("#preview").complete && document.querySelector("#preview").naturalWidth > 0'), { process: electron });
  const fullFile = fileURLToPath(await choice.evaluate('document.querySelector("#preview").src'));
  assertPng(fullFile);
  let clipboardCheck = await control("compare", { file: fullFile });
  assert.equal(clipboardCheck.png && clipboardCheck.matches, true, "quick capture writes a real clipboard PNG matching the saved image");
  const fullSize = (await control("status")).captureSize;
  assert.equal((await control("status")).petHiddenDuringCapture, true, "pet is hidden from the captured desktop");
  assert.equal((await control("status")).petVisible, true, "pet returns after the capture");
  assert.deepEqual(clipboardCheck.size, { width: fullSize.width, height: fullSize.height });

  await choice.evaluate('setTimeout(() => document.querySelector("[data-act=edit]").click(), 30); true');
  const editor = await connect((await findWindow("screenshot-editor.html")).webSocketDebuggerUrl);
  try {
    await waitFor(() => editor.evaluate('document.querySelector("#board")?.width > 300 && document.querySelector("#statusText")?.textContent === "可开始标注"'), { process: electron });
  } catch (error) {
    const page = await editor.evaluate('({url:location.href,ready:document.readyState,title:document.title,canvasWidth:document.querySelector("#board")?.width,status:document.querySelector("#statusText")?.textContent})');
    throw new Error(`Editor did not load: ${JSON.stringify(page)}; ${error.message}`);
  }
  const beforeDrawing = await editor.evaluate('document.querySelector("#board").toDataURL("image/png")');
  const canvas = await editor.evaluate('(()=>{const r=document.querySelector(".stage").getBoundingClientRect(); return {x:r.x+r.width/2-30,y:r.y+r.height/2-15}})()');
  await editor.send("Input.dispatchMouseEvent", { type: "mousePressed", x: canvas.x, y: canvas.y, button: "left", clickCount: 1 });
  await editor.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: canvas.x + 60, y: canvas.y + 30, button: "left", buttons: 1 });
  await editor.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: canvas.x + 60, y: canvas.y + 30, button: "left", clickCount: 1 });
  const editedDataUrl = await editor.evaluate('document.querySelector("#board").toDataURL("image/png")');
  assert.notEqual(editedDataUrl, beforeDrawing, "the editor changes the image through its drawing handlers");
  await editor.evaluate('document.querySelector("[data-act=copy]").click()');
  await waitFor(() => editor.evaluate('document.querySelector("#statusText").textContent === "已复制到剪贴板"'), { process: electron });
  clipboardCheck = await control("compare", { dataUrl: editedDataUrl });
  assert.equal(clipboardCheck.png && clipboardCheck.matches, true, "editor copy uses the real system clipboard");
  await editor.evaluate('document.querySelector("[data-act=save]").click()');
  await waitFor(() => editor.evaluate('document.querySelector("#statusText").textContent.startsWith("已保存：")'), { process: electron });
  const editedFile = path.join(path.dirname(fullFile), await editor.evaluate('document.querySelector("#fileName").textContent'));
  assertPng(editedFile);
  assert.equal((await control("compare", { file: editedFile })).matches, true);
  assert.equal((await control("compare", { dataUrl: editedDataUrl })).matches, true);
  assert.equal(await editor.evaluate('window.screenshotResult.copy().then(result => result.success)'), true, "current-image copy IPC also uses the current Electron API");
  assert.equal((await control("compare", { file: editedFile })).matches, true);
  await editor.evaluate('setTimeout(() => document.querySelector("[data-act=close]").click(), 30); true');
  await waitFor(async () => !(await targets()).some(item => item.url.includes("screenshot-editor.html")), { process: electron });

  // A region selection follows real pointer handlers and region:submit IPC.
  await workspace.evaluate('document.querySelector("[data-module-action=screenshot-region]").click()');
  const region = await connect((await findWindow("region-capture.html")).webSocketDebuggerUrl);
  await waitFor(() => region.evaluate('document.querySelector("#board").width === innerWidth && document.querySelector("#board").height === innerHeight'), { process: electron });
  await region.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 80, y: 80, button: "left", clickCount: 1 });
  await region.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 180, y: 140, button: "left", buttons: 1 });
  await region.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 180, y: 140, button: "left", clickCount: 1 });
  await waitFor(() => region.evaluate('getComputedStyle(document.querySelector("#toolbar")).display === "flex"'), { process: electron });
  await region.evaluate('setTimeout(() => document.querySelector("[data-act=done]").click(), 30); true');
  choice = await connect((await findWindow("screenshot-choice.html")).webSocketDebuggerUrl);
  await waitFor(() => choice.evaluate('document.querySelector("#preview").complete && document.querySelector("#preview").naturalWidth > 0'), { process: electron });
  const regionFile = fileURLToPath(await choice.evaluate('document.querySelector("#preview").src'));
  assertPng(regionFile);
  assert.match(path.basename(regionFile), /^DM_region_/);
  const scale = (await control("status")).captureSize.scale;
  clipboardCheck = await control("compare", { file: regionFile });
  assert.equal(clipboardCheck.png && clipboardCheck.matches, true);
  assert.deepEqual(clipboardCheck.size, { width: Math.round(100 * scale), height: Math.round(60 * scale) });
  assert.equal((await control("status")).captures, 2);
  await choice.evaluate('setTimeout(() => document.querySelector("[data-act=close]").click(), 30); true');
  await waitFor(async () => !(await targets()).some(item => item.url.includes("screenshot-choice.html")), { process: electron });
  restorationConfirmed = (await control("restore")).restored;
  assert.equal(restorationConfirmed, true);
  console.log("Screenshot E2E passed: real camera UI, synthetic full/region capture, selection/editor windows, drawing, PNG save, ClipboardItem copy/read and original clipboard restoration.");
} finally {
  if (electron && !restorationConfirmed && fs.existsSync(path.join(root, "clipboard-ready.json"))) {
    if (fs.existsSync(path.join(root, "clipboard-restored.json"))) restorationConfirmed = true;
    else if (!electron.exited) {
      try { restorationConfirmed = (await control("restore")).restored; }
      catch { retainProcess = true; }
    }
    if (!restorationConfirmed) {
      retainProcess = true;
      console.error(`Clipboard restoration is unconfirmed; retained test resources at ${root} and Electron PID ${electron.child.pid}.`);
      process.exitCode = 1;
    }
  }
  for (const socket of sockets) { try { socket.close(); } catch {} }
  for (const record of children.reverse()) if (!(retainProcess && record === electron)) await stop(record);
  if (!retainProcess) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
