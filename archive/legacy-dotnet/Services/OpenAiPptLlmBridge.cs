using DanceMonkey.Ppt.Abstractions;

namespace DesktopAssistant.Services;

/// <summary>将桌面端 <see cref="OpenAiApiClient"/> 适配为 <see cref="IPptLlmBridge"/>，供 PPT 大模块复用。</summary>
internal sealed class OpenAiPptLlmBridge : IPptLlmBridge
{
    private readonly OpenAiApiClient _client;

    public OpenAiPptLlmBridge(OpenAiApiClient client) =>
        _client = client ?? throw new ArgumentNullException(nameof(client));

    public async Task<PptLlmCallResult> CallLongAsync(
        string userMessage,
        string systemMessage,
        int maxTokens,
        double temperature,
        CancellationToken cancellationToken = default)
    {
        var r = await _client
            .CallAsyncLong(userMessage, systemMessage, maxTokens, temperature, cancellationToken)
            .ConfigureAwait(false);
        return new PptLlmCallResult(r.Success, r.Result, r.Error);
    }
}
