using DesktopAssistant.Models;
using DesktopAssistant.Services;
using Xunit;

namespace DanceMonkey.Ui.Tests;

public sealed class TodayDashboardComposerTests
{
    private static readonly DateTime Friday = new(2026, 7, 24);

    [Fact]
    public void Compose_selects_focus_by_overdue_today_priority_then_updated_time()
    {
        var input = Input(
            tasks:
            [
                Task("priority", impact: 5, urgency: 5, updatedAt: At(23, 0)),
                Task("today", dueDate: Day(24), impact: 5, urgency: 5, updatedAt: At(22, 0)),
                Task("overdue-low", dueDate: Day(23), impact: 1, urgency: 1, updatedAt: At(23, 30)),
                Task("overdue-high-old", dueDate: Day(23), impact: 5, urgency: 5, updatedAt: At(7, 0)),
                Task("overdue-high-recent", dueDate: Day(23), impact: 5, urgency: 5, updatedAt: At(8, 0))
            ]);

        var result = TodayDashboardComposer.Compose(input, At(10, 0));

        Assert.Equal("overdue-high-recent", result.FocusTask?.Title);
    }

    [Fact]
    public void Compose_orders_top_six_tasks_by_overdue_today_priority_due_and_updated()
    {
        var input = Input(
            tasks:
            [
                Task("future-old", dueDate: Day(26), impact: 3, urgency: 3, updatedAt: At(7, 0)),
                Task("medium", impact: 4, urgency: 4, updatedAt: At(6, 0)),
                Task("today", dueDate: Day(24), impact: 1, urgency: 1),
                Task("future-recent", dueDate: Day(26), impact: 3, urgency: 3, updatedAt: At(9, 0)),
                Task("overdue", dueDate: Day(23), impact: 1, urgency: 1),
                Task("high", impact: 5, urgency: 5),
                Task("future-near", dueDate: Day(25), impact: 3, urgency: 3, updatedAt: At(8, 0))
            ]);

        var result = TodayDashboardComposer.Compose(input, At(10, 0));

        Assert.Equal(6, result.Tasks.Count);
        Assert.Equal(
            ["overdue", "today", "high", "medium", "future-near", "future-recent"],
            result.Tasks.Select(task => task.Title));
    }

    [Fact]
    public void Compose_excludes_completed_and_cancelled_tasks_from_focus_and_pending_list()
    {
        var input = Input(
            tasks:
            [
                Task("completed", status: "Completed", dueDate: Day(22)),
                Task("done", status: "dOnE", dueDate: Day(22)),
                Task("cancelled", status: "Cancelled", dueDate: Day(22)),
                Task("canceled", status: "CANCELED", dueDate: Day(22)),
                Task("discarded", status: "废弃", dueDate: Day(22)),
                Task("pending", dueDate: Day(25))
            ]);

        var result = TodayDashboardComposer.Compose(input, At(10, 0));

        Assert.Equal("pending", result.FocusTask?.Title);
        Assert.Equal(["pending"], result.Tasks.Select(task => task.Title));
    }

    [Fact]
    public void Compose_counts_tasks_related_to_monday_sunday_week_by_all_supported_dates()
    {
        var beforeWeek = Day(19);
        var input = Input(
            tasks:
            [
                Task("created", createdAt: Day(20), updatedAt: beforeWeek),
                Task("updated-complete", status: "Done", createdAt: beforeWeek, updatedAt: Day(21)),
                Task("due", dueDate: Day(26), createdAt: beforeWeek, updatedAt: beforeWeek),
                Task("completed-at", status: "Completed", createdAt: beforeWeek, updatedAt: beforeWeek, completedAt: Day(24)),
                Task("outside", dueDate: Day(27), createdAt: beforeWeek, updatedAt: beforeWeek)
            ]);

        var result = TodayDashboardComposer.Compose(input, At(10, 0));

        Assert.Equal(2, result.WeeklyCompletedCount);
        Assert.Equal(4, result.WeeklyTotalCount);
        Assert.Equal(50, result.WeeklyProgressPercent);
    }

