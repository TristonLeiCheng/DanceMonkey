using DanceMonkey.Ppt.Models;
using ShapeCrawler;
using ShapeCrawler.Presentations;

namespace DanceMonkey.Ppt.Rendering.SlideBuilders;

/// <summary>
/// 结束页 — 「几何面板收尾」设计：
/// 与封面呼应：右侧强调色装饰面板 + 左区主文字 + 底部品牌。
/// 比封面略微内敛（AccentSoft 作面板基色），避免重复的视觉冲击。
/// </summary>
internal sealed class EndingSlideBuilder : ISlideBuilder
{
    public PptLayoutHint LayoutHint => PptLayoutHint.Ending;

    public void Build(DraftSlide draft, PptSlide slide, SlideLayoutContext ctx)
    {
        var theme = ctx.Theme;
        var deckTitle = ctx.DeckTitle ?? slide.Title ?? "演示文稿";

        // ── 右侧装饰面板（与封面呼应，用 AccentSoft 弱化，避免视觉疲劳）──
        const int panelX = 640;
        draft.RectangleShape(r =>
        {
            r.X(panelX); r.Y(0); r.Width(SlideDrawing.SlideWidth - panelX); r.Height(SlideDrawing.SlideHeight);
            r.SolidFill(f => f.Color(theme.Palette.AccentSoft));
        });
        // 面板左边装饰细条（Accent 色）
        draft.RectangleShape(r =>
        {
            r.X(panelX); r.Y(0); r.Width(12); r.Height(SlideDrawing.SlideHeight);
            r.SolidFill(f => f.Color(theme.Palette.Accent));
        });

        // ── 顶部通栏装饰条 ────────────────────────────────────────────────────
        SlideDrawing.TopAccentBar(draft, theme);

        // ── 标题区左侧细竖线 ──────────────────────────────────────────────────
        SlideDrawing.LeftAccentBar(draft, theme, x: 60, y: 130, width: 4, height: 160);

        // ── 主文字：感谢语 ────────────────────────────────────────────────────
        SlideDrawing.Text(draft, "Thank You",
            x: 80, y: 130, width: 520, height: 80,
            fontSize: theme.FontScale.DeckTitle + 4, bold: true);

        // ── 短分隔条 ──────────────────────────────────────────────────────────
        SlideDrawing.AccentDivider(draft, theme, x: 80, y: 224, width: 80, height: 3);

        // ── Deck 标题副文字 ────────────────────────────────────────────────────
        SlideDrawing.Text(draft, deckTitle,
            x: 80, y: 236, width: 520, height: 50,
            fontSize: theme.FontScale.DeckSubtitle);

        // ── 底部品牌 ──────────────────────────────────────────────────────────
        SlideDrawing.BrandFooter(draft, theme, "Powered by DanceMonkey AI");
    }
}

