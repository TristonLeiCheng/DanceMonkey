using DanceMonkey.Ppt.Models;

namespace DanceMonkey.Ppt.Abstractions;

/// <summary>把请求 + 来源文档转成 <see cref="PptDeck"/>。AI 实现通常在此处调用 LLM。</summary>
public interface IPptOutlineGenerator
{
    /// <summary>
    /// 生成大纲。当 <paramref name="document"/> 为 null 时（例如 Topic 模式），实现应根据 <see cref="PptGenerationRequest.Topic"/> 自行展开。
    /// </summary>
    Task<PptDeck> GenerateAsync(
        PptGenerationRequest request,
        PptSourceDocument? document,
        CancellationToken cancellationToken = default);
}
