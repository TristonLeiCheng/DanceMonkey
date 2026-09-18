using System.Text.Json.Serialization;
using DanceMonkey.Agent.Core.Abstractions;
using DanceMonkey.Agent.Core.Models;

namespace DanceMonkey.Cli;

/// <summary>
/// 无头 JSON 模式：收集助手全文与工具调用，供序列化到 stdout。
/// </summary>
internal sealed class CliJsonRecordingSink : IAgentSink
{
    public string? AssistantFull { get; private set; }
    public readonly List<JsonToolRecord> Tools = new();

    public void OnAssistantChunk(string chunk)
    {
        // 流式块仍写入由外层决定是否打印；最终以前缀 OnAssistantCompleted 为准
    }

    public void OnAssistantCompleted(string fullText)
    {
        AssistantFull = fullText;
    }

    public void OnToolStart(ToolRequest request, string summary)
    {
        Tools.Add(new JsonToolRecord
        {
            Name = request.Tool,
            Summary = summary,
        });
    }

    public void OnToolEnd(ToolRequest request, ToolResult result)
    {
        // 与最近一次 OnToolStart 配对（同一次调用顺序）
        for (var i = Tools.Count - 1; i >= 0; i--)
        {
            var t = Tools[i];
            if (t.Name != request.Tool || t.Completed) continue;
            t.Success = result.Success;
            t.Rejected = result.Rejected;
            t.OutputPreview = Truncate(result.Output ?? result.Display ?? "", 4000);
            t.Completed = true;
            return;
        }

        Tools.Add(new JsonToolRecord
        {
            Name = request.Tool,
            Summary = null,
            Success = result.Success,
            Rejected = result.Rejected,
            OutputPreview = Truncate(result.Output ?? result.Display ?? "", 4000),
            Completed = true,
        });
    }

    public void OnStatus(string message) { }
    public void OnWarning(string message) { }
    public void OnError(string message) { }

    private static string? Truncate(string s, int max)
    {
        if (string.IsNullOrEmpty(s) || s.Length <= max) return s;
        return s[..max] + "\n…[truncated]";
    }
}

internal sealed class JsonToolRecord
{
    public required string Name { get; set; }
    public string? Summary { get; set; }
    public bool Success { get; set; }
    public bool Rejected { get; set; }
    public string? OutputPreview { get; set; }

    [JsonIgnore]
    public bool Completed { get; set; }
}

internal sealed class HeadlessJsonOutput
{
    [JsonPropertyName("schemaVersion")]
    public int SchemaVersion { get; set; } = 1;

    public bool Success { get; set; }
    public int ExitCode { get; set; }
    public string? Error { get; set; }

    public JsonSessionInfo? Session { get; set; }
    public JsonRunResult? Result { get; set; }
    public List<JsonToolRecord>? Tools { get; set; }
}

internal sealed class JsonSessionInfo
{
    public string? Id { get; set; }
    public long ApproxTokens { get; set; }
    public int MessageCount { get; set; }
}

internal sealed class JsonRunResult
{
    public string? FinalAssistantText { get; set; }
    public long ApproxTokens { get; set; }
    public int StepsUsed { get; set; }
}
