namespace DanceMonkey.Ppt.Abstractions;

/// <summary>
/// 与具体 AI SDK 解耦的「长文本 Chat Completions」桥接，供大纲生成器在 WPF / CLI 等不同宿主中复用。
/// </summary>
public interface IPptLlmBridge
{
    /// <summary>
    /// 单次非流式调用，适合生成较长 JSON（如 PPT 大纲）。
    /// </summary>
    Task<PptLlmCallResult> CallLongAsync(
        string userMessage,
        string systemMessage,
        int maxTokens,
        double temperature,
        CancellationToken cancellationToken = default);
}

/// <summary>LLM 调用结果（与宿主侧 ApiCallResult / LlmResult 对齐的最小字段集）。</summary>
public readonly record struct PptLlmCallResult(bool Success, string? Text, string? Error);
