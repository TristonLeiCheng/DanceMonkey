using DanceMonkey.Agent.Core.Abstractions;
using DanceMonkey.Agent.Core.Models;
using DanceMonkey.Agent.Core.Tools;
using DesktopAssistant.Services;

namespace DesktopAssistant.Services.AgentTools;

/// <summary>
/// list_recent_screenshots：列出笔记库 Inbox/Screenshots 中最近的截图文件（只读）。
/// <code>{ "limit": 10 }</code>
/// </summary>
public sealed class ListRecentScreenshotsTool : ITool
{
    private readonly NoteService _notes;

    public ListRecentScreenshotsTool(string? notesRootPath) =>
        _notes = new NoteService(notesRootPath);

    public string Name => "list_recent_screenshots";

    public string Description => """
list_recent_screenshots: 列出笔记库 Inbox/Screenshots 目录下最近的截图文件。
参数:
  limit (int, 可选, 默认 10, 最大 30) - 返回条数
  folder (string, 可选) - 相对笔记根的子目录，默认 Inbox/Screenshots
可用于查找最近截图路径，再配合 read_file（notes/ 前缀）查看关联笔记或 OCR 结果。
""";

    public ToolRiskLevel Risk => ToolRiskLevel.ReadOnly;

    public string SummarizeCall(ToolRequest request)
    {
        var limit = ToolArgs.GetInt(request.Arguments, "limit", 10);
        return $"列出最近 {limit} 张截图";
    }

    public Task<ToolResult> ExecuteAsync(ToolRequest request, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        var limit = ToolArgs.GetInt(request.Arguments, "limit", 10);
        if (limit <= 0) limit = 10;
        if (limit > 30) limit = 30;

        var folder = ToolArgs.GetString(request.Arguments, "folder", "Inbox/Screenshots").Trim();
        if (string.IsNullOrWhiteSpace(folder))
            folder = "Inbox/Screenshots";

        try
        {
            var dir = Path.GetFullPath(Path.Combine(_notes.RootPath, folder.Replace('/', Path.DirectorySeparatorChar)));
            if (!_notes.IsUnderRoot(dir))
                return Task.FromResult(ToolResult.Fail("folder 不在笔记库内。"));

            if (!Directory.Exists(dir))
                return Task.FromResult(ToolResult.Ok("[list_recent_screenshots] 目录不存在或尚无截图。", display: "✓ 无截图"));

            var exts = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp" };
            var files = Directory.EnumerateFiles(dir, "*.*", SearchOption.TopDirectoryOnly)
                .Where(f => exts.Contains(Path.GetExtension(f)))
                .Select(f => new FileInfo(f))
                .OrderByDescending(f => f.LastWriteTimeUtc)
                .Take(limit)
                .ToList();

            if (files.Count == 0)
                return Task.FromResult(ToolResult.Ok("[list_recent_screenshots] 目录内无图片文件。", display: "✓ 无截图"));

            var sb = new System.Text.StringBuilder();
            sb.AppendLine($"[list_recent_screenshots] 最近 {files.Count} 张（{folder}）");
            sb.AppendLine();

            foreach (var fi in files)
            {
                var rel = TryRelativeNotesPath(_notes.RootPath, fi.FullName);
                sb.AppendLine($"- **{rel}** — {fi.Length / 1024.0:F1} KB, {fi.LastWriteTimeUtc:yyyy-MM-dd HH:mm} UTC");
            }

            sb.AppendLine();
            sb.AppendLine("提示：用 read_file 读取引用该截图的 .md 笔记，或 search_notes 搜索截图相关记录。");

            return Task.FromResult(ToolResult.Ok(sb.ToString().TrimEnd(), display: $"✓ {files.Count} 张截图"));
        }
        catch (Exception ex)
        {
            return Task.FromResult(ToolResult.Fail($"列出截图失败: {ex.Message}"));
        }
    }

    private static string TryRelativeNotesPath(string notesRoot, string fullPath)
    {
        try
        {
            var rel = Path.GetRelativePath(notesRoot, fullPath).Replace('\\', '/');
            return "notes/" + rel;
        }
        catch
        {
            return fullPath;
        }
    }
}
