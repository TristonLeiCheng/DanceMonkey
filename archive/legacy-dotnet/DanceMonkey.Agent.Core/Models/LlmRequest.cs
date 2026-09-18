namespace DanceMonkey.Agent.Core.Models;

/// <summary>
/// 向 LLM 发起的请求。使用 Agent.Core 内部中立模型，由具体 <c>ILlmClient</c> 适配器转换为
/// OpenAI / Anthropic / 公司网关等实际协议。
/// </summary>
public sealed class LlmRequest
{
    public required string SystemPrompt { get; init; }

    public required IReadOnlyList<AgentMessage> Messages { get; init; }

    /// <summary>模型名，为空时由适配器使用默认模型。</summary>
    public string? Model { get; init; }

    public int MaxTokens { get; init; } = 4096;

    public double Temperature { get; init; } = 0.3;

    /// <summary>是否请求流式输出。</summary>
    public bool Stream { get; init; } = true;
}
