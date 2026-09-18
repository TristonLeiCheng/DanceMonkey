using DanceMonkey.Agent.Core.Abstractions;
using DanceMonkey.Agent.Core.Models;
using DanceMonkey.Agent.Core.Tools;
using DesktopAssistant.Services;

namespace DesktopAssistant.Services.AgentTools;

/// <summary>
/// create_note：在笔记库创建新 Markdown 笔记。
/// <code>{ "title": "标题", "folder": "Inbox", "content": "# 标题\n\n正文" }</code>
/// </summary>
public sealed class CreateNoteTool : ITool
{
    private readonly NoteService _notes;

    public CreateNoteTool(string? notesRootPath)
    {
        _notes = new NoteService(notesRootPath);
    }

    public string Name => "create_note";

    public string Description => """
create_note: 在笔记库创建新的 Markdown 笔记文件。
参数:
  title (string, 必填) - 笔记标题（用作文件名基础）
  folder (string, 可选, 默认 Inbox) - 相对笔记根的子目录，如 Inbox、Projects/MyProj
  content (string, 可选) - 初始 Markdown 正文；未提供时生成 # 标题 模板
""";

    public ToolRiskLevel Risk => ToolRiskLevel.Write;

    public string SummarizeCall(ToolRequest request)
    {
        var title = ToolArgs.GetString(request.Arguments, "title", "?");
        var folder = ToolArgs.GetString(request.Arguments, "folder", "Inbox");
        return $"创建笔记 {folder}/{title}";
    }

    public Task<ToolResult> ExecuteAsync(ToolRequest request, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        var title = ToolArgs.GetString(request.Arguments, "title");
        if (string.IsNullOrWhiteSpace(title))
            return Task.FromResult(ToolResult.Fail("create_note 缺少参数 title"));

        var folder = ToolArgs.GetString(request.Arguments, "folder", "Inbox");
        if (string.IsNullOrWhiteSpace(folder))
            folder = "Inbox";

        var content = ToolArgs.GetString(request.Arguments, "content", "");
        if (string.IsNullOrWhiteSpace(content))
            content = $"# {title.Trim()}\n\n";

        try
        {
            var absPath = _notes.CreateNewNote(title.Trim(), folder.Trim(), content);
            var rel = TryRelativeNotesPath(_notes.RootPath, absPath);
            var msg = $"[create_note] 已创建: {rel}\n绝对路径: {absPath}";
            return Task.FromResult(ToolResult.Ok(msg, display: $"✓ 已创建 {rel}"));
        }
        catch (Exception ex)
        {
            return Task.FromResult(ToolResult.Fail($"创建笔记失败: {ex.Message}"));
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
