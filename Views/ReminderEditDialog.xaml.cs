using System.Windows;
using System.Windows.Controls;
using DesktopAssistant.Models;
using DesktopAssistant.Services;

namespace DesktopAssistant.Views;

public partial class ReminderEditDialog : Window
{
    private readonly ReminderDefinition _model;
    private readonly bool _isNew;

    public ReminderDefinition Result { get; private set; }

    public event Action<ReminderDefinition>? TestRequested;

    public ReminderEditDialog(ReminderDefinition model, bool isNew)
    {
        InitializeComponent();
        _model = model;
        _isNew = isNew;
        Result = Clone(model);
        Title = isNew ? "新建提醒" : "编辑提醒";

        RepeatKindCombo.ItemsSource = new ComboItem<ReminderRepeatKind>[]
        {
            new("每 N 分钟", ReminderRepeatKind.IntervalMinutes),
            new("连续使用 N 分钟", ReminderRepeatKind.ActiveUseInterval),
            new("每天指定时刻", ReminderRepeatKind.Daily),
            new("每周指定星期", ReminderRepeatKind.Weekly),
            new("每月指定日期", ReminderRepeatKind.Monthly),
            new("一次性", ReminderRepeatKind.Once),
        };
        RepeatKindCombo.DisplayMemberPath = nameof(ComboItem<ReminderRepeatKind>.Label);
        RepeatKindCombo.SelectedValuePath = nameof(ComboItem<ReminderRepeatKind>.Kind);

        NotifyStyleCombo.ItemsSource = new ComboItem<ReminderNotifyStyle>[]
        {
            new("桌面弹窗", ReminderNotifyStyle.DesktopPopup),
            new("宠物气泡", ReminderNotifyStyle.PetBubble),
        };
        NotifyStyleCombo.DisplayMemberPath = nameof(ComboItem<ReminderNotifyStyle>.Label);
        NotifyStyleCombo.SelectedValuePath = nameof(ComboItem<ReminderNotifyStyle>.Kind);

        PopupStyleCombo.ItemsSource = BuildPopupStyleItems();
        PopupStyleCombo.DisplayMemberPath = nameof(PopupStyleComboItem.Label);
        PopupStyleCombo.SelectedValuePath = nameof(PopupStyleComboItem.Style);

        LoadFromModel();
        RepeatKindCombo.SelectionChanged += (_, _) => UpdatePanels();
    }

    private static PopupStyleComboItem[] BuildPopupStyleItems() =>
    [
        new("跟随全局默认", null),
        new(ReminderPopupStyleResolver.Describe(ReminderPopupStyle.GlassCard), ReminderPopupStyle.GlassCard),
        new(ReminderPopupStyleResolver.Describe(ReminderPopupStyle.Circular), ReminderPopupStyle.Circular),
        new(ReminderPopupStyleResolver.Describe(ReminderPopupStyle.DynamicIsland), ReminderPopupStyle.DynamicIsland),
        new(ReminderPopupStyleResolver.Describe(ReminderPopupStyle.Toast), ReminderPopupStyle.Toast),
        new(ReminderPopupStyleResolver.Describe(ReminderPopupStyle.Banner), ReminderPopupStyle.Banner),
        new(ReminderPopupStyleResolver.Describe(ReminderPopupStyle.Compact), ReminderPopupStyle.Compact),
    ];

    private void LoadFromModel()
    {
        TitleBox.Text = _model.Title;
        MessageInputBox.Text = _model.Message;
        IconBox.Text = _model.Icon;
        EnabledCheck.IsChecked = _model.Enabled;
        IntervalBox.Text = (_model.Schedule.IntervalMinutes ?? 45).ToString();
        DailyTimesBox.Text = string.Join(", ", _model.Schedule.Times ?? ["09:00"]);
        WeeklyTimeBox.Text = _model.Schedule.Times?.FirstOrDefault() ?? "09:00";
        MonthlyDayBox.Text = (_model.Schedule.DayOfMonth ?? 1).ToString();
        MonthlyTimeBox.Text = _model.Schedule.Times?.FirstOrDefault() ?? "09:00";
        OnceAtBox.Text = _model.Schedule.OnceAt?.ToString("yyyy-MM-dd HH:mm") ?? DateTime.Now.AddHours(1).ToString("yyyy-MM-dd HH:mm");
        SkipIdleCheck.IsChecked = _model.Trigger.SkipWhenIdle;
        DoneLabelBox.Text = _model.DoneLabel ?? "完成";
        SnoozeBox.Text = _model.SnoozeMinutes.ToString();

        SelectRepeatKind(_model.Schedule.Kind);
        SelectNotifyStyle(_model.NotifyStyle);
        SelectPopupStyle(_model.PopupStyleOverride);
        ApplyWeekdayMask(_model.Schedule.Weekdays ?? ReminderScheduleHelper.WeekdayMonFri);
        UpdatePanels();
    }

    private void SelectRepeatKind(ReminderRepeatKind kind)
    {
        foreach (ComboItem<ReminderRepeatKind> item in RepeatKindCombo.Items)
        {
            if (item.Kind == kind)
            {
                RepeatKindCombo.SelectedItem = item;
                return;
            }
        }

        RepeatKindCombo.SelectedIndex = 0;
    }

