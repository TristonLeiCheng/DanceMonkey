using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using DanceMonkey.Agent.Core.Abstractions;
using DanceMonkey.Agent.Core.Models;

namespace DanceMonkey.Agent.Core.Runtime;

/// <summary>
/// OpenAI 兼容的 Chat Completions 客户端（无 UI 依赖），供 CLI 等使用；支持 SSE 流式输出与会话历史。
/// </summary>
public sealed class OpenAiCompatibleLlmClient : ILlmClient
{
    private static readonly HttpClient Http = new()
    {
        Timeout = TimeSpan.FromMinutes(5)
    };

    private readonly string _endpoint;
    private readonly string _apiKey;
    private readonly string _defaultModel;

    public OpenAiCompatibleLlmClient(string endpointOrRoot, string apiKey, string defaultModel)
    {
        _endpoint = ResolveChatCompletionsEndpoint(endpointOrRoot);
        _apiKey = apiKey ?? "";
        _defaultModel = string.IsNullOrWhiteSpace(defaultModel) ? "gpt-4o-mini" : defaultModel;
    }

    public async Task<LlmResult> CompleteAsync(
        LlmRequest request,
        Action<string>? onChunk,
        CancellationToken ct)
    {
        var model = string.IsNullOrWhiteSpace(request.Model) ? _defaultModel : request.Model!;
        var messages = BuildMessageArray(request);

        if (!request.Stream || onChunk == null)
            return await CallNonStreamAsync(model, messages, request, ct).ConfigureAwait(false);

        return await CallStreamAsync(model, messages, request, onChunk, ct).ConfigureAwait(false);
    }

    // ═══════════════ 非流式 ═══════════════

    private async Task<LlmResult> CallNonStreamAsync(
        string model,
        object[] messages,
        LlmRequest request,
        CancellationToken ct)
    {
        var payload = new
        {
            model,
            messages,
            temperature = request.Temperature,
            max_tokens = request.MaxTokens,
        };

        try
        {
            var json = JsonSerializer.Serialize(payload);
            using var req = new HttpRequestMessage(HttpMethod.Post, _endpoint);
            req.Content = new StringContent(json, Encoding.UTF8, "application/json");
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _apiKey);

            using var resp = await Http.SendAsync(req, ct).ConfigureAwait(false);
            var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);

            if (!resp.IsSuccessStatusCode)
                return LlmResult.Fail($"API 错误 ({(int)resp.StatusCode}): {TryParseError(body) ?? body}");

            var text = TryExtractAssistantText(body);
            if (text == null)
                return LlmResult.Fail("响应格式无法识别（未找到 assistant 文本）");

