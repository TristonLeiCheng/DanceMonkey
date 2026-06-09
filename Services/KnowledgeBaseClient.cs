using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using DesktopAssistant.Models;

namespace DesktopAssistant.Services;

public sealed class KnowledgeBaseResult
{
    public bool Success { get; init; }
    public string? Reply { get; init; }
    /// <summary>路由信息（agent / route_to / matched_intent 等），可作为消息上方小标签显示。</summary>
    public string? RouteInfo { get; init; }
    /// <summary>引用来源列表（如有）。</summary>
    public IReadOnlyList<string>? Sources { get; init; }
    public string? Error { get; init; }
    /// <summary>原始响应文本（调试用）。</summary>
    public string? RawJson { get; init; }
}

/// <summary>
/// 在线知识库 HTTP 客户端：POST {base}/api/chat/，请求体 {message, auto_route}。
/// 响应结构未严格固定，本类做了鲁棒解析：依次尝试 reply / answer / response / data / message / result。
/// </summary>
public sealed class KnowledgeBaseClient
{
    private static readonly HttpClient SharedHttp = new()
    {
        Timeout = TimeSpan.FromSeconds(120)
    };

    private readonly AppConfig _config;

    public KnowledgeBaseClient(AppConfig config)
    {
        _config = config;
    }

    public string ResolvedEndpoint
    {
        get
        {
            var baseUrl = string.IsNullOrWhiteSpace(_config.KnowledgeBaseUrl)
                ? "http://10.66.30.132:8000"
                : _config.KnowledgeBaseUrl.Trim();
            baseUrl = baseUrl.TrimEnd('/');
            // 已经包含 /api/chat 时直接返回；否则补全。
            if (baseUrl.EndsWith("/api/chat", StringComparison.OrdinalIgnoreCase))
                return baseUrl + "/";
            if (baseUrl.EndsWith("/api/chat/", StringComparison.OrdinalIgnoreCase))
                return baseUrl;
            return baseUrl + "/api/chat/";
        }
    }

    public async Task<KnowledgeBaseResult> AskAsync(
        string message,
        bool? autoRouteOverride = null,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(message))
            return new KnowledgeBaseResult { Success = false, Error = "消息为空。" };

        var endpoint = ResolvedEndpoint;
        var autoRoute = autoRouteOverride ?? _config.KnowledgeBaseAutoRoute;

        var payload = new
        {
            message = message.Trim(),
            auto_route = autoRoute
        };

        var json = JsonSerializer.Serialize(payload);