    private void SelectNotifyStyle(ReminderNotifyStyle style)
    {
        foreach (ComboItem<ReminderNotifyStyle> item in NotifyStyleCombo.Items)
        {
            if (item.Kind == style)
            {
                NotifyStyleCombo.SelectedItem = item;
                return;
            }
        }

        NotifyStyleCombo.SelectedIndex = 0;
    }

    private void SelectPopupStyle(ReminderPopupStyle? style)
    {
        foreach (PopupStyleComboItem item in PopupStyleCombo.Items)
        {
            if (item.Style == style)
            {
                PopupStyleCombo.SelectedItem = item;
                return;
            }
        }

        PopupStyleCombo.SelectedIndex = 0;
    }

    private void NotifyStyle_OnChanged(object sender, SelectionChangedEventArgs e) => UpdatePanels();

    private void UpdatePanels()
    {
        var kind = GetSelectedRepeatKind();
        IntervalPanel.Visibility = kind is ReminderRepeatKind.IntervalMinutes or ReminderRepeatKind.ActiveUseInterval
            ? Visibility.Visible
            : Visibility.Collapsed;
        DailyPanel.Visibility = kind == ReminderRepeatKind.Daily ? Visibility.Visible : Visibility.Collapsed;
        WeeklyPanel.Visibility = kind == ReminderRepeatKind.Weekly ? Visibility.Visible : Visibility.Collapsed;
        MonthlyPanel.Visibility = kind == ReminderRepeatKind.Monthly ? Visibility.Visible : Visibility.Collapsed;
        OncePanel.Visibility = kind == ReminderRepeatKind.Once ? Visibility.Visible : Visibility.Collapsed;

        PopupStylePanel.Visibility = GetSelectedNotifyStyle() == ReminderNotifyStyle.DesktopPopup
            ? Visibility.Visible
            : Visibility.Collapsed;
    }

    private ReminderRepeatKind GetSelectedRepeatKind() =>
        RepeatKindCombo.SelectedItem is ComboItem<ReminderRepeatKind> item
            ? item.Kind
            : ReminderRepeatKind.IntervalMinutes;

    private ReminderNotifyStyle GetSelectedNotifyStyle() =>
        NotifyStyleCombo.SelectedItem is ComboItem<ReminderNotifyStyle> item
            ? item.Kind
            : ReminderNotifyStyle.DesktopPopup;

    private ReminderPopupStyle? GetSelectedPopupStyleOverride() =>
        PopupStyleCombo.SelectedItem is PopupStyleComboItem item
            ? item.Style
            : null;

    private int GetWeekdayMask()
    {
        var mask = 0;
        if (WeekMon.IsChecked == true) mask |= ReminderScheduleHelper.WeekdayMon;
        if (WeekTue.IsChecked == true) mask |= ReminderScheduleHelper.WeekdayTue;
        if (WeekWed.IsChecked == true) mask |= ReminderScheduleHelper.WeekdayWed;
        if (WeekThu.IsChecked == true) mask |= ReminderScheduleHelper.WeekdayThu;
        if (WeekFri.IsChecked == true) mask |= ReminderScheduleHelper.WeekdayFri;
        if (WeekSat.IsChecked == true) mask |= ReminderScheduleHelper.WeekdaySat;
        if (WeekSun.IsChecked == true) mask |= ReminderScheduleHelper.WeekdaySun;
        return mask == 0 ? ReminderScheduleHelper.WeekdayMonFri : mask;
    }

    private void ApplyWeekdayMask(int mask)
    {
        WeekMon.IsChecked = (mask & ReminderScheduleHelper.WeekdayMon) != 0;
        WeekTue.IsChecked = (mask & ReminderScheduleHelper.WeekdayTue) != 0;
        WeekWed.IsChecked = (mask & ReminderScheduleHelper.WeekdayWed) != 0;
        WeekThu.IsChecked = (mask & ReminderScheduleHelper.WeekdayThu) != 0;
        WeekFri.IsChecked = (mask & ReminderScheduleHelper.WeekdayFri) != 0;
        WeekSat.IsChecked = (mask & ReminderScheduleHelper.WeekdaySat) != 0;
        WeekSun.IsChecked = (mask & ReminderScheduleHelper.WeekdaySun) != 0;
    }

