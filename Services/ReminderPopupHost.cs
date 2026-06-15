using System.Windows;
using System.Windows.Controls;
using System.Windows.Media.Animation;
using System.Windows.Media.Imaging;
using DesktopAssistant.Models;

namespace DesktopAssistant.Services;

public static class ReminderPopupHost
{
    public static BitmapSource? CaptureBackdrop(out int originX, out int originY)
    {
        originX = 0;
        originY = 0;
        if (!App.Config.Load().ReminderPopupAcrylic)
            return null;

        return ScreenFrostHelper.CaptureVirtualScreen(out originX, out originY);
    }

    public static void HookFrostLayer(
        Window window,
        Border frostLayer,
        BitmapSource? screenShot,
        int shotOriginX,
        int shotOriginY)
    {
        if (screenShot == null)
            return;

        var shot = screenShot;
        window.ContentRendered += (_, _) =>
            ApplyFrostTo(frostLayer, shot, shotOriginX, shotOriginY);
    }

    public static void ApplyFrostTo(
        Border frostLayer,
        BitmapSource? screenShot,
        int shotOriginX,
        int shotOriginY)
    {
        if (screenShot == null)
            return;

        try
        {
            var topLeft = frostLayer.PointToScreen(new System.Windows.Point(0, 0));
            var bottomRight = frostLayer.PointToScreen(
                new System.Windows.Point(frostLayer.ActualWidth, frostLayer.ActualHeight));

            var brush = ScreenFrostHelper.BuildFrostBrush(
                screenShot, shotOriginX, shotOriginY, topLeft, bottomRight);

            if (brush != null)
                frostLayer.Background = brush;
        }
        catch
        {
            // 保留回退底色
        }
    }

    public static void AcknowledgeAndClose(
        Window window,
        ReminderDefinition reminder,
        ScheduledReminderService service,
        ref bool handled)
    {
        handled = true;
        service.Acknowledge(reminder.Id);
        CloseWithAnimation(window);
    }

    public static void SnoozeAndClose(
        Window window,
        ReminderDefinition reminder,
        ScheduledReminderService service,
        ref bool handled)
    {
        handled = true;
        service.Snooze(reminder.Id);
        CloseWithAnimation(window);
    }

    public static void DismissAndClose(
        Window window,
        ReminderDefinition reminder,
        ScheduledReminderService service,
        ref bool handled)
    {
        if (!handled)
            service.Snooze(reminder.Id);
        CloseWithAnimation(window);
    }

    public static void CloseWithAnimation(Window window, int durationMs = 180)
    {
        var anim = new DoubleAnimation(1, 0, TimeSpan.FromMilliseconds(durationMs));
        anim.Completed += (_, _) => window.Close();
        window.BeginAnimation(UIElement.OpacityProperty, anim);
    }

    public static void PlayFadeIn(Window window, int durationMs = 280)
    {
        window.Opacity = 0;
        var anim = new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(durationMs));
        window.BeginAnimation(UIElement.OpacityProperty, anim);
    }

    public static void PlaySlideInFromRight(
        Window window,
        FrameworkElement root,
        double distance = 80,
        int durationMs = 320)
    {
        root.RenderTransform = new System.Windows.Media.TranslateTransform(distance, 0);
        root.RenderTransformOrigin = new System.Windows.Point(0.5, 0.5);

        var slide = new DoubleAnimation(distance, 0, TimeSpan.FromMilliseconds(durationMs))
        {
            EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut }
        };
        var fade = new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(durationMs * 0.85));
        window.BeginAnimation(UIElement.OpacityProperty, fade);
        (root.RenderTransform as System.Windows.Media.TranslateTransform)
            ?.BeginAnimation(System.Windows.Media.TranslateTransform.XProperty, slide);
    }
}
