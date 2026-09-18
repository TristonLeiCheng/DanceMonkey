using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using DesktopAssistant.Models;

namespace DesktopAssistant.Services;

/// <summary>将「目录型」API 根地址解析为 OpenAI 兼容的 Chat Completions 完整 URL。</summary>
internal static class OpenAiEndpointResolver
{
    /// <summary>
    /// 若用户填写的是 <c>https://host/api/v2/</c> 等根路径，则补全为 <c>.../chat/completions</c>。
    /// 若已包含 <c>chat/completions</c> 或 Anthropic <c>/v1/messages</c>，则原样返回。
    /// </summary>
    public static string ResolveChatCompletionsEndpoint(string? configured)
    {
        if (string.IsNullOrWhiteSpace(configured))
            return "https://api.openai.com/v1/chat/completions";

        var url = configured.Trim();

        if (url.Contains("chat/completions", StringComparison.OrdinalIgnoreCase))
            return url;

        if (url.Contains("/v1/messages", StringComparison.OrdinalIgnoreCase))
            return url;

        url = url.TrimEnd('/');

        if (EndsWithOpenAiCompatibleApiRoot(url))
            return url + "/chat/completions";

        return url;
    }

    private static bool EndsWithOpenAiCompatibleApiRoot(string url)
    {
        static bool EndsWithOrdinal(string u, string suffix) =>
            u.EndsWith(suffix, StringComparison.OrdinalIgnoreCase);

        return EndsWithOrdinal(url, "/api/v1") ||
               EndsWithOrdinal(url, "/api/v2") ||
               EndsWithOrdinal(url, "/api/v3") ||
               EndsWithOrdinal(url, "/v1") ||
               EndsWithOrdinal(url, "/v2") ||
               EndsWithOrdinal(url, "/v3");
    }
}

public sealed class ApiCallResult
{
    public bool Success { get; init; }
    public string? Result { get; init; }
    public string? Error { get; init; }
}

public sealed class TestConnectionResult
{
    public bool Success { get; init; }
    public string? Message { get; init; }
    public string? Error { get; init; }
}

public sealed class OpenAiApiClient
{
    private static readonly HttpClient Http = new()
    {
        Timeout = TimeSpan.FromSeconds(30)
    };

    private static readonly HttpClient HttpVision = new()
    {
        Timeout = TimeSpan.FromMinutes(3)
    };

    private readonly AppConfig _config;

    public OpenAiApiClient(AppConfig config)
    {
        _config = config;
    }

    public Task<ApiCallResult> CallAsync(
        string prompt,
        string systemPrompt = "你是一个有帮助的AI助手。",
        int maxTokens = 2000,
        double temperature = 0.7,
        CancellationToken cancellationToken = default) =>
        SendChatCompletionAsync(prompt, systemPrompt, maxTokens, temperature, Http, cancellationToken);

    /// <summary>发送包含多轮对话历史的请求。<paramref name="messages"/> 格式为 (role, content) 元组列表。</summary>
    public Task<ApiCallResult> CallWithHistoryAsync(
        IReadOnlyList<(string Role, string Content)> messages,
        string systemPrompt = "你是一个有帮助的AI助手。",
        int maxTokens = 2000,
        double temperature = 0.7,
        CancellationToken cancellationToken = default) =>
        SendChatCompletionWithHistoryAsync(messages, systemPrompt, maxTokens, temperature, Http, cancellationToken);

    /// <summary>纯文本对话，使用较长 HTTP 超时（适合笔记生成 PPT 大纲等较长 JSON 输出）。</summary>
    public Task<ApiCallResult> CallAsyncLong(
        string prompt,
        string systemPrompt = "你是一个有帮助的AI助手。",
        int maxTokens = 8192,
        double temperature = 0.35,
        CancellationToken cancellationToken = default) =>
        SendChatCompletionAsync(prompt, systemPrompt, maxTokens, temperature, HttpVision, cancellationToken);