    private bool TryBuildResult(out ReminderDefinition result, out string error)
    {
        error = "";
        var title = TitleBox.Text.Trim();
        if (string.IsNullOrWhiteSpace(title))
        {
            error = "请填写标题。";
            result = Result;
            return false;
        }

        var kind = GetSelectedRepeatKind();
        var schedule = new ReminderSchedule { Kind = kind };

        switch (kind)
        {
            case ReminderRepeatKind.IntervalMinutes:
            case ReminderRepeatKind.ActiveUseInterval:
                if (!int.TryParse(IntervalBox.Text.Trim(), out var interval) || interval < 1 || interval > 24 * 60)
                {
                    error = "间隔应为 1–1440 分钟。";
                    result = Result;
                    return false;
                }

                schedule.IntervalMinutes = interval;
                break;
            case ReminderRepeatKind.Daily:
                schedule.Times = ReminderScheduleHelper.ParseTimes(DailyTimesBox.Text);
                break;
            case ReminderRepeatKind.Weekly:
                schedule.Weekdays = GetWeekdayMask();
                var weeklyTime = ReminderScheduleHelper.NormalizeTime(WeeklyTimeBox.Text.Trim());
                if (weeklyTime == null)
                {
                    error = "请填写有效的时刻，如 09:00。";
                    result = Result;
                    return false;
                }

                schedule.Times = [weeklyTime];
                break;
            case ReminderRepeatKind.Monthly:
                if (!int.TryParse(MonthlyDayBox.Text.Trim(), out var day) || day is < 1 or > 31)
                {
                    error = "每月日期应为 1–31。";
                    result = Result;
                    return false;
                }

                var monthlyTime = ReminderScheduleHelper.NormalizeTime(MonthlyTimeBox.Text.Trim());
                if (monthlyTime == null)
                {
                    error = "请填写有效的时刻，如 09:00。";
                    result = Result;
                    return false;
                }

                schedule.DayOfMonth = day;
                schedule.Times = [monthlyTime];
                break;
            case ReminderRepeatKind.Once:
                if (!DateTime.TryParse(OnceAtBox.Text.Trim(), out var onceAt))
                {
                    error = "请填写有效的一次性时间，如 2026-06-15 09:00。";
                    result = Result;
                    return false;
                }

                schedule.OnceAt = onceAt;
                break;
        }

        if (!int.TryParse(SnoozeBox.Text.Trim(), out var snooze) || snooze < 1 || snooze > 240)
            snooze = 10;

        result = new ReminderDefinition
        {
            Id = _model.Id,
            Title = title,
            Message = MessageInputBox.Text.Trim(),
            Icon = string.IsNullOrWhiteSpace(IconBox.Text) ? "🔔" : IconBox.Text.Trim(),
            Enabled = EnabledCheck.IsChecked == true,
            IsBuiltIn = _model.IsBuiltIn,
            NotifyStyle = GetSelectedNotifyStyle(),
            PopupStyleOverride = GetSelectedPopupStyleOverride(),
            DoneLabel = DoneLabelBox.Text.Trim(),
            LaterLabel = _model.LaterLabel,
            SnoozeMinutes = snooze,
            TrackDailyStats = _model.TrackDailyStats,
            Schedule = schedule,
            Trigger = new ReminderTriggerCondition
            {
                SkipWhenIdle = SkipIdleCheck.IsChecked == true,
                IdleThresholdSeconds = _model.Trigger.IdleThresholdSeconds,
                ResetOnAcknowledge = true
            }
        };

        return true;
    }

    private void Save_OnClick(object sender, RoutedEventArgs e)
    {
        if (!TryBuildResult(out var result, out var error))
        {
            MessageBox.Show(error, Title, MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        Result = result;
        DialogResult = true;
        Close();
    }

    private void Cancel_OnClick(object sender, RoutedEventArgs e)
    {
        DialogResult = false;
        Close();
    }

    private void Test_OnClick(object sender, RoutedEventArgs e)
    {
        if (!TryBuildResult(out var result, out var error))
        {
            MessageBox.Show(error, Title, MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        TestRequested?.Invoke(result);
    }

    private static ReminderDefinition Clone(ReminderDefinition source) => new()
    {
        Id = source.Id,
        Title = source.Title,
        Message = source.Message,
        Icon = source.Icon,
        Enabled = source.Enabled,
        IsBuiltIn = source.IsBuiltIn,
        NotifyStyle = source.NotifyStyle,
        PopupStyleOverride = source.PopupStyleOverride,
        DoneLabel = source.DoneLabel,
        LaterLabel = source.LaterLabel,
        SnoozeMinutes = source.SnoozeMinutes,
        TrackDailyStats = source.TrackDailyStats,
        Schedule = new ReminderSchedule
        {
            Kind = source.Schedule.Kind,
            IntervalMinutes = source.Schedule.IntervalMinutes,
            Times = source.Schedule.Times?.ToList(),
            Weekdays = source.Schedule.Weekdays,
            DayOfMonth = source.Schedule.DayOfMonth,
            OnceAt = source.Schedule.OnceAt
        },
        Trigger = new ReminderTriggerCondition
        {
            SkipWhenIdle = source.Trigger.SkipWhenIdle,
            IdleThresholdSeconds = source.Trigger.IdleThresholdSeconds,
            ResetOnAcknowledge = source.Trigger.ResetOnAcknowledge
        }
    };

    private sealed class ComboItem<T>(string label, T kind)
    {
        public string Label { get; } = label;
        public T Kind { get; } = kind;
    }

    private sealed class PopupStyleComboItem(string label, ReminderPopupStyle? style)
    {
        public string Label { get; } = label;
        public ReminderPopupStyle? Style { get; } = style;
    }
}
