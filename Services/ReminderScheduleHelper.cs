using DesktopAssistant.Models;

namespace DesktopAssistant.Services;

public static class ReminderScheduleHelper
{
    public const int WeekdayMon = 1;
    public const int WeekdayTue = 2;
    public const int WeekdayWed = 4;
    public const int WeekdayThu = 8;
    public const int WeekdayFri = 16;
    public const int WeekdaySat = 32;
    public const int WeekdaySun = 64;
    public const int WeekdayMonFri = WeekdayMon | WeekdayTue | WeekdayWed | WeekdayThu | WeekdayFri;

    public static string DescribeSchedule(ReminderDefinition reminder)
    {
        var schedule = reminder.Schedule;
        return schedule.Kind switch
        {
            ReminderRepeatKind.IntervalMinutes =>
                $"每 {Math.Clamp(schedule.IntervalMinutes ?? 30, 1, 24 * 60)} 分钟",
            ReminderRepeatKind.ActiveUseInterval =>
                $"连续使用 {Math.Clamp(schedule.IntervalMinutes ?? 60, 1, 24 * 60)} 分钟",
            ReminderRepeatKind.Daily =>
                $"每天 {FormatTimes(schedule.Times)}",
            ReminderRepeatKind.Weekly =>
                $"每周 {FormatWeekdays(schedule.Weekdays ?? WeekdayMonFri)} {FormatTimes(schedule.Times, single: true)}",
            ReminderRepeatKind.Monthly =>
                $"每月 {Math.Clamp(schedule.DayOfMonth ?? 1, 1, 31)} 日 {FormatTimes(schedule.Times, single: true)}",
            ReminderRepeatKind.Once when schedule.OnceAt.HasValue =>
                $"一次性 {schedule.OnceAt.Value:yyyy-MM-dd HH:mm}",
            _ => "未配置"
        };
    }

    public static string DescribeNotifyStyle(ReminderNotifyStyle style) =>
        style == ReminderNotifyStyle.PetBubble
            ? LocalizationManager.Get("Reminder.Notify.PetBubble")
            : LocalizationManager.Get("Reminder.Notify.Desktop");

    public static string DescribeReminderPresentation(ReminderDefinition reminder) =>
        ReminderPopupStyleResolver.DescribeForReminder(reminder);

    public static List<string> ParseTimes(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
            return ["09:00"];

        return raw.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(NormalizeTime)
            .Where(t => t != null)
            .Cast<string>()
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    public static string? NormalizeTime(string raw)
    {
        if (TimeSpan.TryParse(raw.Trim(), out var ts))
            return ts.ToString(@"hh\:mm");

        var parts = raw.Trim().Split(':');
        if (parts.Length == 2
            && int.TryParse(parts[0], out var h)
            && int.TryParse(parts[1], out var m)
            && h is >= 0 and <= 23
            && m is >= 0 and <= 59)
            return $"{h:D2}:{m:D2}";

        return null;
    }

    public static string? GetDueSlotKey(ReminderDefinition reminder, DateTime now, string? lastFiredSlotKey)
    {
        return reminder.Schedule.Kind switch
        {
            ReminderRepeatKind.Daily => GetDailyDueSlotKey(reminder, now, lastFiredSlotKey),
            ReminderRepeatKind.Weekly => GetWeeklyDueSlotKey(reminder, now, lastFiredSlotKey),
            ReminderRepeatKind.Monthly => GetMonthlyDueSlotKey(reminder, now, lastFiredSlotKey),
            _ => null
        };
    }

    public static bool IsWeekdaySelected(int mask, DayOfWeek dayOfWeek)
    {
        var bit = dayOfWeek == DayOfWeek.Sunday ? WeekdaySun : 1 << ((int)dayOfWeek - 1);
        return (mask & bit) != 0;
    }

    private static string? GetDailyDueSlotKey(ReminderDefinition reminder, DateTime now, string? lastFiredSlotKey)
    {
        foreach (var time in GetTimes(reminder).OrderBy(t => t, StringComparer.Ordinal))
        {
            if (!TimeSpan.TryParse(time, out var tod))
                continue;

            var slotKey = $"{now:yyyy-MM-dd}T{time}";
            if (now >= now.Date + tod
                && !string.Equals(lastFiredSlotKey, slotKey, StringComparison.Ordinal))
                return slotKey;
        }

        return null;
    }

    private static string? GetWeeklyDueSlotKey(ReminderDefinition reminder, DateTime now, string? lastFiredSlotKey)
    {
        var mask = reminder.Schedule.Weekdays ?? WeekdayMonFri;
        if (!IsWeekdaySelected(mask, now.DayOfWeek))
            return null;

        var time = GetTimes(reminder).FirstOrDefault() ?? "09:00";
        if (!TimeSpan.TryParse(time, out var tod))
            return null;

        var slotKey = $"{now:yyyy-MM-dd}T{time}";
        if (now >= now.Date + tod
            && !string.Equals(lastFiredSlotKey, slotKey, StringComparison.Ordinal))
            return slotKey;

        return null;
    }

    private static string? GetMonthlyDueSlotKey(ReminderDefinition reminder, DateTime now, string? lastFiredSlotKey)
    {
        var day = Math.Clamp(reminder.Schedule.DayOfMonth ?? 1, 1, 31);
        if (now.Day != day)
            return null;

        var time = GetTimes(reminder).FirstOrDefault() ?? "09:00";
        if (!TimeSpan.TryParse(time, out var tod))
            return null;

        var slotKey = $"{now:yyyy-MM}-{day:D2}T{time}";
        if (now >= now.Date + tod
            && !string.Equals(lastFiredSlotKey, slotKey, StringComparison.Ordinal))
            return slotKey;

        return null;
    }

    private static List<string> GetTimes(ReminderDefinition reminder)
    {
        var times = reminder.Schedule.Times?
            .Select(NormalizeTime)
            .Where(t => t != null)
            .Cast<string>()
            .ToList();
        return times is { Count: > 0 } ? times : ["09:00"];
    }

    private static string FormatTimes(IReadOnlyList<string>? times, bool single = false)
    {
        var list = times?
            .Select(NormalizeTime)
            .Where(t => t != null)
            .Cast<string>()
            .ToList() ?? ["09:00"];
        return single ? list[0] : string.Join("、", list);
    }

    private static string FormatWeekdays(int mask)
    {
        var labels = new List<string>();
        if ((mask & WeekdayMon) != 0) labels.Add("一");
        if ((mask & WeekdayTue) != 0) labels.Add("二");
        if ((mask & WeekdayWed) != 0) labels.Add("三");
        if ((mask & WeekdayThu) != 0) labels.Add("四");
        if ((mask & WeekdayFri) != 0) labels.Add("五");
        if ((mask & WeekdaySat) != 0) labels.Add("六");
        if ((mask & WeekdaySun) != 0) labels.Add("日");
        return labels.Count == 0 ? "—" : string.Join("", labels);
    }
}
