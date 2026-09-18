using DanceMonkey.Ppt.Abstractions;
using DanceMonkey.Ppt.Models;

namespace DanceMonkey.Ppt.Services;

/// <summary>
/// P1 过渡期大纲生成器：
/// <para>1) 仍使用旧 <see cref="PptLegacySchema.SystemPrompt"/> + <see cref="PptLegacySchema.BuildLlmSystemPrompt"/>；</para>
/// <para>2) 经 <see cref="IPptLlmBridge"/> 调模型；</para>
/// <para>3) 把 LLM 产出的 <see cref="PptOutline"/> 适配到新 <see cref="PptDeck"/>（单章节包装）。</para>
/// 这样不改 prompt 即可让 NotesView 切换到 <see cref="IPptModule"/>，行为保持一致；
/// 等 P2 升级 schema 时，再替换为「新版生成器」。
/// </summary>
internal sealed class PptLegacyOutlineGenerator : IPptOutlineGenerator
{
    private readonly IPptLlmBridge _llm;
    private readonly string? _sandboxPath;
    private readonly int _maxTokens;
    private readonly double _temperature;

    public PptLegacyOutlineGenerator(
        IPptLlmBridge llm,
        string? sandboxPath,
        int maxTokens = 8192,
        double temperature = 0.35)
    {
        _llm = llm ?? throw new ArgumentNullException(nameof(llm));
        _sandboxPath = sandboxPath;
        _maxTokens = maxTokens;
        _temperature = temperature;
    }

    public async Task<PptDeck> GenerateAsync(
        PptGenerationRequest request,
        PptSourceDocument? document,
        CancellationToken cancellationToken = default)
    {
        var noteMarkdown = ExtractMarkdownPayload(request, document);
        if (string.IsNullOrWhiteSpace(noteMarkdown))
            throw new InvalidOperationException("当前内容为空，无法生成大纲。");

        var userPrompt = PptLegacySchema.BuildUserPrompt(noteMarkdown);
        var systemPrompt = PptLegacySchema.BuildLlmSystemPrompt(_sandboxPath);

        var result = await _llm
            .CallLongAsync(userPrompt, systemPrompt, _maxTokens, _temperature, cancellationToken)
            .ConfigureAwait(false);

        if (!result.Success || string.IsNullOrEmpty(result.Text))
            throw new InvalidOperationException(result.Error ?? "模型未返回有效内容。");

        if (!PptLegacySchema.TryParseOutline(result.Text, out var outline, out var parseErr) ||
            outline == null)
        {
            throw new InvalidOperationException(parseErr ?? "无法从模型回复中解析 PPT 大纲。");
        }

        return ConvertToDeck(outline, request);
    }

    /// <summary>
    /// 旧 schema → 新 Deck 的最小转换：
    /// 整篇放到一个 Section 内；每页 LayoutHint = Bullets；Title/Ending 由渲染器自动补。
    /// </summary>
    internal static PptDeck ConvertToDeck(PptOutline outline, PptGenerationRequest request)
    {
        var deck = new PptDeck
        {
            Title = string.IsNullOrWhiteSpace(outline.DeckTitle) ? "演示文稿" : outline.DeckTitle,
            ThemeId = request.ThemeId,
            Audience = request.Audience,
            Purpose = request.Purpose,
        };

        var section = new PptSection { Title = deck.Title };
        if (outline.Slides != null)
        {
            foreach (var s in outline.Slides)
            {
                section.Slides.Add(PptSlide.FromLegacy(s.Title, s.Bullets));
            }
        }
        deck.Sections.Add(section);
        return deck;
    }

    private static string ExtractMarkdownPayload(PptGenerationRequest request, PptSourceDocument? document)
    {
        // 1) 优先用导入器结果中的拼接文本
        if (document != null && document.Blocks.Count > 0)
        {
            // P1 的 Markdown 导入器把整篇放到一个 Paragraph 块；其它块类型也按文本拼接
            var parts = document.Blocks
                .Select(b => b.Text)
                .Where(s => !string.IsNullOrWhiteSpace(s));
            var joined = string.Join("\n\n", parts);
            if (!string.IsNullOrWhiteSpace(joined))
                return joined;
        }

        // 2) 退而求其次：直接取 request.Source（Markdown / PlainText / Topic）
        return request.Source ?? string.Empty;
    }
}
