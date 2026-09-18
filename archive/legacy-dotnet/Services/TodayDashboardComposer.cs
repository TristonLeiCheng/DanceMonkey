using System.Globalization;
using System.Text.RegularExpressions;
using DesktopAssistant.Models;

namespace DesktopAssistant.Services;

public static partial class TodayDashboardComposer
{
    private const int RecentNoteLimit = 2;
    private const int NoteSummaryDisplayLimit = 72;

    public static TodayDashboardSnapshot Compose(TodayDashboardInput input, DateTime now)
    {
        ArgumentNullException.ThrowIfNull(input);

        var pendingTasks = input.Tasks
            .Where(task => !IsCompleted(task) && !IsCancelled(task.WorkflowStatus))
            .ToArray();

        var focusTask = pendingTasks
            .OrderByDescending(task => IsOverdue(task, now))
            .ThenByDescending(task => IsDueToday(task, now))
            .ThenByDescending(PriorityScore)
            .ThenByDescending(task => task.UpdatedAt)
            .ThenBy(task => task.Id, StringComparer.Ordinal)
            .Select(task => ToTaskItem(task, now))
            .FirstOrDefault();

        var taskItems = pendingTasks
            .OrderByDescending(task => IsOverdue(task, now))
            .ThenByDescending(task => IsDueToday(task, now))
            .ThenByDescending(PriorityScore)
            .ThenBy(task => task.DueDate ?? DateTime.MaxValue)
            .ThenByDescending(task => task.UpdatedAt)
            .ThenBy(task => task.Id, StringComparer.Ordinal)
            .Take(6)
            .Select(task => ToTaskItem(task, now))
            .ToArray();

        var (weekStart, nextWeekStart) = GetWeekBounds(now);
        var weeklyTasks = input.Tasks
            .Where(task => IsRelatedToWeek(task, weekStart, nextWeekStart))
            .ToArray();
        var weeklyCompletedCount = weeklyTasks.Count(IsCompleted);
        var weeklyProgressPercent = weeklyTasks.Length == 0
            ? 0
            : (int)Math.Round(
                weeklyCompletedCount * 100d / weeklyTasks.Length,
                MidpointRounding.AwayFromZero);

        var timeline = BuildTimeline(input, now);
        var recentNotes = input.Notes
            .OrderByDescending(note => note.LastWriteTime)
            .ThenBy(note => note.FullPath, StringComparer.Ordinal)
            .Take(RecentNoteLimit)
            .Select(ToRecentNote)
            .ToArray();
        var digest = BuildDigest(input.Meetings, pendingTasks, timeline, focusTask, now);

        return new TodayDashboardSnapshot(
            now,
            FormatDateLabel(now),
            focusTask,
            weeklyCompletedCount,
            weeklyTasks.Length,
            weeklyProgressPercent,
            timeline,
            taskItems,
            digest,
            recentNotes,
            input.SourceErrors.Count == 0 ? Array.Empty<TodaySourceError>() : input.SourceErrors.ToArray());
    }

    private static TodayTimelineItem[] BuildTimeline(TodayDashboardInput input, DateTime now)
    {
        var items = new List<TodayTimelineItem>();

        items.AddRange(input.Meetings
            .Where(meeting =>
                IsToday(meeting.StartTime, now)
                && !IsCancelled(meeting.Status)
                && !string.Equals(meeting.Status, MeetingStatus.Archived, StringComparison.OrdinalIgnoreCase))
            .Select(meeting => new TodayTimelineItem(
                meeting.Id,
                meeting.Id,
                meeting.StartTime,
                meeting.Title,
                TodayTimelineSource.Meeting)));

        foreach (var reminder in input.Reminders.Where(reminder => reminder.Enabled))
        {
            foreach (var occurrence in GetReminderOccurrences(reminder, now))
            {
                items.Add(new TodayTimelineItem(
                    reminder.Id,
                    $"{reminder.Id}@{occurrence:yyyyMMddHHmm}",
                    occurrence,
                    reminder.Title,
                    TodayTimelineSource.Reminder));
            }
        }

        items.AddRange(input.Tasks
            .Where(task =>
                task.StartDate.HasValue
                && IsToday(task.StartDate.Value, now)
                && !IsCompleted(task)
                && !IsCancelled(task.WorkflowStatus))
            .Select(task => new TodayTimelineItem(
                task.Id,
                task.Id,
                task.StartDate!.Value,
                task.Title,
                TodayTimelineSource.Task)));

        return items
            .OrderBy(item => item.Time)
            .ThenBy(item => item.Source)
            .ThenBy(item => item.Id, StringComparer.Ordinal)
            .ToArray();
    }

