using System.Windows;
using DesktopAssistant.Models;

namespace DesktopAssistant.Services;

public static class ReminderPopupFactory
{
    public static Window Create(ReminderDefinition reminder, ScheduledReminderService service)
    {
        var style = ReminderPopupStyleResolver.Resolve(reminder);
        return style switch
        {
            ReminderPopupStyle.Circular => new ReminderCircularPopupWindow(reminder, service),
            ReminderPopupStyle.DynamicIsland => new ReminderDynamicIslandPopupWindow(reminder, service),
            ReminderPopupStyle.Toast => new ReminderToastPopupWindow(reminder, service),
            ReminderPopupStyle.Banner => new ReminderBannerPopupWindow(reminder, service),
            ReminderPopupStyle.Compact => new ReminderCompactPopupWindow(reminder, service),
            _ => new ReminderPopupWindow(reminder, service)
        };
    }

    public static void ConfigurePresentation(Window window, ReminderPopupStyle style)
    {
        switch (style)
        {
            case ReminderPopupStyle.DynamicIsland:
                ReminderPopupPlacement.TopCenter(window, 2);
                break;
            case ReminderPopupStyle.Toast:
            case ReminderPopupStyle.Compact:
                ReminderPopupPlacement.BottomRight(window);
                break;
            case ReminderPopupStyle.Banner:
                ReminderPopupPlacement.TopBanner(window, 8);
                break;
            default:
                ReminderPopupPlacement.CenterOnScreen(window);
                break;
        }
    }
}
