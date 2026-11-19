const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { randomBytes } = require("node:crypto");
const { createProfiles } = require("./robot-voice-profiles");
const { createProvider } = require("./robot-voice-provider");
const { createDevices, discoverDevices } = require("./robot-devices");
const { createBridge } = require("./robot-voice-bridge");
const { decodeWav, pcmWav, IN_RATE } = require("./robot-voice-audio");

function registerRobotVoice({ app, BrowserWindow, ipcMain, dialog, clipboard, config, safeStorage, fetchMGA, trusted, runCommand }) {
  const page = path.join(__dirname, "../robot-voice/index.html");
  const pageUrl = pathToFileURL(page).href;
  let window, test, busy = false;
  const devices = createDevices({ config });
  let discovery;
  const profiles = createProfiles({ config, safeStorage });
  async function provider(id, signal) {
    const profile = await profiles.resolve(id, signal);
    signal?.throwIfAborted();
    return createProvider(id, profile, { fetchMGA });
  }
  const bridge = createBridge({
    devices,
    getPairing() {
      const saved = config.read().robotPairing;
      if (typeof saved === "string" && /^[a-f0-9]{48}$/.test(saved)) return saved;
      const token = randomBytes(24).toString("hex");
      config.write({ robotPairing: token });
      return token;
    },
    resolveProvider: signal => provider(profiles.getSettings().active, signal),
    runCommand,
  });
  const snapshot = () => ({ settings: profiles.getSettings(), bridge: bridge.snapshot(),
    devices: devices.snapshot(), notesEnabled: config.read().robotNotesEnabled === true });
  const isWindow = event => window && !window.isDestroyed() && event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === pageUrl;

  ipcMain.handle("robotVoice:open", (event) => {
    if (!trusted(event)) return false;
    if (window && !window.isDestroyed()) {
      if (window.isMinimized()) window.restore();
      window.show(); window.focus(); return true;
    }
    window = new BrowserWindow({
      width: 740, height: 755, minWidth: 550, minHeight: 500, title: "小智 · 机器人语音",
      webPreferences: { preload: path.join(__dirname, "robot-voice-preload.js"), sandbox: true, contextIsolation: true },
    });
    window.setMenuBarVisibility(false);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", event => event.preventDefault());
    window.once("closed", () => { window = undefined; test?.abort(); });
    void window.loadFile(page);
    return true;
  });

  const handle = (key, fn) => ipcMain.handle("robotVoice:" + key, async (event, value) => {
    if (!isWindow(event)) return { success: false, error: "请从机器人语音设置窗口操作。" };
    try { return { success: true, value: await fn(value) }; }
    catch (error) { return { success: false, error: error.message || "机器人语音操作失败。" }; }
  });
  function reset() { test?.abort(); bridge.reset(); }
  async function gateway(operation) {
    if (busy) throw Error("网关正在切换，请稍候。");
    busy = true;
    try { return await operation(); } finally { busy = false; }
  }
  handle("status", snapshot);
  handle("discover", query => {
    if (discovery) throw Error("正在查找设备，请稍候。");
    discovery = discoverDevices(query, devices.snapshot());
    return discovery.finally(() => { discovery = undefined; });
  });
  handle("renameDevice", ({ id, name }) => { devices.rename(id, name); return snapshot(); });
  handle("forgetDevice", id => { devices.forget(id); return snapshot(); });
  handle("controlDevice", ({ id, action, value }) => devices.control(id, action, value));
  handle("import", async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(window, {
      title: "选择 CANON/data/voice-profiles.json", defaultPath: path.join(app.getPath("home"), "Desktop", "Coding", "CANON", "data", "voice-profiles.json"),
      properties: ["openFile"], filters: [{ name: "CANON 语音配置", extensions: ["json"] }],
    });
    if (!canceled) { await profiles.importCanon(filePaths[0]); reset(); }
    return snapshot();
  });
  handle("chooseCA", async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(window, {
      title: "选择内网服务器 CA 证书", properties: ["openFile"],
      filters: [{ name: "CA 证书", extensions: ["pem", "crt", "cer"] }],
    });
    return canceled ? "" : filePaths[0];
  });
  handle("save", ({ id, fields }) => { profiles.save(id, fields); reset(); return snapshot(); });
  handle("select", id => { profiles.select(id); reset(); return snapshot(); });
  handle("start", ({ host, port }) => gateway(() => bridge.start(host, Number(port))));
  handle("stop", () => gateway(bridge.stop));
  handle("notes", value => { config.write({ robotNotesEnabled: value === true }); bridge.reset(); return snapshot(); });
  handle("copy", () => {
    const url = bridge.snapshot().otaUrl;
    if (!url) throw Error("请先启动网关。");
    clipboard.writeText(url);
  });
  handle("test", async id => {
    if (test) throw Error("已有语音测试正在运行。");
    const controller = new AbortController(), signal = controller.signal;
    test = controller;
    let client;
    try {
      client = await provider(id, signal);
      await client.capabilities(signal);
      const sample = await client.speech("你好，这是 Dance Monkey 的语音连接测试。", signal);
      const text = await client.transcribe(pcmWav(decodeWav(sample, IN_RATE)), signal);
      if (!text) throw Error("合成成功，但转写返回空白。");
      await client.chat([{ role: "user", content: "这是语音接口连通性测试，请只回答：收到。" }], signal);
      return "语音合成、中文转写、对话接口均已通过。";
    } catch (error) {
      if (signal.aborted) throw Error("测试已取消。");
      throw error;
    } finally {
      await client?.close();
      if (test === controller) test = undefined;
    }
  });
  handle("cancelTest", () => test?.abort());
  return { stop: () => { test?.abort(); return bridge.stop(); } };
}
module.exports = { registerRobotVoice };
