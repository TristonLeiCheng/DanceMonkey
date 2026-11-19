import assert from "node:assert/strict";
import fs from "node:fs/promises";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import audio from "../electron/robot-voice-audio.js";

const cwd = path.resolve(import.meta.dirname, "..");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "dm-robot-ui-"));
const key = path.join(cwd, "test/fixtures/proxy-tls/test-only-key.pem");
const cert = path.join(cwd, "test/fixtures/proxy-tls/test-only-cert.pem");
const processes = [], clients = [], calls = [];
async function port() {
  const temp = net.createServer();
  temp.listen(0, "127.0.0.1");
  await once(temp, "listening");
  const result = temp.address().port;
  await new Promise(resolve => temp.close(resolve));
  return result;
}
function launch(command, args, env) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  processes.push(child);
  child.stderr.on("data", bytes => { child.log = ((child.log || "") + bytes).slice(-4500); });
  child.stdout.resume();
  return child;
}
async function waitFor(fn, label) {
  const end = Date.now() + 12000;
  let error;
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value; } catch (e) { error = e; }
    if (processes.some(child => child.exitCode !== null)) break;
    await delay(100);
  }
  throw Error(label + ": " + (error?.message || "timed out") + "\n" + processes.map(child => child.log || "").join("\n"));
}
async function browser(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  clients.push(ws);
  await once(ws, "open");
  let id = 0;
  return expression => new Promise((resolve, reject) => {
    const next = ++id, timer = setTimeout(() => done(new Error("CDP timeout")), 15000);
    function done(error, value) {
      clearTimeout(timer);
      ws.off("message", receive);
      if (error) reject(error); else resolve(value);
    }
    function receive(message) {
      const response = JSON.parse(message);
      if (response.id !== next) return;
      const error = response.error?.message || response.result?.exceptionDetails?.exception?.description;
      done(error ? Error(error) : null, response.result?.result?.value);
    }
    ws.on("message", receive);
    ws.send(JSON.stringify({ id: next, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true, userGesture: true } }));
  });
}
const pcm = Buffer.alloc(1920);
for (let i = 0; i < 960; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin(i / 4)), i * 2);
const mock = https.createServer({ key: await fs.readFile(key), cert: await fs.readFile(cert) }, async (req, res) => {
  const buffers = [];
  for await (const chunk of req) buffers.push(chunk);
  const body = Buffer.concat(buffers);
  calls.push({ path: req.url, auth: req.headers.authorization, body });
  if (req.headers.authorization !== "Bearer test-only") return res.writeHead(401).end();
  if (req.url.endsWith("/capabilities")) return res.writeHead(200).end('{"stt_enabled":true,"tts_enabled":true}');
  if (req.url.endsWith("/speech")) return res.writeHead(200).end(audio.pcmWav(pcm));
  if (req.url.endsWith("/transcriptions")) return res.writeHead(200).end('{"text":"你好"}');
  if (req.url.endsWith("/completions")) return res.writeHead(200).end('{"choices":[{"message":{"content":"语音链路已连通。"}}]}');
  res.writeHead(404).end();
});
try {
  mock.listen(0, "127.0.0.1");
  await once(mock, "listening");
  const webPort = await port(), debugPort = await port(), gatewayPort = await port();
  const bootstrap = path.join(root, "bootstrap.cjs");
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "dm-robot-test", version: "1.0.0", main: "bootstrap.cjs" }));
  await fs.writeFile(bootstrap, `
    const { app, session } = require('electron');
    const undici = require(${JSON.stringify(path.join(cwd, "node_modules/undici"))});
    const fetch = undici.fetch;
    undici.fetch = (url, opts) => {
      if (new URL(String(url)).hostname !== "127.0.0.1") throw Error("external test request denied");
      return fetch(url, opts);
    };
    const bridge = require(${JSON.stringify(path.join(cwd, "electron/robot-voice-bridge"))});
    const create = bridge.createBridge;
    bridge.createBridge = opts => create({...opts, addresses: () => ["127.0.0.1"]});
    app.whenReady().then(() => session.defaultSession.setProxy({ mode: "direct" }));
    require(${JSON.stringify(path.join(cwd, "electron/main.js"))});
  `);
  launch(process.execPath, ["server.mjs"], { PORT: String(webPort) });
  await waitFor(async () => (await fetch("http://127.0.0.1:" + webPort)).ok, "preview");
  launch(path.join(cwd, "node_modules/.bin/electron"), [root], {
    DM_E2E_ROOT: root, DM_E2E_PORT: String(debugPort), DM_E2E_SERVER_PORT: String(webPort), NODE_EXTRA_CA_CERTS: cert,
  });
  const targets = async () => (await (await fetch("http://127.0.0.1:" + debugPort + "/json")).json()).filter(t => t.type === "page");
  const open = await browser(await waitFor(async () => (await targets()).find(t => t.url === "http://127.0.0.1:" + webPort + "/"), "overlay"));
  await waitFor(() => open("Boolean(window.lumen)"), "overlay preload");
  await open('window.lumen.openWorkspace("settings")');
  const workspace = await browser(await waitFor(async () => (await targets()).find(t => t.url.includes("#workspace/settings")), "settings"));
  await waitFor(() => workspace('Boolean(document.querySelector("[data-settings-tab=robot-voice]"))'), "settings tab");
  await workspace('document.querySelector("[data-settings-tab=robot-voice]").click()');
  await workspace('document.querySelector("[data-module-action=robot-voice-open]").click()');
  const panel = await browser(await waitFor(async () => (await targets()).find(t => t.url.endsWith("/robot-voice/index.html")), "robot window"));
  await waitFor(() => panel('document.getElementById("host").value === "127.0.0.1"'), "robot window initialized");
  const origin = "https://127.0.0.1:" + mock.address().port;
  async function fill() {
    await panel(`(() => { const f = document.getElementById("profile"); f.closest("details").open = true;
      f.elements.origin.value = ${JSON.stringify(origin)}; f.elements.token.value = "test-only";
      f.elements.auth.value = "bearer"; f.elements.caFile.value = ${JSON.stringify(cert)};
      f.requestSubmit(); })()`);
    await waitFor(() => panel('document.getElementById("credential").textContent.includes("本次运行")'), "saved profile");
  }
  await fill();
  await panel('document.getElementById("test").click()');
  await waitFor(() => panel('document.getElementById("notice").textContent.includes("均已通过")'), "local full service test");
  await panel('document.querySelector("[data-mode=mga]").click()');
  await waitFor(() => panel('document.querySelector("[data-mode=mga]").getAttribute("aria-pressed") === "true"'), "switched to MGA");
  await fill();
  await panel('document.getElementById("test").click()');
  await waitFor(() => panel('document.getElementById("notice").textContent.includes("均已通过")'), "MGA full service test");
  assert.deepEqual(calls.map(call => call.path), ["/v1/audio/speech", "/v1/audio/transcriptions", "/v1/chat/completions",
    "/api/v3/audio/capabilities", "/api/v3/audio/speech", "/api/v3/audio/transcriptions", "/api/v2/chat/completions"]);
  await panel(`document.getElementById("port").value = "${gatewayPort}"; document.getElementById("toggle").click()`);
  const ota = await waitFor(() => panel('document.getElementById("ota").value'), "gateway OTA URL");
  const { websocket } = await (await fetch(ota)).json();
  const board = new WebSocket(websocket.url, { headers: { Authorization: "Bearer " + websocket.token, "Protocol-Version": "1", "Device-Id": "00:11:22:33:44:55" } });
  clients.push(board);
  const messages = [], controls = [];
  board.on("message", (value, binary) => {
    const msg = binary ? value : JSON.parse(value); messages.push(msg);
    if (msg.type !== "mcp" || !msg.payload.id) return;
    const rpc = msg.payload;
    let result;
    if (rpc.method === "initialize") result = { serverInfo: { name: "test-board", version: "2.5.2" } };
    else if (rpc.method === "tools/list") result = { tools: ["self.get_device_status", "self.audio_speaker.set_volume", "self.screen.set_brightness"].map(name => ({ name })) };
    else { controls.push(rpc.params); result = { content: [{ type: "text", text: "device status ok" }], isError: false }; }
    board.send(JSON.stringify({ type: "mcp", session_id: msg.session_id, payload: { jsonrpc: "2.0", id: rpc.id, result } }));
  });
  await once(board, "open");
  const send = value => board.send(JSON.stringify(value));
  send({ type: "hello", features: { mcp: true }, version: 1, transport: "websocket", audio_params: { format: "opus", sample_rate: 16000, channels: 1, frame_duration: 60 } });
  const hello = await waitFor(() => messages.find(m => m.type === "hello"), "device hello");
  send({ type: "listen", state: "start", mode: "manual", session_id: hello.session_id });
  const encoder = audio.opus(16000);
  try { for (let i = 0; i < 8; i++) board.send(encoder.encode(pcm, 960)); }
  finally { encoder.delete(); }
  send({ type: "listen", state: "stop", session_id: hello.session_id });
  await waitFor(() => messages.some(m => m.type === "tts" && m.state === "stop"), "real Electron device voice turn");
  assert.ok(messages.some(m => m.text === "语音链路已连通。"));
  assert.ok(messages.some(Buffer.isBuffer));
  assert.deepEqual(calls.slice(-3).map(call => call.path), ["/api/v3/audio/transcriptions", "/api/v2/chat/completions", "/api/v3/audio/speech"]);
  assert.ok(calls.at(-3).body.includes(Buffer.from("RIFF")));
  await waitFor(() => panel('document.getElementById("devices").textContent.includes("test-board") && document.getElementById("devices").textContent.includes("设置音量")'), "device management discovered");
  await panel(`(() => {
    const card = document.querySelector("#devices .device-card");
    const input = card.querySelector("input:not([type=number])");
    input.value = "桌面小智";
    Array.from(card.querySelectorAll("button")).find(b => b.textContent === "重命名").click();
  })()`);
  await waitFor(() => panel('document.querySelector("#devices strong")?.textContent === "桌面小智"'), "renamed device");
  await panel(`(() => {
    const card = document.querySelector("#devices .device-card");
    card.querySelector("input[type=number]").value = 37;
    Array.from(card.querySelectorAll("button")).find(b => b.textContent === "设置音量").click();
  })()`);
  await waitFor(() => controls.some(c => c.name === "self.audio_speaker.set_volume" && c.arguments.volume === 37), "device acknowledged volume");
  await waitFor(() => panel('document.getElementById("notice").textContent.includes("设备已确认")'), "confirmed UI");
  await panel(`Array.from(document.querySelectorAll("#devices button")).find(b => b.textContent === "断开连接").click()`);
  await waitFor(() => panel('document.getElementById("devices").textContent.includes("未连接 DM")'), "device offline state");
  console.log("Electron 小智：语音往返、设备登记、MCP 管理、重命名、音量确认与断线状态通过。");
} finally {
  for (const client of clients) client.terminate();
  for (const child of processes) child.kill();
  mock.closeAllConnections();
  await new Promise(resolve => mock.close(resolve));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
}
