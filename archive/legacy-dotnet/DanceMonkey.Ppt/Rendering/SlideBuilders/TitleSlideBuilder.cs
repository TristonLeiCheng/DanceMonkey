using DanceMonkey.Ppt.Models;
using ShapeCrawler;
using ShapeCrawler.Presentations;

namespace DanceMonkey.Ppt.Rendering.SlideBuilders;

/// <summary>
/// 封面页 — 「非对称色块」设计：
/// 左 60% 浅色区承载标题文字，右 40% 满高纯色装饰面板制造视觉重量。
/// 强调色面板不放任何文字，避免字色后处理冲突。
/// </summary>
internal sealed class TitleSlideBuilder : ISlideBuilder
{
    public PptLayoutHint LayoutHint => PptLayoutHint.Title;

    public void Build(DraftSlide draft, PptSlide slide, SlideLayoutContext ctx)
    {
        var theme = ctx.Theme;
        var deckTitle = !string.IsNullOrWhiteSpace(slide.Title) ? slide.Title! : (ctx.DeckTitle ?? "演示文稿");
        var subtitle = !string.IsNullOrWhiteSpace(slide.Subtitle)
            ? slide.Subtitle!
            : $"共 {Math.Max(1, ctx.TotalPages - 2)} 个章节  ·  由 AI 自动生成";
        var brand = string.IsNullOrWhiteSpace(ctx.Author) ? null : ctx.Author;

        // ── 右侧满高装饰面板（纯色，不含文字）──────────────────────────────────
        const int panelX = 580;
        draft.RectangleShape(r =>
        {
            r.X(panelX); r.Y(0); r.Width(SlideDrawing.SlideWidth - panelX); r.Height(SlideDrawing.SlideHeight);
            r.SolidFill(f => f.Color(theme.Palette.Accent));
        });

        // 面板上叠加 AccentSoft 小矩形作内部层次装饰
        draft.RectangleShape(r =>
        {
            r.X(panelX); r.Y(0); r.Width(16); r.Height(SlideDrawing.SlideHeight);
            r.SolidFill(f => f.Color(theme.Palette.AccentSoft));
        });

        // ── 顶部通栏装饰条（覆盖在面板上方，保持视觉一致性）──────────────────
        SlideDrawing.TopAccentBar(draft, theme);

        // ── 左侧细竖线（标题区锚点）────────────────────────────────────────────
        SlideDrawing.LeftAccentBar(draft, theme, x: 52, y: 110, width: 4, height: 210);

        // ── 主标题 ──────────────────────────────────────────────────────────────
        // 可用宽度 = panelX - 左边距 - 右间距 = 580 - 52 - 40 = 488
        SlideDrawing.Text(draft, deckTitle,
            x: 72, y: 110, width: 488, height: 130,
            fontSize: theme.FontScale.DeckTitle, bold: true);

        // ── 短分隔条（标题与副标题之间）────────────────────────────────────────
        SlideDrawing.AccentDivider(draft, theme, x: 72, y: 254, width: 80, height: 3);

        // ── 副标题 ──────────────────────────────────────────────────────────────
        SlideDrawing.Text(draft, subtitle,
            x: 72, y: 266, width: 488, height: 60,
            fontSize: theme.FontScale.DeckSubtitle);

        // ── 品牌 / 作者（左下角）────────────────────────────────────────────────
        SlideDrawing.BrandFooter(draft, theme, brand);
    }
}

