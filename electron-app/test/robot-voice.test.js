const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { once } = require("node:events");
const { WebSocket } = require("ws");
const { createBridge } = require("../electron/robot-voice-bridge");
const { createProfiles, canonAccount, normalizeProfile } = require("../electron/robot-voice-profiles");
const { createProvider } = require("../electron/robot-voice-provider");
const { createRobotActions } = require("../electron/robot-voice-actions");
const { decodeWav, pcmWav, pack, unpack, opus, rms } = require("../electron/robot-voice-audio");

function sine(rate, length) {
  const pcm = Buffer.alloc(length * 2);
  for (let i = 0; i < length; i++) pcm.writeInt16LE(Math.round(7500 * Math.sin(2 * Math.PI * 660 * i / rate)), i * 2);
  return pcm;
}
async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dm-robot-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
function slot() {
  let value = {};
  return { read: () => value, write: fields => { value = { ...value, ...fields }; return value; } };
}
function deferred() {
  let resolve;
  return { promise: new Promise(done => { resolve = done; }), resolve };
}

test("CANON import binds its Keychain accounts to the original service and never exports credentials", async t => {
  const filename = path.join(await temporary(t), "voice-profiles.json");
  const mga = "https://voice.example.test", local = "https://lan.example.test:8443";
  await fs.writeFile(filename, JSON.stringify({ version: 1, active: "mga", profiles: {
    mga: { credential_saved: true, config: { provider: "mga", origin: mga, auth: "api_token" } },
    local: { credential_saved: true, config: { provider: "openai_audio", origin: local, auth: "bearer", verify_tls: false } },
  } }));
  const config = slot(), keys = [];
  const store = createProfiles({ config, lookup: async key => { keys.push(key); return "keychain-secret"; } });
  const view = await store.importCanon(filename);
  assert.equal(view.active, "mga");
  assert.equal(view.profiles.local.verifyTls, true);
  assert.equal((await store.resolve("mga")).token, "keychain-secret");
  assert.equal(keys[0], canonAccount("mga", normalizeProfile("mga", { origin: mga })));
  assert.equal(JSON.stringify(store.getSettings()).includes("keychain-secret"), false);
  assert.equal(JSON.stringify(config.read()).includes("keychain-secret"), false);
  store.save("mga", { ...view.profiles.mga, origin: "https://other.example.test", verifyTls: false });
  await assert.rejects(store.resolve("mga"), /没有可用的语音凭据/);
  assert.equal(keys.length, 1);
  assert.equal(store.getSettings().profiles.mga.verifyTls, true);
});

test("both CANON voice contracts use isolated routes and refuse to forward credentials through redirects", async () => {
  const calls = [];
  const fake = route => async (url, options, proxy) => {
    calls.push({ route, url, options, proxy });
    if (url.endsWith("/capabilities")) return Response.json({ stt_enabled: true, tts_enabled: true });
    if (url.endsWith("/transcriptions")) return Response.json({ text: "你好" });
    if (url.endsWith("/speech")) return new Response(pcmWav(sine(16000, 960)));
    return Response.json({ choices: [{ message: { content: "你好！" } }] });
  };
  for (const id of ["local", "mga"]) {
    const profile = { ...normalizeProfile(id, { origin: "https://voice.example.test" }), token: id + "-key" };
    const p = await createProvider(id, profile, { fetchMGA: fake("mga"), fetchLocal: fake("local") });
    try {
      await p.capabilities();
      assert.equal(await p.transcribe(pcmWav(sine(16000, 960))), "你好");
      assert.equal(await p.chat([{ role: "user", content: "你好" }]), "你好！");
      assert.equal((await p.speech("你好")).toString("ascii", 0, 4), "RIFF");
    } finally { await p.close(); }
  }
  const local = calls.filter(c => c.route === "local"), mga = calls.filter(c => c.route === "mga");
  assert.deepEqual(local.map(c => new URL(c.url).pathname), ["/v1/audio/transcriptions", "/v1/chat/completions", "/v1/audio/speech"]);
  assert.deepEqual(mga.map(c => new URL(c.url).pathname), ["/api/v3/audio/capabilities", "/api/v3/audio/transcriptions", "/api/v2/chat/completions", "/api/v3/audio/speech"]);
  assert.ok(local.every(c => c.options.dispatcher && c.options.headers.Authorization === "Bearer local-key"));
  assert.ok(mga.every(c => c.proxy === "system" && c.options.headers["x-baychatgpt-accesstoken"] === "mga-key"));
  assert.ok(calls.every(c => c.options.redirect === "manual"));
  assert.equal(mga[1].options.body.get("file").name, "voice.wav");
  assert.equal(mga[1].options.body.get("language"), "zh");
  const redirecting = await createProvider("mga", { ...normalizeProfile("mga", { origin: "https://voice.example.test" }), token: "never-log" },
    { fetchMGA: async () => new Response("never-log", { status: 307, headers: { location: "https://other.example.test" } }) });
  await assert.rejects(redirecting.speech("你好"), error => /HTTP 307/.test(error.message) && !error.message.includes("never-log"));
});

