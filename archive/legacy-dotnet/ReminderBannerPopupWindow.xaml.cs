using System.Windows;
using System.Windows.Media.Imaging;
using DesktopAssistant.Models;
using DesktopAssistant.Services;

namespace DesktopAssistant;

public partial class ReminderBannerPopupWindow : Window
{
    private readonly ReminderDefinition _reminder;
    private readonly ScheduledReminderService _service;
    private readonly ReminderPopupDisplay _display;
    private bool _handled;
    private BitmapSource? _screenShot;
    private int _shotOriginX;
    private int _shotOriginY;

    public ReminderBannerPopupWindow(ReminderDefinition reminder, ScheduledReminderService service)
    {
        _reminder = reminder;
        _service = service;
        _display = ReminderPopupContentHelper.Resolve(reminder, service);
        _screenShot = ReminderPopupHost.CaptureBackdrop(out _shotOriginX, out _shotOriginY);

        InitializeComponent();
        ApplyContent();
        ReminderPopupHost.HookFrostLayer(this, FrostLayer, _screenShot, _shotOriginX, _shotOriginY);
        Loaded += (_, _) => ReminderPopupHost.PlayFadeIn(this, 240);
    }

    private void ApplyContent()
    {
        IconText.Text = _display.Icon;
        TitleText.Text = _display.Title;
        DescText.Text = _display.Message;
        DoneBtnText.Text = _display.DoneLabel;
        LaterBtn.Content = _display.LaterLabel;

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

    private void Done_OnClick(object sender, RoutedEventArgs e) =>
        ReminderPopupHost.AcknowledgeAndClose(this, _reminder, _service, ref _handled);

    private void Later_OnClick(object sender, RoutedEventArgs e) =>
        ReminderPopupHost.SnoozeAndClose(this, _reminder, _service, ref _handled);

    private void Close_OnClick(object sender, RoutedEventArgs e) =>
        ReminderPopupHost.DismissAndClose(this, _reminder, _service, ref _handled);
}
