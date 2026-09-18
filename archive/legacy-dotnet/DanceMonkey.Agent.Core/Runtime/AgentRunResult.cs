namespace DanceMonkey.Agent.Core.Runtime;

/// <summary>单轮 Agent 运行结果。</summary>
public sealed class AgentRunResult
{
    public required bool Success { get; init; }

    /// <summary>模型最终给出的文本回复（若成功）。</summary>
    public string? FinalAssistantText { get; init; }

    /// <summary>失败原因（若失败）。</summary>
    public string? Error { get; init; }

    /// <summary>本轮消耗 token 近似值。</summary>
    public long ApproxTokens { get; init; }

    /// <summary>本轮实际跑了多少次 LLM → 工具往返。</summary>
    public int StepsUsed { get; init; }
}
