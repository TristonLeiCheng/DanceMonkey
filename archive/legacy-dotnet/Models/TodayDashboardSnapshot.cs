using DesktopAssistant.Services;

namespace DesktopAssistant.Models;

public sealed record TodayDashboardInput(
    IReadOnlyList<ZenTaskRecord> Tasks,
    IReadOnlyList<MeetingRecord> Meetings,
    IReadOnlyList<ReminderDefinition> Reminders,
    IReadOnlyList<TodayNoteDocument> Notes,
    IReadOnlyList<TodaySourceError> SourceErrors);

public sealed record TodayDashboardSnapshot(
    DateTime GeneratedAt,
    string DateLabel,
    TodayTaskItem? FocusTask,
    int WeeklyCompletedCount,
    int WeeklyTotalCount,
    int WeeklyProgressPercent,
    IReadOnlyList<TodayTimelineItem> Timeline,
    IReadOnlyList<TodayTaskItem> Tasks,
    TodayDigest Digest,
    IReadOnlyList<TodayRecentNote> RecentNotes,
    IReadOnlyList<TodaySourceError> SourceErrors);

public sealed record TodayTaskItem(
    string Id,
    string Title,
    string Project,
    string PriorityLabel,
    string EnergyLevel,
    string EnergyLabel,
    string NotesSummary,
    DateTime? DueDate,
    DateTime? StartDate,
    bool IsOverdue,
    bool IsDueToday,
    bool IsCompleted)
{
    public string DueLabel =>
        IsOverdue
            ? $"已逾期 · {DueDate:MM-dd}"
            : IsDueToday
                ? "今天到期"
                : DueDate.HasValue
                    ? $"{DueDate:MM-dd} 到期"
                    : "未设置截止日期";
}

public sealed record TodayTimelineItem(
    string Id,
    string OccurrenceKey,
    DateTime Time,
    string Title,
    TodayTimelineSource Source)
{
    public string SourceLabel => Source switch
    {
        TodayTimelineSource.Meeting => "会议",
        TodayTimelineSource.Reminder => "提醒",
        _ => "任务"
    };
}

public enum TodayTimelineSource
{
    Meeting,
    Reminder,
    Task
}

public sealed record TodayNoteDocument(
    string FullPath,
    DateTime LastWriteTime,
    string Markdown);

public sealed record TodayRecentNote(
    string FullPath,
    string Title,
    string Summary,
    DateTime LastWriteTime);

public sealed record TodayDigest(
    string Title,
    string Subtitle,
    string Body,
    string ActionLabel);

public sealed record TodaySourceError(string Source, string Message);

public sealed record FocusSession
{
    private FocusSession(TimeSpan duration, TimeSpan remaining, bool isRunning)
    {
        Duration = duration;
        Remaining = remaining;
        IsRunning = isRunning;
    }

    public TimeSpan Duration { get; }

    public TimeSpan Remaining { get; }

    public bool IsRunning { get; }

    public string DisplayTime =>
        $"{(int)Remaining.TotalMinutes:00}:{Remaining.Seconds:00}";

    public double ProgressPercent =>
        Duration <= TimeSpan.Zero
            ? 0
            : Math.Clamp(Remaining.TotalMilliseconds / Duration.TotalMilliseconds * 100, 0, 100);

    public static FocusSession Create(TimeSpan duration)
    {
        if (duration <= TimeSpan.Zero)
            throw new ArgumentOutOfRangeException(nameof(duration), "Focus duration must be positive.");

        return new FocusSession(duration, duration, false);
    }

    public FocusSession Start() =>
        Remaining <= TimeSpan.Zero
            ? new FocusSession(Duration, Duration, true)
            : new FocusSession(Duration, Remaining, true);

    public FocusSession Pause() =>
        IsRunning
            ? new FocusSession(Duration, Remaining, false)
            : this;

    public FocusSession Reset() =>
        new(Duration, Duration, false);

    public FocusSession Tick(TimeSpan elapsed)
    {
        if (!IsRunning || elapsed <= TimeSpan.Zero)
            return this;

        var remaining = Remaining - elapsed;
        if (remaining <= TimeSpan.Zero)
            return new FocusSession(Duration, TimeSpan.Zero, false);

        return new FocusSession(Duration, remaining, true);
    }
}