        using var req = new HttpRequestMessage(HttpMethod.Post, endpoint)
        {
            Content = new StringContent(json, Encoding.UTF8, "application/json")
        };
        req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));

        try
        {
            var timeoutSec = _config.KnowledgeBaseTimeoutSeconds <= 0 ? 60 : _config.KnowledgeBaseTimeoutSeconds;
            using var perCallCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            perCallCts.CancelAfter(TimeSpan.FromSeconds(timeoutSec));

            var resp = await SharedHttp.SendAsync(req, HttpCompletionOption.ResponseContentRead, perCallCts.Token)
                .ConfigureAwait(false);
            var body = await resp.Content.ReadAsStringAsync(perCallCts.Token).ConfigureAwait(false);

            if (!resp.IsSuccessStatusCode)
            {
                var snippet = string.IsNullOrEmpty(body)
                    ? ""
                    : "\n" + (body.Length > 800 ? body[..800] + "…" : body);
                return new KnowledgeBaseResult
                {
                    Success = false,
                    Error = $"HTTP {(int)resp.StatusCode} {resp.ReasonPhrase}{snippet}",
                    RawJson = body
                };
            }

            return ParseResponse(body);
        }
        catch (TaskCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return new KnowledgeBaseResult
            {
                Success = false,
                Error = $"知识库请求超时（>{_config.KnowledgeBaseTimeoutSeconds}s），请检查 {endpoint} 是否可达。"
            };
        }
        catch (HttpRequestException ex)
        {
            return new KnowledgeBaseResult
            {
                Success = false,
                Error = $"无法连接知识库：{ex.Message}"
            };
        }
        catch (Exception ex)
        {
            return new KnowledgeBaseResult { Success = false, Error = ex.Message };
        }
    }

    public async Task<TestConnectionResult> TestConnectionAsync(CancellationToken ct = default)
    {
        var r = await AskAsync("ping", autoRouteOverride: false, cancellationToken: ct).ConfigureAwait(false);
        if (r.Success)
            return new TestConnectionResult { Success = true, Message = "知识库可达。" };
        return new TestConnectionResult { Success = false, Error = r.Error ?? "未知错误。" };
    }

    /// <summary>鲁棒解析：尝试常见字段名，最终回退为整个 body 字符串。</summary>
    private static KnowledgeBaseResult ParseResponse(string body)
    {
        if (string.IsNullOrWhiteSpace(body))
            return new KnowledgeBaseResult { Success = false, Error = "响应为空。" };

        JsonNode? root = null;
        try { root = JsonNode.Parse(body); }
        catch { /* 非 JSON 走 raw 文本 */ }

        if (root is null)
        {
            // 非 JSON：当作纯文本回复
            return new KnowledgeBaseResult { Success = true, Reply = body.Trim(), RawJson = body };
        }

        // 字符串根
        if (root is JsonValue rootVal && rootVal.TryGetValue<string>(out var sRoot))
            return new KnowledgeBaseResult { Success = true, Reply = sRoot, RawJson = body };

        if (root is JsonObject obj)
        {
            // 1) 找 reply 字段（按优先级）
            string? reply = ExtractStringField(obj,
                "reply", "answer", "response", "result", "output", "text", "content");

            // 一些 KB 系统会把回复放在嵌套 data 里
            if (string.IsNullOrWhiteSpace(reply) && obj["data"] is JsonNode dataNode)
            {
                if (dataNode is JsonValue dv && dv.TryGetValue<string>(out var ds))
                    reply = ds;
                else if (dataNode is JsonObject dobj)
                    reply = ExtractStringField(dobj,
                        "reply", "answer", "response", "result", "output", "text", "content", "message");
            }

            // 2) 路由信息（可选，用作 UI 标签）
            string? routeInfo = ExtractStringField(obj,
                "route", "route_to", "agent", "matched_intent", "intent", "source_name");
            if (string.IsNullOrWhiteSpace(routeInfo) && obj["routing"] is JsonObject ro)
                routeInfo = ExtractStringField(ro, "agent", "intent", "matched", "name");

            // 3) 引用来源（可选）
            var sources = ExtractStringList(obj, "sources", "citations", "references", "documents", "source_documents");

            if (!string.IsNullOrWhiteSpace(reply))
            {
                return new KnowledgeBaseResult
                {
                    Success = true,
                    Reply = reply.Trim(),
                    RouteInfo = string.IsNullOrWhiteSpace(routeInfo) ? null : routeInfo.Trim(),
                    Sources = sources,
                    RawJson = body
                };
            }

            // 显式错误字段
            string? errMsg = ExtractStringField(obj, "error", "message", "detail", "msg");
            if (!string.IsNullOrWhiteSpace(errMsg))
                return new KnowledgeBaseResult { Success = false, Error = errMsg, RawJson = body };

            // 兜底：把整个 JSON 作为回复（让用户至少看到内容）
            return new KnowledgeBaseResult
            {
                Success = true,
                Reply = body.Trim(),
                RouteInfo = string.IsNullOrWhiteSpace(routeInfo) ? null : routeInfo.Trim(),
                Sources = sources,
                RawJson = body
            };
        }

        return new KnowledgeBaseResult { Success = true, Reply = body.Trim(), RawJson = body };
    }

    private static string? ExtractStringField(JsonObject obj, params string[] keys)
    {
        foreach (var k in keys)
        {
            if (obj.TryGetPropertyValue(k, out var node) && node is JsonValue v)
            {
                if (v.TryGetValue<string>(out var s) && !string.IsNullOrWhiteSpace(s))
                    return s;
            }
        }
        return null;
    }

    private static IReadOnlyList<string>? ExtractStringList(JsonObject obj, params string[] keys)
    {
        foreach (var k in keys)
        {
            if (obj.TryGetPropertyValue(k, out var node) && node is JsonArray arr)
            {
                var list = new List<string>();
                foreach (var n in arr)
                {
                    if (n is JsonValue v && v.TryGetValue<string>(out var s) && !string.IsNullOrWhiteSpace(s))
                    {
                        list.Add(s.Trim());
                    }
                    else if (n is JsonObject inner)
                    {
                        // 文档对象：尝试 title / name / source / url
                        var t = ExtractStringField(inner, "title", "name", "source", "url", "path", "file");
                        if (!string.IsNullOrWhiteSpace(t))
                            list.Add(t.Trim());
                    }
                }
                if (list.Count > 0)
                    return list;
            }
        }
        return null;
    }
}
