using System.Windows;
using System.Windows.Input;
using System.Windows.Media.Imaging;
using DesktopAssistant.Models;
using DesktopAssistant.Services;

namespace DesktopAssistant;

public partial class ReminderCompactPopupWindow : Window
{
    private const double CompactHeight = 50;
    private const double ExpandedCornerRadius = 22;

    private readonly ReminderDefinition _reminder;
    private readonly ScheduledReminderService _service;
    private readonly ReminderPopupDisplay _display;
    private bool _handled;
    private bool _expanded;
    private BitmapSource? _screenShot;
    private int _shotOriginX;
    private int _shotOriginY;

    public ReminderCompactPopupWindow(ReminderDefinition reminder, ScheduledReminderService service)
    {
        _reminder = reminder;
        _service = service;
        _display = ReminderPopupContentHelper.Resolve(reminder, service);
        _screenShot = ReminderPopupHost.CaptureBackdrop(out _shotOriginX, out _shotOriginY);

        InitializeComponent();
        ApplyContent();
        ReminderPopupHost.HookFrostLayer(this, FrostLayer, _screenShot, _shotOriginX, _shotOriginY);
        PillShapeHelper.BindPillShape(RootCard, FrostLayer, TintLayer, StrokeLayer);
        PillShapeHelper.BindPillShape(ShadowHost);

        Loaded += (_, _) => ReminderPopupHost.PlaySlideInFromRight(this, ShadowHost, 60, 280);
        RootCard.MouseLeftButtonUp += OnRootTapped;
    }

    private void ApplyContent()
    {
        IconText.Text = _display.Icon;
        TitleText.Text = _display.Title;
        ExpandedDesc.Text = _display.Message;
        ExpandedDoneText.Text = _display.DoneLabel;
        ExpandedLaterBtn.Content = _display.LaterLabel;
        DoneBtn.ToolTip = _display.DoneLabel;
        LaterBtn.ToolTip = _display.LaterLabel;
    }

    private void OnRootTapped(object sender, MouseButtonEventArgs e)
    {
        if (_expanded || e.OriginalSource is System.Windows.Controls.Button)
            return;

        _expanded = true;
        CompactRow.Visibility = Visibility.Collapsed;
        ExpandedPanel.Visibility = Visibility.Visible;
        RootCard.MinHeight = 0;
        RootCard.Height = double.NaN;
        RootCard.Padding = new Thickness(0);

        var pillRadius = CompactHeight / 2.0;
        PillShapeHelper.AnimateToRounded(
            RootCard, [FrostLayer, TintLayer, StrokeLayer],
            pillRadius, ExpandedCornerRadius);
        PillShapeHelper.ApplyRounded(ShadowHost, ExpandedCornerRadius);
    }

    private void Done_OnClick(object sender, RoutedEventArgs e) =>
        ReminderPopupHost.AcknowledgeAndClose(this, _reminder, _service, ref _handled);

    private void Later_OnClick(object sender, RoutedEventArgs e) =>
        ReminderPopupHost.SnoozeAndClose(this, _reminder, _service, ref _handled);
}
