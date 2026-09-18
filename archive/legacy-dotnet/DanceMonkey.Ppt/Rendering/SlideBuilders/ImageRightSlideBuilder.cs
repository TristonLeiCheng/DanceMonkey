using DanceMonkey.Ppt.Models;
using ShapeCrawler;
using ShapeCrawler.Presentations;

namespace DanceMonkey.Ppt.Rendering.SlideBuilders;

/// <summary>
/// 图文页：左侧标题 + bullets，右侧第一张图片。
/// 图片不存在或无法读取时退化为左满版要点（Bullets 风格）。
/// </summary>
internal sealed class ImageRightSlideBuilder : ISlideBuilder
{
    public PptLayoutHint LayoutHint => PptLayoutHint.ImageRight;

    public void Build(DraftSlide draft, PptSlide slide, SlideLayoutContext ctx)
    {
        var theme = ctx.Theme;
        var title = string.IsNullOrWhiteSpace(slide.Title) ? "图文" : slide.Title!;
        var pad = theme.PagePadding;

        SlideDrawing.TopAccentBar(draft, theme);

        // 标题区：细左竖线 + 标题（与 BulletsSlide 同款头部，视觉一致性）
        SlideDrawing.LeftAccentBar(draft, theme, x: pad, y: theme.AccentBarHeight, width: 3, height: 72);
        SlideDrawing.Text(draft, title,
            x: pad + 16, y: 12, width: SlideDrawing.SlideWidth - pad * 2 - 16, height: 68,
            fontSize: theme.FontScale.SlideTitle, bold: true);

        SlideDrawing.HorizontalDivider(draft, theme, x: pad, y: 88, width: SlideDrawing.SlideWidth - pad * 2);

        // 左半要点 + 右半图片
        var image = slide.Media.FirstOrDefault(m => m.Kind == PptMediaKind.Image && !string.IsNullOrWhiteSpace(m.Source));
        var hasImage = image != null && File.Exists(image!.Source!);

        int contentY = 96;
        var bulletsRight = hasImage ? 460 : SlideDrawing.SlideWidth - pad * 2;

        // 左侧细竖线装饰（内容区锚点）
        SlideDrawing.LeftAccentBar(draft, theme, x: pad, y: contentY, width: 4, height: 390);

        if (slide.Bullets.Count > 0)
        {
            draft.TextShape(t =>
            {
                t.X(pad + 16); t.Y(contentY + 8); t.Width(bulletsRight - 24); t.Height(374);
                t.TextBox(tb =>
                {
                    foreach (var bullet in slide.Bullets)
                    {
                        var content = bullet?.Trim();
                        if (string.IsNullOrEmpty(content)) continue;
                        tb.Paragraph(p =>
                        {
                            p.Text(content);
                            p.Font(f => f.Size(theme.FontScale.Body));
                            p.BulletedList("\u2013");
                        });
                    }
                });
            });
        }
        else if (slide.Paragraphs.Count > 0)
        {
            draft.TextShape(t =>
            {
                t.X(pad + 16); t.Y(contentY + 8); t.Width(bulletsRight - 24); t.Height(374);
                t.TextBox(tb =>
                {
                    foreach (var para in slide.Paragraphs)
                    {
                        var content = para?.Trim();
                        if (string.IsNullOrEmpty(content)) continue;
                        tb.Paragraph(p =>
                        {
                            p.Text(content);
                            p.Font(f => f.Size(theme.FontScale.Body));
                        });
                    }
                });
            });
        }

        if (hasImage)
        {
            try
            {
                using var fs = File.OpenRead(image!.Source!);
                using var ms = new MemoryStream();
                fs.CopyTo(ms);
                ms.Position = 0;
                var bytes = ms.ToArray();

                draft.Picture(pic =>
                {
                    pic.Name("ImageRight");
                    pic.X(528);
                    pic.Y(120);
                    pic.Width(384);
                    pic.Height(280);
                    pic.Image(new MemoryStream(bytes));
                });

                if (!string.IsNullOrWhiteSpace(image!.Caption))
                {
                    SlideDrawing.Text(draft, image.Caption!,
                        x: 528, y: 408, width: 384, height: 24,
                        fontSize: theme.FontScale.Caption);
                }
            }
            catch (Exception ex)
            {
                ctx.Warnings.Add($"读取图片失败：{ex.Message}（{image?.Source}）");
            }
        }

        SlideDrawing.PageNumber(draft, theme, ctx.PageNumber, ctx.TotalPages);
    }
}
