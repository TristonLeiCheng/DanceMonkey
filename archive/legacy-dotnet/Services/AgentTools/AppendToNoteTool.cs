using System.Text;
using DanceMonkey.Agent.Core.Abstractions;
using DanceMonkey.Agent.Core.Models;
using DanceMonkey.Agent.Core.Tools;
using DesktopAssistant.Services;

namespace DesktopAssistant.Services.AgentTools;

/// <summary>
/// append_to_note：向已有笔记末尾追加 Markdown 内容。
/// <code>{ "path": "notes/Inbox/foo.md", "content": "\n\n## 追加\n\n正文" }</code>
/// </summary>
public sealed class AppendToNoteTool : ITool
{
    private readonly NoteService _notes;

    public AppendToNoteTool(string? notesRootPath) =>
        _notes = new NoteService(notesRootPath);

    public string Name => "append_to_note";

    public string Description => """
append_to_note: 向笔记库中已有 Markdown 文件末尾追加内容。
参数:
  path (string, 必填) - 笔记路径，如 notes/Inbox/foo.md 或 Inbox/foo.md
  content (string, 必填) - 要追加的 Markdown 文本（建议以换行开头）
  ensure_newline (bool, 可选, 默认 true) - 追加前若文件末尾无换行则自动补一个
""";

    public ToolRiskLevel Risk => ToolRiskLevel.Write;

    public string SummarizeCall(ToolRequest request)
    {
        var path = ToolArgs.GetString(request.Arguments, "path", "?");
        return $"追加笔记 {Truncate(path, 60)}";
    }

    public Task<ToolResult> ExecuteAsync(ToolRequest request, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        var pathArg = ToolArgs.GetString(request.Arguments, "path");
        var content = ToolArgs.GetString(request.Arguments, "content");
        if (string.IsNullOrWhiteSpace(pathArg))
            return Task.FromResult(ToolResult.Fail("append_to_note 缺少参数 path"));
        if (string.IsNullOrEmpty(content))
            return Task.FromResult(ToolResult.Fail("append_to_note 缺少参数 content"));

        var ensureNewline = ToolArgs.GetBool(request.Arguments, "ensure_newline", true);

        try
        {
            var fullPath = ResolveNotePath(pathArg);
            if (!File.Exists(fullPath))
                return Task.FromResult(ToolResult.Fail($"笔记不存在: {pathArg}"));

            var existing = File.ReadAllText(fullPath, Encoding.UTF8);
            var sb = new StringBuilder(existing);
            if (ensureNewline && existing.Length > 0 && !existing.EndsWith('\n'))
                sb.AppendLine();
            sb.Append(content);

            _notes.Save(fullPath, sb.ToString());
            var rel = TryRelativeNotesPath(_notes.RootPath, fullPath);
            return Task.FromResult(ToolResult.Ok(
                $"[append_to_note] 已追加到 {rel}（+{content.Length} 字符）",
                display: $"✓ 已追加 {rel}"));
        }
        catch (Exception ex)
        {
            return Task.FromResult(ToolResult.Fail($"追加笔记失败: {ex.Message}"));
        }
    }

    private string ResolveNotePath(string pathArg)
    {
        var rel = pathArg.Trim().Replace('\\', '/');
        if (rel.StartsWith("notes/", StringComparison.OrdinalIgnoreCase))
            rel = rel["notes/".Length..];

        if (!rel.EndsWith(".md", StringComparison.OrdinalIgnoreCase))
            rel += ".md";

        var full = Path.GetFullPath(Path.Combine(_notes.RootPath, rel.Replace('/', Path.DirectorySeparatorChar)));
        if (!_notes.IsUnderRoot(full))
            throw new InvalidOperationException("路径不在笔记库内。");
        return full;
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

    private static string Truncate(string s, int max) =>
        s.Length <= max ? s : s[..max] + "…";
}
