using DanceMonkey.Ppt.Models;
using ShapeCrawler;
using ShapeCrawler.Presentations;

namespace DanceMonkey.Ppt.Rendering;

/// <summary>
/// 各 SlideBuilder 共用的小工具：装饰条、页脚、品牌、单段文本块。
/// 所有方法均「主题驱动」，禁止字面量颜色/字号；调用方传 IPptTheme 即可。
/// </summary>
internal static class SlideDrawing
{
    // 16:9 PowerPoint 默认幻灯片尺寸（点）：960 x 540
    public const int SlideWidth = 960;
    public const int SlideHeight = 540;

    /// <summary>顶部装饰横条（贴边）。</summary>
    public static void TopAccentBar(DraftSlide s, IPptTheme theme)
    {
        s.RectangleShape(r =>
        {
            r.X(0); r.Y(0); r.Width(SlideWidth); r.Height(theme.AccentBarHeight);
            r.SolidFill(f => f.Color(theme.Palette.Accent));
        });
    }

    /// <summary>水平细分隔线（用主题 Divider 色）。</summary>
    public static void HorizontalDivider(DraftSlide s, IPptTheme theme, int x, int y, int width, int height = 2)
    {
        s.RectangleShape(r =>
        {
            r.X(x); r.Y(y); r.Width(width); r.Height(height);
            r.SolidFill(f => f.Color(theme.Palette.Divider));
        });
    }

    /// <summary>左侧短装饰竖条（封面常用）。</summary>
    public static void LeftAccentBar(DraftSlide s, IPptTheme theme, int x, int y, int width, int height)
    {
        s.RectangleShape(r =>
        {
            r.X(x); r.Y(y); r.Width(width); r.Height(height);
            r.SolidFill(f => f.Color(theme.Palette.Accent));
        });
    }

    /// <summary>纯色实心矩形（卡片底）。</summary>
    public static void SurfaceCard(DraftSlide s, IPptTheme theme, int x, int y, int width, int height, decimal? transparency = null)
    {
        s.RectangleShape(r =>
        {
            r.X(x); r.Y(y); r.Width(width); r.Height(height);
            r.SolidFill(f =>
            {
                f.Color(theme.Palette.Surface);
                if (transparency.HasValue) f.Transparency(transparency.Value);
            });
        });
    }

    /// <summary>单行文本。</summary>
    public static void Text(DraftSlide s, string content, int x, int y, int width, int height, int fontSize, bool bold = false)
    {
        s.TextShape(t =>
        {
            t.X(x); t.Y(y); t.Width(width); t.Height(height);
            t.Paragraph(p =>
            {
                p.Text(content);
                p.Font(f =>
                {
                    f.Size(fontSize);
                    if (bold) f.Bold();
                });
            });
        });
    }

    /// <summary>右下角页码：使用主题 Caption 字号。</summary>
    public static void PageNumber(DraftSlide s, IPptTheme theme, int pageNumber, int totalPages)
    {
        Text(s, $"{pageNumber} / {totalPages}", x: SlideWidth - 100, y: SlideHeight - 40, width: 80, height: 24, fontSize: theme.FontScale.Caption);
    }

    /// <summary>左下角品牌（默认 DanceMonkey）。</summary>
    public static void BrandFooter(DraftSlide s, IPptTheme theme, string? brand = null)
    {
        Text(s, brand ?? "DanceMonkey · Desktop Assistant", x: 48, y: SlideHeight - 40, width: 400, height: 24, fontSize: theme.FontScale.Caption);
    }

    /// <summary>强调色分隔横条（比 HorizontalDivider 更显眼，使用 Accent 色）。</summary>
    public static void AccentDivider(DraftSlide s, IPptTheme theme, int x, int y, int width, int height = 3)
    {
        s.RectangleShape(r =>
        {
            r.X(x); r.Y(y); r.Width(width); r.Height(height);
            r.SolidFill(f => f.Color(theme.Palette.Accent));
        });
    }

    /// <summary>要点装饰小方块（accent 色，用于要点列表的行标记）。</summary>
    public static void BulletDot(DraftSlide s, IPptTheme theme, int x, int y, int size = 8)
    {
        s.RectangleShape(r =>
        {
            r.X(x); r.Y(y); r.Width(size); r.Height(size);
            r.SolidFill(f => f.Color(theme.Palette.Accent));
        });
    }
}
