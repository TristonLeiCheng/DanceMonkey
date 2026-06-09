using DanceMonkey.Ppt.Models;
using ShapeCrawler;
using ShapeCrawler.Presentations;

namespace DanceMonkey.Ppt.Rendering.SlideBuilders;

/// <summary>
/// 要点页 — 「行式布局」设计：
/// 每条要点独立成行，左侧强调色小方块作行标记（不含文字，避免字色冲突）。
/// 有 KeyMessage 时在标题下方以强调色横线 + 单独文字块突出显示。
/// 1-5 条：每行独立 TextShape + BulletDot；6 条以上退化为文字框列表。
/// </summary>
internal sealed class BulletsSlideBuilder : ISlideBuilder
{
    public PptLayoutHint LayoutHint => PptLayoutHint.Bullets;

    public void Build(DraftSlide draft, PptSlide slide, SlideLayoutContext ctx)
    {
        var theme = ctx.Theme;
        var pad = theme.PagePadding;          // 通常 48
        var title = string.IsNullOrWhiteSpace(slide.Title) ? $"第 {ctx.IndexInSection + 1} 部分" : slide.Title!;
        var bullets = (slide.Bullets?.Count > 0 ? slide.Bullets : slide.Paragraphs) ?? new List<string>();
        var keyMessage = slide.KeyMessage;

        // ── 顶部装饰条 ────────────────────────────────────────────────────────
        SlideDrawing.TopAccentBar(draft, theme);

        // ── 标题区：细左竖线 + 标题文字 ──────────────────────────────────────
        SlideDrawing.LeftAccentBar(draft, theme, x: pad, y: theme.AccentBarHeight, width: 3, height: 72);
        SlideDrawing.Text(draft, title,
            x: pad + 16, y: 12, width: SlideDrawing.SlideWidth - pad * 2 - 16, height: 68,
            fontSize: theme.FontScale.SlideTitle, bold: true);

        // ── KeyMessage 区 / 普通分隔线 ───────────────────────────────────────
        int contentY;
        if (!string.IsNullOrWhiteSpace(keyMessage))
        {
            // 强调色粗分隔条（视觉层级标记）
            SlideDrawing.AccentDivider(draft, theme, x: pad, y: 88, width: SlideDrawing.SlideWidth - pad * 2, height: 3);
            // KeyMessage 文字（略大于正文，显示在强调条下方）
            SlideDrawing.Text(draft, keyMessage!,
                x: pad, y: 97, width: SlideDrawing.SlideWidth - pad * 2, height: 40,
                fontSize: theme.FontScale.Body + 2);
            // 细分隔线隔开 KeyMessage 与要点
            SlideDrawing.HorizontalDivider(draft, theme, x: pad, y: 143, width: SlideDrawing.SlideWidth - pad * 2);
            contentY = 150;
        }
        else
        {
            SlideDrawing.HorizontalDivider(draft, theme, x: pad, y: 88, width: SlideDrawing.SlideWidth - pad * 2);
            contentY = 96;
        }

        // ── 要点列表 ──────────────────────────────────────────────────────────
        const int contentBottom = 490;
        if (bullets.Count == 0)
        {
            SlideDrawing.Text(draft, "（暂无要点）",
                x: pad, y: contentY, width: SlideDrawing.SlideWidth - pad * 2, height: contentBottom - contentY,
                fontSize: theme.FontScale.Body);
        }
        else if (bullets.Count <= 5)
        {
            // ≤5 条：每行独立 TextShape + 左侧 BulletDot（高端逐行布局）
            int available = contentBottom - contentY;
            int rowH = available / bullets.Count;
            int dotSize = 8;
            int textX = pad + dotSize + 12;
            int textW = SlideDrawing.SlideWidth - textX - pad;

            for (int i = 0; i < bullets.Count; i++)
            {
                var content = bullets[i]?.Trim() ?? "";
                if (content.Length == 0) continue;

                int rowY = contentY + i * rowH;
                int dotY = rowY + 16;   // 与首行文字顶部对齐

                SlideDrawing.BulletDot(draft, theme, x: pad, y: dotY, size: dotSize);
                SlideDrawing.Text(draft, content,
                    x: textX, y: rowY + 4, width: textW, height: rowH - 8,
                    fontSize: theme.FontScale.Body);
            }
        }
        else
        {
            // ≥6 条：文字框集中显示，使用 en-dash 前缀（比圆点更精致）
            draft.TextShape(t =>
            {
                t.X(pad); t.Y(contentY); t.Width(SlideDrawing.SlideWidth - pad * 2); t.Height(contentBottom - contentY);
                t.TextBox(tb =>
                {
                    foreach (var bullet in bullets.Take(8))
                    {
                        var content = bullet?.Trim() ?? "";
                        if (content.Length == 0) continue;
                        tb.Paragraph(p =>
                        {
                            p.Text(content);
                            p.Font(f => f.Size(theme.FontScale.Body));
                            p.BulletedList("\u2013");  // en dash
                        });
                    }
                });
            });
        }

        SlideDrawing.PageNumber(draft, theme, ctx.PageNumber, ctx.TotalPages);
    }
}

