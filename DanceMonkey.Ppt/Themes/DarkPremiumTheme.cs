using DanceMonkey.Ppt.Models;

namespace DanceMonkey.Ppt.Themes;

/// <summary>
/// 深色高端：迁移自现有 PptGenerationService 的深色扁平配色，
/// 用于「深色高端 / 发布会风格」。后续 P1 渲染统一后，桌面端旧调用走该主题以保持视觉延续。
/// </summary>
internal static class DarkPremiumTheme
{
    public const string Id = "dark-premium";

    public static IPptTheme Create() => new PptTheme
    {
        Id = Id,
        DisplayName = "深色高端",
        Description = "深蓝黑 / 浅白文 / 蓝紫主色 — 发布会 & 高端",
        Palette = new PptPalette
        {
            Background = "0F1219",
            Surface    = "1A1E2E",
            TextPrimary= "FFFFFF",
            TextBody   = "E2E4EC",
            TextMuted  = "8B90A8",
            Accent     = "4F6EF7",
            AccentSoft = "38B2AC",
            Divider    = "2A2F42",
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
