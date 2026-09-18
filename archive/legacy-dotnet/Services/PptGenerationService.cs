using System.Text;
using DanceMonkey.Ppt.Models;
using DanceMonkey.Ppt.Services;
using ShapeCrawler;
using ShapeCrawler.Presentations;

namespace DesktopAssistant.Services;

/// <summary>将 Markdown 笔记经 AI 转为大纲并写入 .pptx（ShapeCrawler）— 高级感扁平化设计。</summary>
public static class PptGenerationService
{
    // ── 色板：深色扁平高级感 ──
    private const string ColBgDark    = "0F1219";   // 幻灯片深底色
    private const string ColBgCard    = "1A1E2E";   // 内容卡片底色
    private const string ColAccent    = "4F6EF7";   // 主题蓝
    private const string ColAccentSub = "38B2AC";   // 辅助色 teal
    private const string ColTextWhite = "FFFFFF";
    private const string ColTextLight = "E2E4EC";   // 正文浅灰白
    private const string ColTextMuted = "8B90A8";   // 辅助文字
    private const string ColDivider   = "2A2F42";   // 分隔线色

    public static string SystemPrompt => PptLegacySchema.SystemPrompt;

    public static string BuildUserPrompt(string noteMarkdown) => PptLegacySchema.BuildUserPrompt(noteMarkdown);

    public static string BuildLlmSystemPrompt(string? sandboxConfigPath) =>
        PptLegacySchema.BuildLlmSystemPrompt(sandboxConfigPath);

    /// <summary>从模型原始文本中剥离可选 ```json 围栏并反序列化。</summary>
    public static bool TryParseOutline(string raw, out PptOutline? outline, out string? error) =>
        PptLegacySchema.TryParseOutline(raw, out outline, out error);
    //  高级感 PPT 生成
    // ═══════════════════════════════════════════════════════════════

    /// <summary>根据大纲生成并保存 .pptx — 深色扁平高级感设计。</summary>
    public static void SaveToFile(PptOutline outline, string filePath)
    {
        var slides = outline.Slides ?? new List<PptSlideOutline>();
        var totalSlides = 1 + slides.Count + 1; // title + content + ending

        using var pres = new Presentation(p =>
        {
            // ── 封面页 ──
            p.Slide(s =>
            {
                s.SolidBackground(ColBgDark);
                BuildTitleSlide(s, outline.DeckTitle ?? "演示文稿", slides.Count);
            });

            // ── 内容页 ──
            for (var i = 0; i < slides.Count; i++)
            {
                var slide = slides[i];
                var pageNum = i + 2;
                var total = totalSlides;
                var idx = i;
                p.Slide(s =>
                {
                    s.SolidBackground(ColBgDark);
                    BuildContentSlide(s, slide, idx, pageNum, total);
                });
            }

            // ── 结尾页 ──
            p.Slide(s =>
            {
                s.SolidBackground(ColBgDark);
                BuildEndSlide(s, outline.DeckTitle ?? "演示文稿", totalSlides);
            });
        });

        // ── 后处理：设置字体颜色（Draft API 不支持字体颜色） ──
        ApplyFontColors(pres, slides.Count);

        pres.Save(filePath);
    }

    /// <summary>遍历全部幻灯片的所有文字，按字号/粗细推断应使用的颜色。</summary>
    private static void ApplyFontColors(Presentation pres, int contentSlideCount)
    {
        var totalSlides = 1 + contentSlideCount + 1;
        for (var si = 1; si <= totalSlides; si++)
        {
            var slide = pres.Slide(si);
            foreach (var shape in slide.Shapes)
            {
                if (shape.TextBox == null) continue;
                foreach (var para in shape.TextBox.Paragraphs)
                {
                    // 根据字号判断颜色：大标题=白色，中标题=白色，正文=浅灰白，小字=灰色
                    var fontSize = 14;
                    try
                    {
                        var portion = para.Portions.Count > 0 ? para.Portions[0] : null;
                        var size = portion?.Font?.Size;
                        if (size != null)
                            fontSize = (int)size;
                    }
                    catch { /* use default */ }

                    string color;
                    if (fontSize >= 30)
                        color = ColTextWhite;     // 大标题 → 纯白
                    else if (fontSize >= 20)
                        color = ColTextWhite;     // 章节标题/编号 → 纯白
                    else if (fontSize >= 14)
                        color = ColTextLight;     // 正文 → 浅灰白
                    else
                        color = ColTextMuted;     // 页码/品牌等小字 → 灰色

                    try
                    {
                        para.SetFontColor(color);
                    }
                    catch
                    {
                        // 个别段落可能无法设置颜色（如空段落），忽略
                    }
                }
            }
        }
    }

