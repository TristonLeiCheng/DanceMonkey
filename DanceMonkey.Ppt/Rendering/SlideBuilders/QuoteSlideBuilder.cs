using DanceMonkey.Ppt.Models;
using ShapeCrawler;
using ShapeCrawler.Presentations;

namespace DanceMonkey.Ppt.Rendering.SlideBuilders;

/// <summary>
/// 引述版式：用于名言、数据亮点、金句等高影响力单句内容。
/// 视觉设计：大字号引述居中 + 出处副标题 + 左侧粗 accent 竖条。
/// <para>字段映射：<see cref="PptSlide.Bullets"/>[0] → 引述正文；<see cref="PptSlide.Subtitle"/> → 出处。</para>
/// </summary>
internal sealed class QuoteSlideBuilder : ISlideBuilder
{
    public PptLayoutHint LayoutHint => PptLayoutHint.Quote;

    public void Build(DraftSlide draft, PptSlide slide, SlideLayoutContext ctx)
    {
        var theme = ctx.Theme;
        var quoteText = slide.Bullets.Count > 0
            ? slide.Bullets[0]
            : (slide.Paragraphs.Count > 0 ? slide.Paragraphs[0] : "（引述内容）");
        var source = slide.Subtitle ?? "";

        // ── 顶部装饰条 ────────────────────────────────────────────────────
        SlideDrawing.TopAccentBar(draft, theme);

        // ── 左侧粗竖条（整段引述区高度，视觉锚点）───────────────────────────
        const int barX = 60;
        const int barY = 80;
        const int barH = 320;
        draft.RectangleShape(r =>
        {
            r.X(barX); r.Y(barY); r.Width(10); r.Height(barH);
            r.SolidFill(f => f.Color(theme.Palette.Accent));
        });

        // ── 顶部 AccentSoft 装饰小块（引号区域视觉层次）─────────────────────
        draft.RectangleShape(r =>
        {
            r.X(SlideDrawing.SlideWidth - 120); r.Y(60); r.Width(60); r.Height(4);
            r.SolidFill(f => f.Color(theme.Palette.AccentSoft));
        });

        // ── 大引号装饰（TextPrimary 色，字号 ≥ DeckTitle 故显为主色）────────
        SlideDrawing.Text(draft, "\u201C",
            x: 82, y: 68, width: 100, height: 80,
            fontSize: theme.FontScale.DeckTitle + 20, bold: true);

        // ── 引述正文（引号下方，稍作缩进）───────────────────────────────────
        draft.TextShape(t =>
        {
            t.X(92); t.Y(140); t.Width(820); t.Height(200);
            t.TextBox(tb =>
            {
                tb.Paragraph(p =>
                {
                    p.Text(quoteText);
                    p.Font(f => f.Size(theme.FontScale.Quote));
                });
            });
        });

        // ── 出处 ──────────────────────────────────────────────────────────
        if (!string.IsNullOrWhiteSpace(source))
        {
            SlideDrawing.HorizontalDivider(draft, theme, x: 92, y: 354, width: 160);
            SlideDrawing.Text(draft, $"\u2014 {source}",
                x: 92, y: 364, width: 640, height: 36,
                fontSize: theme.FontScale.Caption + 2);
        }

        // ── 可选页标题（底部小字，作上下文标注）──────────────────────────────
        if (!string.IsNullOrWhiteSpace(slide.Title))
        {
            SlideDrawing.Text(draft, slide.Title!,
                x: 92, y: 460, width: 820, height: 30,
                fontSize: theme.FontScale.Caption + 2, bold: true);
        }

        SlideDrawing.PageNumber(draft, theme, ctx.PageNumber, ctx.TotalPages);
    }
}
