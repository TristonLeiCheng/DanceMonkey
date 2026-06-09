using DanceMonkey.Ppt.Models;
using ShapeCrawler;
using ShapeCrawler.Presentations;

namespace DanceMonkey.Ppt.Rendering.SlideBuilders;

/// <summary>
/// 章节分隔页 — 「大号数字锚点」设计：
/// 左侧贯通强调色竖条 + 超大章节序号（视觉锚）+ 章节标题 + 简介。
/// 与内容页形成强烈差异感，明确告知读者进入新章节。
/// </summary>
internal sealed class SectionSlideBuilder : ISlideBuilder
{
    public PptLayoutHint LayoutHint => PptLayoutHint.Section;

    public void Build(DraftSlide draft, PptSlide slide, SlideLayoutContext ctx)
    {
        var theme = ctx.Theme;
        var title = string.IsNullOrWhiteSpace(slide.Title) ? $"第 {ctx.SectionIndex + 1} 章" : slide.Title!;
        var subtitle = slide.Subtitle ?? "";

        // ── 顶部通栏装饰条 ────────────────────────────────────────────────────
        SlideDrawing.TopAccentBar(draft, theme);

        // ── 左侧贯通竖条（8pt 宽，全高，与封面面板呼应）─────────────────────
        draft.RectangleShape(r =>
        {
            r.X(0); r.Y(0); r.Width(8); r.Height(SlideDrawing.SlideHeight);
            r.SolidFill(f => f.Color(theme.Palette.Accent));
        });

        // ── 右侧幽灵装饰矩形（AccentSoft 极浅，营造空间层次）────────────────
        draft.RectangleShape(r =>
        {
            r.X(680); r.Y(140); r.Width(220); r.Height(220);
            r.SolidFill(f => f.Color(theme.Palette.Surface));
        });

        // ── 超大章节序号（视觉锚点，TextPrimary 色，字号 = DeckTitle+32）────
        int bigNumSize = theme.FontScale.DeckTitle + 32; // e.g. 40+32=72pt
        SlideDrawing.Text(draft, $"{ctx.SectionIndex + 1:D2}",
            x: 36, y: 80, width: 240, height: bigNumSize + 20,
            fontSize: bigNumSize, bold: true);

        // ── 短强调分隔条（在序号下方，章节标题上方）──────────────────────────
        int divY = 80 + bigNumSize + 28;  // 序号底部再留 28px
        SlideDrawing.AccentDivider(draft, theme, x: 36, y: divY, width: 56, height: 4);

        // ── 章节标题 ──────────────────────────────────────────────────────────
        SlideDrawing.Text(draft, title,
            x: 36, y: divY + 14, width: 840, height: 70,
            fontSize: theme.FontScale.SectionTitle, bold: true);

        // ── 章节简介（可选）──────────────────────────────────────────────────
        if (!string.IsNullOrWhiteSpace(subtitle))
        {
            SlideDrawing.Text(draft, subtitle,
                x: 36, y: divY + 90, width: 720, height: 48,
                fontSize: theme.FontScale.Body);
        }

        SlideDrawing.PageNumber(draft, theme, ctx.PageNumber, ctx.TotalPages);
    }
}

