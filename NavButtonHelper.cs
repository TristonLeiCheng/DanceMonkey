using System.Windows;

namespace DesktopAssistant;

/// <summary>侧栏导航项选中态（供模板触发器使用，避免占用 <see cref="FrameworkElement.Tag"/>）。</summary>
public static class NavButtonHelper
{
    public static readonly DependencyProperty IsNavActiveProperty = DependencyProperty.RegisterAttached(
        "IsNavActive",
        typeof(bool),
        typeof(NavButtonHelper),
        new FrameworkPropertyMetadata(false, FrameworkPropertyMetadataOptions.AffectsRender));

    public static bool GetIsNavActive(DependencyObject obj) => (bool)obj.GetValue(IsNavActiveProperty);

    public static void SetIsNavActive(DependencyObject obj, bool value) => obj.SetValue(IsNavActiveProperty, value);
}
