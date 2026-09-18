namespace DanceMonkey.Agent.Core.Models;

/// <summary>LLM 调用结果。</summary>
public sealed class LlmResult
{
    public required bool Success { get; init; }

    /// <summary>模型完整文本（流式场景下为所有 chunk 拼接）。</summary>
    public string? Text { get; init; }

    /// <summary>错误信息（Success=false 时）。</summary>
    public string? Error { get; init; }

    /// <summary>近似 token 消耗；适配器如能获取到真实 usage 则填真实值。</summary>
    public long ApproxTokens { get; init; }

    public static LlmResult Ok(string text, long approxTokens = 0) =>
        new() { Success = true, Text = text, ApproxTokens = approxTokens };

    public static LlmResult Fail(string error) =>
        new() { Success = false, Error = error };
}
