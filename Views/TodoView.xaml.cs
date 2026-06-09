using System.Collections.ObjectModel;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;
using DesktopAssistant.Services;
using Microsoft.Web.WebView2.Core;

namespace DesktopAssistant.Views;

public partial class TodoView : UserControl
{
    private const int TaskStoreSchemaVersion = 1;
    private static readonly JsonSerializerOptions WebJsonOptions = new()
    {
        PropertyNameCaseInsensitive = true
    };

    private string? _strategicTaskFilePath;
    private string? _projectFilePath;
    private readonly ObservableCollection<StrategicTaskItem> _strategicTasks = new();
    private readonly ObservableCollection<ProjectItem> _projects = new();
    private readonly DispatcherTimer _reminderTimer;
    private bool _webReady;
    private bool _messageHooked;
    private string _activeTab = "Dashboard";
    private string _searchText = "";
    private string? _selectedProjectId;
    private string? _editingTaskId;
    private string _aiInsight = "";
    private string _aiPlan = "";
    private string _aiSchedule = "";
    private string _aiWorkReview = "";
    private bool _isAiWorking;
    private List<AiImportCandidate> _aiImportCandidates = new();
    private bool _focusModeActive;
    private DateTime? _focusModeStartedAtUtc;

    public TodoView()
    {
        InitializeComponent();
        _reminderTimer = new DispatcherTimer { Interval = TimeSpan.FromMinutes(30) };
        _reminderTimer.Tick += ReminderTimer_Tick;
        _reminderTimer.Start();

        Loaded += async (_, _) =>
        {
            await EnsureWebAsync();
            Reload();
        };
    }

    public sealed class StrategicTaskItem
    {
        public string Id { get; set; } = Guid.NewGuid().ToString("N");
        public string ProjectId { get; set; } = "";
        public string Project { get; set; } = "未分配";
        public string Title { get; set; } = "";
        public string SourceTag { get; set; } = "Manual";
        public string Layer { get; set; } = "Task";
        public int Impact { get; set; } = 3;
        public int Urgency { get; set; } = 3;
        public string RaciRole { get; set; } = "Responsible";
        public string EnergyLevel { get; set; } = "Low";
        public string WorkflowStatus { get; set; } = "Todo";
        public DateTime? DueDate { get; set; }
        public DateTime? StartDate { get; set; }
        public DateTime? EndDate { get; set; }
        public string Notes { get; set; } = "";
        public string Tags { get; set; } = "";         // comma-separated
        public List<ChecklistItem> Checklist { get; set; } = new();
        public string Objective { get; set; } = "";
        public string KeyResult { get; set; } = "";
        public DateTime CreatedAt { get; set; } = DateTime.Now;
        public DateTime UpdatedAt { get; set; } = DateTime.Now;
        public DateTime? CompletedAt { get; set; }
        public List<string> AuditTrail { get; set; } = new();
        public bool IsDone => WorkflowStatus == "Completed" || WorkflowStatus == "Done";
        public bool IsHighEnergy => EnergyLevel.Equals("High", StringComparison.OrdinalIgnoreCase);
        public string DueDateDisplay => DueDate?.ToString("yyyy-MM-dd") ?? "—";
        public string PriorityLabel => GetPriorityLabel(Impact, Urgency);
        public static string GetPriorityLabel(int impact, int urgency) => (impact, urgency) switch
        {
            (>= 4, >= 4) => "Urgent & Important",
            (>= 4, < 4) => "Not Urgent & Important",
            (< 4, >= 4) => "Urgent & Not Important",
            _ => "Not Urgent & Not Important"
        };
    }

    public sealed class ChecklistItem
    {
        public string Id { get; set; } = Guid.NewGuid().ToString("N")[..8];
        public string Text { get; set; } = "";
        public bool Done { get; set; } = false;
    }

    public sealed class ProjectItem
    {
        public string Id { get; set; } = $"p{DateTime.Now.Ticks}";
        public string Name { get; set; } = "";
        public string Owner { get; set; } = "Alexander";
        public int Progress { get; set; }
        public string Priority { get; set; } = "Medium";
        public string Status { get; set; } = "On Track";
        public string Category { get; set; } = "New Initiatives";
        public int Team { get; set; } = 1;
        public string Description { get; set; } = "New project created from dashboard.";
    }

    public void Reload()
    {
        var cfg = App.Config.Load();
        var root = NoteService.ResolveRoot(cfg.NotesRootPath);
        var journalDir = Path.Combine(root, "Journal");
        Directory.CreateDirectory(journalDir);
        _strategicTaskFilePath = Path.Combine(journalDir, "task-module.json");
        _projectFilePath = Path.Combine(journalDir, "zentask-projects.json");
        LoadProjects();
        LoadStrategicTasks();
        EnsureProjectLinks();
        ReloadReminderSettings();
        _ = PushStateToWebAsync();
    }

    public void ReloadReminderSettings()
    {
        var cfg = App.Config.Load();
        _reminderTimer.Interval = TimeSpan.FromMinutes(Math.Clamp(cfg.TodoReminderMinutes, 5, 240));
        if (cfg.TodoReminderEnabled) _reminderTimer.Start();
        else _reminderTimer.Stop();
        _ = PushStateToWebAsync();
    }

    /// <summary>Dock 等入口：按 Web 端新建任务相同的默认属性（未分配项目、Medium 等）写入 Zen Task。</summary>
    public void QuickAddDefaultZenTask(string title)
    {
        var t = title?.Trim() ?? "";
        if (string.IsNullOrWhiteSpace(t))
            return;

        if (string.IsNullOrEmpty(_strategicTaskFilePath))
            Reload();

        AddStrategicTask(new WebAction
        {
            Title = t,
            ProjectId = "",
            Priority = "Medium",
            Raci = "Responsible",
            Energy = "Medium"
        });
        _ = PushStateToWebAsync();
    }

