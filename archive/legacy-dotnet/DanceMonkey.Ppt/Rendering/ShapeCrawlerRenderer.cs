using DanceMonkey.Ppt.Abstractions;
using DanceMonkey.Ppt.Models;
using DanceMonkey.Ppt.Rendering.SlideBuilders;
using ShapeCrawler;
using ShapeCrawler.Presentations;

namespace DanceMonkey.Ppt.Rendering;

/// <summary>
/// 使用 ShapeCrawler 把 <see cref="PptDeck"/> 渲染为 .pptx。
/// <para>设计要点：</para>
/// <list type="bullet">
///   <item>颜色与字号全部来自 <see cref="IPptTheme"/>，禁止硬编码。</item>
///   <item>按版式分发到 <see cref="ISlideBuilder"/>；未实现/Auto 回落到 <see cref="BulletsSlideBuilder"/>。</item>
///   <item>封面 + 内容页 + 结束页结构保持与旧 PptGenerationService 一致，确保视觉不退化。</item>
///   <item>ShapeCrawler Draft API 不支持设置字体颜色，按字号分层在 Save 前 patch 一次。</item>
/// </list>
/// </summary>
internal sealed class ShapeCrawlerRenderer : IPptRenderer
{
    private readonly IReadOnlyDictionary<PptLayoutHint, ISlideBuilder> _builders;
    private readonly ISlideBuilder _fallback;

    public ShapeCrawlerRenderer()
    {
        var builders = new ISlideBuilder[]
        {
            new TitleSlideBuilder(),
            new SectionSlideBuilder(),
            new BulletsSlideBuilder(),
            new TwoColumnSlideBuilder(),
            new ImageRightSlideBuilder(),
            new QuoteSlideBuilder(),
            new TableSlideBuilder(),
            new EndingSlideBuilder(),
        };
        _builders = builders.ToDictionary(b => b.LayoutHint);
        _fallback = _builders[PptLayoutHint.Bullets];
    }

    public Task<IReadOnlyList<string>> RenderAsync(
        PptDeck deck,
        IPptTheme theme,
        string outputPath,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(deck);
        ArgumentNullException.ThrowIfNull(theme);
        if (string.IsNullOrWhiteSpace(outputPath))
            throw new ArgumentException("输出路径为空", nameof(outputPath));

        cancellationToken.ThrowIfCancellationRequested();

        var plan = BuildRenderPlan(deck);
        var warnings = new List<string>();

        using (var pres = new Presentation(p =>
        {
            for (var i = 0; i < plan.Count; i++)
            {
                var item = plan[i];
                var ctx = new SlideLayoutContext
                {
                    Theme = theme,
                    PageNumber = i + 1,
                    TotalPages = plan.Count,
                    SectionIndex = item.SectionIndex,
                    IndexInSection = item.IndexInSection,
                    DeckTitle = deck.Title,
                    Author = deck.Author,
                };

                p.Slide(s =>
                {
                    s.SolidBackground(theme.Palette.Background);
                    var builder = ResolveBuilder(item.Slide.LayoutHint);
                    builder.Build(s, item.Slide, ctx);
                    warnings.AddRange(ctx.Warnings);
                });
            }
        }))
        {
            ApplyFontColors(pres, theme);
            ApplySpeakerNotes(pres, plan, warnings);

            try
            {
                EnsureOutputDirectory(outputPath);
                pres.Save(outputPath);
            }
            catch (Exception ex)
            {
                throw new InvalidOperationException($"写入 PPTX 失败：{ex.Message}", ex);
            }
        }

        return Task.FromResult<IReadOnlyList<string>>(warnings);
    }

    /// <summary>
    /// 把每页的 SpeakerNotes（含 VisualSuggestion 追加）通过 IUserSlide.AddNotes(IEnumerable&lt;string&gt;) 写入 notes slide。
    /// 该 API 不可用或单页失败时记录警告并继续，避免影响主体保存。
    /// </summary>
    private static void ApplySpeakerNotes(Presentation pres, IReadOnlyList<RenderItem> plan, List<string> warnings)
    {
        for (var i = 0; i < plan.Count; i++)
        {
            var slide = plan[i].Slide;
            var notes = slide.SpeakerNotes;
            var visual = slide.VisualSuggestion;

            // 若有 VisualSuggestion，追加到演讲备注末尾
            if (!string.IsNullOrWhiteSpace(visual))
            {
                var visualNote = $"【可视化建议】{visual.Trim()}";
                notes = string.IsNullOrWhiteSpace(notes)
                    ? visualNote
                    : notes.TrimEnd() + "\n" + visualNote;
            }

            if (string.IsNullOrWhiteSpace(notes)) continue;

            try
            {
                var pptSlide = pres.Slide(i + 1);
                var lines = notes
                    .Split(new[] { "\r\n", "\n", "\r" }, StringSplitOptions.None)
                    .Where(l => !string.IsNullOrWhiteSpace(l))
                    .ToArray();
                pptSlide.AddNotes(lines);
            }
            catch (Exception ex)
            {
                warnings.Add($"写入第 {i + 1} 页演讲备注失败：{ex.Message}");
            }
        }
    }

