using System.Windows;
using Forms = System.Windows.Forms;

namespace DesktopAssistant.Services;

public static class ReminderPopupPlacement
{
    public static void CenterOnScreen(Window window)
    {
        window.WindowStartupLocation = WindowStartupLocation.CenterScreen;
    }

    public static void TopCenter(Window window, double topMarginDip = 14)
    {
        window.WindowStartupLocation = WindowStartupLocation.Manual;
        window.Loaded += (_, _) =>
        {
            var area = Forms.Screen.PrimaryScreen?.WorkingArea
                       ?? Forms.SystemInformation.WorkingArea;
            var scale = GetDpiScale(window);
            var w = window.ActualWidth > 0 ? window.ActualWidth : window.Width;
            var left = area.Left / scale + (area.Width / scale - w) / 2;
            var top = area.Top / scale + topMarginDip;
            window.Left = left;
            window.Top = top;
        };
    }

    public static void BottomRight(Window window, double marginDip = 22)
    {
        window.WindowStartupLocation = WindowStartupLocation.Manual;
        window.Loaded += (_, _) =>
        {
            var area = Forms.Screen.PrimaryScreen?.WorkingArea
                       ?? Forms.SystemInformation.WorkingArea;
            var scale = GetDpiScale(window);
            var w = window.ActualWidth > 0 ? window.ActualWidth : window.Width;
            var h = window.ActualHeight > 0 ? window.ActualHeight : window.Height;
            window.Left = area.Right / scale - w - marginDip;
            window.Top = area.Bottom / scale - h - marginDip;
        };
    }

    public static void TopBanner(Window window, double topMarginDip = 12)
    {
        window.WindowStartupLocation = WindowStartupLocation.Manual;
        window.Loaded += (_, _) =>
        {
            var area = Forms.Screen.PrimaryScreen?.WorkingArea
                       ?? Forms.SystemInformation.WorkingArea;
            var scale = GetDpiScale(window);
            var w = window.ActualWidth > 0 ? window.ActualWidth : window.Width;
            var left = area.Left / scale + (area.Width / scale - w) / 2;
            window.Left = left;
            window.Top = area.Top / scale + topMarginDip;
        };
    }

    private static double GetDpiScale(Window window)
    {
        var source = PresentationSource.FromVisual(window);
        if (source?.CompositionTarget == null)
            return 1.0;
        return source.CompositionTarget.TransformToDevice.M11;
    }
}
