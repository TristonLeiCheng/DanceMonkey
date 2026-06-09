using DanceMonkey.Agent.Core.Abstractions;
using DanceMonkey.Agent.Core.Models;
using DanceMonkey.Agent.Core.Tools;
using DesktopAssistant.Services;

namespace DesktopAssistant.Services.AgentTools;

/// <summary>
/// search_notes：在笔记库全文搜索，返回匹配文件与摘要片段。
/// <code>{ "query": "关键词", "limit": 20 }</code>
/// </summary>
public sealed class SearchNotesTool : ITool
{
    private readonly NoteService _notes;

    public SearchNotesTool(string? notesRootPath)
    {
        _notes = new NoteService(notesRootPath);
    }

    public string Name => "search_notes";

    public string Description => """
search_notes: 在笔记库全部 Markdown 文件中全文搜索，返回匹配路径与摘要。
参数:
  query (string, 必填) - 搜索关键词
  limit (int, 可选, 默认 20, 最大 50) - 最多返回条数
""";

    public ToolRiskLevel Risk => ToolRiskLevel.ReadOnly;

    public string SummarizeCall(ToolRequest request)
    {
        var q = ToolArgs.GetString(request.Arguments, "query", "?");
        return $"搜索笔记: {Truncate(q, 60)}";
    }

    public Task<ToolResult> ExecuteAsync(ToolRequest request, CancellationToken ct)
    {
        var query = ToolArgs.GetString(request.Arguments, "query");
        if (string.IsNullOrWhiteSpace(query))
            return Task.FromResult(ToolResult.Fail("search_notes 缺少参数 query"));

        var limit = ToolArgs.GetInt(request.Arguments, "limit", 20);
        if (limit <= 0) limit = 20;
        if (limit > 50) limit = 50;

        try
        {
            var matches = _notes.SearchWithSnippets(query, ct);
            if (matches.Count == 0)
                return Task.FromResult(ToolResult.Ok("[search_notes] 未找到匹配。", display: "✓ 无匹配"));

            var sb = new System.Text.StringBuilder();
            sb.AppendLine($"[search_notes] 找到 {matches.Count} 条（展示前 {Math.Min(limit, matches.Count)} 条）");
            sb.AppendLine($"笔记根: {_notes.RootPath}");
            sb.AppendLine();

            foreach (var m in matches.Take(limit))
            {
                var rel = TryRelativeNotesPath(_notes.RootPath, m.FilePath);
                sb.AppendLine($"- **{rel}**");
                sb.AppendLine($"  {m.Snippet}");
            }

            if (matches.Count > limit)
                sb.AppendLine($"\n… 另有 {matches.Count - limit} 条未展示");

            var output = sb.ToString().TrimEnd();
            return Task.FromResult(ToolResult.Ok(output, display: $"✓ 找到 {matches.Count} 条"));
        }
        catch (Exception ex)
        {
            return Task.FromResult(ToolResult.Fail($"搜索失败: {ex.Message}"));
        }
    }

    private static string TryRelativeNotesPath(string notesRoot, string fullPath)
    {
        try
        {
            var rel = Path.GetRelativePath(notesRoot, fullPath).Replace('\\', '/');
            return rel.StartsWith("notes/", StringComparison.OrdinalIgnoreCase) ? rel : "notes/" + rel;
        }
        catch
        {
            return fullPath;
        }
    }

    private static string Truncate(string s, int n) =>
        s.Length <= n ? s : s[..n] + "…";
}
