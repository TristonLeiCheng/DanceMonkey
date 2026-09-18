using DanceMonkey.Ppt.Abstractions;
using DanceMonkey.Ppt.Importers;
using DanceMonkey.Ppt.Rendering;

namespace DanceMonkey.Ppt.Services;

/// <summary>
/// 集中装配 <see cref="IPptModule"/>。桌面与 CLI 均通过 <see cref="Create"/> 注入各自的 <see cref="IPptLlmBridge"/>。
/// </summary>
public static class PptModuleFactory
{
    private static readonly Lazy<IPptThemeProvider> SharedThemes = new(() => new PptThemeProvider());

    public static IPptThemeProvider Themes => SharedThemes.Value;

    /// <param name="useLegacyPrompt">true 时回落到 P1 旧 prompt + 旧 schema，便于灰度回滚。</param>
    public static IPptModule Create(
        IPptLlmBridge llm,
        string? sandboxPath,
        bool useLegacyPrompt = false,
        int maxTokens = 8192,
        double temperature = 0.35)
    {
        ArgumentNullException.ThrowIfNull(llm);

        IPptOutlineGenerator outline = useLegacyPrompt
            ? new PptLegacyOutlineGenerator(llm, sandboxPath, maxTokens, temperature)
            : new PptOutlineGenerator(llm, sandboxPath, maxTokens, temperature);

        var renderer = new ShapeCrawlerRenderer();
        var importers = new IPptSourceImporter[]
        {
            new MarkdownSourceImporter(),
            new WordSourceImporter(),
            new PdfSourceImporter(),
        };

        return new PptModule(Themes, outline, renderer, importers);
    }

    /// <summary>当前运行环境是否具备 Office Word COM（用于 PDF / Word 导入）。</summary>
    public static bool IsOfficeWordAvailable() => OfficeWordReader.IsAvailable();
}
