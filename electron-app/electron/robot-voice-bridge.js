const http = require("node:http");
const os = require("node:os");
const { randomBytes, randomUUID, timingSafeEqual } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const { WebSocket, WebSocketServer } = require("ws");
const { IN_RATE, OUT_RATE, FRAME_MS, MAX_SECONDS, opus, pcmWav, decodeWav, pack, unpack, rms } = require("./robot-voice-audio");

const { createMcp } = require("./robot-devices");

const WS_PATH = "/xiaozhi/v1/";
const SYSTEM = "你是 Dance Monkey 的桌面语音助手。用简短、自然的中文回答，适合小屏幕和直接朗读。不要使用 Markdown 表格，不要声称已新增任务或读过笔记。";
const MAX_CAPTURE = IN_RATE * 2 * MAX_SECONDS;

function isPrivate(address) {
  return /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.)/.test(address);
}
function lanAddresses() {
  return [...new Set(Object.values(os.networkInterfaces()).flat().filter(row =>
    row.family === "IPv4" && !row.internal && isPrivate(row.address)).map(row => row.address))];
}
function sameSecret(a, b) {
  const x = Buffer.from(a || ""), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function harmless(value) {
  return value.replace(/[\x00-\x1f\x7f]/g, " ").trim();
}
function createDeviceSession(ws, { protocol, resolveProvider, runCommand, report = () => {}, onReady = () => () => {}, onInfo = () => {} }) {
  const sessionId = randomUUID();
  let decoder, encoder, version, capture, turn, history = [], context = {};
  const helloTimeout = setTimeout(() => ws.close(1008, "hello required"), 8000);
  let idleTimer, unregister = () => {};
  const mcp = createMcp(payload => send("mcp", { payload }), onInfo);
  function heartbeat() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => ws.close(1000, "idle"), 180000);
    idleTimer.unref?.();
  }
  function send(type, fields = {}) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ session_id: sessionId, type, ...fields }));
  }
  function clearCapture() {
    clearTimeout(capture?.deadline);
    capture = undefined;
  }
  function cancel() {
    turn?.abort();
    turn = undefined;
    clearCapture();
  }
  function start(manual) {
    clearCapture();
    capture = { manual, samples: [], bytes: 0, voiced: 0, quiet: 0, quietBefore: 0 };
    capture.deadline = setTimeout(finish, (MAX_SECONDS + 3) * 1000);
    report("listening");
  }
  async function play(display, audio, signal) {
    signal.throwIfAborted();
    send("tts", { state: "start" });
    send("tts", { state: "sentence_start", text: display });
    report("speaking");
    try {
      if (!audio) return;
      const pcm = decodeWav(audio);
      encoder ||= opus(OUT_RATE);
      const frameSamples = OUT_RATE * FRAME_MS / 1000, frameBytes = frameSamples * 2;
      let timestamp = 0;
      for (let offset = 0; offset < pcm.length; offset += frameBytes) {
        signal.throwIfAborted();
        if (ws.readyState !== WebSocket.OPEN) return;
        const frame = Buffer.alloc(frameBytes);
        pcm.copy(frame, 0, offset, offset + frameBytes);
        ws.send(pack(encoder.encode(frame, frameSamples), version, timestamp));
        timestamp += FRAME_MS;
        // The firmware has a small playback queue; pace packets at audio rate.
        await delay(FRAME_MS, undefined, { signal });
      }
    } finally {
      if (!signal.aborted) send("tts", { state: "stop" });
    }
  }
  async function respond(record, controller) {
    const { signal } = controller;
    let provider;
    try {
      if (record.voiced < 0.14 * IN_RATE * 2) {
        await play("没有听清，请再说一次。", null, signal);
        report("connected");
        return;
      }
      report("thinking");
      provider = await resolveProvider(signal);
      signal.throwIfAborted();
      const transcript = harmless(await provider.transcribe(pcmWav(Buffer.concat(record.samples)), signal));
      signal.throwIfAborted();
      if (!transcript || /^(字幕由|请订阅|感谢观看)[\s\S]{0,30}$/.test(transcript)) {
        await play("没有听清，请再说一次。", null, signal);
        report("connected");
        return;
      }
      send("stt", { text: transcript });
      const action = await runCommand?.(transcript, context, signal);
      signal.throwIfAborted();
      let reply = action?.speech, display = action?.display;
      if (!reply) {
        const user = { role: "user", content: transcript };
        reply = await provider.chat([{ role: "system", content: SYSTEM }, ...history, user], signal);
        signal.throwIfAborted();
        history = [...history, user, { role: "assistant", content: reply }].slice(-12);
      }
      let audio;
      try { audio = await provider.speech(reply, signal); }
      catch (error) {
        if (signal.aborted) return;
        await play(display || reply, null, signal);
        report("error", error.message);
        return;
      }
      await play(display || reply, audio, signal);
      report("connected");
    } catch (error) {
      if (!signal.aborted) {
        send("alert", { status: "DM 语音", message: error.message || "语音请求失败。", emotion: "sad" });
        send("tts", { state: "start" });
        send("tts", { state: "stop" });
        report("error", error.message);
      }
    } finally {
      await provider?.close();
      if (turn === controller) turn = undefined;
    }
  }
  function finish() {
    if (!capture || turn) return;
    const record = capture;
    clearCapture();
    turn = new AbortController();
    void respond(record, turn);
  }
  ws.on("message", (data, binary) => {
    heartbeat();
    try {
      if (binary) {
        if (!decoder || !capture || turn) return;
        const pcm = decoder.decode(unpack(data, version));
        const loud = rms(pcm) >= 0.012;
        if (loud) {
          capture.voiced += pcm.length;
          capture.quiet = 0;
        } else capture.quiet += pcm.length;
        if (!capture.manual && !capture.voiced && capture.bytes > IN_RATE) {
          const drop = capture.samples.shift();
          capture.bytes -= drop.length;
          capture.quietBefore += drop.length;
          if (capture.quietBefore >= 10 * IN_RATE * 2) return finish();
        }
        capture.samples.push(pcm);
        capture.bytes += pcm.length;
        if (capture.bytes >= MAX_CAPTURE ||
            (!capture.manual && capture.voiced >= 0.14 * IN_RATE * 2 && capture.quiet >= IN_RATE * 2)) finish();
        return;
      }
      const msg = JSON.parse(data.toString());
      if (!decoder) {
        const params = msg?.audio_params;
        if (msg?.type !== "hello" || msg.transport !== "websocket" ||
            ![1, 2, 3].includes(msg.version) || (protocol && msg.version !== Number(protocol)) ||
            params?.format !== "opus" || params.sample_rate !== IN_RATE || params.channels !== 1) {
          ws.close(1008, "unsupported hello");
          return;
        }
        clearTimeout(helloTimeout);
        version = msg.version;
        decoder = opus(IN_RATE);
        send("hello", { version, transport: "websocket", audio_params: {
          format: "opus", sample_rate: OUT_RATE, channels: 1, frame_duration: FRAME_MS,
        } });
        unregister = onReady({ tools: mcp.tools, call: mcp.call,
          disconnect: () => { cancel(); ws.terminate(); } });
        if (msg.features?.mcp === true) void mcp.start();
        report("connected");
        return;
      }
      if (msg.session_id && msg.session_id !== sessionId) return;
      if (msg.type === "mcp") { mcp.receive(msg.payload); return; }
      if (msg.type === "abort") {
        cancel();
        context = {};
        send("tts", { state: "stop" });
        report("connected");
      } else if (msg.type === "listen") {
        if (msg.state === "start" && !turn && !capture) start(msg.mode === "manual");
        if (msg.state === "stop") finish();
      }
    } catch {
      cancel();
      ws.close(1007, "invalid voice packet");
    }
  });
  ws.once("close", () => {
    clearTimeout(helloTimeout);
    clearTimeout(idleTimer);
    mcp.close();
    unregister();
    cancel();
    decoder?.delete();
    encoder?.delete();
  });
  ws.on("error", () => ws.terminate());
  return cancel;
}

