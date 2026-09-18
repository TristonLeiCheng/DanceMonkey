using System.Text.Json;
using Spectre.Console;

namespace DanceMonkey.Cli;

/// <summary>
/// 斜杠命令 <c>/notes</c>、<c>/tasks</c>：列出笔记与 Zen Task 数据（只读）。
/// <para>
/// 不使用多列 <see cref="Table"/> 展示中英混排长文本：Spectre 按「字符个数」而非「终端显示宽度」排版，
/// CJK 全角字符会导致列线错位。此处改为逐行/分块输出，并对标题、路径做显示宽度截断。
/// </para>
/// </summary>
internal static class NotesTasksListCommands
{
    private const int MaxNoteLines = 800;
    private const int MaxTitleDisplayCols = 76;
    private const int MaxPathDisplayCols = 96;
    private const int MaxCellDisplayCols = 36;
    private const int MaxTaskLineDisplayCols = 160;
    private const int MinTaskLineDisplayCols = 72;

    public static void ListNotes(CliDancePaths paths, IAnsiConsole console)
    {
        var root = paths.NotesRootAbsolute;
        if (!Directory.Exists(root))
        {
            console.MarkupLine($"[red]笔记根目录不存在: {Markup.Escape(root)}[/]");
            return;
        }

        var files = Directory.EnumerateFiles(root, "*.md", SearchOption.AllDirectories)
            .Select(p => new FileInfo(p))
            .OrderByDescending(f => f.LastWriteTimeUtc)
            .Take(MaxNoteLines)
            .ToList();

        console.MarkupLine($"[grey]笔记根: {Markup.Escape(root)}[/]");
        if (files.Count >= MaxNoteLines)
            console.MarkupLine($"[yellow]仅显示最近 {MaxNoteLines} 个 .md 文件（按修改时间）。[/]");
        console.WriteLine();

        foreach (var fi in files)
        {
            var rel = Path.GetRelativePath(root, fi.FullName).Replace('\\', '/');
            var relDisp = TerminalDisplayWidth.TruncateToDisplayWidth(rel, MaxPathDisplayCols);
            var time = fi.LastWriteTimeUtc.ToString("yyyy-MM-dd HH:mm");
            // 固定宽度时间戳 + 路径，避免 Table 在 CJK 路径下错列
            console.MarkupLine($"[grey]{time}[/]  {Markup.Escape(relDisp)}");
        }
    }

    public static void ListTasks(CliDancePaths paths, IAnsiConsole console)
    {
        var taskPath = paths.TaskModuleJsonPath;
        var projPath = paths.ProjectsJsonPath;

        console.MarkupLine($"[grey]任务 JSON: {Markup.Escape(taskPath)}[/]");
        console.MarkupLine($"[grey]项目 JSON: {Markup.Escape(projPath)}[/]");

        List<ZenTaskRow>? tasks = null;
        if (File.Exists(taskPath))
        {
            try
            {
                tasks = LoadItems<ZenTaskRow>(taskPath);
            }
            catch (Exception ex)
            {
                console.MarkupLine($"[red]读取 task-module.json 失败: {Markup.Escape(ex.Message)}[/]");
            }
        }
        else
        {
            console.MarkupLine("[yellow]尚无 task-module.json（在 Zen Task 里创建任务后会生成）。[/]");
        }

        List<ZenProjectRow>? projects = null;
        if (File.Exists(projPath))
        {
            try
            {
                projects = LoadItems<ZenProjectRow>(projPath);
            }
            catch (Exception ex)
            {
                console.MarkupLine($"[red]读取 zentask-projects.json 失败: {Markup.Escape(ex.Message)}[/]");
            }
        }

        if (projects is { Count: > 0 })
        {
            console.WriteLine();
            console.Write(new Rule("[bold]项目[/]").RuleStyle(Style.Parse("grey")));
            var idx = 1;
            foreach (var p in projects.OrderBy(x => x.Name))
            {
                var name = TerminalDisplayWidth.TruncateToDisplayWidth(p.Name ?? "—", MaxTitleDisplayCols);
                var st = TerminalDisplayWidth.TruncateToDisplayWidth(p.Status ?? "—", MaxCellDisplayCols);
                var pr = TerminalDisplayWidth.TruncateToDisplayWidth(p.Priority ?? "—", MaxCellDisplayCols);
                console.WriteLine();
                console.MarkupLine($"[bold cyan]{idx,3}[/]  [bold]{Markup.Escape(name)}[/]");
                idx++;
                console.MarkupLine($"     [grey]状态[/]  {Markup.Escape(st)}");
                console.MarkupLine($"     [grey]优先级[/]  {Markup.Escape(pr)}");
            }
        }

        if (tasks is not { Count: > 0 })
        {
            if (tasks != null)
            {
                console.WriteLine();
                console.MarkupLine("[yellow]任务列表为空。[/]");
            }
            return;
        }

        console.WriteLine();
        console.Write(new Rule("[bold]任务[/]").RuleStyle(Style.Parse("grey")));

        var ordered = tasks.OrderBy(x => x.DueDate ?? DateTime.MaxValue).ToList();
        for (var i = 0; i < ordered.Count; i++)
        {
            var t = ordered[i];
            var line = BuildTaskSummaryLine(t);
            var display = TerminalDisplayWidth.TruncateToDisplayWidth(line, GetTaskLineDisplayCols());
            console.WriteLine();
            console.MarkupLine($"[bold yellow]{i + 1,3}[/]  {Markup.Escape(display)}");
        }
    }

