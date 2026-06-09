using DanceMonkey.Ppt.Models;

namespace DanceMonkey.Ppt.Themes;

/// <summary>
/// 暖色杂志风：暖米底 + 橙红主色 + 琥珀辅色。
/// 适合创意分享、人文内容、教育培训、非正式汇报场景。
/// 与 ppt_scaffold/scaffold_core.py 中的 warm_magazine 配色对齐。
/// </summary>
internal static class WarmMagazineTheme
{
    public const string Id = "warm-magazine";

    public static IPptTheme Create() => new PptTheme
    {
        Id = Id,
        DisplayName = "暖色杂志",
        Description = "暖米底 / 橙红主色 / 琥珀辅色 — 创意 & 人文",
        Palette = new PptPalette
        {
            Background = "FFF7ED",
            Surface    = "FFFFFF",
            TextPrimary= "291C0F",
            TextBody   = "442C1A",
            TextMuted  = "78563A",
            Accent     = "EA580C",
            AccentSoft = "D97706",
            Divider    = "FED7AA",
        },
        FontScale = new PptFontScale
        {
            DeckTitle    = 42,
            DeckSubtitle = 18,
            SectionTitle = 32,
            SlideTitle   = 26,
            Body         = 16,
            Quote        = 24,
            Caption      = 10,
        },
        AccentBarHeight = 6,
        PagePadding     = 52,
    };
}
