using DanceMonkey.Ppt.Abstractions;
using DanceMonkey.Ppt.Models;

namespace DanceMonkey.Ppt.Services;

/// <summary>
/// PPT 大模块门面（P0 骨架）。
/// <para>导入、AI 大纲、渲染经 <see cref="IPptModule"/> 统一编排；宿主通过 <see cref="IPptLlmBridge"/> 注入模型调用。</para>
/// </summary>
public sealed class PptModule : IPptModule
{
    private readonly IPptThemeProvider _themes;
    private readonly IPptOutlineGenerator? _outline;
    private readonly IPptRenderer? _renderer;
    private readonly IReadOnlyDictionary<PptSourceKind, IPptSourceImporter> _importers;

    public PptModule(
        IPptThemeProvider themes,
        IPptOutlineGenerator? outline = null,
        IPptRenderer? renderer = null,
        IEnumerable<IPptSourceImporter>? importers = null)
    {
        _themes = themes ?? throw new ArgumentNullException(nameof(themes));
        _outline = outline;
        _renderer = renderer;
        _importers = (importers ?? Array.Empty<IPptSourceImporter>())
            .GroupBy(i => i.SourceKind)
            .ToDictionary(g => g.Key, g => g.First());
    }

    public IReadOnlyList<IPptTheme> ListThemes() => _themes.List();

    public Task<PptGenerationResult> GenerateFromSourceAsync(
        PptGenerationRequest request,
        string outputPath,
        CancellationToken cancellationToken = default)
    {
        if (request is null)
            return Task.FromResult(PptGenerationResult.Fail("请求为空"));
        if (string.IsNullOrWhiteSpace(outputPath))
            return Task.FromResult(PptGenerationResult.Fail("输出路径为空"));

        // P0 占位：依赖项尚未注入，直接返回未实现错误，避免误导调用方以为已可用。
        if (_outline is null || _renderer is null)
            return Task.FromResult(PptGenerationResult.Fail("PPT 大模块尚未完成接线（P1 起接入大纲与渲染）"));

        return GenerateFromSourceCoreAsync(request, outputPath, cancellationToken);
    }

    public Task<PptGenerationResult> GenerateOutlineAsync(
        PptGenerationRequest request,
        CancellationToken cancellationToken = default)
    {
        if (request is null)
            return Task.FromResult(PptGenerationResult.Fail("请求为空"));
        if (_outline is null)
            return Task.FromResult(PptGenerationResult.Fail("大纲生成器尚未接入（P1）"));

        return GenerateOutlineCoreAsync(request, cancellationToken);
    }

    public Task<PptGenerationResult> RenderAsync(
        PptDeck deck,
        string outputPath,
        CancellationToken cancellationToken = default)
    {
        if (deck is null)
            return Task.FromResult(PptGenerationResult.Fail("Deck 为空"));
        if (string.IsNullOrWhiteSpace(outputPath))
            return Task.FromResult(PptGenerationResult.Fail("输出路径为空"));
        if (_renderer is null)
            return Task.FromResult(PptGenerationResult.Fail("渲染器尚未接入（P1）"));

        return RenderCoreAsync(deck, outputPath, cancellationToken);
    }

    // ── 私有：核心编排（依赖项就绪后才会走这里） ─────────────────────────

    private async Task<PptGenerationResult> GenerateFromSourceCoreAsync(
        PptGenerationRequest request,
        string outputPath,
        CancellationToken ct)
    {
        var warnings = new List<string>();

        PptSourceDocument? document = null;
        if (_importers.TryGetValue(request.SourceKind, out var importer))
        {
            try
            {
                var assetsDir = DeriveAssetsDirectory(outputPath);
                document = await importer.ImportAsync(request.Source, assetsDir, ct).ConfigureAwait(false);
                if (document.Warnings.Count > 0)
                    warnings.AddRange(document.Warnings);
            }
            catch (Exception ex)
            {
                return PptGenerationResult.Fail($"导入来源失败：{ex.Message}", warnings);
            }
        }
        // 无对应导入器时不报错：Topic 模式或纯字符串场景由大纲生成器直接处理。

        PptDeck deck;
        try
        {
            deck = await _outline!.GenerateAsync(request, document, ct).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            return PptGenerationResult.Fail($"生成大纲失败：{ex.Message}", warnings);
        }

        var theme = _themes.Resolve(deck.ThemeId ?? request.ThemeId);

        // 把模型在 media[].source 中给出的引用解析为本地实际文件路径；不存在则丢弃 + 警告。
        // 同时把来源文档中的图片注入到 deck（针对未给出 media 的 Image 版式页面做兜底）。
        SanitizeAndProjectMedia(deck, document, warnings);

        try
        {
            var renderWarnings = await _renderer!.RenderAsync(deck, theme, outputPath, ct).ConfigureAwait(false);
            if (renderWarnings.Count > 0)
                warnings.AddRange(renderWarnings);
        }
        catch (Exception ex)
        {
            return PptGenerationResult.Fail($"渲染 PPTX 失败：{ex.Message}", warnings);
        }

        return PptGenerationResult.Ok(outputPath, warnings);
    }