test("robot notes keep protected excerpts off the provider and confirmed tasks write once to the original vault", async t => {
  const root = await temporary(t);
  await fs.mkdir(path.join(root, "60_Health"));
  await fs.writeFile(path.join(root, "Meeting.md"), "# 会议纪要\n报价本周四截止");
  await fs.writeFile(path.join(root, "Secret.md"), "---\nsensitivity: \"sensitive\"\n---\n报价绝密");
  await fs.writeFile(path.join(root, "60_Health", "Private.md"), "# 报价健康记录");
  const changes = [], context = {}, signal = new AbortController().signal;
  let generation = 1;
  const action = createRobotActions({ enabled: () => true, getRoot: () => root, getGeneration: () => generation,
    addTask: input => changes.push(input), now: () => new Date(2026, 10, 6, 12) });
  const found = action("查笔记 报价", context, signal);
  assert.equal(found.speech, "找到1篇笔记，请看屏幕。");
  assert.match(found.display, /会议纪要.*报价本周四截止/);
  assert.doesNotMatch(found.display, /绝密|健康/);
  action("添加任务 明天发报价单", context, signal);
  assert.equal(changes.length, 0);
  generation++;
  assert.match(action("确认", context, signal).speech, /笔记库已切换/);
  action("添加任务 明天发报价单", context, signal);
  assert.equal(action("确认", context, signal).speech, "任务已添加。");
  assert.equal(action("确认", context, signal).speech, "当前没有待确认的任务。");
  assert.deepEqual(changes, [{ title: "发报价单", dueDate: "2026-11-07" }]);
});

async function availablePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
function device(url, token, version = 1) {
  const socket = new WebSocket(url, { headers: { Authorization: "Bearer " + token, "Protocol-Version": version } });
  const frames = [], pending = [];
  socket.on("message", (data, binary) => {
    const msg = binary ? data : JSON.parse(data);
    frames.push(msg);
    for (const waiter of pending) if (waiter.predicate(msg)) waiter.resolve(msg);
  });
  const send = data => socket.send(JSON.stringify(data));
  return { socket, frames, send, wait(predicate) {
    const found = frames.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise(resolve => pending.push({ predicate, resolve }));
  } };
}
function utterance(board, session_id, version = 1, auto = false) {
  const input = opus(16000);
  try {
    board.send({ type: "listen", state: "start", mode: auto ? "auto" : "manual", session_id });
    for (let i = 0; i < 8; i++) board.socket.send(pack(input.encode(sine(16000, 960), 960), version, 60 * i));
    if (!auto) board.send({ type: "listen", state: "stop", session_id });
    else for (let i = 8; i < 30; i++) board.socket.send(pack(input.encode(Buffer.alloc(1920), 960), version, 60 * i));
  } finally { input.delete(); }
}
test("stock Xiaozhi OTA, authenticated Opus round trip, VAD and provider switch cancel old turns", { timeout: 10000 }, async t => {
  const heard = deferred(), token = "robot-pairing-test";
  let mode = "local", block = false;
  const paths = [];
  const bridge = createBridge({ getPairing: () => token, addresses: () => ["127.0.0.1"],
    resolveProvider: async () => {
      const current = mode;
      return {
        async transcribe(wav, signal) {
          paths.push(current);
          assert.equal(wav.readUInt32LE(24), 16000);
          assert.ok(rms(decodeWav(wav, 16000)) > 0.03);
          if (block) {
            heard.resolve(signal);
            await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
          }
          return "你好";
        },
        async chat(messages) { assert.equal(messages.at(-1).content, "你好"); return current + " 回答"; },
        async speech() { return pcmWav(sine(22050, 2205), 22050); }, close() {},
      };
    },
  });
  t.after(() => bridge.stop());
  const port = await availablePort(), started = await bridge.start("127.0.0.1", port);
  assert.equal((await fetch("http://127.0.0.1:" + port + "/xiaozhi/ota/")).status, 404);
  const ota = await (await fetch(started.otaUrl, { method: "POST", body: "{}" })).json();
  assert.equal(ota.firmware, undefined);
  assert.equal(ota.websocket.token, token);
  const denied = device(ota.websocket.url, "bad");
  const [error] = await once(denied.socket, "error");
  assert.match(error.message, /403/);
  async function connect(version) {
    const board = device(ota.websocket.url, token, version);
    await once(board.socket, "open");
    board.send({ type: "hello", version, transport: "websocket", audio_params: { format: "opus", sample_rate: 16000, channels: 1, frame_duration: 60 } });
    const hello = await board.wait(m => m.type === "hello");
    assert.equal(hello.audio_params.sample_rate, 24000);
    return [board, hello.session_id];
  }
  const [first, firstId] = await connect(1);
  utterance(first, firstId, 1, true);
  await first.wait(m => m.type === "tts" && m.state === "stop");
  assert.ok(first.frames.some(m => m.type === "stt" && m.text === "你好"));
  assert.ok(first.frames.some(m => m.text === "local 回答"));
  const decoder = opus(24000);
  try { assert.ok(first.frames.filter(Buffer.isBuffer).some(packet => rms(decoder.decode(packet)) > .05)); }
  finally { decoder.delete(); }

  block = true;
  utterance(first, firstId);
  const signal = await heard.promise;
  mode = "mga";
  const closed = once(first.socket, "close");
  bridge.reset();
  assert.ok(signal.aborted);
  await closed;
  block = false;
  const [second, secondId] = await connect(3);
  utterance(second, secondId, 3);
  await second.wait(m => m.type === "tts" && m.state === "stop");
  assert.ok(second.frames.some(m => m.text === "mga 回答"));
  assert.ok(second.frames.filter(Buffer.isBuffer).every(packet => unpack(packet, 3).length > 0));
  assert.deepEqual(paths, ["local", "local", "mga"]);
});
