namespace DanceMonkey.Agent.Core.Proxy;

public sealed class CodexProxyOptions
{
    public string Host { get; init; } = "127.0.0.1";
    public int Port { get; init; } = 8000;
    public string ChatCompletionsEndpoint { get; init; } = "https://api.openai.com/v1/chat/completions";
    public string ApiKey { get; init; } = "";
    public string DefaultModel { get; init; } = "gpt-4o-mini";
    public TimeSpan UpstreamTimeout { get; init; } = TimeSpan.FromMinutes(5);
    public Action<string>? Log { get; init; }
}
