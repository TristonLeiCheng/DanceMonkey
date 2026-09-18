using DanceMonkey.Ppt.Models;
using ShapeCrawler;
using ShapeCrawler.Presentations;

namespace DanceMonkey.Ppt.Rendering.SlideBuilders;

/// <summary>
/// 表格页：标题 + 一张表格。表格数据从 slide.Media 里第一条 <see cref="PptMediaKind.Table"/> 取。
/// 无表格数据时退化为要点页（仅展示 bullets/标题）。
/// </summary>
internal sealed class TableSlideBuilder : ISlideBuilder
{
    public PptLayoutHint LayoutHint => PptLayoutHint.Table;

    public void Build(DraftSlide draft, PptSlide slide, SlideLayoutContext ctx)
    {
        var theme = ctx.Theme;
        var title = string.IsNullOrWhiteSpace(slide.Title) ? "数据" : slide.Title!;

        SlideDrawing.TopAccentBar(draft, theme);

        draft.RectangleShape(r =>
        {
            r.X(48); r.Y(32); r.Width(48); r.Height(48);
            r.SolidFill(f => f.Color(theme.Palette.Accent));
        });
        SlideDrawing.Text(draft, $"{ctx.IndexInSection + 1:D2}",
            x: 48, y: 32, width: 48, height: 48,
            fontSize: 20, bold: true);

        SlideDrawing.Text(draft, title,
            x: 112, y: 32, width: 800, height: 50,
            fontSize: theme.FontScale.SlideTitle, bold: true);

        SlideDrawing.HorizontalDivider(draft, theme, x: 48, y: 92, width: 864);

        var tableMedia = slide.Media.FirstOrDefault(m => m.Kind == PptMediaKind.Table && m.TableData != null);
        var data = tableMedia?.TableData;

        if (data != null && data.Count > 0)
        {
            var columns = data[0].Count;
            var rows = data.Count;

            try
            {
                draft.TableShape(tb =>
                {
                    // ShapeCrawler 0.79：TableShape(Action<DraftTable>)
                    tb.Columns(columns);
                    foreach (var row in data)
                    {
                        tb.Row(r =>
                        {
                            for (var ci = 0; ci < columns; ci++)
                            {
                                var text = ci < row.Count ? (row[ci] ?? "") : "";
                                r.Cell(cell =>
                                {
                                    cell.TextBox(text);
                                });
                            }
                        });
                    }
                });
            }
            catch (Exception ex)
            {
                ctx.Warnings.Add($"绘制表格失败：{ex.Message}（已退化为提示）。");
                SlideDrawing.Text(draft, $"（表格 {rows}×{columns} 渲染失败）",
                    x: 72, y: 124, width: 816, height: 36,
                    fontSize: theme.FontScale.Body);
            }
        }
        else
        {
            SlideDrawing.Text(draft, "（暂无表格数据）",
                x: 72, y: 124, width: 816, height: 36,
                fontSize: theme.FontScale.Body);
        }

        SlideDrawing.PageNumber(draft, theme, ctx.PageNumber, ctx.TotalPages);
    }
}