    [Fact]
    public void Compose_returns_zero_weekly_progress_when_no_tasks_are_related_to_week()
    {
        var result = TodayDashboardComposer.Compose(Input(), At(10, 0));

        Assert.Equal(0, result.WeeklyProgressPercent);
        Assert.Equal(0, result.WeeklyCompletedCount);
        Assert.Equal(0, result.WeeklyTotalCount);
    }

    [Fact]
    public void Compose_merges_today_meetings_reminders_and_started_tasks_in_clock_order()
    {
        var input = Input(
            tasks:
            [
                Task("scheduled task", startDate: At(13, 30)),
                Task("finished task", status: "Completed", startDate: At(14, 0))
            ],
            meetings:
            [
                Meeting("meeting", At(9, 30)),
                Meeting("cancelled meeting", At(9, 0), MeetingStatus.Cancelled),
                Meeting("tomorrow meeting", Day(25).AddHours(8))
            ],
            reminders:
            [
                Reminder("reminder", ReminderRepeatKind.Daily, times: ["10:00"])
            ]);

        var result = TodayDashboardComposer.Compose(input, At(8, 0));

        Assert.Equal(
            ["09:30|Meeting|meeting", "10:00|Reminder|reminder", "13:30|Task|scheduled task"],
            result.Timeline.Select(item => $"{item.Time:HH:mm}|{item.Source}|{item.Title}"));
    }

    [Fact]
    public void Compose_keeps_stable_reminder_id_separate_from_occurrence_key()
    {
        var result = TodayDashboardComposer.Compose(
            Input(reminders: [Reminder("hydration", ReminderRepeatKind.Daily, times: ["09:00", "14:30"])]),
            At(8, 0));

        Assert.Equal(["hydration", "hydration"], result.Timeline.Select(item => item.Id));
        Assert.Equal(
            ["hydration@202607240900", "hydration@202607241430"],
            result.Timeline.Select(item => item.OccurrenceKey));
    }

    [Fact]
    public void Compose_expands_only_stable_reminder_occurrences_valid_for_today()
    {
        var input = Input(
            reminders:
            [
                Reminder("daily", ReminderRepeatKind.Daily, times: ["08:00", "bad", "18:30"]),
                Reminder("weekly-selected", ReminderRepeatKind.Weekly, times: ["09:00"], weekdays: ReminderScheduleHelper.WeekdayFri),
                Reminder("weekly-other", ReminderRepeatKind.Weekly, times: ["09:15"], weekdays: ReminderScheduleHelper.WeekdayThu),
                Reminder("monthly-selected", ReminderRepeatKind.Monthly, times: ["10:00"], dayOfMonth: 24),
                Reminder("monthly-other", ReminderRepeatKind.Monthly, times: ["10:15"], dayOfMonth: 23),
                Reminder("once-today", ReminderRepeatKind.Once, onceAt: At(11, 0)),
                Reminder("once-tomorrow", ReminderRepeatKind.Once, onceAt: Day(25).AddHours(11)),
                Reminder("interval", ReminderRepeatKind.IntervalMinutes, times: ["12:00"]),
                Reminder("active-use", ReminderRepeatKind.ActiveUseInterval, times: ["12:30"]),
                Reminder("disabled", ReminderRepeatKind.Daily, times: ["13:00"], enabled: false)
            ]);

        var result = TodayDashboardComposer.Compose(input, At(7, 0));

        Assert.Equal(
            ["08:00|daily", "09:00|weekly-selected", "10:00|monthly-selected", "11:00|once-today", "18:30|daily"],
            result.Timeline.Select(item => $"{item.Time:HH:mm}|{item.Title}"));
    }

