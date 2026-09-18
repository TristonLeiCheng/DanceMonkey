using DanceMonkey.Ppt.Models;
using ShapeCrawler;
using ShapeCrawler.Presentations;

namespace DanceMonkey.Ppt.Rendering.SlideBuilders;

/// <summary>
/// 双栏版式：标题 + 左右两个并列内容卡片。
/// 适合对比/并列场景（如优缺点、前后对比、两种方案比较）。
/// 左栏使用 <see cref="PptSlide.Bullets"/>，右栏使用 <see cref="PptSlide.RightBullets"/>。
/// 当右栏无内容时自动降级到 <see cref="BulletsSlideBuilder"/>。
/// </summary>
internal sealed class TwoColumnSlideBuilder : ISlideBuilder
{
    private readonly BulletsSlideBuilder _fallback = new();

    public PptLayoutHint LayoutHint => PptLayoutHint.TwoColumn;

    public void Build(DraftSlide draft, PptSlide slide, SlideLayoutContext ctx)
    {
        // 右栏为空 → 降级
        if (slide.RightBullets.Count == 0)
        {
            ctx.Warnings.Add($"第 {ctx.PageNumber} 页（{slide.Title}）版式 twoColumn 缺少 rightBullets，已降级为 bullets。");
            _fallback.Build(draft, slide, ctx);
            return;
        }

        var theme = ctx.Theme;
        var title = string.IsNullOrWhiteSpace(slide.Title) ? $"第 {ctx.IndexInSection + 1} 部分" : slide.Title!;

        SlideDrawing.TopAccentBar(draft, theme);

        // ── 标题区：细左竖线 + 标题文字（与 BulletsSlide 同款头部）──────────
        var pad = theme.PagePadding;
        SlideDrawing.LeftAccentBar(draft, theme, x: pad, y: theme.AccentBarHeight, width: 3, height: 72);
        SlideDrawing.Text(draft, title,
            x: pad + 16, y: 12, width: SlideDrawing.SlideWidth - pad * 2 - 16, height: 68,
            fontSize: theme.FontScale.SlideTitle, bold: true);

        SlideDrawing.HorizontalDivider(draft, theme, x: pad, y: 88, width: SlideDrawing.SlideWidth - pad * 2);

        // ── 双栏卡片 ──────────────────────────────────────────────────────────
        const int cardTop = 100;
        const int cardHeight = 382;
        int leftCardX = pad;
        const int leftCardW = 415;
        const int rightCardW = 415;
        int rightCardX = SlideDrawing.SlideWidth - pad - rightCardW;   // 对称留边

        // 左栏：Accent 竖条 + Surface 背景
        SlideDrawing.LeftAccentBar(draft, theme, x: leftCardX, y: cardTop, width: 4, height: cardHeight);
        SlideDrawing.SurfaceCard(draft, theme, x: leftCardX + 4, y: cardTop, width: leftCardW - 4, height: cardHeight, transparency: 0.15m);

        // 右栏：AccentSoft 竖条 + Surface 背景
        draft.RectangleShape(r =>
        {
            r.X(rightCardX); r.Y(cardTop); r.Width(4); r.Height(cardHeight);
            r.SolidFill(f => f.Color(theme.Palette.AccentSoft));
        });
        SlideDrawing.SurfaceCard(draft, theme, x: rightCardX + 4, y: cardTop, width: rightCardW - 4, height: cardHeight, transparency: 0.15m);

        BuildBulletList(draft, slide.Bullets, theme, leftCardX + 16, cardTop + 12, leftCardW - 24, cardHeight - 24);
        BuildBulletList(draft, slide.RightBullets, theme, rightCardX + 16, cardTop + 12, rightCardW - 24, cardHeight - 24);

        SlideDrawing.PageNumber(draft, theme, ctx.PageNumber, ctx.TotalPages);
    }

    private static void BuildBulletList(DraftSlide draft, List<string> bullets, IPptTheme theme, int x, int y, int w, int h)
    {
        if (bullets.Count == 0)
        {
            SlideDrawing.Text(draft, "（暂无内容）", x, y, w, h, theme.FontScale.Body);
            return;
        }

        draft.TextShape(t =>
        {
            t.X(x); t.Y(y); t.Width(w); t.Height(h);
            t.TextBox(tb =>
            {
                foreach (var bullet in bullets)
                {
                    var content = bullet.Trim();
                    if (content.Length == 0) continue;
                    tb.Paragraph(p =>
                    {
                        p.Text(content);
                        p.Font(f => f.Size(theme.FontScale.Body));
                        p.BulletedList("●");
                    });
                }
            });
        });
    }
}
