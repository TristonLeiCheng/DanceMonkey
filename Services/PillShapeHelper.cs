using System.Windows;
using System.Windows.Controls;
using System.Windows.Media.Animation;

namespace DesktopAssistant.Services;

/// <summary>
/// 让 Border 呈现标准胶囊（pill）外形：圆角半径 = 高度的一半。
/// </summary>
public static class PillShapeHelper
{
    public static void BindPillShape(Border shell, params Border[] innerLayers)
    {
        void OnSizeChanged(object _, SizeChangedEventArgs __) =>
            ApplyPillRadius(shell, innerLayers);

        void OnLoaded(object _, RoutedEventArgs __) =>
            ApplyPillRadius(shell, innerLayers);

        shell.SizeChanged += OnSizeChanged;
        shell.Loaded += OnLoaded;
    }

    public static void ApplyPillRadius(Border shell, params Border[] innerLayers)
    {
        var h = shell.ActualHeight;
        if (h < 2)
            return;

        var r = h / 2.0;
        var radius = new CornerRadius(r);
        shell.CornerRadius = radius;

        foreach (var layer in innerLayers)
            layer.CornerRadius = radius;
    }

    public static void ApplyRounded(Border shell, double radius, params Border[] innerLayers)
    {
        var cr = new CornerRadius(radius);
        shell.CornerRadius = cr;
        foreach (var layer in innerLayers)
            layer.CornerRadius = cr;
    }

    /// <summary>展开动画期间圆角从胶囊过渡到圆角矩形。</summary>
    public static void AnimateToRounded(
        Border shell,
        Border[] innerLayers,
        double fromRadius,
        double toRadius,
        int durationMs = 420)
    {
        var ease = new CubicEase { EasingMode = EasingMode.EaseOut };
        // CornerRadius 无法直接动画，分步插值
        var start = DateTime.UtcNow;
        var duration = TimeSpan.FromMilliseconds(durationMs);

        var timer = new System.Windows.Threading.DispatcherTimer
        {
            Interval = TimeSpan.FromMilliseconds(16)
        };

        timer.Tick += (_, _) =>
        {
            var t = (DateTime.UtcNow - start).TotalMilliseconds / duration.TotalMilliseconds;
            if (t >= 1)
            {
                timer.Stop();
                ApplyRounded(shell, toRadius, innerLayers);
                return;
            }

            t = ease.Ease(t);
            var r = fromRadius + (toRadius - fromRadius) * t;
            ApplyRounded(shell, r, innerLayers);
        };

        timer.Start();
    }
}
