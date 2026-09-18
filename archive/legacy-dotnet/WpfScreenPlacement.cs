using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using FormsScreen = System.Windows.Forms.Screen;

namespace DesktopAssistant;

/// <summary>
/// WinForms <see cref="FormsScreen.WorkingArea"/> 等为 GDI 物理像素，WPF <see cref="Window.Left"/>/<see cref="Window.Top"/> 为 DIP。
/// 混用会导致缩放非 100% 时窗口被摆到屏幕外。
/// </summary>
internal static class WpfScreenPlacement
{
    private const uint MonitorDefaultToNearest = 2;
    private const int MdtEffectiveDpi = 0;

    [StructLayout(LayoutKind.Sequential)]
    private struct RectNative
    {
        public int Left, Top, Right, Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PointNative
    {
        public int X, Y;
    }

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromPoint(PointNative pt, uint dwFlags);

    [DllImport("shcore.dll", CharSet = CharSet.Unicode)]
    private static extern int GetDpiForMonitor(IntPtr hmonitor, int dpiType, out uint dpiX, out uint dpiY);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out RectNative lpRect);

    /// <summary>将指定屏幕的工作区从物理像素转为 DIP 矩形。</summary>
    public static Rect GetWorkingAreaDip(FormsScreen screen)
    {
        var wa = screen.WorkingArea;
        var pt = new PointNative
        {
            X = wa.Left + Math.Max(1, wa.Width / 2),
            Y = wa.Top + Math.Max(1, wa.Height / 2)
        };
        var hMonitor = MonitorFromPoint(pt, MonitorDefaultToNearest);
        uint dpiX = 96, dpiY = 96;
        if (hMonitor != IntPtr.Zero && GetDpiForMonitor(hMonitor, MdtEffectiveDpi, out dpiX, out dpiY) != 0)
        {
            dpiX = 96;
            dpiY = 96;
        }

        var dipLeft = wa.Left * 96.0 / dpiX;
        var dipTop = wa.Top * 96.0 / dpiY;
        var dipW = wa.Width * 96.0 / dpiX;
        var dipH = wa.Height * 96.0 / dpiY;
        return new Rect(dipLeft, dipTop, dipW, dipH);
    }

    /// <summary>主窗口中心在屏幕上的物理像素，供 <see cref="FormsScreen.FromPoint"/> 使用。</summary>
    public static bool TryGetMainWindowCenterPhysical(Window window, out int x, out int y)
    {
        x = 0;
        y = 0;
        var helper = new WindowInteropHelper(window);
        if (helper.Handle == IntPtr.Zero)
            helper.EnsureHandle();
        if (helper.Handle == IntPtr.Zero)
            return false;
        if (!GetWindowRect(helper.Handle, out var rc))
            return false;
        x = (rc.Left + rc.Right) / 2;
        y = (rc.Top + rc.Bottom) / 2;
        return true;
    }
}
