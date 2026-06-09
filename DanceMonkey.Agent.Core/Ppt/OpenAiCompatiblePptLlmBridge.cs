using DanceMonkey.Ppt.Abstractions;
using DanceMonkey.Agent.Core.Abstractions;
using DanceMonkey.Agent.Core.Models;

namespace DanceMonkey.Agent.Core.Ppt;

/// <summary>将 <see cref="ILlmClient"/>（CLI OpenAI 兼容客户端）适配为 <see cref="IPptLlmBridge"/>。</summary>
public sealed class OpenAiCompatiblePptLlmBridge : IPptLlmBridge
{
    private readonly ILlmClient _llm;
    private readonly string? _modelOverride;

    public OpenAiCompatiblePptLlmBridge(ILlmClient llm, string? modelOverride = null)
    {
        _llm = llm ?? throw new ArgumentNullException(nameof(llm));
        _modelOverride = modelOverride;
    }

    public async Task<PptLlmCallResult> CallLongAsync(
        string userMessage,
        string systemMessage,
        int maxTokens,
        double temperature,
        CancellationToken cancellationToken = default)
    {
        var req = new LlmRequest
        {
            SystemPrompt = systemMessage,
            Messages = new[] { AgentMessage.User(userMessage) },
            Model = _modelOverride,
            MaxTokens = maxTokens,
            Temperature = temperature,
            Stream = false,
        };

        var res = await _llm.CompleteAsync(req, null, cancellationToken).ConfigureAwait(false);
        return res.Success
            ? new PptLlmCallResult(true, res.Text, null)
            : new PptLlmCallResult(false, null, res.Error);
    }
}
