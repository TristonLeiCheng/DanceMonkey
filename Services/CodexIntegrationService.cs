using System.Text;
using System.Text.RegularExpressions;
using DesktopAssistant.Models;

namespace DesktopAssistant.Services;

/// <summary>
/// 启动 DM Proxy 时自动配置 Codex：NO_PROXY 环境变量与 config.toml。
/// </summary>
public static class CodexIntegrationService
{
    public const string ProviderId = "api";
    public const string ProviderName = "DMproxy";
    public const string NoProxyValue = "localhost,127.0.0.1";
    public const string DefaultCodexModel = "gpt-5.5";
    public const string DefaultReasoningEffort = "medium";

    public static readonly IReadOnlyList<string> PresetCodexModels =
    [
        "gpt-5.5",
        "claude-opus-4.6",
        "claude-opus-4.7",
        "claude-opus-4.8",
        "claude-sonnet-4.6",
        "claude-sonnet-4.7",
        "claude-sonnet-4.8",
    ];

    private const string MarkerStart = "# --- DanceMonkey DM Proxy (auto-managed) ---";
    private const string MarkerEnd = "# --- End DanceMonkey DM Proxy ---";

    public sealed record ApplyResult(bool Success, IReadOnlyList<string> Messages, string? Error = null);

    public static string CodexHomeDirectory =>
        Environment.GetEnvironmentVariable("CODEX_HOME") is { Length: > 0 } custom
            ? custom
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codex");

    public static string ConfigTomlPath => Path.Combine(CodexHomeDirectory, "config.toml");

    public static ApplyResult Apply(AppConfig config)
    {
        if (!config.CodexAutoConfigure)
            return new ApplyResult(true, ["已跳过 Codex 自动配置（未启用）。"]);

        return WriteCodexConfig(config);
    }

    public static ApplyResult WriteCodexConfig(AppConfig config)
    {
        var messages = new List<string>();
        try
        {
            Directory.CreateDirectory(CodexHomeDirectory);
            WriteConfigToml(config, messages);
            ApplyNoProxyUserEnv(messages);

            messages.Add($"config.toml: {ConfigTomlPath}");
            messages.Add("请完全退出并重新打开 Codex；新环境变量需重启应用后生效。");
            return new ApplyResult(true, messages);
        }
        catch (Exception ex)
        {
            return new ApplyResult(false, messages, ex.Message);
        }
    }

    /// <summary>等价于 setx NO_PROXY "localhost,127.0.0.1"</summary>
    public static ApplyResult ApplyNoProxyManual()
    {
        var messages = new List<string>();
        try
        {
            ApplyNoProxyUserEnv(messages);
            messages.Add("等价命令: setx NO_PROXY \"localhost,127.0.0.1\"");
            messages.Add("请完全退出并重新打开 Codex / VS Code 后生效。");
            return new ApplyResult(true, messages);
        }
        catch (Exception ex)
        {
            return new ApplyResult(false, messages, ex.Message);
        }
    }

    public static string ResolveCodexModel(AppConfig config)
    {
        if (!string.IsNullOrWhiteSpace(config.CodexModel))
            return config.CodexModel.Trim();

        if (!string.IsNullOrWhiteSpace(config.Model))
            return config.Model.Trim();

        return DefaultCodexModel;
    }

    private static void ApplyNoProxyUserEnv(List<string> messages)
    {
        foreach (var name in new[] { "NO_PROXY", "no_proxy" })
        {
            Environment.SetEnvironmentVariable(name, NoProxyValue, EnvironmentVariableTarget.User);
            messages.Add($"已设置用户环境变量 {name}={NoProxyValue}");
        }
    }

    private static void WriteConfigToml(AppConfig config, List<string> messages)
    {
        var managedBlock = BuildManagedBlock(config);
        string content;

        if (File.Exists(ConfigTomlPath))
        {
            var existing = File.ReadAllText(ConfigTomlPath, Encoding.UTF8);
            content = ReplaceManagedBlock(existing, managedBlock);
            messages.Add("已更新 config.toml（保留其他自定义配置）");
        }
        else
        {
            content = managedBlock + Environment.NewLine;
            messages.Add("已创建 config.toml");
        }

        File.WriteAllText(ConfigTomlPath, content, Encoding.UTF8);
    }

    private static string BuildManagedBlock(AppConfig config)
    {
        var baseUrl = CodexProxyDesktopService.BuildBaseUrl(config);
        var model = ResolveCodexModel(config);
        var reasoning = NormalizeReasoningEffort(config.CodexModelReasoningEffort);
        var reasoningSummary = NormalizeReasoningSummary(config.CodexModelReasoningSummary);
        var contextWindow = config.CodexModelContextWindow is > 0 ? config.CodexModelContextWindow : 1_000_000;
        var compactLimit = config.CodexModelAutoCompactTokenLimit is > 0
            ? config.CodexModelAutoCompactTokenLimit
            : 900_000;

        var sb = new StringBuilder();
        sb.AppendLine(MarkerStart);
        sb.AppendLine($"model = \"{EscapeTomlString(model)}\"");
        if (!string.IsNullOrWhiteSpace(reasoning))
            sb.AppendLine($"model_reasoning_effort = \"{EscapeTomlString(reasoning)}\"");
        sb.AppendLine($"model_context_window = {contextWindow}");
        sb.AppendLine($"model_auto_compact_token_limit = {compactLimit}");
        if (!string.IsNullOrWhiteSpace(reasoningSummary))
            sb.AppendLine($"model_reasoning_summary = \"{EscapeTomlString(reasoningSummary)}\"");
        sb.AppendLine($"model_provider = \"{ProviderId}\"");
        sb.AppendLine();
        sb.AppendLine($"[model_providers.{ProviderId}]");
        sb.AppendLine($"name = \"{ProviderName}\"");
        sb.AppendLine($"base_url = \"{EscapeTomlString(baseUrl)}\"");
        sb.AppendLine("wire_api = \"responses\"");
        sb.AppendLine("requires_openai_auth = false");
        sb.Append(MarkerEnd);
        return sb.ToString();
    }

    private static string? NormalizeReasoningEffort(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
            return null;

        var normalized = value.Trim().ToLowerInvariant();
        return normalized is "minimal" or "none" or "low" or "medium" or "high" or "xhigh"
            ? normalized
            : value.Trim();
    }

    private static string? NormalizeReasoningSummary(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
            return null;

        return value.Trim();
    }

    private static string ReplaceManagedBlock(string existing, string managedBlock)
    {
        var pattern = Regex.Escape(MarkerStart) + ".*?" + Regex.Escape(MarkerEnd);
        var withoutManaged = Regex.Replace(existing, pattern, "", RegexOptions.Singleline).TrimEnd();

        if (string.IsNullOrWhiteSpace(withoutManaged))
            return managedBlock + Environment.NewLine;

        return withoutManaged + Environment.NewLine + Environment.NewLine + managedBlock + Environment.NewLine;
    }

    private static string EscapeTomlString(string value) =>
        value.Replace("\\", "\\\\").Replace("\"", "\\\"");
}
