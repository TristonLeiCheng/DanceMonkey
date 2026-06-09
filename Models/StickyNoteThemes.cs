using System.Globalization;
using WpfColor = System.Windows.Media.Color;

namespace DesktopAssistant.Models;

/// <summary>桌面便签背景预设（窗口底色 + 标题栏底色）。</summary>
public static class StickyNoteThemes
{
    public const string DefaultKey = "Default";

    public static IReadOnlyList<(string Key, string DisplayName, WpfColor Window, WpfColor TitleBar)> Presets { get; } =
        new List<(string, string, WpfColor, WpfColor)>
        {
            ("Default", "默认", ParseArgb("FFFAF3C8"), ParseArgb("FFE8D88A")),
            ("Mint", "薄荷", ParseArgb("FFE8F5E9"), ParseArgb("FFC8E6C9")),
            ("Sky", "浅蓝", ParseArgb("FFE3F2FD"), ParseArgb("FFBBDEFB")),
            ("Pink", "浅粉", ParseArgb("FFFCE4EC"), ParseArgb("FFF8BBD0")),
            ("Lavender", "淡紫", ParseArgb("FFF3E5F5"), ParseArgb("FFE1BEE7")),
            ("Gray", "浅灰", ParseArgb("FFECEFF1"), ParseArgb("FFCFD8DC"))
        };

    public static (WpfColor Window, WpfColor TitleBar) GetColors(string? key)
    {
        var k = string.IsNullOrWhiteSpace(key) ? DefaultKey : key;
        foreach (var p in Presets)
        {
            if (string.Equals(p.Key, k, StringComparison.OrdinalIgnoreCase))
                return (p.Window, p.TitleBar);
        }

        return (Presets[0].Window, Presets[0].TitleBar);
    }

    private static WpfColor ParseArgb(string rrggbbWithAlpha8)
    {
        // 8 hex chars: AARRGGBB
        var v = uint.Parse(rrggbbWithAlpha8, NumberStyles.HexNumber, CultureInfo.InvariantCulture);
        return WpfColor.FromArgb(
            (byte)((v >> 24) & 0xFF),
            (byte)((v >> 16) & 0xFF),
            (byte)((v >> 8) & 0xFF),
            (byte)(v & 0xFF));
    }
}
