using System.Text.Json.Serialization;

namespace DesktopAssistant.Models;

public static class ReminderBuiltInIds
{
    public const string Water = "builtin-water";
    public const string Sedentary = "builtin-sedentary";
}

public enum ReminderRepeatKind
{
    IntervalMinutes,
    ActiveUseInterval,
    Daily,
    Weekly,
    Monthly,
    Once
}

public enum ReminderNotifyStyle
{
    DesktopPopup,
    PetBubble
}

/// <summary>桌面弹窗视觉样式（仅 <see cref="ReminderNotifyStyle.DesktopPopup"/> 时生效）。</summary>
public enum ReminderPopupStyle
{
    /// <summary>磨砂玻璃卡片（居中）。</summary>
    GlassCard,
    /// <summary>圆形弹窗（居中）。</summary>
    Circular,
    /// <summary>灵动岛（屏幕顶部居中，展开动画）。</summary>
    DynamicIsland,
    /// <summary>Toast 通知（右下角滑入）。</summary>
    Toast,
    /// <summary>横幅条（顶部宽条）。</summary>
    Banner,
    /// <summary>紧凑胶囊（右下角小条）。</summary>
    Compact
}

public sealed class ReminderSchedule
{
    [JsonPropertyName("kind")]
    public ReminderRepeatKind Kind { get; set; } = ReminderRepeatKind.IntervalMinutes;

    [JsonPropertyName("intervalMinutes")]
    public int? IntervalMinutes { get; set; }

    [JsonPropertyName("times")]
    public List<string>? Times { get; set; }

    [JsonPropertyName("weekdays")]
    public int? Weekdays { get; set; }

    [JsonPropertyName("dayOfMonth")]
    public int? DayOfMonth { get; set; }

    [JsonPropertyName("onceAt")]
    public DateTime? OnceAt { get; set; }
}

public sealed class ReminderTriggerCondition
{
    [JsonPropertyName("skipWhenIdle")]
    public bool SkipWhenIdle { get; set; } = true;

    [JsonPropertyName("idleThresholdSeconds")]
    public int IdleThresholdSeconds { get; set; } = 300;

    [JsonPropertyName("resetOnAcknowledge")]
    public bool ResetOnAcknowledge { get; set; } = true;
}

public sealed class ReminderDefinition
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    [JsonPropertyName("title")]
    public string Title { get; set; } = "";

    [JsonPropertyName("message")]
    public string Message { get; set; } = "";

    [JsonPropertyName("icon")]
    public string Icon { get; set; } = "🔔";

    [JsonPropertyName("enabled")]
    public bool Enabled { get; set; } = true;

    [JsonPropertyName("isBuiltIn")]
    public bool IsBuiltIn { get; set; }

    [JsonPropertyName("notifyStyle")]
    public ReminderNotifyStyle NotifyStyle { get; set; } = ReminderNotifyStyle.DesktopPopup;

    /// <summary>桌面弹窗样式覆盖；为 null 时使用全局默认。</summary>
    [JsonPropertyName("popupStyleOverride")]
    public ReminderPopupStyle? PopupStyleOverride { get; set; }

    [JsonPropertyName("doneLabel")]
    public string? DoneLabel { get; set; }

    [JsonPropertyName("laterLabel")]
    public string? LaterLabel { get; set; }

    [JsonPropertyName("snoozeMinutes")]
    public int SnoozeMinutes { get; set; } = 10;

    [JsonPropertyName("trackDailyStats")]
    public bool TrackDailyStats { get; set; } = true;

    [JsonPropertyName("schedule")]
    public ReminderSchedule Schedule { get; set; } = new();

    [JsonPropertyName("trigger")]
    public ReminderTriggerCondition Trigger { get; set; } = new();
}

public sealed class ReminderRuntimeState
{
    [JsonPropertyName("reminderId")]
    public string ReminderId { get; set; } = "";

    [JsonPropertyName("lastTriggeredAt")]
    public DateTime? LastTriggeredAt { get; set; }

    [JsonPropertyName("lastAcknowledgedAt")]
    public DateTime? LastAcknowledgedAt { get; set; }

    [JsonPropertyName("snoozeUntil")]
    public DateTime? SnoozeUntil { get; set; }

    [JsonPropertyName("continuousUseStart")]
    public DateTime ContinuousUseStart { get; set; } = DateTime.Now;

    [JsonPropertyName("todayAckCount")]
    public int TodayAckCount { get; set; }

    [JsonPropertyName("statsDate")]
    public DateTime StatsDate { get; set; } = DateTime.Today;

    /// <summary>日历类提醒已触发的槽位键，如 2026-06-15T09:00。</summary>
    [JsonPropertyName("lastFiredSlotKey")]
    public string? LastFiredSlotKey { get; set; }
}

public sealed class ReminderStoreFile
{
    [JsonPropertyName("schemaVersion")]
    public int SchemaVersion { get; set; } = 1;

    [JsonPropertyName("reminders")]
    public List<ReminderDefinition> Reminders { get; set; } = new();

    [JsonPropertyName("runtime")]
    public List<ReminderRuntimeState> Runtime { get; set; } = new();
}