    private async Task<ApiCallResult> SendChatCompletionAsync(
        string prompt,
        string systemPrompt,
        int maxTokens,
        double temperature,
        HttpClient http,
        CancellationToken cancellationToken)
    {
        var endpoint = OpenAiEndpointResolver.ResolveChatCompletionsEndpoint(_config.ApiEndpoint);

        var model = string.IsNullOrWhiteSpace(_config.Model) ? "gpt-3.5-turbo" : _config.Model.Trim();

        var payload = new
        {
            model,
            messages = new object[]
            {
                new { role = "system", content = systemPrompt },
                new { role = "user", content = prompt }
            },
            temperature,
            max_tokens = maxTokens
        };

        try
        {
            var json = JsonSerializer.Serialize(payload);
            using var request = new HttpRequestMessage(HttpMethod.Post, endpoint);
            request.Content = new StringContent(json, Encoding.UTF8, "application/json");
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _config.ApiKey ?? "");

            using var response = await http.SendAsync(request, cancellationToken).ConfigureAwait(false);
            var body = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);

            if (response.IsSuccessStatusCode)
            {
                var content = TryExtractAssistantText(body);
                if (content != null)
                    return new ApiCallResult { Success = true, Result = content };

                return new ApiCallResult
                {
                    Success = false,
                    Error = "响应格式异常（未识别到模型文本）。若贵司 API 非 OpenAI Chat Completions 格式，请联系管理员确认接口文档。"
                };
            }

