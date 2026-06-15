using System.Windows;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Imaging;
using DesktopAssistant.Models;
using DesktopAssistant.Services;

namespace DesktopAssistant;

public partial class ReminderDynamicIslandPopupWindow : Window
{
    private const double CompactHeight = 44;
    private const double CompactWidth = 420;
    private const double IdleWidth = 120;
    private const double ExpandedWidth = 420;
    private const double ExpandedHeight = 280;
    private const double ExpandedCornerRadius = 32;

    private readonly ReminderDefinition _reminder;
    private readonly ScheduledReminderService _service;
    private readonly ReminderPopupDisplay _display;
    private bool _handled;
    private bool _expanded;
    private BitmapSource? _screenShot;
    private int _shotOriginX;
    private int _shotOriginY;

    public ReminderDynamicIslandPopupWindow(ReminderDefinition reminder, ScheduledReminderService service)
    {
        _reminder = reminder;
        _service = service;
        _display = ReminderPopupContentHelper.Resolve(reminder, service);
        _screenShot = ReminderPopupHost.CaptureBackdrop(out _shotOriginX, out _shotOriginY);

        InitializeComponent();
        ApplyContent();
        ReminderPopupHost.HookFrostLayer(this, FrostLayer, _screenShot, _shotOriginX, _shotOriginY);
        IslandShell.SizeChanged += (_, _) =>
        {
            if (!_expanded)
                PillShapeHelper.ApplyPillRadius(IslandShell, FrostLayer, TintLayer);
        };
        Loaded += OnLoaded;
    }

    private void ApplyContent()
    {
        IconText.Text = _display.Icon;
        TitleText.Text = _display.Title;
        ExpandedIconText.Text = _display.Icon;
        ExpandedTitleText.Text = _display.Title;
        ExpandedSubtitleText.Text = Truncate(_display.Message, 42);
        DescText.Text = _display.Message;
        DoneBtnText.Text = _display.DoneLabel;
        LaterBtn.Content = _display.LaterLabel;
        CompactHintText.Text = LocalizationManager.Get("Reminder.Island.TapExpand");

        var stats = ReminderPopupContentHelper.FormatStats(_display);
        if (stats != null)
        {
            StatsText.Text = stats;
            StatsText.Visibility = Visibility.Visible;
        }
        else
        {
            StatsText.Visibility = Visibility.Collapsed;
        }
    }

    private void OnLoaded(object sender, RoutedEventArgs e)
    {
        Loaded -= OnLoaded;
        PlayEntranceAnimation();
        StartPulseAnimation();
    }

    /// <summary>从 idle 小胶囊弹性展开到完整长条。</summary>
    private void PlayEntranceAnimation()
    {
        IslandShell.Width = IdleWidth;
        IslandShell.Height = CompactHeight;
        PillShapeHelper.ApplyPillRadius(IslandShell, FrostLayer, TintLayer);
        Opacity = 0;

        var ease = new CubicEase { EasingMode = EasingMode.EaseOut };

        var fade = new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(260)) { EasingFunction = ease };
        BeginAnimation(OpacityProperty, fade);

        var widthAnim = new DoubleAnimation(IdleWidth, CompactWidth, TimeSpan.FromMilliseconds(520))
        {
            EasingFunction = new ElasticEase { Oscillations = 1, Springiness = 3, EasingMode = EasingMode.EaseOut }
        };
        widthAnim.Completed += (_, _) =>
            PillShapeHelper.ApplyPillRadius(IslandShell, FrostLayer, TintLayer);
        IslandShell.BeginAnimation(FrameworkElement.WidthProperty, widthAnim);
    }

    private void StartPulseAnimation()
    {
        var pulse = new DoubleAnimation(1, 0.35, TimeSpan.FromMilliseconds(900))
        {
            AutoReverse = true,
            RepeatBehavior = RepeatBehavior.Forever,
            EasingFunction = new SineEase { EasingMode = EasingMode.EaseInOut }
        };
        PulseDot.BeginAnimation(UIElement.OpacityProperty, pulse);
    }

    private void IslandShell_OnTap(object sender, MouseButtonEventArgs e)
    {
        if (_expanded)
            return;

        if (e.OriginalSource is System.Windows.Controls.Button)
            return;

        e.Handled = true;
        ExpandIsland();
    }

    private void ExpandIsland()
    {
        _expanded = true;
        IslandShell.Cursor = Cursors.Arrow;
        IslandShell.MouseLeftButtonUp -= IslandShell_OnTap;

        PulseDot.BeginAnimation(UIElement.OpacityProperty, null);
        PulseDot.Opacity = 1;

        CompactRow.Visibility = Visibility.Collapsed;
        ExpandedPanel.Visibility = Visibility.Visible;

        var targetHeight = StatsText.Visibility == Visibility.Visible
            ? ExpandedHeight
            : ExpandedHeight - 22;

        var ease = new CubicEase { EasingMode = EasingMode.EaseOut };

        var heightAnim = new DoubleAnimation(CompactHeight, targetHeight, TimeSpan.FromMilliseconds(420))
        {
            EasingFunction = ease
        };
        IslandShell.BeginAnimation(FrameworkElement.HeightProperty, heightAnim);

        var pillRadius = CompactHeight / 2.0;
        PillShapeHelper.AnimateToRounded(
            IslandShell, [FrostLayer, TintLayer],
            pillRadius, ExpandedCornerRadius);

        var widthAnim = new DoubleAnimation(CompactWidth, ExpandedWidth, TimeSpan.FromMilliseconds(420))
        {
            EasingFunction = ease
        };
        IslandShell.BeginAnimation(FrameworkElement.WidthProperty, widthAnim);

        var fadeAnim = new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(320))
        {
            BeginTime = TimeSpan.FromMilliseconds(120),
            EasingFunction = ease
        };
        ExpandedPanel.BeginAnimation(UIElement.OpacityProperty, fadeAnim);
    }

    private void Done_OnClick(object sender, RoutedEventArgs e) =>
        ReminderPopupHost.AcknowledgeAndClose(this, _reminder, _service, ref _handled);

    private void Later_OnClick(object sender, RoutedEventArgs e) =>
        ReminderPopupHost.SnoozeAndClose(this, _reminder, _service, ref _handled);

    private void Close_OnClick(object sender, RoutedEventArgs e) =>
        ReminderPopupHost.DismissAndClose(this, _reminder, _service, ref _handled);

    private static string Truncate(string text, int max) =>
        text.Length <= max ? text : text[..max] + "…";
}
