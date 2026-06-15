using System.Windows;
using DesktopAssistant.Models;

namespace DesktopAssistant.Services;

/// <summary>
/// 将到期提醒路由到桌面弹窗（多种样式）或宠物气泡。
/// </summary>
public sealed class ReminderNotifier
{
    public bool IsPresenting { get; private set; }

    public void Present(
        ReminderDefinition reminder,
        ScheduledReminderService service,
        MainWindow owner,
        Func<DesktopPetWindow?> getPet,
        Action<Window> trySetForeground)
    {
        if (IsPresenting) return;

        IsPresenting = true;
        try
        {
            if (reminder.NotifyStyle == ReminderNotifyStyle.PetBubble)
            {
                var pet = getPet();
                if (pet != null && pet.TryShowScheduledReminder(reminder, service))
                    return;

                owner.ShowTrayTip(
                    AppBranding.DisplayName,
                    LocalizationManager.Get("Reminder.PetFallback"),
                    3500);
            }

            var style = ReminderPopupStyleResolver.Resolve(reminder);
            var win = ReminderPopupFactory.Create(reminder, service);
            ReminderPopupFactory.ConfigurePresentation(win, style);

            win.Owner = owner;
            win.ShowActivated = true;
            win.Topmost = true;

            win.SourceInitialized += (_, _) => trySetForeground(win);
            win.Loaded += (_, _) =>
            {
                win.Activate();
                trySetForeground(win);
            };
            win.ContentRendered += (_, _) =>
            {
                win.Topmost = true;
                win.Activate();
                trySetForeground(win);
            };

            win.ShowDialog();
        }
        finally
        {
            IsPresenting = false;
        }
    }
}
