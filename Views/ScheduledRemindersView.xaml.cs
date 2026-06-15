using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using DesktopAssistant.Models;
using DesktopAssistant.Services;
using MediaBrush = System.Windows.Media.Brush;
using OpenFileDialog = Microsoft.Win32.OpenFileDialog;
using SaveFileDialog = Microsoft.Win32.SaveFileDialog;

namespace DesktopAssistant.Views;

public partial class ScheduledRemindersView : UserControl
{
    private readonly ScheduledReminderService _service;
    private readonly Action<ReminderDefinition> _testReminder;

    public ScheduledRemindersView(ScheduledReminderService service, Action<ReminderDefinition> testReminder)
    {
        _service = service;
        _testReminder = testReminder;
        InitializeComponent();
        Loaded += (_, _) =>
        {
            var cfg = App.Config.Load();
            AcrylicCheck.IsChecked = cfg.ReminderPopupAcrylic;
            InitPopupStyleCombo(cfg.DefaultReminderPopupStyle);
            Reload();
        };
    }

    private void InitPopupStyleCombo(ReminderPopupStyle selected)
    {
        DefaultPopupStyleCombo.ItemsSource = Enum.GetValues<ReminderPopupStyle>()
            .Select(s => new PopupStyleItem(ReminderPopupStyleResolver.Describe(s), s))
            .ToList();
        DefaultPopupStyleCombo.DisplayMemberPath = nameof(PopupStyleItem.Label);
        DefaultPopupStyleCombo.SelectedValuePath = nameof(PopupStyleItem.Style);

        foreach (PopupStyleItem item in DefaultPopupStyleCombo.Items)
        {
            if (item.Style == selected)
            {
                DefaultPopupStyleCombo.SelectedItem = item;
                return;
            }
        }

        DefaultPopupStyleCombo.SelectedIndex = 0;
    }

    public void Reload()
    {
        var cfg = App.Config.Load();
        _service.Reload(cfg);
        ReminderListPanel.Children.Clear();

        foreach (var reminder in _service.Reminders)
            ReminderListPanel.Children.Add(BuildCard(reminder));
    }

    private Border BuildCard(ReminderDefinition reminder)
    {
        var card = new Border
        {
            Style = (Style)FindResource("UiCard"),
            Margin = new Thickness(0, 0, 0, 10),
            Padding = new Thickness(16, 14, 16, 14)
        };

        var grid = new Grid();
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

        var icon = new TextBlock
        {
            Text = string.IsNullOrWhiteSpace(reminder.Icon) ? "🔔" : reminder.Icon,
            FontSize = 28,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(0, 0, 14, 0)
        };
        Grid.SetColumn(icon, 0);
        grid.Children.Add(icon);

        var info = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
        info.Children.Add(new TextBlock
        {
            Text = reminder.Title,
            FontSize = 15,
            FontWeight = FontWeights.SemiBold,
            Foreground = (MediaBrush)FindResource("BrushTextPrimary")
        });
        info.Children.Add(new TextBlock
        {
            Text = ReminderScheduleHelper.DescribeSchedule(reminder),
            FontSize = 12.5,
            Foreground = (MediaBrush)FindResource("BrushTextSecondary"),
            Margin = new Thickness(0, 4, 0, 0)
        });
        info.Children.Add(new TextBlock
        {
            Text = ReminderScheduleHelper.DescribeReminderPresentation(reminder),
            FontSize = 12,
            Foreground = (MediaBrush)FindResource("BrushTextMuted"),
            Margin = new Thickness(0, 2, 0, 0)
        });
        Grid.SetColumn(info, 1);
        grid.Children.Add(info);

        var actions = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            VerticalAlignment = VerticalAlignment.Center
        };

        var toggle = new CheckBox
        {
            Content = "启用",
            IsChecked = reminder.Enabled,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(0, 0, 10, 0)
        };
        toggle.Checked += (_, _) => SetEnabled(reminder, true);
        toggle.Unchecked += (_, _) => SetEnabled(reminder, false);
        actions.Children.Add(toggle);

        actions.Children.Add(MakeActionButton("编辑", (_, _) => EditReminder(reminder)));
        actions.Children.Add(MakeActionButton("测试", (_, _) => _testReminder(reminder)));

        if (reminder.IsBuiltIn)
            actions.Children.Add(MakeActionButton("恢复默认", (_, _) => ResetBuiltIn(reminder)));
        else
            actions.Children.Add(MakeActionButton("删除", (_, _) => DeleteReminder(reminder)));

        Grid.SetColumn(actions, 2);
        grid.Children.Add(actions);

