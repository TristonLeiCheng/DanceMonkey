using System.Text.Json;
using System.Text.RegularExpressions;
using DanceMonkey.Agent.Core.Models;

namespace DanceMonkey.Agent.Core.Runtime;

/// <summary>
/// 解析 assistant 回复，分离出"面向用户的文本"与"工具调用数组"。
/// 协议见 <see cref="SystemPromptBuilder"/> 中的 &lt;tool_calls&gt; 约定。
/// </summary>
public static class ToolCallParser
{
    private const string OpenTag = "<tool_calls>";
    private const string CloseTag = "</tool_calls>";
    private static readonly Regex ToolCallsRegex = new(
        @"<tool_calls>\s*(?<body>.*?)\s*</tool_calls>",
        RegexOptions.Compiled | RegexOptions.Singleline | RegexOptions.IgnoreCase);

    /// <summary>
    /// 从 assistant 文本中提取工具调用。<paramref name="userFacingText"/> 返回去除 tool_calls 块后的文本。
    /// </summary>
    public static IReadOnlyList<ToolRequest> Parse(
        string assistantText,
        out string userFacingText,
        out bool hadToolCallBlock,
        out bool parseFailed)
    {
        hadToolCallBlock = false;
        parseFailed = false;
        userFacingText = assistantText;
        if (string.IsNullOrWhiteSpace(assistantText))
            return Array.Empty<ToolRequest>();

        var match = ToolCallsRegex.Match(assistantText);
        if (!match.Success)
            return Array.Empty<ToolRequest>();
        hadToolCallBlock = true;

        // 剥离标签，留给用户看的文本是两侧拼接
        userFacingText = (assistantText[..match.Index] + assistantText[(match.Index + match.Length)..]).Trim();

        var body = match.Groups["body"].Value.Trim();
        // 兼容模型外套 ```json ... ``` 的情况
        body = StripCodeFences(body);

        List<ToolRequest> requests = new();
        try
        {
            using var doc = JsonDocument.Parse(body);
            if (doc.RootElement.ValueKind != JsonValueKind.Array)
            {
                parseFailed = true;
                return Array.Empty<ToolRequest>();
            }

            int callIdx = 0;
            foreach (var item in doc.RootElement.EnumerateArray())
            {
                if (item.ValueKind != JsonValueKind.Object) continue;

                string? tool = null;
                if (item.TryGetProperty("tool", out var tEl) && tEl.ValueKind == JsonValueKind.String)
                    tool = tEl.GetString();
                else if (item.TryGetProperty("name", out var nEl) && nEl.ValueKind == JsonValueKind.String)
                    tool = nEl.GetString();

                if (string.IsNullOrWhiteSpace(tool)) continue;

                JsonElement args = default;
                if (item.TryGetProperty("arguments", out var aEl)) args = aEl.Clone();
                else if (item.TryGetProperty("args", out var a2)) args = a2.Clone();
                else if (item.TryGetProperty("parameters", out var a3)) args = a3.Clone();

                requests.Add(new ToolRequest
                {
                    Tool = tool!,
                    Arguments = args,
                    CallId = $"call_{++callIdx}",
                });
            }
        }
        catch (JsonException)
        {
            parseFailed = true;
            return Array.Empty<ToolRequest>();
        }

        return requests;
    }

    public static bool HasUnclosedToolCallTag(string assistantText)
    {
        if (string.IsNullOrWhiteSpace(assistantText))
            return false;

        var hasOpen = assistantText.Contains(OpenTag, StringComparison.OrdinalIgnoreCase);
        var hasClose = assistantText.Contains(CloseTag, StringComparison.OrdinalIgnoreCase);
        return hasOpen && !hasClose;
    }

    private static string StripCodeFences(string s)
    {
        s = s.Trim();
        if (!s.StartsWith("```")) return s;
        var firstNewline = s.IndexOf('\n');
        if (firstNewline < 0) return s;
        var inner = s[(firstNewline + 1)..];
        if (inner.EndsWith("```"))
            inner = inner[..^3];
        return inner.Trim();
    }
}
