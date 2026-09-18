using DanceMonkey.Ppt.Models;

namespace DanceMonkey.Ppt.Abstractions;

/// <summary>把 <see cref="PptDeck"/> 渲染为 .pptx 文件。当前唯一实现：ShapeCrawlerRenderer。</summary>
public interface IPptRenderer
{
    /// <summary>渲染并保存到 <paramref name="outputPath"/>。返回非致命警告列表。</summary>
    Task<IReadOnlyList<string>> RenderAsync(
        PptDeck deck,
        IPptTheme theme,
        string outputPath,
        CancellationToken cancellationToken = default);
}
