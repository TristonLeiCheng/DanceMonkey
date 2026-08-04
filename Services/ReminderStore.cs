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

    private readonly object _gate = new();
    private readonly string _storePath;
    private ReminderStoreFile _data = new();

    public string StorePath => _storePath;

    public ReminderStore()
        : this(Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "DanceMonkey",
            "reminders.json"))
    {
    }

    public ReminderStore(string storePath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(storePath);
        _storePath = Path.GetFullPath(storePath);
        var dir = Path.GetDirectoryName(_storePath)
                  ?? throw new ArgumentException("Reminder store path must include a directory.", nameof(storePath));
        Directory.CreateDirectory(dir);
    }

    public void EnsureLoaded(AppConfig config)
    {
        ArgumentNullException.ThrowIfNull(config);
        lock (_gate)
        {
            if (!File.Exists(_storePath))
            {
                _data = CreateFromLegacyConfig(config);
                SaveUnsafe();
                return;
            }

            try
            {
                var json = File.ReadAllText(_storePath);
                var loaded = JsonSerializer.Deserialize<ReminderStoreFile>(json, JsonOptions);
                _data = loaded ?? CreateFromLegacyConfig(config);
            }
            catch
            {
                _data = CreateFromLegacyConfig(config);
            }

            NormalizeDataUnsafe();
            EnsureBuiltInsExistUnsafe();
            EnsureRuntimeStatesUnsafe();
        }
    }

    public void UpsertReminder(ReminderDefinition reminder)
    {
        ArgumentNullException.ThrowIfNull(reminder);
        lock (_gate)
        {
            NormalizeDataUnsafe();
            EnsureRuntimeStatesUnsafe();
            UpsertReminderUnsafe(Clone(reminder));
            EnsureRuntimeStatesUnsafe();
            SaveUnsafe();
        }
    }

    public bool DeleteReminder(string id)
    {
        lock (_gate)
        {
            NormalizeDataUnsafe();
            var reminder = FindUnsafe(id);
            if (reminder == null || reminder.IsBuiltIn)
                return false;

            _data.Reminders.Remove(reminder);
            _data.Runtime.RemoveAll(r => string.Equals(r.ReminderId, id, StringComparison.OrdinalIgnoreCase));
            SaveUnsafe();
            return true;
        }
    }

    public void ResetBuiltIn(string id, AppConfig config)
    {
        lock (_gate)
        {
            ReminderDefinition? fresh = null;
            if (string.Equals(id, ReminderBuiltInIds.Water, StringComparison.OrdinalIgnoreCase))
                fresh = CreateWaterReminder(config);
            else if (string.Equals(id, ReminderBuiltInIds.Sedentary, StringComparison.OrdinalIgnoreCase))
                fresh = CreateSedentaryReminder(config);

            if (fresh == null)
                return;

            NormalizeDataUnsafe();
            UpsertReminderUnsafe(fresh);
            EnsureRuntimeStatesUnsafe();
            SaveUnsafe();
        }
    }

    public void ApplyBuiltInsToConfig(AppConfig config)
    {
        lock (_gate)
        {
            var water = FindUnsafe(ReminderBuiltInIds.Water);
            var sedentary = FindUnsafe(ReminderBuiltInIds.Sedentary);
            if (water == null || sedentary == null)
                return;

            config.HealthReminderEnabled = water.Enabled || sedentary.Enabled;
            config.WaterReminderMinutes = Math.Clamp(water.Schedule.IntervalMinutes ?? 45, 5, 240);
            config.MovementReminderMinutes = Math.Clamp(sedentary.Schedule.IntervalMinutes ?? 60, 5, 240);
        }
    }

    public void Save()
    {
        lock (_gate)
            SaveUnsafe();
    }

    public void ExportTo(string path)
    {
        lock (_gate)
        {
            EnsureRuntimeStatesUnsafe();
            var json = JsonSerializer.Serialize(_data, JsonOptions);
            File.WriteAllText(path, json);
        }
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
        lock (_gate)
        {
            _data = imported == null ? new ReminderStoreFile() : Clone(imported);
            NormalizeDataUnsafe();
            EnsureBuiltInsExistUnsafe();
            EnsureRuntimeStatesUnsafe();
            ApplyBuiltInsToConfigUnsafe(config);
            SaveUnsafe();
        }
    }

    /// <summary>合并导入：按 id 更新/新增，不删除现有项，跳过覆盖内置项。</summary>
    public int ImportMerge(ReminderStoreFile imported)
    {
        lock (_gate)
        {
            imported.Reminders ??= [];
            var count = 0;
            foreach (var sourceReminder in imported.Reminders.Where(reminder => reminder != null))
            {
                var reminder = Clone(sourceReminder);
                if (string.IsNullOrWhiteSpace(reminder.Id))
                    reminder.Id = Guid.NewGuid().ToString("N");

                var existing = FindUnsafe(reminder.Id);
                if (existing?.IsBuiltIn == true)
                    continue;

                UpsertReminderUnsafe(reminder);
                count++;
            }

            EnsureRuntimeStatesUnsafe();
            SaveUnsafe();
            return count;
        }
    }

    public IReadOnlyList<ReminderDefinition> GetRemindersSnapshot()
    {
        lock (_gate)
        {
            NormalizeDataUnsafe();
            return Clone(_data.Reminders).ToArray();
        }
    }

    public ReminderDefinition? Find(string id)
    {
        lock (_gate)
        {
            var reminder = FindUnsafe(id);
            return reminder == null ? null : Clone(reminder);
        }
    }

    public ReminderRuntimeState GetRuntimeSnapshot(string reminderId)
    {
        lock (_gate)
        {
            EnsureRuntimeStatesUnsafe();
            return Clone(_data.Runtime.First(
                runtime => string.Equals(runtime.ReminderId, reminderId, StringComparison.OrdinalIgnoreCase)));
        }
    }

    internal void MutateAndSave(Action<ReminderStoreFile> mutation)
    {
        ArgumentNullException.ThrowIfNull(mutation);
        lock (_gate)
        {
            NormalizeDataUnsafe();
            EnsureRuntimeStatesUnsafe();
            mutation(_data);
            NormalizeDataUnsafe();
            EnsureRuntimeStatesUnsafe();
            SaveUnsafe();
        }
    }

    public void SyncBuiltInsFromConfig(AppConfig config)
    {
        lock (_gate)
        {
            EnsureBuiltInsExistUnsafe();
            var water = FindUnsafe(ReminderBuiltInIds.Water);
            var sedentary = FindUnsafe(ReminderBuiltInIds.Sedentary);
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

    private void EnsureBuiltInsExistUnsafe()
    {
        if (FindUnsafe(ReminderBuiltInIds.Water) == null)
            _data.Reminders.Insert(0, CreateWaterReminder(new AppConfig()));

        if (FindUnsafe(ReminderBuiltInIds.Sedentary) == null)
            _data.Reminders.Insert(FindUnsafe(ReminderBuiltInIds.Water) != null ? 1 : 0, CreateSedentaryReminder(new AppConfig()));
    }

    private void EnsureRuntimeStatesUnsafe()
    {
        NormalizeDataUnsafe();
        var now = DateTime.Now;
        foreach (var reminder in _data.Reminders)
        {
            if (_data.Runtime.Any(r => string.Equals(r.ReminderId, reminder.Id, StringComparison.OrdinalIgnoreCase)))
                continue;

            _data.Runtime.Add(new ReminderRuntimeState
            {
                ReminderId = reminder.Id,
                ContinuousUseStart = now,
                StatsDate = DateTime.Today
            });
        }

        _data.Runtime.RemoveAll(r =>
            !_data.Reminders.Any(d => string.Equals(d.Id, r.ReminderId, StringComparison.OrdinalIgnoreCase)));
    }

    private void NormalizeDataUnsafe()
    {
        _data.Reminders ??= [];
        _data.Runtime ??= [];
        _data.Reminders = _data.Reminders.Where(reminder => reminder != null).ToList();
        _data.Runtime = _data.Runtime.Where(runtime => runtime != null).ToList();
    }

    private ReminderDefinition? FindUnsafe(string id) =>
        _data.Reminders.FirstOrDefault(
            reminder => string.Equals(reminder.Id, id, StringComparison.OrdinalIgnoreCase));

    private void UpsertReminderUnsafe(ReminderDefinition reminder)
    {
        var existing = FindUnsafe(reminder.Id);
        if (existing == null)
        {
            _data.Reminders.Add(reminder);
            return;
        }

        var index = _data.Reminders.IndexOf(existing);
        _data.Reminders[index] = reminder;
    }

    private void ApplyBuiltInsToConfigUnsafe(AppConfig config)
    {
        var water = FindUnsafe(ReminderBuiltInIds.Water);
        var sedentary = FindUnsafe(ReminderBuiltInIds.Sedentary);
        if (water == null || sedentary == null)
            return;

        config.HealthReminderEnabled = water.Enabled || sedentary.Enabled;
        config.WaterReminderMinutes = Math.Clamp(water.Schedule.IntervalMinutes ?? 45, 5, 240);
        config.MovementReminderMinutes = Math.Clamp(sedentary.Schedule.IntervalMinutes ?? 60, 5, 240);
    }

    private void SaveUnsafe()
    {
        EnsureRuntimeStatesUnsafe();
        var json = JsonSerializer.Serialize(_data, JsonOptions);
        File.WriteAllText(_storePath, json);
    }

    private static T Clone<T>(T value)
    {
        var json = JsonSerializer.Serialize(value, JsonOptions);
        return JsonSerializer.Deserialize<T>(json, JsonOptions)
               ?? throw new InvalidDataException("Unable to clone reminder data.");
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
