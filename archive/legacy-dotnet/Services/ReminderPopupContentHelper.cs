using DesktopAssistant.Models;

namespace DesktopAssistant.Services;

public sealed record ReminderPopupDisplay(
    string Icon,
    string Title,
    string Message,
    string DoneLabel,
    string LaterLabel,
    string? StatsFormat,
    int StatsCount,
    bool ShowStats);

public static class ReminderPopupContentHelper
{
    public static ReminderPopupDisplay Resolve(ReminderDefinition reminder, ScheduledReminderService service)
    {
        var statsCount = service.GetTodayAckCount(reminder.Id);

        if (reminder.Id == ReminderBuiltInIds.Water)
        {
            return new ReminderPopupDisplay(
                string.IsNullOrWhiteSpace(reminder.Icon) ? "💧" : reminder.Icon,
                L("Health.WaterTitle"),
                L("Health.WaterDesc"),
                L("Health.WaterDone"),
                reminder.LaterLabel ?? "稍后再喝",
                L("Health.WaterStats"),
                statsCount,
                reminder.TrackDailyStats);
        }

        if (reminder.Id == ReminderBuiltInIds.Sedentary)
        {
            return new ReminderPopupDisplay(
                string.IsNullOrWhiteSpace(reminder.Icon) ? "🏃" : reminder.Icon,
                L("Health.StandTitle"),
                L("Health.StandDesc"),
                L("Health.StandDone"),
                reminder.LaterLabel ?? "稍后去动",
                L("Health.StandStats"),
                statsCount,
                reminder.TrackDailyStats);
        }

        return new ReminderPopupDisplay(
            string.IsNullOrWhiteSpace(reminder.Icon) ? "🔔" : reminder.Icon,
            reminder.Title,
            reminder.Message,
            string.IsNullOrWhiteSpace(reminder.DoneLabel) ? L("Reminder.Done") : reminder.DoneLabel!,
            string.IsNullOrWhiteSpace(reminder.LaterLabel) ? L("Health.Later") : reminder.LaterLabel!,
            reminder.TrackDailyStats ? L("Reminder.Stats") : null,
            statsCount,
            reminder.TrackDailyStats && !string.IsNullOrEmpty(L("Reminder.Stats")));
    }

    public static string? FormatStats(ReminderPopupDisplay display) =>
        display.ShowStats && display.StatsFormat != null
            ? string.Format(display.StatsFormat, display.StatsCount)
            : null;

    private static string L(string key) => LocalizationManager.Get(key);
}
