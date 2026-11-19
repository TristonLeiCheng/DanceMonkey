const fs = require("node:fs/promises");
const { createHash, randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const MODES = ["local", "mga"];
const SERVICE = "Tab-CANON voice profiles";
const DEFAULT_PATHS = ["/v1/audio/transcriptions", "/v1/chat/completions", "/v1/audio/speech"];
const MGA_PATHS = ["/api/v3/audio/transcriptions", "/api/v2/chat/completions", "/api/v3/audio/speech"];
function mode(id) {
  if (!MODES.includes(id)) throw Error("请选择内网本地语音或 MGA 语音。");
  return id;
}
function short(value, max = 160) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
function normalizeProfile(id, input = {}) {
  const mga = mode(id) === "mga";
  const rawOrigin = short(input.origin, 512);
  let origin = "", bindingOrigin = "";
  if (rawOrigin) {
    let url;
    try { url = new URL(rawOrigin); } catch { throw Error("语音服务地址无效。"); }
    if (!/^https:\/\/[^/\s?#]+\/?$/i.test(rawOrigin) || url.protocol !== "https:" ||
        !url.hostname || url.username || url.password) throw Error("请填写 HTTPS 服务根地址。");
    origin = url.origin;
    bindingOrigin = rawOrigin.replace(/\/$/, "");
  }
  const auth = input.auth || (mga ? "api_token" : "bearer");
  if (!["bearer", "api_token", "x_api_key"].includes(auth)) throw Error("语音凭据类型无效。");
  const paths = mga ? MGA_PATHS : DEFAULT_PATHS.map((fallback, i) => {
    const value = short(input[["sttPath", "chatPath", "ttsPath"][i]]) || fallback;
    if (!/^\/[A-Za-z0-9_-][A-Za-z0-9_/-]*$/.test(value)) throw Error("接口路径必须是站点内的相对路径。");
    return value;
  });
  return { origin, bindingOrigin, auth, textModel: short(input.textModel) || (mga ? "gpt-6-luna" : ""),
    sttModel: short(input.sttModel), ttsModel: short(input.ttsModel),
    voice: short(input.voice) || (mga ? "vivian" : ""),
    sttPath: paths[0], chatPath: paths[1], ttsPath: paths[2],
    caFile: mga ? "" : short(input.caFile, 2048),
    verifyTls: mga || input.verifyTls !== false };
}
function canonAccount(id, profile) {
  const values = [id, id === "mga" ? "mga" : "openai_audio", profile.bindingOrigin || profile.origin || "", profile.auth || ""];
  // Python json.dumps uses spaces after separators. The origin is ASCII in CANON's profiles.
  const bytes = "[" + values.map(value => JSON.stringify(value).replace(/[\u007f-\uffff]/g,
    c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"))).join(", ") + "]";
  return id + "-" + createHash("sha256").update(bytes).digest("hex");
}
async function macCredential(account, signal) {
  if (process.platform !== "darwin") return "";
  try {
    const { stdout } = await promisify(execFile)("/usr/bin/security",
      ["find-generic-password", "-s", SERVICE, "-a", account, "-w"],
      { timeout: 60000, maxBuffer: 32768, signal });
    return stdout.trim();
  } catch { return ""; }
}
function createProfiles({ config, safeStorage, lookup = macCredential }) {
  const session = new Map();
  const state = () => config.read().robotVoice || {};
  const getRow = id => state().profiles?.[id] || {};
  function getSettings() {
    const row = id => {
      const stored = getRow(id), { bindingOrigin, ...profile } = normalizeProfile(id, stored.bindingOrigin ?
        { ...stored, origin: stored.bindingOrigin } : stored);
      return { ...profile, origin: bindingOrigin || profile.origin,
        credential: session.has(canonAccount(id, { ...profile, bindingOrigin })) ? "session" :
          stored.secret ? "saved" : stored.canon ? "canon" : "" };
    };
    return { active: state().active === "mga" ? "mga" : "local", profiles: { local: row("local"), mga: row("mga") } };
  }
  function select(id) {
    mode(id);
    config.write({ robotVoice: { ...state(), active: id } });
    return getSettings();
  }
  function save(id, data = {}) {
    const previous = getRow(mode(id));
    const next = normalizeProfile(id, data);
    if (!next.origin) throw Error("请填写语音服务地址。");
    const key = canonAccount(id, next);
    const old = canonAccount(id, previous);
    const same = key === old;
    const token = typeof data.token === "string" ? data.token.trim() : "";
    if (token.length > 16000 || /[\r\n]/.test(token)) throw Error("语音凭据格式无效。");
    let secret = same && !data.clearCredential ? previous.secret : undefined;
    let canon = same && !data.clearCredential && !token && previous.canon === true;
    if (token) {
      secret = undefined;
      if (data.remember) {
        if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === "basic_text") {
          throw Error("系统凭据存储不可用，可以仅在本次运行中使用。");
        }
        secret = safeStorage.encryptString(token).toString("base64");
      }
    }
    config.write({ robotVoice: { ...state(), profiles: { ...state().profiles, [id]: { ...next, secret, canon } } } });
    if (token || data.clearCredential || !same) session.delete(old);
    if (token && !secret) session.set(key, token);
    return getSettings();
  }
  async function importCanon(filename) {
    let data;
    try {
      if ((await fs.stat(filename)).size > 65536) throw Error();
      data = JSON.parse(await fs.readFile(filename, "utf8"));
    } catch { throw Error("无法读取 CANON 的 voice-profiles.json。"); }
    if (data?.version !== 1) throw Error("CANON 语音配置版本不受支持。");
    const imported = {};
    for (const id of MODES) {
      const row = data.profiles?.[id], c = row?.config;
      if (c?.provider !== (id === "mga" ? "mga" : "openai_audio") || !c.origin) throw Error("CANON 语音配置不完整。");
      const next = normalizeProfile(id, { origin: c.origin, auth: c.auth, textModel: c.text_model, sttModel: c.stt_model,
        ttsModel: c.tts_model, voice: c.voice, sttPath: c.stt_path, chatPath: c.chat_path,
        ttsPath: c.tts_path, caFile: c.ca_file });
      const old = getRow(id);
      const same = canonAccount(id, old) === canonAccount(id, next);
      imported[id] = { ...next, secret: same ? old.secret : undefined,
        canon: row.credential_saved === true };
    }
    config.write({ robotVoice: { active: state().active || (data.active === "mga" ? "mga" : "local"), profiles: imported } });
    session.clear();
    return getSettings();
  }
  async function resolve(id, signal) {
    signal?.throwIfAborted();
    const row = getRow(mode(id));
    const profile = normalizeProfile(id, { ...row, origin: row.bindingOrigin || row.origin });
    if (!profile.origin) throw Error("请先导入 CANON 配置或填写服务地址。");
    const key = canonAccount(id, profile);
    let token = session.get(key);
    if (!token && row.secret) {
      try { token = safeStorage.decryptString(Buffer.from(row.secret, "base64")); }
      catch { throw Error("无法解锁 DM 中保存的语音凭据，请重新填写。"); }
    }
    if (!token && row.canon) {
      token = await lookup(key, signal);
      signal?.throwIfAborted();
      if (token && token.length <= 16000 && !/[\r\n]/.test(token) && getRow(id).canon && canonAccount(id, getRow(id)) === key) {
        session.set(key, token);
      }
    }
    if (!token || token.length > 16000 || /[\r\n]/.test(token)) throw Error("没有可用的语音凭据；请在 DM 中填写，或允许访问 CANON 钥匙串。");
    return { ...profile, token };
  }
  return { getSettings, select, save, importCanon, resolve };
}
module.exports = { MODES, createProfiles, normalizeProfile, canonAccount };