    // ── 封面页：大标题 + 装饰条 + 副标题 ──
    private static void BuildTitleSlide(DraftSlide s, string deckTitle, int slideCount)
    {
        // 顶部装饰横条（accent 蓝色）
        s.RectangleShape(r =>
        {
            r.X(0); r.Y(0); r.Width(960); r.Height(6);
            r.SolidFill(f => f.Color(ColAccent));
        });

        // 左侧装饰竖条
        s.RectangleShape(r =>
        {
            r.X(60); r.Y(160); r.Width(5); r.Height(120);
            r.SolidFill(f => f.Color(ColAccent));
        });

        // 主标题
        s.TextShape(t =>
        {
            t.X(80); t.Y(155); t.Width(800); t.Height(80);
            t.Paragraph(p =>
            {
                p.Text(deckTitle);
                p.Font(f => { f.Size(38); f.Bold(); });
            });
        });

        // 副标题说明
        s.TextShape(t =>
        {
            t.X(80); t.Y(250); t.Width(800); t.Height(36);
            t.Paragraph(p =>
            {
                p.Text($"共 {slideCount} 个章节  ·  由 AI 自动生成");
                p.Font(f => f.Size(16));
            });
        });

        // 底部装饰横条
        s.RectangleShape(r =>
        {
            r.X(60); r.Y(480); r.Width(840); r.Height(2);
            r.SolidFill(f => f.Color(ColDivider));
        });

        // 底部品牌标注
        s.TextShape(t =>
        {
            t.X(60); t.Y(490); t.Width(400); t.Height(24);
            t.Paragraph(p =>
            {
                p.Text("DanceMonkey · Desktop Assistant");
                p.Font(f => f.Size(10));
            });
        });
    }

    // ── 内容页：章节标题 + 要点列表 + 装饰元素 ──
    private static void BuildContentSlide(DraftSlide s, PptSlideOutline slide, int sectionIdx, int pageNum, int totalPages)
    {
        var title = string.IsNullOrWhiteSpace(slide.Title) ? $"第 {sectionIdx + 1} 部分" : slide.Title!;
        var bullets = slide.Bullets ?? new List<string>();

        // 顶部 accent 细线
        s.RectangleShape(r =>
        {
            r.X(0); r.Y(0); r.Width(960); r.Height(4);
            r.SolidFill(f => f.Color(ColAccent));
        });

        // 章节编号圆点装饰区 (accent 色块)
        s.RectangleShape(r =>
        {
            r.X(48); r.Y(32); r.Width(48); r.Height(48);
            r.SolidFill(f => f.Color(ColAccent));
        });

        // 章节编号文字
        s.TextShape(t =>
        {
            t.X(48); t.Y(32); t.Width(48); t.Height(48);
            t.Paragraph(p =>
            {
                p.Text($"{sectionIdx + 1:D2}");
                p.Font(f => { f.Size(20); f.Bold(); });
            });
        });

        // 章节标题
        s.TextShape(t =>
        {
            t.X(112); t.Y(32); t.Width(800); t.Height(50);
            t.Paragraph(p =>
            {
                p.Text(title);
                p.Font(f => { f.Size(26); f.Bold(); });
            });
        });

        // 标题下分隔线
        s.RectangleShape(r =>
        {
            r.X(48); r.Y(92); r.Width(864); r.Height(2);
            r.SolidFill(f => f.Color(ColDivider));
        });

        // 内容卡片背景
        s.RectangleShape(r =>
        {
            r.X(48); r.Y(108); r.Width(864); r.Height(380);
            r.SolidFill(f =>
            {
                f.Color(ColBgCard);
                f.Transparency(0.15m);
            });
        });

        // 要点文字 — 每条一个段落，用 bullet 样式
        if (bullets.Count > 0)
        {
            s.TextShape(t =>
            {
                t.X(72); t.Y(124); t.Width(816); t.Height(348);
                t.TextBox(tb =>
                {
                    foreach (var bullet in bullets)
                    {
                        tb.Paragraph(p =>
                        {
                            p.Text(bullet.Trim());
                            p.Font(f => f.Size(16));
                            p.BulletedList("●");
                        });
                    }
                });
            });
        }
        else
        {
            s.TextShape(t =>
            {
                t.X(72); t.Y(124); t.Width(816); t.Height(348);
                t.Paragraph(p =>
                {
                    p.Text("（暂无要点）");
                    p.Font(f => f.Size(14));
                });
            });
        }

        // 页码
        s.TextShape(t =>
        {
            t.X(860); t.Y(500); t.Width(80); t.Height(24);
            t.Paragraph(p =>
            {
                p.Text($"{pageNum} / {totalPages}");
                p.Font(f => f.Size(10));
            });
        });
    }

    // ── 结尾页：感谢 + 品牌 ──
    private static void BuildEndSlide(DraftSlide s, string deckTitle, int totalPages)
    {
        // 顶部 accent 线
        s.RectangleShape(r =>
        {
            r.X(0); r.Y(0); r.Width(960); r.Height(6);
            r.SolidFill(f => f.Color(ColAccent));
        });

        // 中央感谢语
        s.TextShape(t =>
        {
            t.X(80); t.Y(170); t.Width(800); t.Height(60);
            t.Paragraph(p =>
            {
                p.Text("Thank You");
                p.Font(f => { f.Size(42); f.Bold(); });
            });
        });

        // 二级说明
        s.TextShape(t =>
        {
            t.X(80); t.Y(240); t.Width(800); t.Height(40);
            t.Paragraph(p =>
            {
                p.Text(deckTitle);
                p.Font(f => f.Size(18));
            });
        });

        // 装饰竖线
        s.RectangleShape(r =>
        {
            r.X(460); r.Y(300); r.Width(40); r.Height(3);
            r.SolidFill(f => f.Color(ColAccent));
        });

        // 底部品牌
        s.TextShape(t =>
        {
            t.X(60); t.Y(490); t.Width(400); t.Height(24);
            t.Paragraph(p =>
            {
                p.Text("Powered by DanceMonkey AI");
                p.Font(f => f.Size(10));
            });
        });

        // 页码
        s.TextShape(t =>
        {
            t.X(860); t.Y(500); t.Width(80); t.Height(24);
            t.Paragraph(p =>
            {
                p.Text($"{totalPages} / {totalPages}");
                p.Font(f => f.Size(10));
            });
        });
    }
}