    private ISlideBuilder ResolveBuilder(PptLayoutHint hint)
    {
        if (hint == PptLayoutHint.Auto) return _fallback;
        return _builders.TryGetValue(hint, out var b) ? b : _fallback;
    }

    /// <summary>
    /// 把 <see cref="PptDeck"/> 拍平为顺序的渲染项：可选封面 → 章节(可选分隔页) → 内容页 → 可选结尾。
    /// 当 Deck 已显式提供 Title/Ending 版式的 slide 时，不重复插入。
    /// </summary>
    private static IReadOnlyList<RenderItem> BuildRenderPlan(PptDeck deck)
    {
        var items = new List<RenderItem>();

        var hasExplicitTitle = deck.Sections
            .SelectMany(sec => sec.Slides)
            .Any(s => s.LayoutHint == PptLayoutHint.Title);

        var hasExplicitEnding = deck.Sections
            .SelectMany(sec => sec.Slides)
            .Any(s => s.LayoutHint == PptLayoutHint.Ending);

        if (!hasExplicitTitle)
        {
            items.Add(new RenderItem(
                new PptSlide
                {
                    Title = deck.Title,
                    Subtitle = deck.Subtitle,
                    LayoutHint = PptLayoutHint.Title,
                },
                SectionIndex: -1,
                IndexInSection: 0));
        }

        for (var si = 0; si < deck.Sections.Count; si++)
        {
            var section = deck.Sections[si];

            // 多章节才插入章节分隔页；单章节场景视为「直接内容页」，避免一篇笔记被强行加一页章节标题。
            if (deck.Sections.Count > 1)
            {
                items.Add(new RenderItem(
                    new PptSlide
                    {
                        Title = section.Title ?? $"第 {si + 1} 章",
                        Subtitle = section.Summary,
                        LayoutHint = PptLayoutHint.Section,
                    },
                    SectionIndex: si,
                    IndexInSection: 0));
            }

            for (var idx = 0; idx < section.Slides.Count; idx++)
            {
                items.Add(new RenderItem(section.Slides[idx], si, idx));
            }
        }

        if (!hasExplicitEnding)
        {
            items.Add(new RenderItem(
                new PptSlide
                {
                    Title = deck.Title,
                    LayoutHint = PptLayoutHint.Ending,
                },
                SectionIndex: deck.Sections.Count,
                IndexInSection: 0));
        }

        return items;
    }

    /// <summary>
    /// ShapeCrawler Draft API 不能直接设置字体颜色，统一在 Save 前按字号映射主题色。
    /// </summary>
    private static void ApplyFontColors(Presentation pres, IPptTheme theme)
    {
        var palette = theme.Palette;
        var fs = theme.FontScale;

        for (var si = 1; si <= pres.Slides.Count; si++)
        {
            var slide = pres.Slide(si);
            foreach (var shape in slide.Shapes)
            {
                if (shape.TextBox == null) continue;
                foreach (var para in shape.TextBox.Paragraphs)
                {
                    var fontSize = fs.Body;
                    try
                    {
                        var portion = para.Portions.Count > 0 ? para.Portions[0] : null;
                        var size = portion?.Font?.Size;
                        if (size != null)
                            fontSize = (int)size;
                    }
                    catch
                    {
                        // 取不到字号用主题正文字号兜底
                    }

                    string color;
                    if (fontSize >= fs.DeckTitle)
                        color = palette.TextPrimary;
                    else if (fontSize >= fs.SlideTitle)
                        color = palette.TextPrimary;
                    else if (fontSize >= fs.Body)
                        color = palette.TextBody;
                    else
                        color = palette.TextMuted;

                    try
                    {
                        para.SetFontColor(color);
                    }
                    catch
                    {
                        // 个别段落（如空段落）设色失败可忽略
                    }
                }
            }
        }
    }

    private static void EnsureOutputDirectory(string outputPath)
    {
        var dir = Path.GetDirectoryName(outputPath);
        if (!string.IsNullOrEmpty(dir))
            Directory.CreateDirectory(dir);
    }

    private readonly record struct RenderItem(PptSlide Slide, int SectionIndex, int IndexInSection);
}