    private async Task EnsureWebAsync()
    {
        if (_webReady) return;
        await TodoWeb.EnsureCoreWebView2Async(null);
        if (TodoWeb.CoreWebView2 == null) return;
        if (!_messageHooked)
        {
            TodoWeb.CoreWebView2.WebMessageReceived += TodoWeb_OnWebMessageReceived;
            TodoWeb.NavigationCompleted += async (_, _) =>
            {
                _webReady = true;
                await PushStateToWebAsync();
            };
            _messageHooked = true;
        }
        var htmlPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "Assets", "zentask.html");
        TodoWeb.Source = new Uri(htmlPath);
    }

    private async void TodoWeb_OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            var message = JsonSerializer.Deserialize<WebAction>(e.WebMessageAsJson, WebJsonOptions);
            if (message?.Type == null) return;

            switch (message.Type)
            {
                case "init":
                    break;
                case "setTab":
                    _activeTab = message.Tab ?? "Dashboard";
                    if (_activeTab != "ProjectDetail")
                        _selectedProjectId = null;
                    if (_activeTab != "Dashboard")
                        ExitFocusMode();
                    break;
                case "openProject":
                    ExitFocusMode();
                    _selectedProjectId = message.ProjectId;
                    _activeTab = "ProjectDetail";
                    break;
                case "search":
                    _searchText = message.Value?.Trim() ?? "";
                    break;
                case "addTask":
                    AddStrategicTask(message);
                    break;
                case "updateTask":
                    UpdateTask(message);
                    break;
                case "addProject":
                    AddProject(message);
                    break;
                case "toggleDone":
                    ToggleTaskDone(message.Id, message.CompleteChecklist);
                    break;
                case "completeTasks":
                    CompleteTasks(message.Ids, message.CompleteChecklist);
                    break;
                case "deleteTask":
                    DeleteTask(message.Id);
                    break;
                case "setReminder":
                    SetReminder(message.Enabled);
                    break;
                case "testReminder":
                    TestReminder();
                    break;
                case "openHelp":
                    OpenTaskModuleHelp();
                    break;
                case "openTodaysFocusHelp":
                    OpenTodaysFocusHelp();
                    break;
                case "convertMeeting":
                    ConvertMeetingActions(message.Text);
                    break;
                case "startFocus":
                    _activeTab = "Dashboard";
                    _searchText = "";
                    _focusModeActive = true;
                    _focusModeStartedAtUtc = DateTime.UtcNow;
                    break;
                case "endFocus":
                    ExitFocusMode();
                    break;
                case "setUserName":
                    SavePreferredUserName(message.Value);
                    break;
                case "analyzeTasks":
                    await AnalyzeTasksAsync();
                    break;
                case "planTasks":
                    await PlanTasksAsync();
                    break;
                case "scheduleTasks":
                    await ScheduleTasksAsync();
                    break;
                case "applyAiPlan":
                    ApplyAiPlanToTasks();
                    break;
                case "importAiTasks":
                    ImportAiTasks(message.Items);
                    break;
                case "generateWorkReview":
                    await GenerateWorkReviewAsync(message.StartDate, message.EndDate, message.ProjectId);
                    break;
                case "saveWorkReview":
                    SaveWorkReviewMarkdown(message.Title, message.Text, message.StartDate, message.EndDate, message.ProjectId);
                    break;
            }
        }
        catch
        {
            // ignore malformed message
        }

        await PushStateToWebAsync();
    }

    private async Task PushStateToWebAsync()
    {
        if (!_webReady || TodoWeb.CoreWebView2 == null) return;
        var json = JsonSerializer.Serialize(BuildWebState());
        await TodoWeb.ExecuteScriptAsync($"window.ZenTask && window.ZenTask.receiveState({json});");
    }

    private object BuildWebState()
    {
        var reminderEnabled = App.Config.Load().TodoReminderEnabled;
        var filteredTasks = GetFilteredTasks().ToList();
        var selectedProject = _projects.FirstOrDefault(p => p.Id == _selectedProjectId);
        var projectTasks = _strategicTasks.Where(t => t.ProjectId == _selectedProjectId).OrderBy(t => t.DueDate ?? DateTime.MaxValue).ToList();
        var total = _strategicTasks.Count;
        var completed = _strategicTasks.Count(t => t.IsDone);
        var urgent = _strategicTasks.Count(t => !t.IsDone && t.PriorityLabel.Contains("Urgent", StringComparison.OrdinalIgnoreCase));
        var highEnergy = _strategicTasks.Count(t => t.IsHighEnergy && !t.IsDone);
        var todayDate = DateTime.Today;
        var overdue = _strategicTasks.Count(t => !t.IsDone && t.DueDate.HasValue && t.DueDate.Value.Date < todayDate);
        var inProgress = _strategicTasks.Count(t => t.WorkflowStatus == "In Progress");
        var blocked = _strategicTasks.Count(t => t.WorkflowStatus == "Blocked");
        var deferred = _strategicTasks.Count(t => t.WorkflowStatus == "Deferred");
        var energyLow = _strategicTasks.Count(t => !t.IsDone && t.EnergyLevel.Equals("Low", StringComparison.OrdinalIgnoreCase));
        var energyMed = _strategicTasks.Count(t => !t.IsDone && t.EnergyLevel.Equals("Medium", StringComparison.OrdinalIgnoreCase));
        var energyHigh = _strategicTasks.Count(t => !t.IsDone && t.IsHighEnergy);
        var allTags = _strategicTasks
            .Where(t => !string.IsNullOrWhiteSpace(t.Tags))
            .SelectMany(t => t.Tags.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            .Distinct(StringComparer.OrdinalIgnoreCase).Take(20).ToList();

        var focusTasks = GetFocusTasks().Select(ToWebTask);

        return new
        {
            activeTab = _activeTab,
            search = _searchText,
            editingTaskId = _editingTaskId,
            userName = GetUserName(),
            reminderEnabled,
            reminderMinutes = (int)_reminderTimer.Interval.TotalMinutes,
            tasks = filteredTasks.Select(ToWebTask),
            focusTasks,
            projects = _projects.Select(ToWebProject),
            selectedProject = selectedProject == null ? null : ToWebProjectDetail(selectedProject, projectTasks),
            aiInsight = _aiInsight,
            aiPlan = _aiPlan,
            aiSchedule = _aiSchedule,
            aiWorkReview = _aiWorkReview,
            aiBusy = _isAiWorking,
            aiImportCandidates = _aiImportCandidates.Select(c => new
            {
                title = c.Title,
                projectId = c.ProjectId,
                project = c.Project,
                priority = c.Priority,
                energy = c.Energy,
                deadline = c.Deadline
            }),
            stats = new
            {
                total,
                completed,
                urgent,
                highEnergy,
                overdue,
                inProgress,
                blocked,
                deferred,
                energyLow,
                energyMed,
                energyHigh,
                allTags
            },
            focusMode = _focusModeActive,
            focusStartedAt = _focusModeStartedAtUtc?.ToString("o")
        };
    }

    private void ExitFocusMode()
    {
        _focusModeActive = false;
        _focusModeStartedAtUtc = null;
    }

    private IEnumerable<StrategicTaskItem> GetFilteredTasks()
    {
        IEnumerable<StrategicTaskItem> filtered = _strategicTasks;

        filtered = _activeTab switch
        {
            "Inbox" => filtered
                .Where(t => !t.IsDone)
                .OrderBy(t => t.DueDate ?? DateTime.MaxValue)
                .ThenByDescending(t => t.Impact + t.Urgency),
            "My Tasks" => filtered
                .Where(t => !t.IsDone && IsMyTask(t))
                .OrderBy(t => t.DueDate ?? DateTime.MaxValue)
                .ThenByDescending(t => t.Impact + t.Urgency),
            "Completed" => filtered
                .Where(t => t.IsDone)
                .OrderByDescending(t => t.CompletedAt ?? t.UpdatedAt),
            "Projects" => filtered.OrderByDescending(t => t.UpdatedAt),
            "Analytics" => filtered.OrderByDescending(t => t.Impact + t.Urgency),
            _ => filtered.OrderBy(t => t.IsDone ? 1 : 0).ThenBy(t => t.DueDate ?? DateTime.MaxValue)
        };

        if (!string.IsNullOrWhiteSpace(_searchText))
        {
            filtered = filtered.Where(t =>
                t.Title.Contains(_searchText, StringComparison.OrdinalIgnoreCase) ||
                t.Project.Contains(_searchText, StringComparison.OrdinalIgnoreCase) ||
                t.SourceTag.Contains(_searchText, StringComparison.OrdinalIgnoreCase) ||
                t.RaciRole.Contains(_searchText, StringComparison.OrdinalIgnoreCase) ||
                t.Notes.Contains(_searchText, StringComparison.OrdinalIgnoreCase) ||
                t.Tags.Contains(_searchText, StringComparison.OrdinalIgnoreCase));
        }

        return filtered;
    }

    /// <summary>
    /// 「今日重心」：GTD + 艾森豪威尔矩阵导向的优先级队列（逾期/今日、Q1 高优、Accountable 终责）。
    /// </summary>
    private List<StrategicTaskItem> GetFocusTasks()
    {
        var today = DateTime.Today;
        return _strategicTasks
            .Where(t => IsFocusTaskCandidate(t, today))
            .OrderByDescending(t => GetFocusPriorityRank(t))
            .ThenBy(t => GetFocusDueSortKey(t, today))
            .ThenByDescending(t => t.Impact + t.Urgency)
            .ThenBy(t => t.DueDate ?? DateTime.MaxValue)
            .ToList();
    }

    private static bool IsTaskCancelled(StrategicTaskItem t) =>
        t.WorkflowStatus.Equals("Cancelled", StringComparison.OrdinalIgnoreCase) ||
        t.WorkflowStatus.Equals("Canceled", StringComparison.OrdinalIgnoreCase) ||
        t.WorkflowStatus.Equals("废弃", StringComparison.OrdinalIgnoreCase);

    private bool IsFocusTaskCandidate(StrategicTaskItem t, DateTime today)
    {
        if (t.IsDone || IsTaskCancelled(t))
            return false;

        var raci = NormalizeRaci(t.RaciRole);

        // RACI：最终责任人（Accountable）优先进入重心，即使优先级为 Medium
        if (raci.Equals("Accountable", StringComparison.OrdinalIgnoreCase))
            return true;

        // 艾森豪威尔 Q1：紧急且重要（含 Critical/High 映射到该象限后的表现）
        if (t.PriorityLabel.Equals("Urgent & Important", StringComparison.OrdinalIgnoreCase))
            return true;

        // 时间因素：今日及以前到期（含逾期），债务风险最高
        if (t.DueDate.HasValue && t.DueDate.Value.Date <= today)
            return true;

        return false;
    }

    /// <summary>Critical / Urgent / High / Medium 梯队，用于 Eat the Frog 排序。</summary>
    private static int GetFocusPriorityRank(StrategicTaskItem t) => t.PriorityLabel switch
    {
        "Urgent & Important" => 4,
        "Not Urgent & Important" => 3,
        "Urgent & Not Important" => 2,
        "Not Urgent & Not Important" => 1,
        _ => 1
    };

    /// <summary>逾期优先于今日，无日期靠后。</summary>
    private static int GetFocusDueSortKey(StrategicTaskItem t, DateTime today)
    {
        if (!t.DueDate.HasValue)
            return 2;
        if (t.DueDate.Value.Date < today)
            return 0;
        if (t.DueDate.Value.Date == today)
            return 1;
        return 3;
    }

    private object ToWebTask(StrategicTaskItem t) => new
    {
        id = t.Id,
        projectId = t.ProjectId,
        project = t.Project,
        title = t.Title,
        priority = t.PriorityLabel,
        energy = t.EnergyLevel,
        raci = t.RaciRole,
        source = t.SourceTag,
        status = NormalizeTaskStatus(t.WorkflowStatus),
        deadline = t.DueDate?.ToString("yyyy-MM-dd") ?? "",
        startDate = t.StartDate?.ToString("yyyy-MM-dd") ?? "",
        endDate = t.EndDate?.ToString("yyyy-MM-dd") ?? "",
        completedAt = t.CompletedAt?.ToString("yyyy-MM-dd HH:mm") ?? "",
        updatedAt = t.UpdatedAt.ToString("yyyy-MM-dd HH:mm"),
        notes = t.Notes,
        tags = t.Tags,
        checklist = t.Checklist.Select(c => new { c.Id, c.Text, c.Done }).ToList(),
        type = t.Layer,
        impact = t.Impact,
        urgency = t.Urgency,
        objective = t.Objective,
        keyResult = t.KeyResult
    };

    private object ToWebProject(ProjectItem p)
    {
        var associated = _strategicTasks.Where(t => t.ProjectId == p.Id).ToList();
        var calculatedProgress = associated.Count == 0 ? p.Progress : (int)Math.Round(associated.Count(t => t.IsDone) * 100.0 / associated.Count);
        return new
        {
            id = p.Id,
            name = p.Name,
            owner = p.Owner,
            progress = calculatedProgress,
            priority = p.Priority,
            status = p.Status,
            category = p.Category,
            team = p.Team,
            description = p.Description,
            taskCount = associated.Count
        };
    }

    private object ToWebProjectDetail(ProjectItem p, List<StrategicTaskItem> tasks) => new
    {
        id = p.Id,
        name = p.Name,
        owner = p.Owner,
        progress = tasks.Count == 0 ? p.Progress : (int)Math.Round(tasks.Count(t => t.IsDone) * 100.0 / tasks.Count),
        priority = p.Priority,
        status = p.Status,
        category = p.Category,
        team = p.Team,
        description = p.Description,
        tasks = tasks.Select(ToWebTask),
        stakeholders = new[]
        {
            new { name = p.Owner, role = "Project Owner", initial = GetInitials(p.Owner) },
            new { name = "Sarah Chen", role = "Primary Exec", initial = "SC" },
            new { name = "Finance Dept", role = "Informed", initial = "FD" }
        }
    };

    private void LoadProjects()
    {
        _projects.Clear();
        if (string.IsNullOrWhiteSpace(_projectFilePath) || !File.Exists(_projectFilePath))
            return;
        try
        {
            var json = File.ReadAllText(_projectFilePath, Encoding.UTF8);
            List<ProjectItem>? list = null;
            var trimmed = json.TrimStart();
            if (trimmed.StartsWith('{'))
            {
                var wrapped = JsonSerializer.Deserialize<ProjectStoreEnvelope>(json);
                if (wrapped?.Items != null)
                    list = wrapped.Items;
            }
            else
            {
                list = JsonSerializer.Deserialize<List<ProjectItem>>(json);
            }
            if (list != null)
            {
                foreach (var project in list)
                    _projects.Add(project);
            }
        }
        catch (Exception ex)
        {
            ReportIoError("加载项目失败", ex, _projectFilePath);
        }
    }

    private void SaveProjects()
    {
        if (string.IsNullOrWhiteSpace(_projectFilePath)) return;
        try
        {
            var env = new ProjectStoreEnvelope
            {
                SchemaVersion = TaskStoreSchemaVersion,
                Items = _projects.ToList()
            };
            var json = JsonSerializer.Serialize(env, new JsonSerializerOptions { WriteIndented = true });
            AtomicWriteAllText(_projectFilePath, json);
        }
        catch (Exception ex)
        {
            ReportIoError("保存项目失败", ex, _projectFilePath);
        }
    }

    private void LoadStrategicTasks()
    {
        _strategicTasks.Clear();
        if (string.IsNullOrWhiteSpace(_strategicTaskFilePath) || !File.Exists(_strategicTaskFilePath))
            return;
        try
        {
            var json = File.ReadAllText(_strategicTaskFilePath, Encoding.UTF8);
            List<StrategicTaskItem>? list = null;
            var wrapped = JsonSerializer.Deserialize<TaskStoreEnvelope>(json);
            if (wrapped?.Items != null)
                list = wrapped.Items;
            else
                list = JsonSerializer.Deserialize<List<StrategicTaskItem>>(json);
            if (list != null)
            {
                foreach (var task in list)
                    _strategicTasks.Add(task);
            }
        }
        catch (Exception ex)
        {
            ReportIoError("加载任务失败", ex, _strategicTaskFilePath);
        }
    }

    private void SaveStrategicTasks()
    {
        if (string.IsNullOrWhiteSpace(_strategicTaskFilePath)) return;
        try
        {
            var env = new TaskStoreEnvelope
            {
                SchemaVersion = TaskStoreSchemaVersion,
                Items = _strategicTasks.ToList()
            };
            var json = JsonSerializer.Serialize(env, new JsonSerializerOptions { WriteIndented = true });
            AtomicWriteAllText(_strategicTaskFilePath, json);
        }
        catch (Exception ex)
        {
            ReportIoError("保存任务失败", ex, _strategicTaskFilePath);
        }
    }

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

    private static void ReportIoError(string action, Exception ex, string? path)
    {
        Debug.WriteLine($"[TodoView] {action}: {ex.Message} path={path}");
        var detail = string.IsNullOrWhiteSpace(path) ? ex.Message : $"{ex.Message}\n{path}";
        MessageBox.Show(detail, action, MessageBoxButton.OK, MessageBoxImage.Warning);
    }

    private void EnsureProjectLinks()
    {
        if (_projects.Count == 0 && _strategicTasks.Count > 0)
        {
            var grouped = _strategicTasks
                .Where(t => !string.IsNullOrWhiteSpace(t.Project))
                .Select(t => t.Project)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();

            foreach (var name in grouped)
            {
                _projects.Add(new ProjectItem
                {
                    Id = $"p{Guid.NewGuid():N}"[..8],
                    Name = name,
                    Category = "Imported",
                    Priority = "Medium",
                    Status = "On Track",
                    Description = "Imported from existing task data."
                });
            }
            SaveProjects();
        }

        foreach (var task in _strategicTasks)
        {
            if (!string.IsNullOrWhiteSpace(task.ProjectId) && _projects.Any(p => p.Id == task.ProjectId))
            {
                task.Project = _projects.First(p => p.Id == task.ProjectId).Name;
                continue;
            }

            if (!string.IsNullOrWhiteSpace(task.Project))
            {
                var existing = _projects.FirstOrDefault(p => string.Equals(p.Name, task.Project, StringComparison.OrdinalIgnoreCase));
                if (existing != null)
                {
                    task.ProjectId = existing.Id;
                    continue;
                }
            }

            task.Project = "Unassigned";
            task.ProjectId = "";
        }
        SaveStrategicTasks();
    }

    private void AddProject(WebAction message)
    {
        var title = message.Title?.Trim() ?? "";
        if (string.IsNullOrWhiteSpace(title))
        {
            MessageBox.Show("请先输入项目名称。", "Zen Task", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }

        var project = new ProjectItem
        {
            Id = $"p{DateTime.Now.Ticks}",
            Name = title,
            Owner = "Alexander",
            Progress = 0,
            Priority = NormalizeProjectPriority(message.Priority),
            Status = "On Track",
            Category = "New Initiatives",
            Team = 1,
            Description = "New project created from dashboard."
        };
        _projects.Insert(0, project);
        SaveProjects();
    }

    private void AddStrategicTask(WebAction message)
    {
        var title = message.Title?.Trim() ?? "";
        if (string.IsNullOrWhiteSpace(title))
        {
            MessageBox.Show("请先输入任务标题。", "Zen Task", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }

        var project = _projects.FirstOrDefault(p => p.Id == (message.ProjectId ?? ""));
        var priorityText = message.Priority ?? "Medium";
        var (impact, urgency) = ParsePriority(priorityText);

        var item = new StrategicTaskItem
        {
            Title = title,
            ProjectId = project?.Id ?? "",
            Project = project?.Name ?? "Unassigned",
            SourceTag = string.IsNullOrWhiteSpace(message.Source) ? "Manual" : message.Source,
            Layer = string.IsNullOrWhiteSpace(message.Level) ? "Project Task" : message.Level,
            Impact = impact,
            Urgency = urgency,
            RaciRole = NormalizeRaci(message.Raci),
            EnergyLevel = NormalizeEnergy(message.Energy),
            WorkflowStatus = "Todo",
            DueDate = DateTime.TryParse(message.Deadline, out var due) ? due : null,
            StartDate = DateTime.TryParse(message.StartDate, out var sd) ? sd : null,
            EndDate = DateTime.TryParse(message.EndDate, out var ed) ? ed : null,
            Notes = message.Notes?.Trim() ?? "",
            Tags = message.Tags?.Trim() ?? "",
            Checklist = message.Checklist?.Select(c => new ChecklistItem {
                Id = string.IsNullOrWhiteSpace(c.Id) ? Guid.NewGuid().ToString("N")[..8] : c.Id,
                Text = c.Text, Done = c.Done
            }).ToList() ?? new(),
            CreatedAt = DateTime.Now,
            UpdatedAt = DateTime.Now
        };
        item.AuditTrail.Add($"{DateTime.Now:yyyy-MM-dd HH:mm} created");
        _strategicTasks.Insert(0, item);
        SaveStrategicTasks();
        _editingTaskId = null;
    }

    private void UpdateTask(WebAction message)
    {
        var item = FindTask(message.Id);
        if (item == null)
            return;

        var title = message.Title?.Trim() ?? "";
        if (string.IsNullOrWhiteSpace(title))
            return;

        var project = _projects.FirstOrDefault(p => p.Id == (message.ProjectId ?? ""));
        var (impact, urgency) = ParsePriority(message.Priority ?? "Medium");

        item.Title = title;
        item.ProjectId = project?.Id ?? "";
        item.Project = project?.Name ?? "Unassigned";
        item.RaciRole = NormalizeRaci(message.Raci);
        item.EnergyLevel = NormalizeEnergy(message.Energy);
        item.Impact = impact;
        item.Urgency = urgency;
        item.DueDate = DateTime.TryParse(message.Deadline, out var due) ? due : null;
        item.StartDate = DateTime.TryParse(message.StartDate, out var sd) ? sd : null;
        item.EndDate = DateTime.TryParse(message.EndDate, out var ed) ? ed : null;
        if (!string.IsNullOrWhiteSpace(message.WorkflowStatus) && message.WorkflowStatus != "Completed")
            item.WorkflowStatus = message.WorkflowStatus;
        item.Notes = message.Notes?.Trim() ?? item.Notes;
        item.Tags = message.Tags?.Trim() ?? item.Tags;
        if (message.Checklist != null)
            item.Checklist = message.Checklist.Select(c => new ChecklistItem {
                Id = string.IsNullOrWhiteSpace(c.Id) ? Guid.NewGuid().ToString("N")[..8] : c.Id,
                Text = c.Text, Done = c.Done
            }).ToList();
        item.UpdatedAt = DateTime.Now;
        item.Objective = message.Objective?.Trim() ?? item.Objective;
        item.KeyResult = message.KeyResult?.Trim() ?? item.KeyResult;
        item.AuditTrail.Add($"{DateTime.Now:yyyy-MM-dd HH:mm} edited");
        SaveStrategicTasks();
        _editingTaskId = null;
    }

    private void ToggleTaskDone(string? id, bool completeChecklist)
    {
        var item = FindTask(id);
        if (item == null) return;
        var markDone = !item.IsDone;
        item.WorkflowStatus = markDone ? "Completed" : "Todo";
        item.CompletedAt = markDone ? DateTime.Now : null;
        if (markDone && completeChecklist && item.Checklist.Count > 0)
        {
            foreach (var checklistItem in item.Checklist)
                checklistItem.Done = true;
        }
        item.UpdatedAt = DateTime.Now;
        item.AuditTrail.Add($"{DateTime.Now:yyyy-MM-dd HH:mm} status -> {item.WorkflowStatus}");
        SaveStrategicTasks();
    }

    private void DeleteTask(string? id)
    {
        var item = FindTask(id);
        if (item == null) return;
        if (MessageBox.Show($"确定删除「{item.Title}」？", "删除任务", MessageBoxButton.YesNo, MessageBoxImage.Question) != MessageBoxResult.Yes)
            return;
        _strategicTasks.Remove(item);
        SaveStrategicTasks();
    }

    private void CompleteTasks(List<string>? ids, bool completeChecklist)
    {
        if (ids == null || ids.Count == 0)
            return;

        var updated = false;
        foreach (var id in ids.Where(static x => !string.IsNullOrWhiteSpace(x)).Distinct(StringComparer.OrdinalIgnoreCase))
        {
            var item = FindTask(id);
            if (item == null || item.IsDone)
                continue;

            item.WorkflowStatus = "Completed";
            item.CompletedAt = DateTime.Now;
            if (completeChecklist && item.Checklist.Count > 0)
            {
                foreach (var checklistItem in item.Checklist)
                    checklistItem.Done = true;
            }
            item.UpdatedAt = DateTime.Now;
            item.AuditTrail.Add($"{DateTime.Now:yyyy-MM-dd HH:mm} batch completed");
            updated = true;
        }

        if (updated)
            SaveStrategicTasks();
    }

    private void ConvertMeetingActions(string? rawText)
    {
        var lines = (rawText ?? "").Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (lines.Length == 0) return;
        foreach (var line in lines)
        {
            _strategicTasks.Insert(0, new StrategicTaskItem
            {
                Title = line,
                Project = "Unassigned",
                SourceTag = "Manual",
                Layer = "Inbox",
                Impact = 3,
                Urgency = 3,
                RaciRole = "Responsible",
                EnergyLevel = "Medium",
                WorkflowStatus = "Todo",
                Objective = "Meeting to Action",
                CreatedAt = DateTime.Now,
                UpdatedAt = DateTime.Now,
                AuditTrail = new List<string> { $"{DateTime.Now:yyyy-MM-dd HH:mm} from meeting notes" }
            });
        }
        SaveStrategicTasks();
    }

    private StrategicTaskItem? FindTask(string? id) =>
        string.IsNullOrWhiteSpace(id) ? null : _strategicTasks.FirstOrDefault(t => string.Equals(t.Id, id, StringComparison.OrdinalIgnoreCase));

    private void OpenTaskModuleHelp()
    {
        try
        {
            var htmlPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "Assets", "task-management-philosophy-help.html");
            Process.Start(new ProcessStartInfo { FileName = htmlPath, UseShellExecute = true });
        }
        catch (Exception ex)
        {
            MessageBox.Show($"打开帮助失败：{ex.Message}", "Zen Task", MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }

    private void OpenTodaysFocusHelp()
    {
        try
        {
            var htmlPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "Assets", "todays-focus-help.html");
            Process.Start(new ProcessStartInfo { FileName = htmlPath, UseShellExecute = true });
        }
        catch (Exception ex)
        {
            MessageBox.Show($"打开帮助失败：{ex.Message}", "Zen Task", MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }

    private void SetReminder(bool enabled)
    {
        if (enabled) _reminderTimer.Start();
        else _reminderTimer.Stop();
        var cfg = App.Config.Load();
        cfg.TodoReminderEnabled = enabled;
        cfg.TodoReminderMinutes = Math.Clamp((int)_reminderTimer.Interval.TotalMinutes, 5, 240);
        App.Config.Save(cfg);
        ShowReminderToggleFeedback(enabled);
    }

    private void ShowReminderToggleFeedback(bool enabled)
    {
        var pending = _strategicTasks.Count(t => !t.IsDone);
        var msg = enabled
            ? $"任务提醒已开启（每{(int)_reminderTimer.Interval.TotalMinutes}分钟）。当前未完成：{pending} 项。"
            : "任务提醒已关闭。";
        if (Application.Current.MainWindow is MainWindow main)
            main.ShowTrayTip("📋 任务提醒设置", msg, 2500);
        else
            MessageBox.Show(msg, "任务提醒", MessageBoxButton.OK, MessageBoxImage.Information);
    }

    private void TestReminder()
    {
        var pending = _strategicTasks.Where(t => !t.IsDone).ToList();
        var msg = pending.Count == 0
            ? "当前没有未完成任务，提醒功能可正常使用。"
            : $"测试提醒：当前未完成 {pending.Count} 项。示例：{pending[0].Title}";
        if (Application.Current.MainWindow is MainWindow main)
            main.ShowTrayTip("📋 任务提醒测试", msg, 3500);
        else
            MessageBox.Show(msg, "任务提醒测试", MessageBoxButton.OK, MessageBoxImage.Information);
    }

    private void ReminderTimer_Tick(object? sender, EventArgs e)
    {
        if (!App.Config.Load().TodoReminderEnabled) return;
        var pending = _strategicTasks.Where(t => !t.IsDone).ToList();
        if (pending.Count == 0) return;
        var urgent = pending.Where(t => t.PriorityLabel.Contains("Urgent", StringComparison.OrdinalIgnoreCase)).ToList();
        var msg = urgent.Count > 0
            ? $"您有 {pending.Count} 项任务未完成，其中 {urgent.Count} 项高优先级。\n最紧急：{urgent[0].Title}"
            : $"您有 {pending.Count} 项任务待处理。";
        if (Application.Current.MainWindow is MainWindow main)
            main.ShowTrayTip("📋 任务提醒", msg, 5000);
    }

    private string GetUserName()
    {
        var preferred = App.Config.Load().PreferredUserName?.Trim();
        if (!string.IsNullOrWhiteSpace(preferred))
            return preferred;

        var envName = Environment.UserName?.Trim();
        return string.IsNullOrWhiteSpace(envName) ? "Friend" : envName;
    }

    private void SavePreferredUserName(string? value)
    {
        var name = value?.Trim() ?? "";
        if (string.IsNullOrWhiteSpace(name))
            return;

        var cfg = App.Config.Load();
        cfg.PreferredUserName = name;
        App.Config.Save(cfg);
    }

    private List<StrategicTaskItem> GetAiCandidateTasks() =>
        _strategicTasks
            .OrderBy(t => t.IsDone ? 1 : 0)
            .ThenBy(t => t.DueDate ?? DateTime.MaxValue)
            .ThenByDescending(t => t.Impact + t.Urgency)
            .ThenByDescending(t => t.UpdatedAt)
            .Take(12)
            .ToList();

    private async Task AnalyzeTasksAsync()
    {
        var cfg = App.Config.Load();
        if (string.IsNullOrWhiteSpace(cfg.ApiKey))
        {
            _aiInsight = "请先在设置中配置 API Key 与端点，随后即可使用任务 AI 分析。";
            return;
        }

        var tasks = GetAiCandidateTasks();
        if (tasks.Count == 0)
        {
            _aiInsight = "当前暂无可分析的任务。请先创建一些任务。";
            return;
        }

        _isAiWorking = true;
        await PushStateToWebAsync();
        try
        {
            var client = new OpenAiApiClient(cfg);
            var prompt = ZenTaskAiService.BuildRecentTaskAnalysisPrompt(GetUserName(), tasks);
            var result = await client.CallAsyncLong(prompt, ZenTaskAiService.AnalysisSystemPrompt, 2048, 0.35);
            _aiInsight = result.Success && !string.IsNullOrWhiteSpace(result.Result)
                ? result.Result.Trim()
                : result.Error ?? "AI 未返回有效分析结果。";
        }
        finally
        {
            _isAiWorking = false;
        }
    }

    private async Task PlanTasksAsync()
    {
        var cfg = App.Config.Load();
        if (string.IsNullOrWhiteSpace(cfg.ApiKey))
        {
            _aiPlan = "请先在设置中配置 API Key 与端点，随后即可使用 AI 任务安排。";
            return;
        }

        var tasks = GetAiCandidateTasks();
        if (tasks.Count == 0)
        {
            _aiPlan = "当前暂无可安排的任务。请先创建一些任务。";
            return;
        }

        _isAiWorking = true;
        await PushStateToWebAsync();
        try
        {
            var client = new OpenAiApiClient(cfg);
            var prompt = ZenTaskAiService.BuildTaskPlanningPrompt(GetUserName(), tasks);
            var result = await client.CallAsyncLong(prompt, ZenTaskAiService.PlanningSystemPrompt, 2048, 0.4);
            _aiPlan = result.Success && !string.IsNullOrWhiteSpace(result.Result)
                ? result.Result.Trim()
                : result.Error ?? "AI 未返回有效安排结果。";
        }
        finally
        {
            _isAiWorking = false;
        }
    }

    private async Task ScheduleTasksAsync()
    {
        var cfg = App.Config.Load();
        if (string.IsNullOrWhiteSpace(cfg.ApiKey))
        {
            _aiSchedule = "请先在设置中配置 API Key 与端点，随后即可使用 AI 时间块安排。";
            return;
        }

        var tasks = GetAiCandidateTasks();
        if (tasks.Count == 0)
        {
            _aiSchedule = "当前暂无可安排的任务。请先创建一些任务。";
            return;
        }

        _isAiWorking = true;
        await PushStateToWebAsync();
        try
        {
            var client = new OpenAiApiClient(cfg);
            var prompt = ZenTaskAiService.BuildTodaySchedulePrompt(GetUserName(), tasks);
            var result = await client.CallAsyncLong(prompt, ZenTaskAiService.ScheduleSystemPrompt, 2048, 0.35);
            _aiSchedule = result.Success && !string.IsNullOrWhiteSpace(result.Result)
                ? result.Result.Trim()
                : result.Error ?? "AI 未返回有效时间块安排。";
        }
        finally
        {
            _isAiWorking = false;
        }
    }

    private void ApplyAiPlanToTasks()
    {
        _aiImportCandidates = ExtractAiCandidates(_aiPlan)
            .Concat(ExtractAiCandidates(_aiSchedule))
            .GroupBy(static x => x.Title, StringComparer.OrdinalIgnoreCase)
            .Select(static g => g.First())
            .Take(8)
            .ToList();

        if (_aiImportCandidates.Count == 0)
            MessageBox.Show("当前 AI 结果里没有可提炼的可执行任务，请先生成 AI 任务安排或时间块建议。", "Zen Task", MessageBoxButton.OK, MessageBoxImage.Information);
    }

    private List<AiImportCandidate> ExtractAiCandidates(string? text)
    {
        if (string.IsNullOrWhiteSpace(text))
            return new List<AiImportCandidate>();

        return text
            .Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(CleanAiTaskLine)
            .Where(static line => !string.IsNullOrWhiteSpace(line) && line.Length >= 4)
            .Where(static line => !line.Contains("原因：", StringComparison.OrdinalIgnoreCase))
            .Where(static line => !line.Contains("建议：", StringComparison.OrdinalIgnoreCase))
            .Take(5)
            .Select(line =>
            {
                var matchedProject = MatchProjectForAiTask(line, null);
                return new AiImportCandidate
                {
                    Title = line,
                    ProjectId = matchedProject?.Id ?? "",
                    Project = matchedProject?.Name ?? "Unassigned",
                    Priority = "High",
                    Energy = "Medium",
                    Deadline = DateTime.Today.ToString("yyyy-MM-dd")
                };
            })
            .ToList();
    }

    private void ImportAiTasks(List<AiImportItem>? items)
    {
        if (items == null || items.Count == 0)
            return;

        var created = 0;
        foreach (var item in items.Where(static x => !string.IsNullOrWhiteSpace(x.Title)))
        {
            var line = item.Title!.Trim();
            if (_strategicTasks.Any(t => string.Equals(t.Title, line, StringComparison.OrdinalIgnoreCase) && !t.IsDone))
                continue;

            var matchedProject = MatchProjectForAiTask(line, item.ProjectId);
            var (impact, urgency) = ParsePriority(item.Priority ?? "High");
            _strategicTasks.Insert(0, new StrategicTaskItem
            {
                Title = line,
                Project = matchedProject?.Name ?? "Unassigned",
                ProjectId = matchedProject?.Id ?? "",
                SourceTag = "AI Planner",
                Layer = "Project Task",
                Impact = impact,
                Urgency = urgency,
                RaciRole = "Responsible",
                EnergyLevel = NormalizeEnergy(item.Energy),
                WorkflowStatus = "Todo",
                DueDate = DateTime.TryParse(item.Deadline, out var due) ? due : DateTime.Today,
                CreatedAt = DateTime.Now,
                UpdatedAt = DateTime.Now,
                AuditTrail = new List<string> { $"{DateTime.Now:yyyy-MM-dd HH:mm} created from AI suggestion" }
            });
            created++;
        }

        _aiImportCandidates.Clear();
        if (created > 0)
        {
            SaveStrategicTasks();
            _activeTab = "Inbox";
        }
    }

    private ProjectItem? MatchProjectForAiTask(string title, string? preferredProjectId)
    {
        if (!string.IsNullOrWhiteSpace(preferredProjectId))
        {
            var preferred = _projects.FirstOrDefault(p => p.Id == preferredProjectId);
            if (preferred != null)
                return preferred;
        }

        var byName = _projects.FirstOrDefault(p => title.Contains(p.Name, StringComparison.OrdinalIgnoreCase));
        if (byName != null)
            return byName;

        foreach (var task in _strategicTasks.OrderByDescending(t => t.UpdatedAt))
        {
            if (string.IsNullOrWhiteSpace(task.ProjectId))
                continue;
            var keyword = task.Title.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).FirstOrDefault();
            if (!string.IsNullOrWhiteSpace(keyword) && title.Contains(keyword, StringComparison.OrdinalIgnoreCase))
                return _projects.FirstOrDefault(p => p.Id == task.ProjectId);
        }

        return null;
    }

    private static string CleanAiTaskLine(string line)
    {
        var text = line.Trim();
        text = text.TrimStart('-', '*', '•', '●', '○', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '.', '、', ':', '：', ' ');
        if (text.StartsWith("上午", StringComparison.OrdinalIgnoreCase) ||
            text.StartsWith("下午", StringComparison.OrdinalIgnoreCase) ||
            text.StartsWith("晚些时候", StringComparison.OrdinalIgnoreCase) ||
            text.StartsWith("收尾", StringComparison.OrdinalIgnoreCase))
        {
            var index = text.IndexOfAny([':', '：']);
            if (index >= 0 && index < text.Length - 1)
                text = text[(index + 1)..].Trim();
        }

        return text;
    }

    private static (int Impact, int Urgency) ParsePriority(string priority) => priority switch
    {
        "Urgent & Important" => (5, 5),
        "Not Urgent & Important" => (5, 2),
        "Urgent & Not Important" => (2, 5),
        "Critical" => (5, 5),
        "High" => (4, 4),
        "Medium" => (3, 3),
        "Low" => (2, 2),
        _ => (3, 3)
    };

    private static string NormalizeTaskStatus(string status) => status switch
    {
        "Done" => "Completed",
        "Inbox" => "Todo",
        _ => status
    };

    private static string NormalizeProjectPriority(string? priority) => priority switch
    {
        "Urgent & Important" => "Critical",
        "Not Urgent & Important" => "High",
        "Urgent & Not Important" => "Medium",
        null or "" => "Medium",
        _ => priority
    };

    private static string NormalizeRaci(string? raci) => raci switch
    {
        null or "" => "Responsible",
        "RACI-R" => "Responsible",
        "RACI-A" => "Accountable",
        "RACI-C" => "Consulted",
        "RACI-I" => "Informed",
        _ => raci
    };

    private static bool IsMyTask(StrategicTaskItem task)
    {
        var raci = NormalizeRaci(task.RaciRole);
        return raci is "Responsible" or "Accountable";
    }

    private static string NormalizeEnergy(string? energy) => energy switch
    {
        null or "" => "Low",
        var e when e.Contains("High", StringComparison.OrdinalIgnoreCase) => "High",
        var e when e.Contains("Medium", StringComparison.OrdinalIgnoreCase) => "Medium",
        _ => "Low"
    };

    private static string GetInitials(string text)
    {
        var parts = text.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (parts.Length == 0) return "NA";
        if (parts.Length == 1) return parts[0].Length >= 2 ? parts[0][..2].ToUpperInvariant() : parts[0].ToUpperInvariant();
        return $"{char.ToUpperInvariant(parts[0][0])}{char.ToUpperInvariant(parts[1][0])}";
    }

    private async Task GenerateWorkReviewAsync(string? startDateText, string? endDateText, string? projectId)
    {
        var cfg = App.Config.Load();
        if (string.IsNullOrWhiteSpace(cfg.ApiKey))
        {
            _aiWorkReview = "请先在设置中配置 API Key 与端点，随后即可使用工作回顾。";
            return;
        }

        var endDate = DateTime.TryParse(endDateText, out var parsedEnd) ? parsedEnd.Date : DateTime.Today;
        var startDate = DateTime.TryParse(startDateText, out var parsedStart) ? parsedStart.Date : endDate.AddDays(-6);
        if (startDate > endDate)
            (startDate, endDate) = (endDate, startDate);

        var project = _projects.FirstOrDefault(p => p.Id == (projectId ?? ""));
        var tasks = _strategicTasks
            .Where(t => t.IsDone)
            .Where(t =>
            {
                var completed = (t.CompletedAt ?? t.UpdatedAt).Date;
                if (completed < startDate || completed > endDate)
                    return false;
                if (project != null && !string.Equals(t.ProjectId, project.Id, StringComparison.OrdinalIgnoreCase))
                    return false;
                return true;
            })
            .OrderByDescending(t => t.CompletedAt ?? t.UpdatedAt)
            .Take(50)
            .ToList();

        if (tasks.Count == 0)
        {
            _aiWorkReview = "所选时间范围（或项目）内没有已完成任务，无法生成回顾。请调整筛选条件后重试。";
            return;
        }

        _isAiWorking = true;
        await PushStateToWebAsync();
        try
        {
            var client = new OpenAiApiClient(cfg);
            var prompt = ZenTaskAiService.BuildWorkReviewPrompt(GetUserName(), startDate, endDate, project?.Name, tasks);
            var result = await client.CallAsyncLong(prompt, ZenTaskAiService.WorkReviewSystemPrompt, 2600, 0.35);
            _aiWorkReview = result.Success && !string.IsNullOrWhiteSpace(result.Result)
                ? result.Result.Trim()
                : result.Error ?? "AI 未返回有效回顾结果。";
        }
        finally
        {
            _isAiWorking = false;
        }
    }

    private void SaveWorkReviewMarkdown(string? title, string? content, string? startDateText, string? endDateText, string? projectId)
    {
        var text = content?.Trim() ?? "";
        if (string.IsNullOrWhiteSpace(text))
            return;

        var cfg = App.Config.Load();
        var root = NoteService.ResolveRoot(cfg.NotesRootPath);
        var reviewDir = Path.Combine(root, "Journal", "Reviews");
        Directory.CreateDirectory(reviewDir);

        var endDate = DateTime.TryParse(endDateText, out var parsedEnd) ? parsedEnd.Date : DateTime.Today;
        var startDate = DateTime.TryParse(startDateText, out var parsedStart) ? parsedStart.Date : endDate.AddDays(-6);
        if (startDate > endDate)
            (startDate, endDate) = (endDate, startDate);

        var projectName = _projects.FirstOrDefault(p => p.Id == (projectId ?? ""))?.Name ?? "全部项目";
        var safeProjectName = string.Concat(projectName.Select(ch => Path.GetInvalidFileNameChars().Contains(ch) ? '_' : ch));
        var safeTitle = string.IsNullOrWhiteSpace(title) ? "工作回顾" : string.Concat(title.Trim().Select(ch => Path.GetInvalidFileNameChars().Contains(ch) ? '_' : ch));
        var fileName = $"{DateTime.Now:yyyyMMdd_HHmmss}_{safeTitle}_{safeProjectName}.md";
        var filePath = Path.Combine(reviewDir, fileName);

        var md = new StringBuilder();
        md.AppendLine($"# {safeTitle}");
        md.AppendLine();
        md.AppendLine($"- 生成时间: {DateTime.Now:yyyy-MM-dd HH:mm}");
        md.AppendLine($"- 时间范围: {startDate:yyyy-MM-dd} ~ {endDate:yyyy-MM-dd}");
        md.AppendLine($"- 项目范围: {projectName}");
        md.AppendLine();
        md.AppendLine(text);

        AtomicWriteAllText(filePath, md.ToString());
        _aiWorkReview = $"{text}\n\n---\n已保存到：`{filePath}`";
    }

    private sealed class WebAction
    {
        public string? Type { get; set; }
        public string? Tab { get; set; }
        public string? Value { get; set; }
        public string? Id { get; set; }
        public string? ProjectId { get; set; }
        public bool Enabled { get; set; }
        public string? Text { get; set; }
        public string? Title { get; set; }
        public string? Source { get; set; }
        public string? Level { get; set; }
        public string? Impact { get; set; }
        public string? Urgency { get; set; }
        public string? Raci { get; set; }
        public string? Energy { get; set; }
        public string? Status { get; set; }
        public string? DueDate { get; set; }
        public string? Deadline { get; set; }
        public string? StartDate { get; set; }
        public string? EndDate { get; set; }
        public string? WorkflowStatus { get; set; }
        public string? Notes { get; set; }
        public string? Tags { get; set; }
        public List<ChecklistItem>? Checklist { get; set; }
        public string? Objective { get; set; }
        public string? KeyResult { get; set; }
        public string? Priority { get; set; }
        public bool CompleteChecklist { get; set; }
        public List<string>? Ids { get; set; }
        public List<AiImportItem>? Items { get; set; }
    }

    private sealed class AiImportCandidate
    {
        public string Title { get; set; } = "";
        public string ProjectId { get; set; } = "";
        public string Project { get; set; } = "Unassigned";
        public string Priority { get; set; } = "High";
        public string Energy { get; set; } = "Medium";
        public string Deadline { get; set; } = "";
    }

    private sealed class AiImportItem
    {
        public string? Title { get; set; }
        public string? ProjectId { get; set; }
        public string? Priority { get; set; }
        public string? Energy { get; set; }
        public string? Deadline { get; set; }
    }

    private sealed class TaskStoreEnvelope
    {
        public int SchemaVersion { get; set; } = TaskStoreSchemaVersion;
        public List<StrategicTaskItem> Items { get; set; } = new();
    }

    private sealed class ProjectStoreEnvelope
    {
        public int SchemaVersion { get; set; } = TaskStoreSchemaVersion;
        public List<ProjectItem> Items { get; set; } = new();
    }
}
