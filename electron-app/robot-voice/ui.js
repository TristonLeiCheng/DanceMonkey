const api = window.robotVoice;
const el = id => document.getElementById(id);
const form = el("profile"), host = el("host"), port = el("port"), toggle = el("toggle");
let state, busy = false, testing = false;
const statusLabels = { off: "网关未启动", waiting: "等待小智连接", connected: "小智已连接", listening: "正在收音",
  thinking: "正在处理", speaking: "正在播报", error: "语音处理失败" };
const credentialLabels = { canon: "使用 CANON 钥匙串凭据。首次连接可能需要授权。", session: "已设置本次运行的凭据。",
  saved: "凭据已加密保存。", "": "还没有凭据。" };
function notify(text, error = false) {
  el("notice").textContent = text;
  el("notice").dataset.error = error;
}
async function invoke(method, value) {
  const result = await api[method](value);
  if (!result.success) throw Error(result.error);
  return result.value;
}
function drawBridge(bridge) {
  const old = host.value;
  if (Array.from(host.options, option => option.value).join("|") !== bridge.addresses.join("|")) {
    host.replaceChildren(...bridge.addresses.map(address => new Option(address, address)));
  }
  if (bridge.host || bridge.addresses.includes(old)) host.value = bridge.host || old;
  if (bridge.running) port.value = bridge.port;
  host.disabled = port.disabled = bridge.running || busy;
  toggle.disabled = busy || (!bridge.running && !bridge.addresses.length);
  toggle.textContent = bridge.running ? "停止网关" : "启动网关";
  el("status").textContent = statusLabels[bridge.status] || statusLabels.off;
  el("status").title = bridge.detail || "";
  el("ota-row").hidden = !bridge.running;
  el("ota").value = bridge.otaUrl || "";
}
let deviceFingerprint = "";
function node(tag, text, className) {
  const item = document.createElement(tag);
  if (text) item.textContent = text;
  if (className) item.className = className;
  return item;
}
function drawDevices(rows = []) {
  const target = el("devices"), signature = JSON.stringify(rows);
  if (signature === deviceFingerprint || target.contains(document.activeElement)) return;
  deviceFingerprint = signature;
  target.replaceChildren();
  if (!rows.length) { target.append(node("p", "还没有接入过的小智。", "help")); return; }
  for (const row of rows) {
    const card = node("article", "", "device-card");
    const title = node("div", "", "heading");
    title.append(node("strong", row.name), node("span", row.connected ? "已连接 DM" : "未连接 DM", "help"));
    card.append(title, node("p", [row.ip, row.id, row.board, row.version && "固件 " + row.version].filter(Boolean).join(" · "), "device-meta"));
    if (row.lastSeen) card.append(node("p", "最近接入：" + new Date(row.lastSeen).toLocaleString(), "help"));
    const edit = node("div", "", "row");
    const label = node("label", "设备名称"), name = node("input");
    name.value = row.name; name.maxLength = 40; label.append(name); edit.append(label);
    function button(text, action, enabled = true) {
      const b = node("button", text); b.type = "button"; b.disabled = !enabled;
      b.onclick = () => run(action);
      return b;
    }
    edit.append(button("重命名", async () => {
      const next = await invoke("renameDevice", { id: row.id, name: name.value });
      document.activeElement?.blur(); draw(next); notify("设备名称已更新。");
    }));
    edit.append(button("移除记录", async () => {
      const next = await invoke("forgetDevice", row.id);
      document.activeElement?.blur(); draw(next); notify("已移除 DM 中的设备记录。");
    }, !row.connected));
    card.append(edit);
    const controls = node("div", "", "row device-controls");
    controls.append(button("刷新设备状态", async () => {
      const text = await invoke("controlDevice", { id: row.id, action: "status" });
      output.textContent = text || "设备未返回状态内容。";
    }, row.connected && row.tools.includes("self.get_device_status")));
    controls.append(button("断开连接", async () => {
      await invoke("controlDevice", { id: row.id, action: "disconnect" });
      notify("已断开。下次唤醒小智时可重新连接。");
    }, row.connected));
    card.append(controls);
    const output = node("pre", "", "device-output");
    for (const [action, text, tool] of [["volume", "音量", "self.audio_speaker.set_volume"], ["brightness", "亮度", "self.screen.set_brightness"]]) {
      if (!row.connected || !row.tools.includes(tool)) continue;
      const line = node("div", "", "row device-controls"), l = node("label", text + "（0–100）"), value = node("input");
      value.type = "number"; value.min = 0; value.max = 100; value.placeholder = "输入目标值"; l.append(value);
      line.append(l, button("设置" + text, async () => {
        if (!value.value) throw Error("请填写目标" + text + "。");
        notify(await invoke("controlDevice", { id: row.id, action, value: Number(value.value) }));
      }));
      card.append(line);
    }
    card.append(output); target.append(card);
  }
}
el("device-search").onsubmit = async event => {
  event.preventDefault();
  const button = el("discover"); if (button.disabled) return;
  button.disabled = true; button.textContent = "正在查找…";
  el("discovery-status").textContent = ""; el("candidates").replaceChildren();
  try {
    const result = await invoke("discover", el("device-query").value);
    el("discovery-status").textContent = result.warning || (result.candidates.length ?
      "找到 " + result.candidates.length + " 个候选设备，接入 DM 后可管理。" : "未找到可识别的小智。请确认网络，或填写 MAC / 设备名称后再试。");
    for (const item of result.candidates) {
      const card = node("div", "", "device-card");
      card.append(node("strong", item.name), node("p", [item.ip, item.id].filter(Boolean).join(" · "), "device-meta"),
        node("p", item.evidence, "help"));
      el("candidates").append(card);
    }
  } catch (error) { el("discovery-status").textContent = error.message; }
  finally { button.disabled = false; button.textContent = "查找设备"; }
};
function draw(data) {
  state = data;
  drawDevices(data.devices);
  const { active, profiles } = data.settings;
  const profile = profiles[active];
  for (const button of el("modes").querySelectorAll("button")) button.setAttribute("aria-pressed", button.dataset.mode === active);
  el("mode-help").textContent = active === "mga" ? "音频、对话和合成由公司 MGA 接口处理。" : "音频、对话和合成直连配置的内网语音服务器。";
  el("local-only").hidden = active !== "local";
  el("notes").checked = data.notesEnabled;
  for (const [key, value] of Object.entries(profile)) {
    if (key === "credential") continue;
    if (form.elements[key]?.type === "checkbox") form.elements[key].checked = value;
    else if (form.elements[key]) form.elements[key].value = value;
  }
  form.elements.token.value = "";
  form.elements.remember.checked = false;
  el("credential").textContent = credentialLabels[profile.credential];
  drawBridge(data.bridge);
}
function profileFields() {
  const data = Object.fromEntries(new FormData(form).entries());
  data.verifyTls = form.elements.verifyTls.checked;
  data.remember = form.elements.remember.checked;
  return data;
}
async function run(operation) {
  if (busy) return;
  busy = true;
  if (state) drawBridge(state.bridge);
  try { await operation(); }
  catch (error) { notify(error.message, true); if (state) el("notes").checked = state.notesEnabled; }
  finally { busy = false; if (state) drawBridge(state.bridge); }
}
toggle.onclick = () => {
  if (!state) return;
  const args = { host: host.value, port: Number(port.value) };
  void run(async () => {
    state.bridge = await invoke(state.bridge.running ? "stop" : "start", args);
    notify(state.bridge.running ? "网关已启动。请在小智配网页填入上方地址。" : "网关已停止。");
  });
};
el("import").onclick = () => run(async () => { draw(await invoke("import")); });
el("notes").onchange = () => run(async () => {
  const checked = el("notes").checked, data = await invoke("notes", checked);
  state = data;
  notify(checked ? "已开启笔记和任务。小智重新连接后生效。" : "已关闭笔记和任务。");
});
el("copy").onclick = () => run(async () => { await invoke("copy"); notify("已复制 OTA 地址。"); });
el("modes").onclick = event => {
  const mode = event.target.dataset.mode;
  if (!mode || !state || mode === state.settings.active) return;
  void run(async () => { draw(await invoke("select", mode)); notify("已切换语音服务。下一次唤醒小智时生效。"); });
};
form.onsubmit = event => {
  event.preventDefault();
  if (!state) return;
  void run(async () => {
    draw(await invoke("save", { id: state.settings.active, fields: profileFields() }));
    notify("当前语音配置已保存。");
  });
};
el("clear-credential").onclick = () => {
  if (!state) return;
  void run(async () => {
    draw(await invoke("save", { id: state.settings.active, fields: { ...state.settings.profiles[state.settings.active], clearCredential: true } }));
    notify("已清除 DM 对此语音凭据的访问。");
  });
};
el("choose-ca").onclick = () => run(async () => { const file = await invoke("chooseCA"); if (file) form.elements.caFile.value = file; });
el("clear-ca").onclick = () => { form.elements.caFile.value = ""; };
el("test").onclick = async () => {
  if (!state || busy || testing) return;
  testing = true;
  el("test").disabled = true;
  el("cancel-test").hidden = false;
  notify("正在测试合成、转写和对话…");
  try { notify(await invoke("test", state.settings.active)); }
  catch (error) { notify(error.message, true); }
  finally { testing = false; el("test").disabled = false; el("cancel-test").hidden = true; }
};
el("cancel-test").onclick = () => { void invoke("cancelTest").catch(error => notify(error.message, true)); };
async function init() {
  try {
    draw(await invoke("status"));
    setInterval(async () => {
      if (busy) return;
      try {
        const result = await invoke("status");
        if (busy) return;
        const changed = state.bridge.detail !== result.bridge.detail;
        state.bridge = result.bridge;
        state.devices = result.devices;
        drawDevices(result.devices);
        drawBridge(state.bridge);
        if (changed && result.bridge.detail && !testing) notify(result.bridge.detail, true);
      } catch { /* The next poll can recover. */ }
    }, 1000);
  } catch (error) { notify(error.message, true); }
}
void init();
