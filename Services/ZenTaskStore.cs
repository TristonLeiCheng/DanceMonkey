using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace DesktopAssistant.Services;

/// <summary>Zen Task 数据读写（与 TodoView / zentask.html 共用 JSON 格式）。</summary>
public sealed class ZenTaskStore
{
    private const int SchemaVersion = 2;

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        WriteIndented = true,
        PropertyNameCaseInsensitive = true,
        ReadCommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly string _taskFilePath;
    private readonly string _projectFilePath;

    public ZenTaskStore(string? notesRootPath)
    {
        var root = NoteService.ResolveRoot(notesRootPath);
        var journal = Path.Combine(root, "Journal");
        Directory.CreateDirectory(journal);
        _taskFilePath = Path.Combine(journal, "task-module.json");
        _projectFilePath = Path.Combine(journal, "zentask-projects.json");
    }

    public string TaskFilePath => _taskFilePath;

    public IReadOnlyList<ZenTaskRecord> LoadTasks()
    {
        if (!File.Exists(_taskFilePath))
            return Array.Empty<ZenTaskRecord>();

        var json = File.ReadAllText(_taskFilePath, Encoding.UTF8);
        var wrapped = JsonSerializer.Deserialize<TaskStoreEnvelope>(json, JsonOpts);
        if (wrapped?.Items != null)
            return wrapped.Items;

        return JsonSerializer.Deserialize<List<ZenTaskRecord>>(json, JsonOpts) ?? new List<ZenTaskRecord>();
    }

    public IReadOnlyList<ZenProjectRecord> LoadProjects()
    {
        if (!File.Exists(_projectFilePath))
            return Array.Empty<ZenProjectRecord>();

        var json = File.ReadAllText(_projectFilePath, Encoding.UTF8);
        var wrapped = JsonSerializer.Deserialize<ProjectStoreEnvelope>(json, JsonOpts);
        if (wrapped?.Items != null)
            return wrapped.Items;

        return JsonSerializer.Deserialize<List<ZenProjectRecord>>(json, JsonOpts) ?? new List<ZenProjectRecord>();
    }

    public ZenTaskRecord AddTask(ZenTaskAddRequest req)
    {
        var title = req.Title?.Trim() ?? "";
        if (string.IsNullOrWhiteSpace(title))
            throw new ArgumentException("任务标题不能为空。", nameof(req));

        var projects = LoadProjects().ToList();
        ZenProjectRecord? project = null;
        if (!string.IsNullOrWhiteSpace(req.ProjectId))
            project = projects.FirstOrDefault(p => string.Equals(p.Id, req.ProjectId, StringComparison.OrdinalIgnoreCase));
        if (project == null && !string.IsNullOrWhiteSpace(req.Project))
            project = projects.FirstOrDefault(p => string.Equals(p.Name, req.Project, StringComparison.OrdinalIgnoreCase));

        var (impact, urgency) = ParsePriority(req.Priority ?? "Medium");
        var now = DateTime.Now;
        var item = new ZenTaskRecord
        {
            Id = Guid.NewGuid().ToString("N"),
            Title = title,
            ProjectId = project?.Id ?? "",
            Project = project?.Name ?? (string.IsNullOrWhiteSpace(req.Project) ? "Unassigned" : req.Project.Trim()),
            SourceTag = string.IsNullOrWhiteSpace(req.Source) ? "Agent" : req.Source.Trim(),
            Layer = string.IsNullOrWhiteSpace(req.Layer) ? "Task" : req.Layer.Trim(),
            Impact = impact,
            Urgency = urgency,
            RaciRole = NormalizeRaci(req.Raci),
            EnergyLevel = NormalizeEnergy(req.Energy),
            WorkflowStatus = "Todo",
            DueDate = req.DueDate,
            Notes = req.Notes?.Trim() ?? "",
            Tags = req.Tags?.Trim() ?? "",
            CreatedAt = now,
            UpdatedAt = now,
            AuditTrail = new List<string> { $"{now:yyyy-MM-dd HH:mm} created via Agent" },
        };

        var tasks = LoadTasks().ToList();
        tasks.Insert(0, item);
        SaveTasks(tasks);
        return item;
    }

    public void SaveTasks(IReadOnlyList<ZenTaskRecord> tasks)
    {
        var env = new TaskStoreEnvelope { SchemaVersion = SchemaVersion, Items = tasks.ToList() };
        var json = JsonSerializer.Serialize(env, JsonOpts);
        AtomicWriteAllText(_taskFilePath, json);
    }