function createBridge({ getPairing, resolveProvider, runCommand, addresses = lanAddresses, devices }) {
  let server, sockets, info, status = "off", detail = "";
  const cancellations = new WeakMap();
  const snapshot = () => ({ status, detail, running: !!info, addresses: addresses(), ...info });
  function reset() {
    for (const ws of sockets?.clients || []) {
      cancellations.get(ws)?.();
      ws.terminate();
    }
    if (info) { status = "waiting"; detail = ""; }
  }
  async function stop() {
    if (!server) return snapshot();
    const old = server, oldSockets = sockets;
    reset();
    server = sockets = info = undefined;
    status = "off"; detail = "";
    oldSockets.close();
    await new Promise(resolve => { old.close(resolve); old.closeAllConnections(); });
    return snapshot();
  }
  async function start(host, port = 8765) {
    if (server) throw Error("请先停止当前网关。");
    if (!addresses().includes(host)) throw Error("请选择当前电脑的内网 IPv4 地址。");
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error("端口须为 1024–65535。");
    const token = getPairing() || randomBytes(24).toString("hex");
    const base = host + ":" + port;
    const otaPath = "/xiaozhi/ota/" + token;
    const local = http.createServer({ requestTimeout: 10000, headersTimeout: 5000, keepAliveTimeout: 3000 }, async (req, res) => {
      const length = Number(req.headers["content-length"] || 0);
      if (!["GET", "POST"].includes(req.method) || !Number.isFinite(length) || length > 65536 ||
          (req.url !== otaPath && req.url !== otaPath + "/")) {
        req.resume();
        res.writeHead(404).end();
        return;
      }
      // Read bounded metadata only; never store the request's credentials or Wi-Fi settings.
      let metadata = {}, total = 0, chunks = [];
      try {
        for await (const chunk of req) {
          total += chunk.length;
          if (total > 65536) { res.writeHead(413).end(); req.destroy(); return; }
          chunks.push(chunk);
        }
        if (total) metadata = JSON.parse(Buffer.concat(chunks).toString());
        if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw Error();
      } catch { if (!res.destroyed) res.writeHead(400).end(); return; }
      try {
        devices?.observe(req.headers["device-id"], req.socket.remoteAddress?.replace(/^::ffff:/, ""),
          { board: metadata.board?.name, version: metadata.application?.version });
      } catch { res.writeHead(500).end(); return; }
      // Provision the voice server without changing firmware.

      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store", Connection: "close" });
      res.end(JSON.stringify({ websocket: { url: "ws://" + base + WS_PATH, token, version: 1 },
        server_time: { timestamp: Date.now(), timezone_offset: 0 } }));
    });
    const wss = new WebSocketServer({ noServer: true, maxPayload: 8192, perMessageDeflate: false });
    server = local;
    sockets = wss;
    local.on("upgrade", (req, socket, head) => {
      if (req.url !== WS_PATH || !sameSecret(req.headers.authorization, "Bearer " + token) ||
          wss.clients.size > 0) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      wss.handleUpgrade(req, socket, head, ws => {
        status = "connected"; detail = "";
        const cancel = createDeviceSession(ws, { protocol: req.headers["protocol-version"], resolveProvider, runCommand,
          onReady: controls => devices?.connect(req.headers["device-id"], req.socket.remoteAddress?.replace(/^::ffff:/, ""), controls) || (() => {}),
          onInfo: data => devices?.observe(req.headers["device-id"], req.socket.remoteAddress?.replace(/^::ffff:/, ""), data),
          report: (value, message = "") => {
            if (ws.readyState === WebSocket.OPEN) { status = value; detail = message; }
          } });
        cancellations.set(ws, cancel);
        ws.once("close", () => {
          if (sockets === wss && wss.clients.size === 0) { status = "waiting"; detail = ""; }
        });
      });
    });
    try {
      await new Promise((resolve, reject) => {
        local.once("error", reject);
        local.listen(port, host, () => { local.removeListener("error", reject); resolve(); });
      });
    } catch {
      server = sockets = undefined;
      wss.close();
      throw Error("网关无法监听，请检查 IP 或换一个端口。");
    }
    local.on("error", () => { void stop(); });
    info = { host, port, otaUrl: "http://" + base + otaPath + "/" };
    status = "waiting"; detail = "";
    return snapshot();
  }
  return { start, stop, reset, snapshot };
}
module.exports = { WS_PATH, lanAddresses, createBridge, createDeviceSession };
