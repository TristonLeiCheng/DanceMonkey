const crypto = require("node:crypto");
const fs = require("node:fs");
const { fetchWithSystemProxy } = require("./system-proxy");

const DEFAULT_SYSTEM_PROMPT =
  "你是一个简洁高效的 AI 助手。请用清晰的语言回答；需要时使用 Markdown（标题、列表、加粗）。";

const VISION_SYSTEM_PROMPT = `你是专业的视觉与交互分析助手。请用**简体中文**回复。

输出必须使用 **Markdown**（# / ## 标题、**加粗**、- 列表、表格、行内代码等），便于阅读；不要用一个围栏代码块包裹整篇回答（短代码片段可单独使用代码块）。

请按下面逻辑组织内容：
1. **画面内容**：客观描述截图中的界面、文字、数据或场景（看不清请说明）。
2. **意图推断**：推测用户截取该画面时可能想做什么（例如排错、摘要、提取数据、操作指引、翻译等）。
3. **回应策略**：
   - 若用户意图**足够明确**：直接给出结论、步骤或可执行建议（尽量具体）。
   - 若意图**不明确**：在以上分析后，用 1～2 个具体问题邀请用户补充。

保持语气专业、简洁。`;

const VISION_USER_PROMPT = `请结合本截图完成分析，并按系统说明的结构用 Markdown 输出：
- 先描述画面与关键信息；
- 再推断用户可能意图；
- 若意图明确则直接给出可执行结论；若不明确则友好追问。`;

function resolveEndpoint(configured) {
  const value = String(configured || "").trim();
  if (!value) return "https://api.openai.com/v1/chat/completions";
  if (/chat\/completions/i.test(value) || /\/v1\/messages/i.test(value)) return value;
  const trimmed = value.replace(/\/+$/, "");
  return /\/(?:api\/)?v[123]$/i.test(trimmed) ? `${trimmed}/chat/completions` : trimmed;
}

function errorMessage(body, status) {
  try {
    const parsed = JSON.parse(body);
    const error = parsed.error;
    const detail =
      (typeof error === "string" ? error : error?.message || error?.detail) ||
      parsed.message ||
      parsed.detail;
    if (detail) return `API 错误 (${status})：${detail}`;
  } catch {}
  return `API 错误 (${status})：${body || "未知错误"}`;
}

function extractText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => part?.text || part?.content || "").join("");
  }
  return (
    payload?.choices?.[0]?.text ||
    (typeof payload?.message === "string" ? payload.message : "") ||
    (typeof payload?.content === "string" ? payload.content : "") ||
    (typeof payload?.result === "string" ? payload.result : "")
  );
}

function publicSettings(config) {
  return {
    apiEndpoint: config.apiEndpoint || "",
    apiKey: config.apiKey || "",
    model: config.model || "gpt-3.5-turbo",
    modelProfiles: Array.isArray(config.modelProfiles) ? config.modelProfiles : [],
    promptSnippets: Array.isArray(config.promptSnippets) ? config.promptSnippets : [],
    globalChatSystemPrompt: config.globalChatSystemPrompt || "",
  };
}

function createAiService(configStore) {
  const active = new Map();

  function getSettings() {
    return publicSettings(configStore.read());
  }

  function saveSettings(settings) {
    const allowed = {
      apiEndpoint: String(settings.apiEndpoint || "").trim(),
      apiKey: String(settings.apiKey || "").trim(),
      model: String(settings.model || "").trim() || "gpt-3.5-turbo",
      globalChatSystemPrompt: String(settings.globalChatSystemPrompt || ""),
    };
    return publicSettings(configStore.write(allowed));
  }

  async function chat(payload, onChunk) {
    const config = configStore.read();
    if (!String(config.apiKey || "").trim()) throw new Error("请先在 AI 设置中填写 API Key。");

    const requestId = payload.requestId || crypto.randomUUID();
    const controller = new AbortController();
    active.set(requestId, controller);
    const systemPrompt =
      String(payload.systemPrompt || config.globalChatSystemPrompt || "").trim() ||
      DEFAULT_SYSTEM_PROMPT;
    const history = Array.isArray(payload.messages)
      ? payload.messages
          .filter((message) => ["user", "assistant"].includes(message?.role))
          .map((message) => ({ role: message.role, content: String(message.content || "") }))
      : [];
    const body = {
      model: String(payload.model || config.model || "gpt-3.5-turbo").trim(),
      messages: [{ role: "system", content: systemPrompt }, ...history],
      temperature: 0.7,
      max_tokens: 4096,
      stream: true,
    };

    try {
      const endpoint = resolveEndpoint(config.apiEndpoint);
      const response = await fetchWithSystemProxy(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(errorMessage(await response.text(), response.status));

      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("text/event-stream") || !response.body) {
        const text = extractText(await response.json());
        if (!text) throw new Error("响应格式异常，未识别到模型文本。");
        onChunk(text);
        return text;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let fullText = "";
      let done = false;
      while (!done) {
        const next = await reader.read();
        done = next.done;
        buffer += decoder.decode(next.value || new Uint8Array(), { stream: !done });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          try {
            const chunk = JSON.parse(data)?.choices?.[0]?.delta?.content;
            const text = typeof chunk === "string" ? chunk : "";
            if (text) {
              fullText += text;
              onChunk(text);
            }
          } catch {}
        }
      }
      return fullText;
    } catch (error) {
      if (error?.name === "AbortError") throw new Error("已停止生成。");
      throw error;
    } finally {
      active.delete(requestId);
    }
  }

  async function analyzeImage(payload = {}) {
    const config = configStore.read();
    if (!String(config.apiKey || "").trim()) throw new Error("请先在 AI 设置中填写 API Key。");

    let dataUrl = String(payload.dataUrl || "").trim();
    if (!dataUrl && payload.imagePath) {
      const bytes = fs.readFileSync(payload.imagePath);
      dataUrl = `data:image/png;base64,${bytes.toString("base64")}`;
    }
    if (!dataUrl.startsWith("data:image/")) throw new Error("无效的截图数据。");

    const requestId = payload.requestId || crypto.randomUUID();
    const controller = new AbortController();
    active.set(requestId, controller);
    const timer = setTimeout(() => controller.abort(), 180000);

    const body = {
      model: String(payload.model || config.model || "gpt-4o").trim() || "gpt-4o",
      messages: [
        { role: "system", content: VISION_SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: String(payload.prompt || VISION_USER_PROMPT) },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
      temperature: 0.45,
      max_tokens: 4096,
      stream: false,
    };

    try {
      const endpoint = resolveEndpoint(config.apiEndpoint);
      const response = await fetchWithSystemProxy(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const raw = await response.text();
      if (!response.ok) throw new Error(errorMessage(raw, response.status));
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error("响应不是有效 JSON。");
      }
      const text = extractText(parsed);
      if (!text) {
        throw new Error(
          "响应格式异常（未识别到模型文本）。若当前模型不支持图片，请在设置中换用支持视觉的模型。",
        );
      }
      return text;
    } catch (error) {
      if (error?.name === "AbortError") throw new Error("请求超时或已取消。");
      throw error;
    } finally {
      clearTimeout(timer);
      active.delete(requestId);
    }
  }

  function cancel(requestId) {
    return active.get(requestId)?.abort() ?? false;
  }

  return { getSettings, saveSettings, chat, analyzeImage, cancel };
}

module.exports = { createAiService, resolveEndpoint };
