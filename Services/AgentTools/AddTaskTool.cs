using DanceMonkey.Agent.Core.Abstractions;
using DanceMonkey.Agent.Core.Models;
using DanceMonkey.Agent.Core.Tools;
using DesktopAssistant.Services;

namespace DesktopAssistant.Services.AgentTools;

/// <summary>
/// add_task：向 Zen Task 添加战略任务。
/// <code>{ "title": "完成报告", "project": "Work", "priority": "High", "due_date": "2026-06-05" }</code>
/// </summary>
public sealed class AddTaskTool : ITool
{
    private readonly ZenTaskStore _store;

    public AddTaskTool(string? notesRootPath) =>
        _store = new ZenTaskStore(notesRootPath);

    public string Name => "add_task";

    public string Description => """
add_task: 在 Zen Task 中创建新任务（写入 notes/Journal/task-module.json）。
参数:
  title (string, 必填) - 任务标题
  project (string, 可选) - 项目名称（若存在则关联）
  project_id (string, 可选) - 项目 ID（优先于 project 名称）
  priority (string, 可选, 默认 Medium) - Critical/High/Medium/Low 或 Q1–Q4
  energy (string, 可选, 默认 Medium) - High/Medium/Low
  due_date (string, 可选) - 截止日期 yyyy-MM-dd
  notes (string, 可选) - 备注
  tags (string, 可选) - 逗号分隔标签
""";

    public ToolRiskLevel Risk => ToolRiskLevel.Write;

    public string SummarizeCall(ToolRequest request)
    {
        var title = ToolArgs.GetString(request.Arguments, "title", "?");
        return $"添加任务: {Truncate(title, 50)}";
    }

    public Task<ToolResult> ExecuteAsync(ToolRequest request, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        var title = ToolArgs.GetString(request.Arguments, "title");
        if (string.IsNullOrWhiteSpace(title))
            return Task.FromResult(ToolResult.Fail("add_task 缺少参数 title"));

        DateTime? due = null;
        var dueRaw = ToolArgs.GetString(request.Arguments, "due_date", "");
        if (!string.IsNullOrWhiteSpace(dueRaw) && DateTime.TryParse(dueRaw, out var parsed))
            due = parsed.Date;

        try
        {
            var item = _store.AddTask(new ZenTaskAddRequest
            {
                Title = title.Trim(),
                Project = ToolArgs.GetString(request.Arguments, "project", ""),
                ProjectId = ToolArgs.GetString(request.Arguments, "project_id", ""),
                Priority = ToolArgs.GetString(request.Arguments, "priority", "Medium"),
                Energy = ToolArgs.GetString(request.Arguments, "energy", "Medium"),
                Notes = ToolArgs.GetString(request.Arguments, "notes", ""),
                Tags = ToolArgs.GetString(request.Arguments, "tags", ""),
                DueDate = due,
                Source = "Agent",
            });

            var msg = $"[add_task] 已创建任务 `{item.Id}`: {item.Title}\n项目: {item.Project}\n到期: {item.DueDate?.ToString("yyyy-MM-dd") ?? "—"}";
            return Task.FromResult(ToolResult.Ok(msg, display: $"✓ 已添加 {item.Title}"));
        }
        catch (Exception ex)
        {
            return Task.FromResult(ToolResult.Fail($"添加任务失败: {ex.Message}"));
        }
    }

    private static string Truncate(string s, int max) =>
        s.Length <= max ? s : s[..max] + "…";
}
