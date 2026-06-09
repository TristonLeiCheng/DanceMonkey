using DanceMonkey.Agent.Core.Abstractions;
using DanceMonkey.Agent.Core.Models;
using DanceMonkey.Agent.Core.Tools;
using DesktopAssistant.Services;

namespace DesktopAssistant.Services.AgentTools;

/// <summary>
/// list_tasks：列出 Zen Task 任务（只读）。
/// <code>{ "status": "Todo", "project": "MyProj", "limit": 30 }</code>
/// </summary>
public sealed class ListTasksTool : ITool
{
    private readonly ZenTaskStore _store;

    public ListTasksTool(string? notesRootPath) =>
        _store = new ZenTaskStore(notesRootPath);

    public string Name => "list_tasks";

    public string Description => """
list_tasks: 列出 Zen Task 战略任务（数据来自 notes/Journal/task-module.json）。
参数:
  status (string, 可选) - 过滤状态，如 Todo、In Progress、Completed
  project (string, 可选) - 按项目名称过滤（模糊包含）
  limit (int, 可选, 默认 30, 最大 80) - 最多返回条数
""";

    public ToolRiskLevel Risk => ToolRiskLevel.ReadOnly;

    public string SummarizeCall(ToolRequest request)
    {
        var status = ToolArgs.GetString(request.Arguments, "status", "");
        var project = ToolArgs.GetString(request.Arguments, "project", "");
        var hint = string.Join(" ", new[] { status, project }.Where(s => !string.IsNullOrWhiteSpace(s)));
        return $"列出任务{(string.IsNullOrWhiteSpace(hint) ? "" : $" ({hint.Trim()})")}";
    }

    public Task<ToolResult> ExecuteAsync(ToolRequest request, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        var statusFilter = ToolArgs.GetString(request.Arguments, "status", "").Trim();
        var projectFilter = ToolArgs.GetString(request.Arguments, "project", "").Trim();
        var limit = ToolArgs.GetInt(request.Arguments, "limit", 30);
        if (limit <= 0) limit = 30;
        if (limit > 80) limit = 80;

        try
        {
            var tasks = _store.LoadTasks().AsEnumerable();

            if (!string.IsNullOrWhiteSpace(statusFilter))
            {
                tasks = tasks.Where(t =>
                    (t.WorkflowStatus ?? "").Contains(statusFilter, StringComparison.OrdinalIgnoreCase));
            }

            if (!string.IsNullOrWhiteSpace(projectFilter))
            {
                tasks = tasks.Where(t =>
                    (t.Project ?? "").Contains(projectFilter, StringComparison.OrdinalIgnoreCase));
            }

            var ordered = tasks
                .OrderBy(t => t.DueDate ?? DateTime.MaxValue)
                .ThenByDescending(t => t.Impact * 10 + t.Urgency)
                .Take(limit)
                .ToList();

            if (ordered.Count == 0)
                return Task.FromResult(ToolResult.Ok("[list_tasks] 无匹配任务。", display: "✓ 无任务"));

            var sb = new System.Text.StringBuilder();
            sb.AppendLine($"[list_tasks] 共 {ordered.Count} 条（文件: notes/Journal/task-module.json）");
            sb.AppendLine();

            foreach (var t in ordered)
            {
                sb.AppendLine($"- `{t.Id}` {ZenTaskStore.FormatTaskLine(t)}");
                if (!string.IsNullOrWhiteSpace(t.Notes))
                    sb.AppendLine($"  备注: {Truncate(t.Notes, 120)}");
            }

            return Task.FromResult(ToolResult.Ok(sb.ToString().TrimEnd(), display: $"✓ {ordered.Count} 条任务"));
        }
        catch (Exception ex)
        {
            return Task.FromResult(ToolResult.Fail($"读取任务失败: {ex.Message}"));
        }
    }

    private static string Truncate(string s, int max) =>
        s.Length <= max ? s : s[..max] + "…";
}