    private static List<T>? LoadItems<T>(string path)
    {
        var json = File.ReadAllText(path);
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        if (root.ValueKind == JsonValueKind.Array)
            return JsonSerializer.Deserialize<List<T>>(root.GetRawText(), JsonOpts);

        if (root.ValueKind == JsonValueKind.Object &&
            TryGetPropertyIgnoreCase(root, "items", out var items) &&
            items.ValueKind == JsonValueKind.Array)
        {
            return JsonSerializer.Deserialize<List<T>>(items.GetRawText(), JsonOpts);
        }

        return null;
    }

    private static bool TryGetPropertyIgnoreCase(JsonElement element, string name, out JsonElement value)
    {
        foreach (var property in element.EnumerateObject())
        {
            if (property.NameEquals(name) || property.Name.Equals(name, StringComparison.OrdinalIgnoreCase))
            {
                value = property.Value;
                return true;
            }
        }

        value = default;
        return false;
    }

    private static string BuildTaskSummaryLine(ZenTaskRow task)
    {
        var title = task.Title ?? "—";
        var project = string.IsNullOrWhiteSpace(task.Project) ? "未分配" : task.Project!;
        var status = string.IsNullOrWhiteSpace(task.WorkflowStatus) ? "—" : task.WorkflowStatus!;
        var due = task.DueDate?.ToString("MM-dd") ?? "—";
        var priority = BuildPriorityCode(task.Impact, task.Urgency);
        var energy = BuildEnergyCode(task.EnergyLevel);

        return $"{title} | 项目:{project} | 状态:{status} | 到期:{due} | 优先:{priority} | 能量:{energy}";
    }

    private static string BuildPriorityCode(int impact, int urgency) => (impact, urgency) switch
    {
        (>= 4, >= 4) => "Q1",
        (>= 4, < 4) => "Q2",
        (< 4, >= 4) => "Q3",
        _ => "Q4"
    };

    private static string BuildEnergyCode(string? energyLevel)
    {
        if (string.IsNullOrWhiteSpace(energyLevel))
            return "-";

        return energyLevel.Trim().ToLowerInvariant() switch
        {
            "high" => "H",
            "medium" => "M",
            "low" => "L",
            _ => energyLevel.Trim()
        };
    }

    private static int GetTaskLineDisplayCols()
    {
        try
        {
            var width = Console.WindowWidth;
            if (width <= 0)
                return MaxTaskLineDisplayCols;

            return Math.Clamp(width - 8, MinTaskLineDisplayCols, MaxTaskLineDisplayCols);
        }
        catch
        {
            return MaxTaskLineDisplayCols;
        }
    }

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNameCaseInsensitive = true,
        ReadCommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true,
    };

    private sealed class ZenTaskRow
    {
        public string? Id { get; set; }
        public string? Title { get; set; }
        public string? Project { get; set; }
        public string? WorkflowStatus { get; set; }
        public DateTime? DueDate { get; set; }
        public int Impact { get; set; }
        public int Urgency { get; set; }
        public string? EnergyLevel { get; set; }
    }

    private sealed class ZenProjectRow
    {
        public string? Name { get; set; }
        public string? Status { get; set; }
        public string? Priority { get; set; }
    }
}
