using DanceMonkey.Ppt.Models;

namespace DanceMonkey.Ppt.Abstractions;

/// <summary>
/// PPT 大模块对外唯一入口。WPF/CLI/Agent 都通过它调用，不直接依赖渲染器/导入器/Prompt 细节。
/// </summary>
public interface IPptModule
{
    /// <summary>列出可用主题（供 UI 选择）。</summary>
    IReadOnlyList<IPptTheme> ListThemes();

    /// <summary>一键生成：导入来源 → 大纲 → 主题 → 渲染到 <paramref name="outputPath"/>。</summary>
    Task<PptGenerationResult> GenerateFromSourceAsync(
        PptGenerationRequest request,
        string outputPath,
        CancellationToken cancellationToken = default);

    /// <summary>只生成大纲，便于工作台 UI 做评审/编辑后再渲染。</summary>
    Task<PptGenerationResult> GenerateOutlineAsync(
        PptGenerationRequest request,
        CancellationToken cancellationToken = default);

    /// <summary>用已经准备好的 <see cref="PptDeck"/> 渲染到 .pptx。</summary>
    Task<PptGenerationResult> RenderAsync(
        PptDeck deck,
        string outputPath,
        CancellationToken cancellationToken = default);
}
