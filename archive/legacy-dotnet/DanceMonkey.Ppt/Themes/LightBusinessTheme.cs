using DanceMonkey.Ppt.Models;

namespace DanceMonkey.Ppt.Themes;

/// <summary>
/// 浅色商务高级感：米白底 + 深灰文 + 深蓝主色 + 金色辅助。默认主题。
/// 视觉目标：克制、专业、可读性高，适合管理层、客户、对外汇报场景。
/// </summary>
internal static class LightBusinessTheme
{
    public const string Id = "light-business";

    public static IPptTheme Create() => new PptTheme
    {
        Id = Id,
        DisplayName = "浅色商务",
        Description = "米白底 / 深蓝主色 / 金色辅助 — 克制专业",
        Palette = new PptPalette
        {
            Background = "FAFAF7",
            Surface    = "FFFFFF",
            TextPrimary= "1A2233",
            TextBody   = "3A4252",
            TextMuted  = "8A8F9C",
            Accent     = "1F3A8A",
            AccentSoft = "C9A14A",
            Divider    = "E2E4EA",
        },
        FontScale = new PptFontScale
        {
            DeckTitle    = 42,
            DeckSubtitle = 18,
            SectionTitle = 32,
            SlideTitle   = 26,
            Body         = 16,
            Quote        = 22,
            Caption      = 10,
        },
        AccentBarHeight = 5,
        PagePadding     = 56,
    };
}