    private static IEnumerable<DateTime> GetReminderOccurrences(ReminderDefinition reminder, DateTime now)
    {
        var schedule = reminder.Schedule;
        if (schedule is null)
            return Array.Empty<DateTime>();

        switch (schedule.Kind)
        {
            case ReminderRepeatKind.Daily:
                return GetValidTimes(schedule.Times)
                    .Select(time => now.Date + time);

            case ReminderRepeatKind.Weekly:
                if (!ReminderScheduleHelper.IsWeekdaySelected(
                        schedule.Weekdays ?? ReminderScheduleHelper.WeekdayMonFri,
                        now.DayOfWeek))
                    return Array.Empty<DateTime>();
                return GetValidTimes(schedule.Times)
                    .Take(1)
                    .Select(time => now.Date + time);

            case ReminderRepeatKind.Monthly:
                var dayOfMonth = Math.Clamp(schedule.DayOfMonth ?? 1, 1, 31);
                if (dayOfMonth != now.Day)
                    return Array.Empty<DateTime>();
                return GetValidTimes(schedule.Times)
                    .Take(1)
                    .Select(time => now.Date + time);

            case ReminderRepeatKind.Once:
                return schedule.OnceAt is { } onceAt && IsToday(onceAt, now)
                    ? [onceAt]
                    : Array.Empty<DateTime>();

            default:
                return Array.Empty<DateTime>();
        }
    }

    private static IEnumerable<TimeSpan> GetValidTimes(IReadOnlyList<string>? configuredTimes)
    {
        var validTimes = configuredTimes?
            .Where(time => !string.IsNullOrWhiteSpace(time))
            .Select(time => ReminderScheduleHelper.NormalizeTime(time))
            .Where(time => time is not null)
            .Distinct(StringComparer.Ordinal)
            .Select(time => TimeSpan.ParseExact(time!, @"hh\:mm", CultureInfo.InvariantCulture))
            .ToArray()
            ?? Array.Empty<TimeSpan>();

        return validTimes.Length == 0 ? [TimeSpan.FromHours(9)] : validTimes;
    }

    private static TodayRecentNote ToRecentNote(TodayNoteDocument note)
    {
        var normalized = (note.Markdown ?? string.Empty).Replace("\r\n", "\n").Replace('\r', '\n');
        var lines = normalized.Split('\n');
        var title = lines
            .Select(line => H1Regex().Match(line))
            .FirstOrDefault(match => match.Success)?
            .Groups[1]
            .Value
            .Trim();

        if (string.IsNullOrWhiteSpace(title))
            title = Path.GetFileNameWithoutExtension(note.FullPath);

        var summaryParts = new List<string>();
        foreach (var line in lines)
        {
            if (H1Regex().IsMatch(line))
            {
                if (summaryParts.Count > 0)
                    break;
                continue;
            }

            var plainLine = StripBasicMarkdown(line);
            if (string.IsNullOrWhiteSpace(plainLine))
            {
                if (summaryParts.Count > 0)
                    break;
                continue;
            }

            summaryParts.Add(plainLine);
        }
        var summary = string.Join(" ", summaryParts);

        return new TodayRecentNote(
            note.FullPath,
            title,
            TruncateDisplayText(summary, NoteSummaryDisplayLimit),
            note.LastWriteTime);
    }

    private static string StripBasicMarkdown(string markdown)
    {
        var text = ImageRegex().Replace(markdown, "$1");
        text = LinkRegex().Replace(text, "$1");
        text = HeadingRegex().Replace(text, string.Empty);
        text = ListMarkerRegex().Replace(text, string.Empty);
        text = BlockQuoteRegex().Replace(text, string.Empty);
        text = MarkdownMarkerRegex().Replace(text, string.Empty);
        return WhitespaceRegex().Replace(text, " ").Trim();
    }

    private static string TruncateDisplayText(string text, int displayLimit)
    {
        var elements = StringInfo.GetTextElementEnumerator(text);
        var boundaries = new List<int>();
        while (elements.MoveNext())
            boundaries.Add(elements.ElementIndex);

        if (boundaries.Count <= displayLimit)
            return text;

        var contentLength = boundaries[displayLimit - 1];
        return text[..contentLength].TrimEnd() + "…";
    }

    private static TodayDigest BuildDigest(
        IReadOnlyList<MeetingRecord> meetings,
        IReadOnlyList<ZenTaskRecord> pendingTasks,
        IReadOnlyList<TodayTimelineItem> timeline,
        TodayTaskItem? focusTask,
        DateTime now)
    {
        var meetingCount = meetings.Count(meeting =>
            IsToday(meeting.StartTime, now)
            && !IsCancelled(meeting.Status)
            && !string.Equals(meeting.Status, MeetingStatus.Archived, StringComparison.OrdinalIgnoreCase));
        var dueTodayCount = pendingTasks.Count(task => IsDueToday(task, now));
        var overdueCount = pendingTasks.Count(task => IsOverdue(task, now));
        var nextItem = timeline.FirstOrDefault(item => item.Time >= now);

        var nextText = nextItem is null
            ? "今天没有后续安排"
            : $"下一项是 {nextItem.Time:HH:mm} {nextItem.Title}";
        var focusText = focusTask is null
            ? "当前没有待处理任务"
            : $"建议优先处理 {focusTask.Title}";

        return new TodayDigest(
            "本地今日摘要",
            "根据本地任务与日程生成",
            $"今天有 {meetingCount} 场会议，{dueTodayCount} 项今天到期，{overdueCount} 项已逾期。{nextText}。{focusText}。",
            "与 AI 对话");
    }

