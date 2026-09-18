using DanceMonkey.Ppt.Models;

namespace DanceMonkey.Ppt.Themes;

/// <summary>
/// 科技蓝：冷灰底 + 蓝色系主色 + 青色强调。适合产品介绍、技术分享。
/// </summary>
internal static class TechBlueTheme
{
    public const string Id = "tech-blue";

    public static IPptTheme Create() => new PptTheme
    {
        Id = Id,
        DisplayName = "科技蓝",
        Description = "冷灰底 / 深蓝主色 / 青色强调 — 产品 & 技术",
        Palette = new PptPalette
        {
            Background = "F4F6FA",
            Surface    = "FFFFFF",
            TextPrimary= "0F2541",
            TextBody   = "33445C",
            TextMuted  = "7A8696",
            Accent     = "2563EB",
            AccentSoft = "06B6D4",
            Divider    = "D8DEE8",
        },
        FontScale = new PptFontScale
        {
            DeckTitle    = 40,
            DeckSubtitle = 18,
            SectionTitle = 30,
            SlideTitle   = 26,
            Body         = 16,
            Quote        = 22,
            Caption      = 10,
        },
        AccentBarHeight = 6,
        PagePadding     = 48,
    };
}
