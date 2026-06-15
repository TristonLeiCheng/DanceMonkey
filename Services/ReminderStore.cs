using System.IO;
using System.Text.Json;
using DesktopAssistant.Models;

namespace DesktopAssistant.Services;

public sealed class ReminderStore
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    private readonly string _storePath;

    public ReminderStoreFile Data { get; private set; } = new();

    public string StorePath => _storePath;

    public ReminderStore()
    {
        var dir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "DanceMonkey");
        Directory.CreateDirectory(dir);
        _storePath = Path.Combine(dir, "reminders.json");
    }

    public void EnsureLoaded(AppConfig config)
    {
        if (!File.Exists(_storePath))
        {
            Data = CreateFromLegacyConfig(config);
            Save();
            return;
        }

        try
        {
            var json = File.ReadAllText(_storePath);
            var loaded = JsonSerializer.Deserialize<ReminderStoreFile>(json, JsonOptions);
            Data = loaded ?? CreateFromLegacyConfig(config);
        }
        catch
        {
            Data = CreateFromLegacyConfig(config);
        }

        EnsureBuiltInsExist();
        EnsureRuntimeStates();
    }

    public void UpsertReminder(ReminderDefinition reminder)
    {
        EnsureRuntimeStates();
        var existing = Find(reminder.Id);
        if (existing == null)
        {
            Data.Reminders.Add(reminder);
        }
        else
        {
            var index = Data.Reminders.IndexOf(existing);
            Data.Reminders[index] = reminder;
        }

        EnsureRuntimeStates();
        Save();
    }

    public bool DeleteReminder(string id)
    {
        var reminder = Find(id);
        if (reminder == null || reminder.IsBuiltIn)
            return false;

        Data.Reminders.Remove(reminder);
        Data.Runtime.RemoveAll(r => string.Equals(r.ReminderId, id, StringComparison.OrdinalIgnoreCase));
        Save();
        return true;
    }

    public void ResetBuiltIn(string id, AppConfig config)
    {
        if (string.Equals(id, ReminderBuiltInIds.Water, StringComparison.OrdinalIgnoreCase))
        {
            var fresh = CreateWaterReminder(config);
            UpsertReminder(fresh);
            return;
        }

        if (string.Equals(id, ReminderBuiltInIds.Sedentary, StringComparison.OrdinalIgnoreCase))
        {
            var fresh = CreateSedentaryReminder(config);
            UpsertReminder(fresh);
        }
    }

    public void ApplyBuiltInsToConfig(AppConfig config)
    {
        var water = Find(ReminderBuiltInIds.Water);
        var sedentary = Find(ReminderBuiltInIds.Sedentary);
        if (water == null || sedentary == null)
            return;

        config.HealthReminderEnabled = water.Enabled || sedentary.Enabled;
        config.WaterReminderMinutes = Math.Clamp(water.Schedule.IntervalMinutes ?? 45, 5, 240);
        config.MovementReminderMinutes = Math.Clamp(sedentary.Schedule.IntervalMinutes ?? 60, 5, 240);
    }

    public void Save()
    {
        EnsureRuntimeStates();
        var json = JsonSerializer.Serialize(Data, JsonOptions);
        File.WriteAllText(_storePath, json);
    }

    public void ExportTo(string path)
    {
        EnsureRuntimeStates();
        var json = JsonSerializer.Serialize(Data, JsonOptions);
        File.WriteAllText(path, json);
    }

    public static ReminderStoreFile? LoadFromFile(string path)
    {
        if (!File.Exists(path))
            return null;

        var json = File.ReadAllText(path);
        return JsonSerializer.Deserialize<ReminderStoreFile>(json, JsonOptions);
    }

    /// <summary>替换当前全部提醒（保留内置项完整性）。</summary>
    public void ImportReplace(ReminderStoreFile imported, AppConfig config)
    {
        Data = imported ?? new ReminderStoreFile();
        Data.Reminders ??= [];
        Data.Runtime ??= [];
        EnsureBuiltInsExist();
        EnsureRuntimeStates();
        ApplyBuiltInsToConfig(config);
        Save();
    }

    /// <summary>合并导入：按 id 更新/新增，不删除现有项，跳过覆盖内置项。</summary>
    public int ImportMerge(ReminderStoreFile imported)
    {
        imported.Reminders ??= [];
        var count = 0;
        foreach (var reminder in imported.Reminders)
        {
            if (string.IsNullOrWhiteSpace(reminder.Id))
                reminder.Id = Guid.NewGuid().ToString("N");

            var existing = Find(reminder.Id);
            if (existing?.IsBuiltIn == true)
                continue;

            UpsertReminder(reminder);
            count++;
        }

        return count;
    }

    public ReminderDefinition? Find(string id) =>
        Data.Reminders.FirstOrDefault(r => string.Equals(r.Id, id, StringComparison.OrdinalIgnoreCase));

    public ReminderRuntimeState GetRuntime(string reminderId)
    {
        EnsureRuntimeStates();
        return Data.Runtime.First(r => string.Equals(r.ReminderId, reminderId, StringComparison.OrdinalIgnoreCase));
    }

    public void SyncBuiltInsFromConfig(AppConfig config)
    {
        EnsureBuiltInsExist();
        var water = Find(ReminderBuiltInIds.Water);
        var sedentary = Find(ReminderBuiltInIds.Sedentary);
        if (water != null)
        {
            water.Enabled = config.HealthReminderEnabled;
            water.Schedule.IntervalMinutes = Math.Clamp(config.WaterReminderMinutes, 5, 240);
        }

        if (sedentary != null)
        {
            sedentary.Enabled = config.HealthReminderEnabled;
            sedentary.Schedule.IntervalMinutes = Math.Clamp(config.MovementReminderMinutes, 5, 240);
        }
    }

    public static ReminderStoreFile CreateFromLegacyConfig(AppConfig config) =>
        new()
        {
            SchemaVersion = 1,
            Reminders =
            [
                CreateWaterReminder(config),
                CreateSedentaryReminder(config)
            ]
        };

    private void EnsureBuiltInsExist()
    {
        if (Find(ReminderBuiltInIds.Water) == null)
            Data.Reminders.Insert(0, CreateWaterReminder(new AppConfig()));

        if (Find(ReminderBuiltInIds.Sedentary) == null)
            Data.Reminders.Insert(Find(ReminderBuiltInIds.Water) != null ? 1 : 0, CreateSedentaryReminder(new AppConfig()));
    }

    private void EnsureRuntimeStates()
    {
        Data.Runtime ??= new List<ReminderRuntimeState>();
        var now = DateTime.Now;
        foreach (var reminder in Data.Reminders)
        {
            if (Data.Runtime.Any(r => string.Equals(r.ReminderId, reminder.Id, StringComparison.OrdinalIgnoreCase)))
                continue;

            Data.Runtime.Add(new ReminderRuntimeState
            {
                ReminderId = reminder.Id,
                ContinuousUseStart = now,
                StatsDate = DateTime.Today
            });
        }

        Data.Runtime.RemoveAll(r =>
            !Data.Reminders.Any(d => string.Equals(d.Id, r.ReminderId, StringComparison.OrdinalIgnoreCase)));
    }

    private static ReminderDefinition CreateWaterReminder(AppConfig config) => new()
    {
        Id = ReminderBuiltInIds.Water,
        Title = "该喝水啦 💧",
        Message = "久坐工作容易忘记喝水，现在起身倒杯水吧！保持充足的水分有助于提高专注力。",
        Icon = "💧",
        Enabled = config.HealthReminderEnabled,
        IsBuiltIn = true,
        NotifyStyle = ReminderNotifyStyle.DesktopPopup,
        DoneLabel = "已喝水",
        LaterLabel = "稍后再喝",
        TrackDailyStats = true,
        Schedule = new ReminderSchedule
        {
            Kind = ReminderRepeatKind.IntervalMinutes,
            IntervalMinutes = Math.Clamp(config.WaterReminderMinutes, 5, 240)
        },
        Trigger = new ReminderTriggerCondition
        {
            SkipWhenIdle = true,
            IdleThresholdSeconds = 300,
            ResetOnAcknowledge = true
        }
    };

    private static ReminderDefinition CreateSedentaryReminder(AppConfig config) => new()
    {
        Id = ReminderBuiltInIds.Sedentary,
        Title = "该起身运动了 🏃",
        Message = "你已经连续工作超过一小时了！站起来伸展一下身体，活动活动筋骨吧。",
        Icon = "🏃",
        Enabled = config.HealthReminderEnabled,
        IsBuiltIn = true,
        NotifyStyle = ReminderNotifyStyle.DesktopPopup,
        DoneLabel = "已运动",
        LaterLabel = "稍后去动",
        TrackDailyStats = true,
        Schedule = new ReminderSchedule
        {
            Kind = ReminderRepeatKind.ActiveUseInterval,
            IntervalMinutes = Math.Clamp(config.MovementReminderMinutes, 5, 240)
        },
        Trigger = new ReminderTriggerCondition
        {
            SkipWhenIdle = true,
            IdleThresholdSeconds = 300,
            ResetOnAcknowledge = true
        }
    };
}