    public static string FormatTaskLine(ZenTaskRecord t)
    {
        var project = string.IsNullOrWhiteSpace(t.Project) ? "未分配" : t.Project;
        var status = string.IsNullOrWhiteSpace(t.WorkflowStatus) ? "—" : t.WorkflowStatus;
        var due = t.DueDate?.ToString("yyyy-MM-dd") ?? "—";
        var priority = GetPriorityLabel(t.Impact, t.Urgency);
        return $"{t.Title} | 项目:{project} | 状态:{status} | 到期:{due} | 优先:{priority} | 能量:{t.EnergyLevel}";
    }

    public static string GetPriorityLabel(int impact, int urgency) => (impact, urgency) switch
    {
        (>= 4, >= 4) => "Q1 紧急重要",
        (>= 4, < 4) => "Q2 重要不紧急",
        (< 4, >= 4) => "Q3 紧急不重要",
        _ => "Q4 不紧急不重要",
    };

    private static (int Impact, int Urgency) ParsePriority(string priority) => priority.Trim() switch
    {
        "Urgent & Important" or "Critical" or "Q1" => (5, 5),
        "Not Urgent & Important" or "Q2" => (5, 2),
        "Urgent & Not Important" or "Q3" => (2, 5),
        "High" => (4, 4),
        "Medium" => (3, 3),
        "Low" or "Q4" => (2, 2),
        _ => (3, 3),
    };

    private static string NormalizeRaci(string? raci) => raci switch
    {
        null or "" => "Responsible",
        "RACI-R" => "Responsible",
        "RACI-A" => "Accountable",
        "RACI-C" => "Consulted",
        "RACI-I" => "Informed",
        _ => raci,
    };

    private static string NormalizeEnergy(string? energy) => energy switch
    {
        null or "" => "Medium",
        var e when e.Contains("High", StringComparison.OrdinalIgnoreCase) => "High",
        var e when e.Contains("Medium", StringComparison.OrdinalIgnoreCase) => "Medium",
        var e when e.Contains("Low", StringComparison.OrdinalIgnoreCase) => "Low",
        _ => "Medium",
    };

    private static void AtomicWriteAllText(string path, string content)
    {
        var dir = Path.GetDirectoryName(path);
        if (string.IsNullOrWhiteSpace(dir))
            throw new InvalidOperationException("目标目录无效。");
        Directory.CreateDirectory(dir);

        var tmpPath = path + ".tmp";
        File.WriteAllText(tmpPath, content, new UTF8Encoding(false));
        if (File.Exists(path))
            File.Replace(tmpPath, path, null, ignoreMetadataErrors: true);
        else
            File.Move(tmpPath, path);
    }

    private sealed class TaskStoreEnvelope
    {
            public int SchemaVersion { get; set; } = ZenTaskStore.SchemaVersion;
        public List<ZenTaskRecord> Items { get; set; } = new();
    }

    private sealed class ProjectStoreEnvelope
    {
            public int SchemaVersion { get; set; } = ZenTaskStore.SchemaVersion;
        public List<ZenProjectRecord> Items { get; set; } = new();
    }
}

public sealed class ZenTaskRecord
{
    public string Id { get; set; } = "";
    public string ProjectId { get; set; } = "";
    public string Project { get; set; } = "Unassigned";
    public string Title { get; set; } = "";
    public string SourceTag { get; set; } = "Agent";
    public string Layer { get; set; } = "Task";
    public int Impact { get; set; } = 3;
    public int Urgency { get; set; } = 3;
    public string RaciRole { get; set; } = "Responsible";
    public string EnergyLevel { get; set; } = "Medium";
    public string WorkflowStatus { get; set; } = "Todo";
    public DateTime? DueDate { get; set; }
    public string Notes { get; set; } = "";
    public string Tags { get; set; } = "";
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
    public List<string> AuditTrail { get; set; } = new();
}

public sealed class ZenProjectRecord
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string Status { get; set; } = "";
    public string Priority { get; set; } = "";
}

public sealed class ZenTaskAddRequest
{
    public string? Title { get; init; }
    public string? Project { get; init; }
    public string? ProjectId { get; init; }
    public string? Priority { get; init; }
    public string? Energy { get; init; }
    public string? Raci { get; init; }
    public string? Layer { get; init; }
    public string? Source { get; init; }
    public string? Notes { get; init; }
    public string? Tags { get; init; }
    public DateTime? DueDate { get; init; }
}
