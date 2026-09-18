using System.Runtime.InteropServices;
using System.Windows.Threading;
using DesktopAssistant.Models;

namespace DesktopAssistant.Services;

/// <summary>
/// 统一定时提醒调度：Interval / ActiveUse / Daily / Weekly / Once，空闲检测，Snooze / Acknowledge。
/// </summary>
public sealed class ScheduledReminderService
{
    [DllImport("user32.dll")]
    private static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);

    [StructLayout(LayoutKind.Sequential)]
    private struct LASTINPUTINFO
    {
        public uint cbSize;
        public uint dwTime;
    }

    private readonly ReminderStore _store;
    private readonly DispatcherTimer _timer;
    private bool _wasIdle;
    private bool _enabled = true;

    public event Action<ReminderDefinition>? ReminderDue;

    public ScheduledReminderService(ReminderStore store)
    {
        _store = store;
        _timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(30) };
        _timer.Tick += (_, _) => OnTick();
    }

    public ReminderStore Store => _store;

    public IReadOnlyList<ReminderDefinition> Reminders => _store.GetRemindersSnapshot();

    public void Reload(AppConfig config)
    {
        _store.EnsureLoaded(config);
        _store.Save();
        if (_enabled && !_timer.IsEnabled)
            _timer.Start();
    }

    public void Start()
    {
        if (!_enabled) return;
        _timer.Start();
    }

    public void Stop() => _timer.Stop();

    public void Restart()
    {
        Stop();
        Start();
    }

    public void SetEnabled(bool enabled)
    {
        _enabled = enabled;
        if (enabled)
            Start();
        else
            Stop();
    }

    public void SaveReminder(ReminderDefinition reminder, AppConfig config)
    {
        _store.UpsertReminder(reminder);
        _store.ApplyBuiltInsToConfig(config);
        App.Config.Save(config);
    }

    public void SetReminderEnabled(string reminderId, bool enabled, AppConfig config)
    {
        var found = false;
        _store.MutateAndSave(data =>
        {
            var reminder = data.Reminders.FirstOrDefault(
                item => string.Equals(item.Id, reminderId, StringComparison.OrdinalIgnoreCase));
            if (reminder == null)
                return;

            reminder.Enabled = enabled;
            found = true;
        });
        if (!found)
            return;
        _store.ApplyBuiltInsToConfig(config);
        App.Config.Save(config);
    }

    public bool DeleteReminder(string reminderId)
    {
        return _store.DeleteReminder(reminderId);
    }

    public void ResetBuiltIn(string reminderId, AppConfig config)
    {
        _store.ResetBuiltIn(reminderId, config);
        _store.ApplyBuiltInsToConfig(config);
        App.Config.Save(config);
    }

    public void ExportReminders(string path) => _store.ExportTo(path);

    public int ImportRemindersReplace(string path, AppConfig config)
    {
        var imported = ReminderStore.LoadFromFile(path);
        if (imported == null)
            throw new InvalidDataException("无法读取提醒文件。");

        _store.ImportReplace(imported, config);
        App.Config.Save(config);
        return imported.Reminders?.Count ?? 0;
    }

    public int ImportRemindersMerge(string path)
    {
        var imported = ReminderStore.LoadFromFile(path);
        if (imported == null)
            throw new InvalidDataException("无法读取提醒文件。");

        return _store.ImportMerge(imported);
    }

    public void Acknowledge(string reminderId)
    {
        var now = DateTime.Now;
        _store.MutateAndSave(data =>
        {
            var reminder = data.Reminders.FirstOrDefault(
                item => string.Equals(item.Id, reminderId, StringComparison.OrdinalIgnoreCase));
            var runtime = data.Runtime.First(
                item => string.Equals(item.ReminderId, reminderId, StringComparison.OrdinalIgnoreCase));
            ResetDailyStatsIfNeeded(runtime);

            if (reminder?.TrackDailyStats == true)
                runtime.TodayAckCount++;

            runtime.LastAcknowledgedAt = now;
            runtime.LastTriggeredAt = now;
            runtime.SnoozeUntil = null;
            runtime.ContinuousUseStart = now;

            if (reminder?.Schedule.Kind == ReminderRepeatKind.Once)
                reminder.Enabled = false;
        });
    }

    public void Snooze(string reminderId, int? minutes = null)
    {
        var now = DateTime.Now;
        _store.MutateAndSave(data =>
        {
            var reminder = data.Reminders.FirstOrDefault(
                item => string.Equals(item.Id, reminderId, StringComparison.OrdinalIgnoreCase));
            var runtime = data.Runtime.First(
                item => string.Equals(item.ReminderId, reminderId, StringComparison.OrdinalIgnoreCase));
            var snooze = minutes ?? reminder?.SnoozeMinutes ?? 10;
            runtime.SnoozeUntil = now.AddMinutes(Math.Clamp(snooze, 1, 240));
            runtime.LastTriggeredAt = now;
        });
    }

    public int GetTodayAckCount(string reminderId)
    {
        var count = 0;
        _store.MutateAndSave(data =>
        {
            var runtime = data.Runtime.First(
                item => string.Equals(item.ReminderId, reminderId, StringComparison.OrdinalIgnoreCase));
            ResetDailyStatsIfNeeded(runtime);
            count = runtime.TodayAckCount;
        });
        return count;
    }

    public void MarkTriggered(ReminderDefinition reminder, string? slotKey = null)
    {
        var now = DateTime.Now;
        _store.MutateAndSave(data =>
        {
            var runtime = data.Runtime.First(
                item => string.Equals(item.ReminderId, reminder.Id, StringComparison.OrdinalIgnoreCase));
            runtime.LastTriggeredAt = now;
            if (!string.IsNullOrWhiteSpace(slotKey))
                runtime.LastFiredSlotKey = slotKey;
        });
    }

    private void OnTick()
    {
        if (!_enabled) return;

        var idleSeconds = GetIdleSeconds();
        var idleThreshold = GetActiveUseIdleThresholdSeconds();
        var isIdle = idleSeconds > idleThreshold;
        UpdateActiveUseAnchors(isIdle);
        _wasIdle = isIdle;

        var now = DateTime.Now;
        var due = CollectDueReminders(now, idleSeconds);
        if (due.Count == 0) return;

        var next = due[0];
        var slotKey = ReminderScheduleHelper.GetDueSlotKey(
            next,
            now,
            _store.GetRuntimeSnapshot(next.Id).LastFiredSlotKey);
        MarkTriggered(next, slotKey);
        ReminderDue?.Invoke(next);
    }

    private List<ReminderDefinition> CollectDueReminders(DateTime now, double idleSeconds)
    {
        var due = new List<ReminderDefinition>();
        foreach (var reminder in _store.GetRemindersSnapshot().Where(r => r.Enabled))
        {
            if (ShouldFire(reminder, now, idleSeconds))
                due.Add(reminder);
        }

        return due
            .OrderBy(GetPriority)
            .ThenBy(r => r.Title, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    private static int GetPriority(ReminderDefinition reminder) => reminder.Id switch
    {
        ReminderBuiltInIds.Water => 0,
        ReminderBuiltInIds.Sedentary => 1,
        _ => 2
    };

    private bool ShouldFire(ReminderDefinition reminder, DateTime now, double idleSeconds)
    {
        if (reminder.Trigger.SkipWhenIdle && idleSeconds > reminder.Trigger.IdleThresholdSeconds)
            return false;

        var runtime = _store.GetRuntimeSnapshot(reminder.Id);
        if (runtime.SnoozeUntil.HasValue && now < runtime.SnoozeUntil.Value)
            return false;

        var interval = Math.Clamp(reminder.Schedule.IntervalMinutes ?? 30, 1, 24 * 60);
        return reminder.Schedule.Kind switch
        {
            ReminderRepeatKind.IntervalMinutes => ShouldFireInterval(runtime, now, interval),
            ReminderRepeatKind.ActiveUseInterval => ShouldFireActiveUse(runtime, now, interval),
            ReminderRepeatKind.Daily or ReminderRepeatKind.Weekly or ReminderRepeatKind.Monthly =>
                ReminderScheduleHelper.GetDueSlotKey(reminder, now, runtime.LastFiredSlotKey) != null,
            ReminderRepeatKind.Once => ShouldFireOnce(reminder, runtime, now),
            _ => false
        };
    }

    private static bool ShouldFireInterval(ReminderRuntimeState runtime, DateTime now, int intervalMinutes)
    {
        var anchor = runtime.LastAcknowledgedAt
                     ?? runtime.LastTriggeredAt
                     ?? runtime.ContinuousUseStart;
        return (now - anchor).TotalMinutes >= intervalMinutes;
    }

    private static bool ShouldFireActiveUse(ReminderRuntimeState runtime, DateTime now, int intervalMinutes)
    {
        var continuousMinutes = (now - runtime.ContinuousUseStart).TotalMinutes;
        var sinceLastEvent = (now - (runtime.LastAcknowledgedAt ?? runtime.LastTriggeredAt ?? runtime.ContinuousUseStart)).TotalMinutes;
        return continuousMinutes >= intervalMinutes && sinceLastEvent >= intervalMinutes;
    }

    private static bool ShouldFireOnce(ReminderDefinition reminder, ReminderRuntimeState runtime, DateTime now)
    {
        var at = reminder.Schedule.OnceAt;
        if (!at.HasValue || now < at.Value)
            return false;

        return runtime.LastTriggeredAt == null;
    }

    private void UpdateActiveUseAnchors(bool isIdle)
    {
        if (_wasIdle && !isIdle)
        {
            var now = DateTime.Now;
            var reminderIds = _store.GetRemindersSnapshot()
                .Where(reminder =>
                    reminder.Enabled &&
                    reminder.Schedule.Kind == ReminderRepeatKind.ActiveUseInterval)
                .Select(reminder => reminder.Id)
                .ToHashSet(StringComparer.OrdinalIgnoreCase);
            if (reminderIds.Count == 0)
                return;

            _store.MutateAndSave(data =>
            {
                foreach (var runtime in data.Runtime.Where(
                             runtime => reminderIds.Contains(runtime.ReminderId)))
                    runtime.ContinuousUseStart = now;
            });
        }
    }

    private int GetActiveUseIdleThresholdSeconds()
    {
        var thresholds = _store.GetRemindersSnapshot()
            .Where(r => r.Enabled && r.Schedule.Kind == ReminderRepeatKind.ActiveUseInterval)
            .Select(r => r.Trigger.IdleThresholdSeconds)
            .DefaultIfEmpty(300)
            .ToList();
        return thresholds.Min();
    }

    private static void ResetDailyStatsIfNeeded(ReminderRuntimeState runtime)
    {
        if (runtime.StatsDate.Date == DateTime.Today)
            return;

        runtime.StatsDate = DateTime.Today;
        runtime.TodayAckCount = 0;
    }

    private static double GetIdleSeconds()
    {
        var info = new LASTINPUTINFO { cbSize = (uint)Marshal.SizeOf<LASTINPUTINFO>() };
        if (!GetLastInputInfo(ref info))
            return 0;
        return (Environment.TickCount - (int)info.dwTime) / 1000.0;
    }
}
