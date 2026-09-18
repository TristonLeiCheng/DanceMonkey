using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Effects;
using System.Windows.Media.Imaging;
using Drawing = System.Drawing;
using Forms = System.Windows.Forms;

namespace DesktopAssistant.Services;

/// <summary>
/// 截取屏幕背景并做高斯模糊，生成可作为窗口背景的"毛玻璃"画刷。
/// 适用于 AllowsTransparency=True 的分层窗口（此时系统 Acrylic 无效），
/// 在 Win10/Win11 上都能稳定呈现真实磨砂质感。
/// </summary>
public static class ScreenFrostHelper
{
    [DllImport("gdi32.dll")]
    private static extern bool DeleteObject(IntPtr hObject);

    /// <summary>在窗口显示前调用，截取整个虚拟桌面（设备像素）。</summary>
    public static BitmapSource? CaptureVirtualScreen(out int originX, out int originY)
    {
        originX = 0;
        originY = 0;
        try
        {
            var vs = Forms.SystemInformation.VirtualScreen;
            if (vs.Width <= 0 || vs.Height <= 0)
                return null;

            originX = vs.Left;
            originY = vs.Top;

            using var bmp = new Drawing.Bitmap(vs.Width, vs.Height, Drawing.Imaging.PixelFormat.Format32bppArgb);
            using (var g = Drawing.Graphics.FromImage(bmp))
            {
                g.CopyFromScreen(vs.Left, vs.Top, 0, 0, vs.Size, Drawing.CopyPixelOperation.SourceCopy);
            }

            var hbmp = bmp.GetHbitmap();
            try
            {
                var src = System.Windows.Interop.Imaging.CreateBitmapSourceFromHBitmap(
                    hbmp, IntPtr.Zero, Int32Rect.Empty, BitmapSizeOptions.FromEmptyOptions());
                src.Freeze();
                return src;
            }
            finally
            {
                DeleteObject(hbmp);
            }
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// 从整屏截图中裁出窗口所在区域并高斯模糊，返回可直接当作 Border.Background 的画刷。
    /// </summary>
    /// <param name="deviceTopLeft">窗口可见区域左上角（设备像素，来自 PointToScreen）。</param>
    /// <param name="deviceBottomRight">窗口可见区域右下角（设备像素）。</param>
    public static ImageBrush? BuildFrostBrush(
        BitmapSource fullScreen,
        int originX,
        int originY,
        System.Windows.Point deviceTopLeft,
        System.Windows.Point deviceBottomRight,
        double blurRadius = 26)
    {
        try
        {
            var x = (int)Math.Round(deviceTopLeft.X) - originX;
            var y = (int)Math.Round(deviceTopLeft.Y) - originY;
            var w = (int)Math.Round(deviceBottomRight.X - deviceTopLeft.X);
            var h = (int)Math.Round(deviceBottomRight.Y - deviceTopLeft.Y);
            if (w <= 1 || h <= 1)
                return null;

            x = Math.Clamp(x, 0, Math.Max(0, fullScreen.PixelWidth - 1));
            y = Math.Clamp(y, 0, Math.Max(0, fullScreen.PixelHeight - 1));
            w = Math.Clamp(w, 1, fullScreen.PixelWidth - x);
            h = Math.Clamp(h, 1, fullScreen.PixelHeight - y);

            var crop = new CroppedBitmap(fullScreen, new Int32Rect(x, y, w, h));

            var visual = new DrawingVisual
            {
                Effect = new BlurEffect
                {
                    Radius = blurRadius,
                    KernelType = KernelType.Gaussian,
                    RenderingBias = RenderingBias.Performance
                }
            };
            using (var dc = visual.RenderOpen())
            {
                dc.DrawImage(crop, new Rect(0, 0, w, h));
            }

            var rtb = new RenderTargetBitmap(w, h, 96, 96, PixelFormats.Pbgra32);
            rtb.Render(visual);
            rtb.Freeze();

            return new ImageBrush(rtb)
            {
                Stretch = Stretch.Fill
            };
        }
        catch
        {
            return null;
        }
    }
}