    [Fact]
    public void Compose_ignores_reminders_with_null_schedules_without_throwing()
    {
        var reminder = new ReminderDefinition
        {
            Id = "null-schedule",
            Title = "null-schedule",
            Schedule = null!
        };

        var result = TodayDashboardComposer.Compose(Input(reminders: [reminder]), At(7, 0));

        Assert.Empty(result.Timeline);
    }

    [Fact]
    public void Compose_ignores_null_and_malformed_times_but_keeps_valid_occurrences()
    {
        var input = Input(
            reminders:
            [
                Reminder("mixed-times", ReminderRepeatKind.Daily, times: [null!, "bad", "14:00"])
            ]);

        var result = TodayDashboardComposer.Compose(input, At(7, 0));

        Assert.Equal(["14:00|mixed-times"], result.Timeline.Select(item => $"{item.Time:HH:mm}|{item.Title}"));
    }

    [Fact]
    public void Compose_uses_scheduler_defaults_for_daily_and_weekly_reminders()
    {
        var input = Input(
            reminders:
            [
                Reminder("daily-default", ReminderRepeatKind.Daily),
                Reminder("weekly-default", ReminderRepeatKind.Weekly)
            ]);

        var result = TodayDashboardComposer.Compose(input, At(7, 0));

        Assert.Equal(
            ["09:00|daily-default", "09:00|weekly-default"],
            result.Timeline.Select(item => $"{item.Time:HH:mm}|{item.Title}"));
    }

    [Fact]
    public void Compose_uses_day_one_for_monthly_reminders_without_a_configured_day()
    {
        var input = Input(
            reminders:
            [
                Reminder("monthly-default", ReminderRepeatKind.Monthly)
            ]);

        var result = TodayDashboardComposer.Compose(input, Day(1).AddHours(7));

        Assert.Equal(["09:00|monthly-default"], result.Timeline.Select(item => $"{item.Time:HH:mm}|{item.Title}"));
    }

    [Theory]
    [InlineData(1, -10)]
    [InlineData(31, 99)]
    public void Compose_clamps_monthly_reminder_day_to_valid_range(int today, int configuredDay)
    {
        var input = Input(
            reminders:
            [
                Reminder(
                    $"monthly-{configuredDay}",
                    ReminderRepeatKind.Monthly,
                    times: ["10:00"],
                    dayOfMonth: configuredDay)
            ]);

        var result = TodayDashboardComposer.Compose(input, Day(today).AddHours(7));

        Assert.Single(result.Timeline);
        Assert.Equal(10, result.Timeline[0].Time.Hour);
    }

    [Fact]
    public void Compose_breaks_equal_task_sort_keys_by_ordinal_id_independent_of_input_order()
    {
        var taskA = Task("task A", id: "a");
        var taskZ = Task("task Z", id: "z");

        var forward = TodayDashboardComposer.Compose(Input(tasks: [taskZ, taskA]), At(10, 0));
        var reverse = TodayDashboardComposer.Compose(Input(tasks: [taskA, taskZ]), At(10, 0));

        Assert.Equal("a", forward.FocusTask?.Id);
        Assert.Equal(["a", "z"], forward.Tasks.Select(task => task.Id));
        Assert.Equal(forward.FocusTask, reverse.FocusTask);
        Assert.Equal(forward.Tasks, reverse.Tasks);
    }

    [Fact]
    public void Compose_breaks_equal_note_times_by_ordinal_full_path_independent_of_input_order()
    {
        var timestamp = At(9, 0);
        var noteA = new TodayNoteDocument(@"C:\notes\a.md", timestamp, "A");
        var noteB = new TodayNoteDocument(@"C:\notes\b.md", timestamp, "B");
        var noteC = new TodayNoteDocument(@"C:\notes\c.md", timestamp, "C");

        var forward = TodayDashboardComposer.Compose(Input(notes: [noteC, noteB, noteA]), At(10, 0));
        var reverse = TodayDashboardComposer.Compose(Input(notes: [noteA, noteB, noteC]), At(10, 0));

        Assert.Equal([noteA.FullPath, noteB.FullPath], forward.RecentNotes.Select(note => note.FullPath));
        Assert.Equal(forward.RecentNotes, reverse.RecentNotes);
    }

