const fs = require("node:fs/promises");
const tls = require("node:tls");
const { Agent, fetch: directFetch, FormData } = require("undici");

const audioLimit = 8_000_000;
const messages = { 401: "凭据缺失或已过期", 403: "账户或接口权限不足", 404: "接口路径不存在",
  422: "模型或音色参数不匹配", 429: "调用频率或预算受限", 503: "服务暂时不可用" };
async function readBody(response, limit) {
  if (!response.body) throw Error("语音服务返回了空响应。");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) { await reader.cancel(); throw Error("语音服务响应超过大小限制。"); }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  } finally { reader.releaseLock(); }
}
async function localAgent(profile) {
  const connect = { timeout: 8000, rejectUnauthorized: profile.verifyTls };
  if (profile.caFile && profile.verifyTls) {
    try {
      if ((await fs.stat(profile.caFile)).size > 262144) throw Error();
      connect.ca = [...tls.getCACertificates("default"), ...tls.getCACertificates("system"),
        await fs.readFile(profile.caFile, "utf8")];
    } catch { throw Error("无法读取内网语音 CA 文件。"); }
  } else if (profile.verifyTls) {
    connect.ca = [...tls.getCACertificates("default"), ...tls.getCACertificates("system")];
  }
  return new Agent({ connect });
}
async function createProvider(id, profile, { fetchMGA, fetchLocal = directFetch } = {}) {
  const mga = id === "mga", label = mga ? "MGA" : "内网语音";
  const agent = mga ? null : await localAgent(profile);
  const authHeader = { bearer: "Authorization", api_token: "x-baychatgpt-accesstoken", x_api_key: "X-API-Key" }[profile.auth];
  async function request(path, body, signal, { timeout = 45000, audio = false } = {}) {
    signal?.throwIfAborted();
    const deadline = AbortSignal.timeout(timeout);
    const headers = { [authHeader]: profile.auth === "bearer" ? "Bearer " + profile.token : profile.token,
      Accept: audio ? "audio/wav" : "application/json" };
    if (!(body instanceof FormData) && body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(body);
    }
    const options = { method: body === undefined ? "GET" : "POST", body, headers, redirect: "manual",
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline };
    let response;
    try {
      response = mga ? await fetchMGA(profile.origin + path, options, "system")
        : await fetchLocal(profile.origin + path, { ...options, dispatcher: agent });
    } catch (error) {
      signal?.throwIfAborted();
      if (deadline.aborted) throw Error(label + "请求超时。");
      if (/CERT|VERIFY|SELF_SIGNED/i.test(error?.cause?.code || error?.code || "")) {
        throw Error(label + "证书验证失败，请检查服务器证书或配置内网 CA。");
      }
      throw Error("无法连接" + label + "，请检查内网、VPN 或代理。");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw Error(label + " HTTP " + response.status + "：" + (messages[response.status] || "接口请求失败") + "。");
    }
    let bytes;
    try { bytes = await readBody(response, audio ? audioLimit : 2_000_000); }
    catch (error) {
      signal?.throwIfAborted();
      if (deadline.aborted) throw Error(label + "响应超时。");
      if (error.message === "语音服务响应超过大小限制。") throw error;
      throw Error(label + "响应未完整接收。");
    }
    if (audio) return bytes;
    try { return JSON.parse(bytes); } catch { throw Error(label + "返回了无效 JSON。"); }
  }
  return {
    async capabilities(signal) {
      if (!mga) return;
      const data = await request("/api/v3/audio/capabilities", undefined, signal);
      if (data?.stt_enabled !== true || data?.tts_enabled !== true) throw Error("MGA 未启用转写或合成。");
    },
    async transcribe(wav, signal) {
      const form = new FormData();
      form.set("language", "zh");
      form.set("response_format", "json");
      form.set("temperature", "0");
      if (profile.sttModel) form.set("model", profile.sttModel);
      form.set("file", new Blob([wav], { type: "audio/wav" }), "voice.wav");
      const result = await request(profile.sttPath, form, signal, { timeout: mga ? 20000 : 35000 });
      if (typeof result?.text !== "string" || result.text.length > 1500) throw Error("语音转写格式无效。");
      return result.text.trim();
    },
    async chat(history, signal) {
      const body = { messages: history, temperature: 0.2, stream: false };
      if (profile.textModel) body.model = profile.textModel;
      const data = await request(profile.chatPath, body, signal);
      const msg = data?.choices?.[0]?.message;
      if (typeof msg?.content !== "string" || !msg.content.trim() || msg.tool_calls?.length) throw Error("语音对话没有返回可播报的回答。");
      return Array.from(msg.content.trim()).slice(0, 240).join("");
    },
    speech(input, signal) {
      const body = { input, response_format: "wav" };
      if (mga) body.language = "zh";
      if (profile.voice) body.voice = profile.voice;
      if (profile.ttsModel) body.model = profile.ttsModel;
      return request(profile.ttsPath, body, signal, { audio: true });
    },
    close: () => agent?.destroy().catch(() => {}),
  };
}
module.exports = { createProvider };
