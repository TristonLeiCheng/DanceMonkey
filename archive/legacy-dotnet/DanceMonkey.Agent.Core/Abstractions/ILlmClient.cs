using DanceMonkey.Agent.Core.Models;

namespace DanceMonkey.Agent.Core.Abstractions;

/// <summary>
/// 与具体 AI 网关解耦的 LLM 客户端抽象（如 OpenAI 兼容 HTTP 实现）。
/// </summary>
public interface ILlmClient
{
    /// <summary>发起一次（可流式）调用。若 <paramref name="onChunk"/> 非空且底层支持流式，应逐块回调。</summary>
    Task<LlmResult> CompleteAsync(
        LlmRequest request,
        Action<string>? onChunk,
        CancellationToken ct);
}
