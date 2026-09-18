using DesktopAssistant.Models;

namespace DesktopAssistant.Services;

public static class ReminderPopupStyleResolver
{
    public static ReminderPopupStyle Resolve(ReminderDefinition reminder)
    {
        if (reminder.PopupStyleOverride.HasValue)
            return reminder.PopupStyleOverride.Value;

        return App.Config.Load().DefaultReminderPopupStyle;
    }

    public static string Describe(ReminderPopupStyle style) => style switch
    {
        ReminderPopupStyle.GlassCard => L("Reminder.PopupStyle.GlassCard"),
        ReminderPopupStyle.Circular => L("Reminder.PopupStyle.Circular"),
        ReminderPopupStyle.DynamicIsland => L("Reminder.PopupStyle.DynamicIsland"),
        ReminderPopupStyle.Toast => L("Reminder.PopupStyle.Toast"),
        ReminderPopupStyle.Banner => L("Reminder.PopupStyle.Banner"),
        ReminderPopupStyle.Compact => L("Reminder.PopupStyle.Compact"),
        _ => L("Reminder.PopupStyle.GlassCard")
    };

    public static string DescribeForReminder(ReminderDefinition reminder)
    {
        if (reminder.NotifyStyle == ReminderNotifyStyle.PetBubble)
            return L("Reminder.Notify.PetBubble");

        var style = Resolve(reminder);
        if (reminder.PopupStyleOverride.HasValue)
            return string.Format(L("Reminder.Notify.DesktopCustom"), Describe(style));

        return string.Format(L("Reminder.Notify.DesktopDefault"), Describe(style));
    }

    private static string L(string key) => LocalizationManager.Get(key);
}
