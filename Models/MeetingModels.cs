namespace DesktopAssistant.Models;

/// <summary>会议中心：参会人。</summary>
public sealed class MeetingAttendee
{
    public string Name { get; set; } = "";
    public string Role { get; set; } = "";
}

/// <summary>会议中心：行动项（可同步到 ZenTask）。</summary>
public sealed class MeetingActionItem
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Task { get; set; } = "";
    public string Owner { get; set; } = "";
    public DateTime? DueDate { get; set; }
    public bool Done { get; set; }

    /// <summary>是否已写入待办（ZenTask），避免重复同步。</summary>
    public bool SyncedToTodo { get; set; }
}

/// <summary>会议中心：单场会议记录。</summary>
public sealed class MeetingRecord
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Title { get; set; } = "";
    public string ProjectId { get; set; } = "";
    public string SeriesId { get; set; } = "";
    public string TemplateId { get; set; } = "";

    public DateTime StartTime { get; set; } = DateTime.Now;
    public DateTime? EndTime { get; set; }
    public int DurationSeconds { get; set; }

    /// <summary>Planned | InProgress | Completed | Cancelled。</summary>
    public string Status { get; set; } = MeetingStatus.Completed;

    public List<MeetingAttendee> Attendees { get; set; } = new();
    public List<string> AgendaItems { get; set; } = new();

    /// <summary>会上手记（与转写并行的人工速记）。</summary>
    public string QuickNotes { get; set; } = "";

    /// <summary>AI 生成的纪要（Markdown）。</summary>
    public string SummaryMarkdown { get; set; } = "";

    public List<string> Decisions { get; set; } = new();
    public List<MeetingActionItem> ActionItems { get; set; } = new();
    public List<string> Tags { get; set; } = new();

    /// <summary>导出的 Markdown 全文路径（人类可读副本）。</summary>
    public string MarkdownPath { get; set; } = "";

    public DateTime CreatedAt { get; set; } = DateTime.Now;
    public DateTime UpdatedAt { get; set; } = DateTime.Now;
}

/// <summary>会议状态常量。</summary>
public static class MeetingStatus
{
    public const string Planned = "Planned";
    public const string InProgress = "InProgress";
    public const string Completed = "Completed";
    public const string Cancelled = "Cancelled";
    public const string Archived = "Archived";
}

/// <summary>会议中心：项目（关联与统计维度）。</summary>
public sealed class MeetingProject
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Name { get; set; } = "";
    public string Color { get; set; } = "#4F6EF7";
    public string Status { get; set; } = "Active";
    public string Owner { get; set; } = "";
    public string Description { get; set; } = "";
    public DateTime CreatedAt { get; set; } = DateTime.Now;
}

/// <summary>会议中心：模板，每类会议预填议程与专属 AI 纪要 prompt。</summary>
public sealed class MeetingTemplate
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Name { get; set; } = "";
    public string Icon { get; set; } = "📝";
    public string Category { get; set; } = "";
    public int DefaultDurationMinutes { get; set; } = 30;
    public List<string> AgendaTemplate { get; set; } = new();

    /// <summary>结构化分区（如 进展 / 风险 / 决策 / 行动项）。</summary>
    public List<string> StructuredSections { get; set; } = new();

    /// <summary>该类会议专属的 AI 纪要 system prompt（留空用默认）。</summary>
    public string SummaryPromptOverride { get; set; } = "";

    public List<string> DefaultTags { get; set; } = new();
    public bool BuiltIn { get; set; }
}

/// <summary>重复规则类型。</summary>
public static class RecurrenceType
{
    public const string Daily = "Daily";
    public const string Weekly = "Weekly";
    public const string BiWeekly = "BiWeekly";
    public const string Monthly = "Monthly";
    public const string Weekday = "Weekday";
}

/// <summary>会议中心：重复规则。</summary>
public sealed class MeetingRecurrence
{
    public string Type { get; set; } = RecurrenceType.Weekly;
    public int Interval { get; set; } = 1;

    /// <summary>Weekly/BiWeekly 适用：0=周日 .. 6=周六。</summary>
    public List<int> DaysOfWeek { get; set; } = new();

    /// <summary>Monthly 适用：每月第几天（1-31）。</summary>
    public int DayOfMonth { get; set; } = 1;

    /// <summary>会议时间（当天的 时:分）。</summary>
    public int Hour { get; set; } = 10;
    public int Minute { get; set; }

    public int DurationMinutes { get; set; } = 30;
}

/// <summary>会议中心：重复性会议系列（周会/例会）。</summary>
public sealed class MeetingSeries
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Name { get; set; } = "";
    public string ProjectId { get; set; } = "";
    public string TemplateId { get; set; } = "";
    public MeetingRecurrence Recurrence { get; set; } = new();
    public List<MeetingAttendee> DefaultAttendees { get; set; } = new();
    public List<string> DefaultAgenda { get; set; } = new();
    public int ReminderMinutesBefore { get; set; } = 10;
    public bool Active { get; set; } = true;
    public DateTime CreatedAt { get; set; } = DateTime.Now;
}