            return LlmResult.Ok(text, approxTokens: EstimateTokens(request, text));
        }
        catch (TaskCanceledException) when (!ct.IsCancellationRequested)
        {
            return LlmResult.Fail("请求超时");
        }
        catch (HttpRequestException ex)
        {
            return LlmResult.Fail($"无法连接到 API: {ex.Message}");
        }
        catch (Exception ex)
        {
            return LlmResult.Fail($"请求失败: {ex.Message}");
        }
    }

    // ═══════════════ 流式 SSE ═══════════════

    private async Task<LlmResult> CallStreamAsync(
        string model,
        object[] messages,
        LlmRequest request,
        Action<string> onChunk,
        CancellationToken ct)
    {
        var payload = new
        {
            model,
            messages,
            temperature = request.Temperature,
            max_tokens = request.MaxTokens,
            stream = true,
        };

        try
        {
            var json = JsonSerializer.Serialize(payload);
            using var req = new HttpRequestMessage(HttpMethod.Post, _endpoint);
            req.Content = new StringContent(json, Encoding.UTF8, "application/json");
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _apiKey);

            using var resp = await Http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct)
                .ConfigureAwait(false);

            if (!resp.IsSuccessStatusCode)
            {
                var err = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
                return LlmResult.Fail($"API 错误 ({(int)resp.StatusCode}): {TryParseError(err) ?? err}");
            }

            using var stream = await resp.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
            using var reader = new StreamReader(stream, Encoding.UTF8);
            var fullText = new StringBuilder();

            while (!reader.EndOfStream)
            {
                ct.ThrowIfCancellationRequested();
                var line = await reader.ReadLineAsync(ct).ConfigureAwait(false);
                if (string.IsNullOrEmpty(line)) continue;
                if (!line.StartsWith("data: ", StringComparison.Ordinal)) continue;
                var data = line["data: ".Length..];
                if (data == "[DONE]") break;

                try
                {
                    using var doc = JsonDocument.Parse(data);
                    var root = doc.RootElement;
                    if (!root.TryGetProperty("choices", out var choices) || choices.GetArrayLength() == 0)
                        continue;

                    var c0 = choices[0];
                    if (!c0.TryGetProperty("delta", out var delta)) continue;
                    if (!delta.TryGetProperty("content", out var contentEl) ||
                        contentEl.ValueKind != JsonValueKind.String) continue;

                    var chunk = contentEl.GetString();
                    if (string.IsNullOrEmpty(chunk)) continue;

                    fullText.Append(chunk);
                    onChunk(chunk);
                }
                catch
                {
                    // 跳过无法解析的 SSE 行
                }
            }

            var text = fullText.ToString();
            return LlmResult.Ok(text, approxTokens: EstimateTokens(request, text));
        }
        catch (OperationCanceledException)
        {
            return LlmResult.Fail("已取消");
        }
        catch (HttpRequestException ex)
        {
            return LlmResult.Fail($"无法连接到 API: {ex.Message}");
        }
        catch (Exception ex)
        {
            return LlmResult.Fail($"流式请求失败: {ex.Message}");
        }
    }

    // ═══════════════ 辅助 ═══════════════

    private static object[] BuildMessageArray(LlmRequest req)
    {
        var list = new List<object>(req.Messages.Count + 1)
        {
            new { role = "system", content = req.SystemPrompt },
        };

        foreach (var m in req.Messages)
        {
            if (m.Role == "tool")
            {
                // OpenAI 兼容网关大多不识别 tool 角色（除非走 tools/function calling），
                // 折叠为一条 user 消息并标注来源
                list.Add(new
                {
                    role = "user",
                    content = $"[tool_result name={m.ToolName ?? "?"}]\n{m.Content}",
                });
            }
            else if (m.Role == "user" && m.HasImages)
            {
                list.Add(new { role = "user", content = BuildVisionUserContent(m) });
            }
            else
            {
                list.Add(new { role = m.Role, content = m.Content });
            }
        }

        return list.ToArray();
    }

    private static object BuildVisionUserContent(AgentMessage m)
    {
        var parts = new List<object>();
        var text = string.IsNullOrWhiteSpace(m.Content)
            ? "请结合附带的图片内容回答。"
            : m.Content;

        parts.Add(new { type = "text", text });

        foreach (var img in m.Images!)
        {
            if (img.Data.Length == 0)
                continue;
            var mime = string.IsNullOrWhiteSpace(img.MimeType) ? "image/png" : img.MimeType.Trim();
            var b64 = Convert.ToBase64String(img.Data);
            parts.Add(new
            {
                type = "image_url",
                image_url = new { url = $"data:{mime};base64,{b64}" },
            });
        }

        return parts;
    }

    internal static string ResolveChatCompletionsEndpoint(string? configured)
    {
        if (string.IsNullOrWhiteSpace(configured))
            return "https://api.openai.com/v1/chat/completions";

        var url = configured.Trim();
        if (url.Contains("chat/completions", StringComparison.OrdinalIgnoreCase)) return url;
        if (url.Contains("/v1/messages", StringComparison.OrdinalIgnoreCase)) return url;

        url = url.TrimEnd('/');
        string[] apiRoots = { "/api/v1", "/api/v2", "/api/v3", "/v1", "/v2", "/v3" };
        foreach (var root in apiRoots)
        {
            if (url.EndsWith(root, StringComparison.OrdinalIgnoreCase))
                return url + "/chat/completions";
        }
        return url;
    }

    private static string? TryExtractAssistantText(string body)
    {
        try
        {
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            if (root.TryGetProperty("choices", out var choices) && choices.GetArrayLength() > 0)
            {
                var c0 = choices[0];
                if (c0.TryGetProperty("message", out var msg) &&
                    msg.TryGetProperty("content", out var content))
                {
                    if (content.ValueKind == JsonValueKind.String)
                        return content.GetString();

                    if (content.ValueKind == JsonValueKind.Array)
                    {
                        var sb = new StringBuilder();
                        foreach (var part in content.EnumerateArray())
                        {
                            if (part.TryGetProperty("text", out var t))
                                sb.Append(t.GetString());
                        }
                        if (sb.Length > 0) return sb.ToString();
                    }
                }
            }
            if (root.TryGetProperty("content", out var c) && c.ValueKind == JsonValueKind.String)
                return c.GetString();
        }
        catch { }
        return null;
    }

    private static string? TryParseError(string body)
    {
        try
        {
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            if (root.TryGetProperty("error", out var err))
            {
                if (err.ValueKind == JsonValueKind.String) return err.GetString();
                if (err.TryGetProperty("message", out var m)) return m.GetString();
            }
            if (root.TryGetProperty("message", out var m2) && m2.ValueKind == JsonValueKind.String)
                return m2.GetString();
        }
        catch { }
        return null;
    }

    private static long EstimateTokens(LlmRequest req, string response)
    {
        long total = Rough(req.SystemPrompt) + Rough(response);
        foreach (var m in req.Messages) total += Rough(m.Content);
        return total;

        static long Rough(string? s)
        {
            if (string.IsNullOrEmpty(s)) return 0;
            long cjk = 0, ascii = 0;
            foreach (var c in s)
            {
                if (c > 0x7F) cjk++;
                else ascii++;
            }
            return (long)(cjk / 1.5 + ascii / 4.0);
        }
    }
}