        card.Child = grid;
        return card;
    }

    private Button MakeActionButton(string text, RoutedEventHandler click)
    {
        var btn = new Button
        {
            Content = text,
            Style = (Style)FindResource("UiBtnSecondary"),
            Padding = new Thickness(12, 6, 12, 6),
            Margin = new Thickness(6, 0, 0, 0)
        };
        btn.Click += click;
        return btn;
    }

    private void SetEnabled(ReminderDefinition reminder, bool enabled)
    {
        var cfg = App.Config.Load();
        _service.SetReminderEnabled(reminder.Id, enabled, cfg);
        Reload();
    }

    private void EditReminder(ReminderDefinition reminder)
    {
        var dlg = new ReminderEditDialog(reminder, isNew: false)
        {
            Owner = Window.GetWindow(this)
        };
        dlg.TestRequested += _testReminder;
        if (dlg.ShowDialog() != true)
            return;

        var cfg = App.Config.Load();
        _service.SaveReminder(dlg.Result, cfg);
        Reload();
    }

    private void Add_OnClick(object sender, RoutedEventArgs e)
    {
        var draft = new ReminderDefinition
        {
            Title = "新提醒",
            Message = "记得处理这件事。",
            Icon = "🔔",
            Schedule = new ReminderSchedule
            {
                Kind = ReminderRepeatKind.IntervalMinutes,
                IntervalMinutes = 60
            }
        };

        var dlg = new ReminderEditDialog(draft, isNew: true)
        {
            Owner = Window.GetWindow(this)
        };
        dlg.TestRequested += _testReminder;
        if (dlg.ShowDialog() != true)
            return;

        var cfg = App.Config.Load();
        _service.SaveReminder(dlg.Result, cfg);
        Reload();
    }

    private void DeleteReminder(ReminderDefinition reminder)
    {
        if (MessageBox.Show($"确定删除提醒「{reminder.Title}」？", "删除提醒",
                MessageBoxButton.YesNo, MessageBoxImage.Question) != MessageBoxResult.Yes)
            return;

        _service.DeleteReminder(reminder.Id);
        Reload();
    }

    private void ResetBuiltIn(ReminderDefinition reminder)
    {
        var cfg = App.Config.Load();
        _service.ResetBuiltIn(reminder.Id, cfg);
        Reload();
    }

    private void Export_OnClick(object sender, RoutedEventArgs e)
    {
        var dlg = new SaveFileDialog
        {
            Title = L("Reminder.Export"),
            Filter = "JSON (*.json)|*.json",
            FileName = $"reminders-{DateTime.Now:yyyyMMdd}.json",
            AddExtension = true
        };

        if (dlg.ShowDialog() != true)
            return;

        try
        {
            _service.ExportReminders(dlg.FileName);
            MessageBox.Show(L("Reminder.ExportOk"), L("Reminder.Export"), MessageBoxButton.OK, MessageBoxImage.Information);
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, L("Reminder.Export"), MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void ImportMerge_OnClick(object sender, RoutedEventArgs e) =>
        ImportFromFile(merge: true);

    private void ImportReplace_OnClick(object sender, RoutedEventArgs e) =>
        ImportFromFile(merge: false);

    private void ImportFromFile(bool merge)
    {
        var dlg = new OpenFileDialog
        {
            Title = merge ? L("Reminder.ImportMerge") : L("Reminder.ImportReplace"),
            Filter = "JSON (*.json)|*.json"
        };

        if (dlg.ShowDialog() != true)
            return;

        if (!merge)
        {
            if (MessageBox.Show(L("Reminder.ImportReplaceConfirm"), L("Reminder.ImportReplace"),
                    MessageBoxButton.YesNo, MessageBoxImage.Warning) != MessageBoxResult.Yes)
                return;
        }

        try
        {
            var cfg = App.Config.Load();
            var count = merge
                ? _service.ImportRemindersMerge(dlg.FileName)
                : _service.ImportRemindersReplace(dlg.FileName, cfg);

            Reload();
            var msg = merge
                ? string.Format(L("Reminder.ImportMergeOk"), count)
                : string.Format(L("Reminder.ImportReplaceOk"), count);
            MessageBox.Show(msg, L("Reminder.ImportTitle"), MessageBoxButton.OK, MessageBoxImage.Information);
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, L("Reminder.ImportTitle"), MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void AcrylicCheck_OnChanged(object sender, RoutedEventArgs e)
    {
        if (!IsLoaded)
            return;

        var cfg = App.Config.Load();
        cfg.ReminderPopupAcrylic = AcrylicCheck.IsChecked == true;
        App.Config.Save(cfg);
    }

    private void DefaultPopupStyle_OnChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!IsLoaded || DefaultPopupStyleCombo.SelectedItem is not PopupStyleItem item)
            return;

        var cfg = App.Config.Load();
        cfg.DefaultReminderPopupStyle = item.Style;
        App.Config.Save(cfg);
        Reload();
    }

    private sealed record PopupStyleItem(string Label, ReminderPopupStyle Style);

    private static string L(string key) => LocalizationManager.Get(key);
}