    private static TodayTaskItem ToTaskItem(ZenTaskRecord task, DateTime now)
    {
        var energyLevel = string.IsNullOrWhiteSpace(task.EnergyLevel)
            ? "Medium"
            : task.EnergyLevel.Trim();
        var energyLabel = string.Equals(
            energyLevel,
            "High",
            StringComparison.OrdinalIgnoreCase)
                ? "高能量"
                : string.Equals(
                    energyLevel,
                    "Low",
                    StringComparison.OrdinalIgnoreCase)
                    ? "低能量"
                    : "中等能量";

        return new TodayTaskItem(
            task.Id,
            task.Title,
            task.Project,
            ZenTaskStore.GetPriorityLabel(task.Impact, task.Urgency),
            energyLevel,
            energyLabel,
            TruncateDisplayText(StripBasicMarkdown(task.Notes ?? string.Empty), NoteSummaryDisplayLimit),
            task.DueDate,
            task.StartDate,
            IsOverdue(task, now),
            IsDueToday(task, now),
            IsCompleted(task));
    }

    private static bool IsRelatedToWeek(ZenTaskRecord task, DateTime weekStart, DateTime nextWeekStart) =>
        IsWithin(task.CreatedAt, weekStart, nextWeekStart)
        || IsWithin(task.UpdatedAt, weekStart, nextWeekStart)
        || IsWithin(task.DueDate, weekStart, nextWeekStart)
        || IsWithin(task.CompletedAt, weekStart, nextWeekStart);

    private static bool IsWithin(DateTime? value, DateTime start, DateTime end) =>
        value.HasValue && value.Value >= start && value.Value < end;

    private static (DateTime Start, DateTime End) GetWeekBounds(DateTime now)
    {
        var daysSinceMonday = ((int)now.DayOfWeek + 6) % 7;
        var start = now.Date.AddDays(-daysSinceMonday);
        return (start, start.AddDays(7));
    }

    private static bool IsCompleted(ZenTaskRecord task) =>
        string.Equals(task.WorkflowStatus, "Completed", StringComparison.OrdinalIgnoreCase)
        || string.Equals(task.WorkflowStatus, "Done", StringComparison.OrdinalIgnoreCase);

    private static bool IsCancelled(string? status) =>
        string.Equals(status, "Cancelled", StringComparison.OrdinalIgnoreCase)
        || string.Equals(status, "Canceled", StringComparison.OrdinalIgnoreCase)
        || string.Equals(status, "废弃", StringComparison.OrdinalIgnoreCase);

    private static bool IsOverdue(ZenTaskRecord task, DateTime now) =>
        task.DueDate.HasValue && task.DueDate.Value.Date < now.Date;

    private static bool IsDueToday(ZenTaskRecord task, DateTime now) =>
        task.DueDate.HasValue && task.DueDate.Value.Date == now.Date;

    private static bool IsToday(DateTime value, DateTime now) => value.Date == now.Date;

    private static int PriorityScore(ZenTaskRecord task) => task.Impact + task.Urgency;

    private static string FormatDateLabel(DateTime now) =>
        $"今天，{now.Month}月{now.Day}日 {GetChineseWeekday(now.DayOfWeek)}";

    private static string GetChineseWeekday(DayOfWeek dayOfWeek) => dayOfWeek switch
    {
        DayOfWeek.Monday => "星期一",
        DayOfWeek.Tuesday => "星期二",
        DayOfWeek.Wednesday => "星期三",
        DayOfWeek.Thursday => "星期四",
        DayOfWeek.Friday => "星期五",
        DayOfWeek.Saturday => "星期六",
        DayOfWeek.Sunday => "星期日",
        _ => throw new ArgumentOutOfRangeException(nameof(dayOfWeek), dayOfWeek, null)
    };

    [GeneratedRegex(@"^\s*#\s+(.+?)\s*$")]
    private static partial Regex H1Regex();

    [GeneratedRegex(@"!\[([^\]]*)\]\([^)]+\)")]
    private static partial Regex ImageRegex();

    [GeneratedRegex(@"\[([^\]]+)\]\([^)]+\)")]
    private static partial Regex LinkRegex();

    [GeneratedRegex(@"^\s{0,3}#{1,6}\s+")]
    private static partial Regex HeadingRegex();

    [GeneratedRegex(@"^\s*(?:[-+*]|\d+\.)\s+")]
    private static partial Regex ListMarkerRegex();

    [GeneratedRegex(@"^\s*>\s?")]
    private static partial Regex BlockQuoteRegex();

    [GeneratedRegex(@"[*_~`]+")]
    private static partial Regex MarkdownMarkerRegex();

    [GeneratedRegex(@"\s+")]
    private static partial Regex WhitespaceRegex();
}