    [Fact]
    public void Compose_selects_two_recent_notes_and_derives_titles_and_plain_summaries()
    {
        var longText = string.Concat(Enumerable.Repeat("内容", 40));
        var input = Input(
            notes:
            [
                new TodayNoteDocument(@"C:\notes\old.md", At(6, 0), "# Old\nIgnored"),
                new TodayNoteDocument(
                    @"C:\notes\fallback-name.md",
                    At(8, 0),
                    "\n\n**Bold** and [link](https://example.test)\ncontinued paragraph\n\nignored paragraph\n"),
                new TodayNoteDocument(@"C:\notes\latest.md", At(9, 0), $"# Latest title\n\n- **{longText}**\n"),
                new TodayNoteDocument(@"C:\notes\middle.md", At(7, 0), "# Middle\nIgnored")
            ]);

        var result = TodayDashboardComposer.Compose(input, At(10, 0));

        Assert.Equal(
            [@"C:\notes\latest.md", @"C:\notes\fallback-name.md"],
            result.RecentNotes.Select(note => note.FullPath));
        Assert.Equal("Latest title", result.RecentNotes[0].Title);
        Assert.DoesNotContain("#", result.RecentNotes[0].Summary);
        Assert.DoesNotContain("*", result.RecentNotes[0].Summary);
        Assert.Equal(72, result.RecentNotes[0].Summary.Length);
        Assert.EndsWith("…", result.RecentNotes[0].Summary);
        Assert.Equal("fallback-name", result.RecentNotes[1].Title);
        Assert.Equal("Bold and link continued paragraph", result.RecentNotes[1].Summary);
    }

    [Fact]
    public void Compose_builds_deterministic_local_digest_and_chinese_date_label()
    {
        var input = Input(
            tasks:
            [
                Task("overdue focus", dueDate: Day(23)),
                Task("due today", dueDate: Day(24))
            ],
            meetings:
            [
                Meeting("first meeting", At(9, 30)),
                Meeting("second meeting", At(15, 0))
            ]);

        var result = TodayDashboardComposer.Compose(input, At(8, 0));

        Assert.Equal("今天，7月24日 星期五", result.DateLabel);
        Assert.Equal("本地今日摘要", result.Digest.Title);
        Assert.Contains("2 场会议", result.Digest.Body);
        Assert.Contains("1 项今天到期", result.Digest.Body);
        Assert.Contains("1 项已逾期", result.Digest.Body);
        Assert.Contains("09:30 first meeting", result.Digest.Body);
        Assert.Contains("overdue focus", result.Digest.Body);
    }

    [Fact]
    public void Compose_preserves_source_errors()
    {
        TodaySourceError[] errors =
        [
            new("Tasks", "task file unavailable"),
            new("Notes", "note root unavailable")
        ];

        var result = TodayDashboardComposer.Compose(Input(errors: errors), At(10, 0));

        Assert.Equal(errors, result.SourceErrors);
    }

    [Fact]
    public void Compose_maps_energy_and_safe_trimmed_notes_metadata()
    {
        var notes = "  **Deep work**   " + new string('x', 100);
        var input = Input(
            tasks:
            [
                Task(
                    "metadata",
                    dueDate: Day(24),
                    energy: "High",
                    notes: notes)
            ]);

        var result = TodayDashboardComposer.Compose(input, At(10, 0));
        var task = Assert.Single(result.Tasks);

        Assert.Equal("High", task.EnergyLevel);
        Assert.Equal("高能量", task.EnergyLabel);
        Assert.DoesNotContain("*", task.NotesSummary);
        Assert.StartsWith("Deep work", task.NotesSummary);
        Assert.EndsWith("…", task.NotesSummary);
        Assert.Equal("今天到期", task.DueLabel);
    }