            var errMsg = TryParseErrorMessage(body) ?? body;
            return new ApiCallResult
            {
                Success = false,
                Error = $"API错误 ({(int)response.StatusCode}): {errMsg}"
            };
        }
        catch (TaskCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return new ApiCallResult { Success = false, Error = "请求超时，请检查网络连接" };
        }
        catch (HttpRequestException ex)
        {
            return new ApiCallResult
            {
                Success = false,
                Error =
                    $"无法连接到 API：{ex.Message}。请确认端点填写为网关根（如 https://chat.int.bayer.com/api/v2/ ）或完整路径（…/chat/completions），且本机可访问公司网络/VPN。"
            };
        }
        catch (Exception ex)
        {
            return new ApiCallResult { Success = false, Error = $"请求失败: {ex.Message}" };
        }
    }

    private async Task<ApiCallResult> SendChatCompletionWithHistoryAsync(
        IReadOnlyList<(string Role, string Content)> messages,
        string systemPrompt,
        int maxTokens,
        double temperature,
        HttpClient http,
        CancellationToken cancellationToken)
    {
        var endpoint = OpenAiEndpointResolver.ResolveChatCompletionsEndpoint(_config.ApiEndpoint);
        var model = string.IsNullOrWhiteSpace(_config.Model) ? "gpt-3.5-turbo" : _config.Model.Trim();

        var msgList = new List<object> { new { role = "system", content = systemPrompt } };
        foreach (var (role, content) in messages)
            msgList.Add(new { role, content });

        var payload = new
        {
            model,
            messages = msgList,
            temperature,
            max_tokens = maxTokens
        };

        try
        {
            var json = JsonSerializer.Serialize(payload);
            using var request = new HttpRequestMessage(HttpMethod.Post, endpoint);
            request.Content = new StringContent(json, Encoding.UTF8, "application/json");
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _config.ApiKey ?? "");

            using var response = await http.SendAsync(request, cancellationToken).ConfigureAwait(false);
            var body = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);

            if (response.IsSuccessStatusCode)
            {
                var content = TryExtractAssistantText(body);
                if (content != null)
                    return new ApiCallResult { Success = true, Result = content };

                return new ApiCallResult
                {
                    Success = false,
                    Error = "响应格式异常（未识别到模型文本）。"
                };
            }

            var errMsg = TryParseErrorMessage(body) ?? body;
            return new ApiCallResult
            {
                Success = false,
                Error = $"API错误 ({(int)response.StatusCode}): {errMsg}"
            };
        }
        catch (TaskCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return new ApiCallResult { Success = false, Error = "请求超时，请检查网络连接" };
        }
        catch (HttpRequestException ex)
        {
            return new ApiCallResult
            {
                Success = false,
                Error = $"无法连接到 API：{ex.Message}"
            };
        }
        catch (Exception ex)
        {
            return new ApiCallResult { Success = false, Error = $"请求失败: {ex.Message}" };
        }
    }

    /// <summary>多模态：发送 PNG 截图（data URL）由模型分析。需网关支持 OpenAI 风格 vision（如 gpt-4o）。</summary>
    public async Task<ApiCallResult> CallWithImageAsync(
        string userPrompt,
        byte[] imagePngBytes,
        string? systemPrompt = null,
        int maxTokens = 4096,
        double temperature = 0.45,
        CancellationToken cancellationToken = default)
    {
        if (imagePngBytes.Length == 0)
            return new ApiCallResult { Success = false, Error = "图片数据为空。" };

        systemPrompt ??= """
你是专业的视觉与交互分析助手。请用**简体中文**回复。

输出必须使用 **Markdown**（# / ## 标题、**加粗**、`-` 列表、表格、`行内代码` 等），便于阅读；不要用**一个**围栏代码块包裹整篇回答（短代码片段可单独使用代码块）。

请按下面逻辑组织内容：
1. **画面内容**：客观描述截图中的界面、文字、数据或场景（看不清请说明）。
2. **意图推断**：推测用户截取该画面时可能想做什么（例如排错、摘要、提取数据、操作指引、翻译等）。
3. **回应策略**：
   - 若用户意图**足够明确**：直接给出结论、步骤或可执行建议（尽量具体）。
   - 若意图**不明确**：在以上分析后，用 1～2 个**具体问题**邀请用户补充（例如「您希望我重点说明哪一部分？」）。

保持语气专业、简洁。
""";

        var endpoint = OpenAiEndpointResolver.ResolveChatCompletionsEndpoint(_config.ApiEndpoint);
        var model = string.IsNullOrWhiteSpace(_config.Model) ? "gpt-4o" : _config.Model.Trim();
        var b64 = Convert.ToBase64String(imagePngBytes);
        var dataUrl = $"data:image/png;base64,{b64}";

        var payload = new
        {
            model,
            messages = new object[]
            {
                new { role = "system", content = systemPrompt },
                new
                {
                    role = "user",
                    content = new object[]
                    {
                        new { type = "text", text = userPrompt },
                        new { type = "image_url", image_url = new { url = dataUrl } }
                    }
                }
            },
            temperature,
            max_tokens = maxTokens
        };

        try
        {
            var json = JsonSerializer.Serialize(payload);
            using var request = new HttpRequestMessage(HttpMethod.Post, endpoint);
            request.Content = new StringContent(json, Encoding.UTF8, "application/json");
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _config.ApiKey ?? "");

            using var response = await HttpVision.SendAsync(request, cancellationToken).ConfigureAwait(false);
            var body = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);

            if (response.IsSuccessStatusCode)
            {
                var content = TryExtractAssistantText(body);
                if (content != null)
                    return new ApiCallResult { Success = true, Result = content };

                return new ApiCallResult
                {
                    Success = false,
                    Error = "响应格式异常（未识别到模型文本）。若当前模型不支持图片，请在设置中换用支持视觉的模型（如 gpt-4o）。"
                };
            }

            var errMsg = TryParseErrorMessage(body) ?? body;
            return new ApiCallResult
            {
                Success = false,
                Error = $"API错误 ({(int)response.StatusCode}): {errMsg}"
            };
        }
        catch (TaskCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return new ApiCallResult { Success = false, Error = "请求超时，请检查网络或稍后重试。" };
        }
        catch (HttpRequestException ex)
        {
            return new ApiCallResult { Success = false, Error = $"无法连接到 API：{ex.Message}" };
        }
        catch (Exception ex)
        {
            return new ApiCallResult { Success = false, Error = $"请求失败: {ex.Message}" };
        }
    }

    /// <summary>多模态：同一用户消息内包含文本与多张图片（OpenAI 兼容 vision）。无图片时退化为 <see cref="CallAsync"/>。</summary>
    public async Task<ApiCallResult> CallMultimodalAsync(
        string userText,
        IReadOnlyList<(byte[] Data, string MimeType)> images,
        string systemPrompt,
        int maxTokens = 4096,
        double temperature = 0.55,
        CancellationToken cancellationToken = default)
    {
        if (images == null || images.Count == 0)
            return await CallAsync(userText, systemPrompt, maxTokens, temperature, cancellationToken)
                .ConfigureAwait(false);

        var endpoint = OpenAiEndpointResolver.ResolveChatCompletionsEndpoint(_config.ApiEndpoint);
        var model = string.IsNullOrWhiteSpace(_config.Model) ? "gpt-4o" : _config.Model.Trim();

        var textPart = string.IsNullOrWhiteSpace(userText)
            ? "请根据图片内容进行说明或回答。"
            : userText.Trim();

        var userContent = new JsonArray { new JsonObject { ["type"] = "text", ["text"] = textPart } };

        foreach (var (data, mime) in images)
        {
            if (data.Length == 0)
                continue;
            var b64 = Convert.ToBase64String(data);
            var dataUrl = $"data:{mime};base64,{b64}";
            userContent.Add(new JsonObject
            {
                ["type"] = "image_url",
                ["image_url"] = new JsonObject { ["url"] = dataUrl }
            });
        }

        if (userContent.Count <= 1)
            return new ApiCallResult { Success = false, Error = "没有有效的图片数据。" };

        var payload = new JsonObject
        {
            ["model"] = model,
            ["messages"] = new JsonArray
            {
                new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                new JsonObject { ["role"] = "user", ["content"] = userContent }
            },
            ["temperature"] = temperature,
            ["max_tokens"] = maxTokens
        };

        try
        {
            var json = payload.ToJsonString();
            using var request = new HttpRequestMessage(HttpMethod.Post, endpoint);
            request.Content = new StringContent(json, Encoding.UTF8, "application/json");
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _config.ApiKey ?? "");

            using var response = await HttpVision.SendAsync(request, cancellationToken).ConfigureAwait(false);
            var body = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);

            if (response.IsSuccessStatusCode)
            {
                var content = TryExtractAssistantText(body);
                if (content != null)
                    return new ApiCallResult { Success = true, Result = content };

                return new ApiCallResult
                {
                    Success = false,
                    Error = "响应格式异常（未识别到模型文本）。若当前模型不支持多图，请换用支持视觉的模型（如 gpt-4o）。"
                };
            }

            var errMsg = TryParseErrorMessage(body) ?? body;
            return new ApiCallResult
            {
                Success = false,
                Error = $"API错误 ({(int)response.StatusCode}): {errMsg}"
            };
        }
        catch (TaskCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return new ApiCallResult { Success = false, Error = "请求超时，请检查网络或稍后重试。" };
        }
        catch (HttpRequestException ex)
        {
            return new ApiCallResult { Success = false, Error = $"无法连接到 API：{ex.Message}" };
        }
        catch (Exception ex)
        {
            return new ApiCallResult { Success = false, Error = $"请求失败: {ex.Message}" };
        }
    }

    /// <summary>#17 SSE 流式输出：逐块回调 AI 生成的文本。</summary>
    public async Task<ApiCallResult> CallStreamAsync(
        string prompt,
        string systemPrompt,
        int maxTokens,
        double temperature,
        Action<string> onChunk,
        CancellationToken cancellationToken = default)
    {
        var messages = new object[]
        {
            new { role = "system", content = systemPrompt },
            new { role = "user", content = prompt }
        };
        return await CallStreamWithMessagesAsync(messages, maxTokens, temperature, onChunk, cancellationToken)
            .ConfigureAwait(false);
    }

    /// <summary>多轮对话流式输出：接受完整 messages 数组（含历史），逐块回调。</summary>
    public async Task<ApiCallResult> CallStreamWithMessagesAsync(
        object[] messages,
        int maxTokens,
        double temperature,
        Action<string> onChunk,
        CancellationToken cancellationToken = default)
    {
        var endpoint = OpenAiEndpointResolver.ResolveChatCompletionsEndpoint(_config.ApiEndpoint);
        var model = string.IsNullOrWhiteSpace(_config.Model) ? "gpt-3.5-turbo" : _config.Model.Trim();

        var payload = new
        {
            model,
            messages,
            temperature,
            max_tokens = maxTokens,
            stream = true
        };

        try
        {
            var json = JsonSerializer.Serialize(payload);
            using var request = new HttpRequestMessage(HttpMethod.Post, endpoint);
            request.Content = new StringContent(json, Encoding.UTF8, "application/json");
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _config.ApiKey ?? "");

            using var response = await HttpVision.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                var errBody = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
                var errMsg = TryParseErrorMessage(errBody) ?? errBody;
                return new ApiCallResult { Success = false, Error = $"API错误 ({(int)response.StatusCode}): {errMsg}" };
            }

            using var stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
            using var reader = new System.IO.StreamReader(stream, Encoding.UTF8);
            var fullText = new StringBuilder();

            while (!reader.EndOfStream)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var line = await reader.ReadLineAsync().ConfigureAwait(false);
                if (string.IsNullOrEmpty(line)) continue;
                if (!line.StartsWith("data: ", StringComparison.Ordinal)) continue;
                var data = line["data: ".Length..];
                if (data == "[DONE]") break;

                try
                {
                    using var doc = JsonDocument.Parse(data);
                    var root = doc.RootElement;
                    if (root.TryGetProperty("choices", out var choices) && choices.GetArrayLength() > 0)
                    {
                        var c0 = choices[0];
                        if (c0.TryGetProperty("delta", out var delta) &&
                            delta.TryGetProperty("content", out var contentEl) &&
                            contentEl.ValueKind == JsonValueKind.String)
                        {
                            var chunk = contentEl.GetString();
                            if (!string.IsNullOrEmpty(chunk))
                            {
                                fullText.Append(chunk);
                                onChunk(chunk);
                            }
                        }
                    }
                }
                catch
                {
                    // 跳过无法解析的行
                }
            }

            return new ApiCallResult { Success = true, Result = fullText.ToString() };
        }
        catch (TaskCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return new ApiCallResult { Success = false, Error = "请求超时" };
        }
        catch (OperationCanceledException)
        {
            return new ApiCallResult { Success = false, Error = "已取消" };
        }
        catch (HttpRequestException ex)
        {
            return new ApiCallResult { Success = false, Error = $"无法连接到 API：{ex.Message}" };
        }
        catch (Exception ex)
        {
            return new ApiCallResult { Success = false, Error = $"流式请求失败: {ex.Message}" };
        }
    }

    public async Task<TestConnectionResult> TestConnectionAsync(CancellationToken cancellationToken = default)
    {
        var r = await CallAsync(
            "请回复'连接成功'",
            "你是一个测试助手，请简短回复。",
            cancellationToken: cancellationToken).ConfigureAwait(false);

        if (r.Success)
            return new TestConnectionResult { Success = true, Message = "API连接测试成功！" };

        return new TestConnectionResult { Success = false, Error = r.Error };
    }

    private static string? TryParseErrorMessage(string body)
    {
        try
        {
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            if (root.TryGetProperty("error", out var err))
            {
                if (err.ValueKind == JsonValueKind.String)
                    return err.GetString();
                if (err.TryGetProperty("message", out var msg))
                    return msg.GetString();
                if (err.TryGetProperty("detail", out var detail))
                    return detail.ValueKind == JsonValueKind.String ? detail.GetString() : detail.ToString();
            }

            if (root.TryGetProperty("message", out var m) && m.ValueKind == JsonValueKind.String)
                return m.GetString();
            if (root.TryGetProperty("detail", out var d) && d.ValueKind == JsonValueKind.String)
                return d.GetString();
        }
        catch
        {
            // ignore
        }

        return null;
    }

    /// <summary>从 OpenAI 风格或其它常见 JSON 中提取助手回复文本。</summary>
    private static string? TryExtractAssistantText(string body)
    {
        try
        {
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;

            if (root.TryGetProperty("choices", out var choices) && choices.GetArrayLength() > 0)
            {
                var c0 = choices[0];
                if (c0.TryGetProperty("message", out var message))
                {
                    if (message.TryGetProperty("content", out var contentEl))
                    {
                        if (contentEl.ValueKind == JsonValueKind.String)
                            return contentEl.GetString();
                        if (contentEl.ValueKind == JsonValueKind.Array)
                        {
                            // 部分网关返回 content 为 [{type,text}] 片段
                            var sb = new StringBuilder();
                            foreach (var part in contentEl.EnumerateArray())
                            {
                                if (part.TryGetProperty("text", out var t))
                                    sb.Append(t.GetString());
                                else if (part.TryGetProperty("content", out var c2) &&
                                         c2.ValueKind == JsonValueKind.String)
                                    sb.Append(c2.GetString());
                            }

                            var s = sb.ToString();
                            if (s.Length > 0)
                                return s;
                        }
                    }
                }

                if (c0.TryGetProperty("text", out var textEl) && textEl.ValueKind == JsonValueKind.String)
                    return textEl.GetString();
            }

            if (root.TryGetProperty("message", out var m) && m.ValueKind == JsonValueKind.String)
                return m.GetString();
            if (root.TryGetProperty("content", out var c) && c.ValueKind == JsonValueKind.String)
                return c.GetString();
            if (root.TryGetProperty("result", out var r) && r.ValueKind == JsonValueKind.String)
                return r.GetString();
        }
        catch
        {
            // ignore
        }

        return null;
    }
}