    /// <summary>
    /// 渲染前的媒体校正：
    /// <list type="bullet">
    ///   <item>把 <c>Slide.Media[].Source</c> 中 LLM 给出的相对路径/原始链接尝试在 <paramref name="document"/> 的图片块里匹配；</item>
    ///   <item>实际不存在的图片资源被剔除，并产生警告；</item>
    ///   <item>若某页 LayoutHint == ImageRight 但没有任何媒体可用，则降级为 Bullets（由渲染器执行；这里只剔除空 media）。</item>
    /// </list>
    /// </summary>
    private static void SanitizeAndProjectMedia(PptDeck deck, PptSourceDocument? document, List<string> warnings)
    {
        var availableImages = document?.Blocks
            .Where(b => b.Kind == PptSourceBlockKind.Image && !string.IsNullOrWhiteSpace(b.MediaPath))
            .Select(b => b.MediaPath!)
            .ToList() ?? new List<string>();

        foreach (var section in deck.Sections)
        {
            foreach (var slide in section.Slides)
            {
                if (slide.Media.Count == 0) continue;

                var sanitized = new List<PptMedia>(slide.Media.Count);
                foreach (var m in slide.Media)
                {
                    if (m.Kind != PptMediaKind.Image)
                    {
                        sanitized.Add(m);
                        continue;
                    }

                    var resolved = ResolveImagePath(m.Source, availableImages);
                    if (resolved != null)
                    {
                        sanitized.Add(new PptMedia
                        {
                            Kind = PptMediaKind.Image,
                            Source = resolved,
                            Caption = m.Caption,
                        });
                    }
                    else
                    {
                        warnings.Add($"找不到图片资源：{m.Source ?? "<空>"}（已忽略）。");
                    }
                }
                slide.Media.Clear();
                slide.Media.AddRange(sanitized);
            }
        }
    }

    private static string? ResolveImagePath(string? requested, IReadOnlyList<string> available)
    {
        if (string.IsNullOrWhiteSpace(requested)) return null;

        // 1) 已是存在的绝对路径
        if (File.Exists(requested)) return requested;

        // 2) 与可用列表里某个路径同名（按文件名匹配）
        var name = Path.GetFileName(requested);
        if (!string.IsNullOrEmpty(name))
        {
            var match = available.FirstOrDefault(p =>
                string.Equals(Path.GetFileName(p), name, StringComparison.OrdinalIgnoreCase));
            if (match != null && File.Exists(match)) return match;
        }

        // 3) URI 或 Markdown 内联引用：截掉 query/fragment 再比一次
        try
        {
            if (Uri.TryCreate(requested, UriKind.RelativeOrAbsolute, out var uri))
            {
                var localName = Path.GetFileName(uri.IsAbsoluteUri ? uri.LocalPath : uri.OriginalString);
                if (!string.IsNullOrEmpty(localName))
                {
                    var match = available.FirstOrDefault(p =>
                        string.Equals(Path.GetFileName(p), localName, StringComparison.OrdinalIgnoreCase));
                    if (match != null && File.Exists(match)) return match;
                }
            }
        }
        catch { /* 忽略路径解析错误 */ }

        return null;
    }

    private async Task<PptGenerationResult> GenerateOutlineCoreAsync(
        PptGenerationRequest request,
        CancellationToken ct)
    {
        var warnings = new List<string>();
        PptSourceDocument? document = null;
        if (_importers.TryGetValue(request.SourceKind, out var importer))
        {
            try
            {
                document = await importer.ImportAsync(request.Source, null, ct).ConfigureAwait(false);
                if (document.Warnings.Count > 0)
                    warnings.AddRange(document.Warnings);
            }
            catch (Exception ex)
            {
                return PptGenerationResult.Fail($"导入来源失败：{ex.Message}", warnings);
            }
        }

        try
        {
            var deck = await _outline!.GenerateAsync(request, document, ct).ConfigureAwait(false);
            return PptGenerationResult.OkDeck(deck, warnings);
        }
        catch (Exception ex)
        {
            return PptGenerationResult.Fail($"生成大纲失败：{ex.Message}", warnings);
        }
    }

    private async Task<PptGenerationResult> RenderCoreAsync(
        PptDeck deck,
        string outputPath,
        CancellationToken ct)
    {
        var theme = _themes.Resolve(deck.ThemeId);
        try
        {
            var warnings = await _renderer!.RenderAsync(deck, theme, outputPath, ct).ConfigureAwait(false);
            return PptGenerationResult.Ok(outputPath, warnings);
        }
        catch (Exception ex)
        {
            return PptGenerationResult.Fail($"渲染 PPTX 失败：{ex.Message}");
        }
    }

    /// <summary>
    /// 由输出 .pptx 路径推导出图片落地的「副本目录」。
    /// 例如 D:\out\demo.pptx → D:\out\demo.assets\
    /// </summary>
    private static string DeriveAssetsDirectory(string outputPath)
    {
        var dir = Path.GetDirectoryName(outputPath);
        var name = Path.GetFileNameWithoutExtension(outputPath);
        var assets = Path.Combine(dir ?? ".", $"{name}.assets");
        Directory.CreateDirectory(assets);
        return assets;
    }
}