    [Fact]
    public void Compose_normalizes_null_and_whitespace_energy_without_losing_other_dashboard_items()
    {
        var input = Input(
            tasks:
            [
                Task("null-energy", energy: null!),
                Task("whitespace-energy", energy: "   "),
                Task("high-energy", energy: "High")
            ],
            meetings:
            [
                Meeting("standup", At(11, 0))
            ]);

        var result = TodayDashboardComposer.Compose(input, At(10, 0));

        var nullEnergy = Assert.Single(result.Tasks, task => task.Title == "null-energy");
        Assert.Equal("Medium", nullEnergy.EnergyLevel);
        Assert.Equal("中等能量", nullEnergy.EnergyLabel);
        var whitespaceEnergy = Assert.Single(
            result.Tasks,
            task => task.Title == "whitespace-energy");
        Assert.Equal("Medium", whitespaceEnergy.EnergyLevel);
        Assert.Equal("中等能量", whitespaceEnergy.EnergyLabel);
        Assert.Contains(result.Tasks, task => task.Title == "high-energy");
        Assert.Contains(
            result.Timeline,
            item => item.Title == "standup" && item.Source == TodayTimelineSource.Meeting);
    }

    private static TodayDashboardInput Input(
        IReadOnlyList<ZenTaskRecord>? tasks = null,
        IReadOnlyList<MeetingRecord>? meetings = null,
        IReadOnlyList<ReminderDefinition>? reminders = null,
        IReadOnlyList<TodayNoteDocument>? notes = null,
        IReadOnlyList<TodaySourceError>? errors = null) =>
        new(
            tasks ?? Array.Empty<ZenTaskRecord>(),
            meetings ?? Array.Empty<MeetingRecord>(),
            reminders ?? Array.Empty<ReminderDefinition>(),
            notes ?? Array.Empty<TodayNoteDocument>(),
            errors ?? Array.Empty<TodaySourceError>());

    private static ZenTaskRecord Task(
        string title,
        string? id = null,
        string status = "Todo",
        DateTime? dueDate = null,
        DateTime? startDate = null,
        int impact = 3,
        int urgency = 3,
        DateTime? createdAt = null,
        DateTime? updatedAt = null,
        DateTime? completedAt = null,
        string energy = "Medium",
        string notes = "") =>
        new()
        {
            Id = id ?? title,
            Title = title,
            Project = "Dashboard",
            WorkflowStatus = status,
            DueDate = dueDate,
            StartDate = startDate,
            Impact = impact,
            Urgency = urgency,
            EnergyLevel = energy,
            Notes = notes,
            CreatedAt = createdAt ?? Day(1),
            UpdatedAt = updatedAt ?? Day(1),
            CompletedAt = completedAt
        };

    private static MeetingRecord Meeting(string title, DateTime start, string status = MeetingStatus.Planned) =>
        new()
        {
            Id = title,
            Title = title,
            StartTime = start,
            Status = status
        };

    private static ReminderDefinition Reminder(
        string title,
        ReminderRepeatKind kind,
        IReadOnlyList<string>? times = null,
        int? weekdays = null,
        int? dayOfMonth = null,
        DateTime? onceAt = null,
        bool enabled = true) =>
        new()
        {
            Id = title,
            Title = title,
            Enabled = enabled,
            Schedule = new ReminderSchedule
            {
                Kind = kind,
                Times = times?.ToList(),
                Weekdays = weekdays,
                DayOfMonth = dayOfMonth,
                OnceAt = onceAt
            }
        };

    private static DateTime At(int hour, int minute) => Friday.AddHours(hour).AddMinutes(minute);

    private static DateTime Day(int day) => new(2026, 7, day);
}
