using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using DesktopAssistant.Models;

namespace DesktopAssistant.Services;

/// <summary>
/// 启动 DM Proxy 时自动配置 Codex：用户环境变量、auth.json、config.toml。
/// </summary>
public static class CodexIntegrationService
{
    public const string PlaceholderApiKey = "dancemonkey-local";
    public const string ProviderId = "dm_proxy";

    private const string MarkerStart = "# --- DanceMonkey DM Proxy (auto-managed) ---";
    private const string MarkerEnd = "# --- End DanceMonkey DM Proxy ---";

    private static readonly string[] LocalProxyBypassHosts = ["127.0.0.1", "localhost"];

    public sealed record ApplyResult(bool Success, IReadOnlyList<string> Messages, string? Error = null);

    public static string CodexHomeDirectory =>
        Environment.GetEnvironmentVariable("CODEX_HOME") is { Length: > 0 } custom
            ? custom
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codex");

    public static string ConfigTomlPath => Path.Combine(CodexHomeDirectory, "config.toml");
    public static string AuthJsonPath => Path.Combine(CodexHomeDirectory, "auth.json");

    public static ApplyResult Apply(AppConfig config)
    {
        if (!config.CodexAutoConfigure)
            return new ApplyResult(true, ["已跳过 Codex 自动配置（未启用）。"]);

        var messages = new List<string>();
        try
        {
            Directory.CreateDirectory(CodexHomeDirectory);

            var baseUrl = CodexProxyDesktopService.BuildBaseUrl(config);
            var codexModel = ResolveCodexModel(config);
            var reasoning = NormalizeReasoningEffort(config.CodexModelReasoningEffort);
            var upstreamKeyConfigured = !string.IsNullOrWhiteSpace(config.ApiKey);
            var codexApiKey = upstreamKeyConfigured ? PlaceholderApiKey : (config.ApiKey ?? "").Trim();

            if (string.IsNullOrWhiteSpace(codexApiKey))
            {
                return new ApplyResult(
                    false,
                    messages,
                    "未配置上游 API Key，且无法为 Codex 生成 OPENAI_API_KEY。请在本页填写上游 Key，或关闭自动配置后手动设置。");
            }

            ApplyUserEnvironmentVariable("OPENAI_API_KEY", codexApiKey, messages);
            ApplyNoProxyBypass(messages);

            WriteAuthJson(codexApiKey, messages);
            WriteConfigToml(baseUrl, codexModel, reasoning, messages);

            messages.Add($"config.toml: {ConfigTomlPath}");
            messages.Add($"auth.json: {AuthJsonPath}");
            messages.Add("请完全退出并重新打开 Codex，新的环境变量才会生效。");
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

        return "gpt-4o-mini";
    }

    private static string? NormalizeReasoningEffort(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
            return null;

        var normalized = value.Trim().ToLowerInvariant();
        return normalized is "low" or "medium" or "high" or "minimal" or "none"
            ? normalized
            : null;
    }

    private static void ApplyUserEnvironmentVariable(string name, string value, List<string> messages)
    {
        Environment.SetEnvironmentVariable(name, value, EnvironmentVariableTarget.User);
        messages.Add($"已设置用户环境变量 {name}");
    }

    private static void ApplyNoProxyBypass(List<string> messages)
    {
        foreach (var name in new[] { "NO_PROXY", "no_proxy" })
        {
            var merged = MergeProxyBypass(Environment.GetEnvironmentVariable(name, EnvironmentVariableTarget.User));
            Environment.SetEnvironmentVariable(name, merged, EnvironmentVariableTarget.User);
            messages.Add($"已更新用户环境变量 {name}={merged}");
        }
    }

    internal static string MergeProxyBypass(string? existing)
    {
        var items = new List<string>();
        if (!string.IsNullOrWhiteSpace(existing))
        {
            foreach (var part in existing.Split([';', ','], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                if (!items.Contains(part, StringComparer.OrdinalIgnoreCase))
                    items.Add(part);
            }
        }

        foreach (var host in LocalProxyBypassHosts)
        {
            if (!items.Contains(host, StringComparer.OrdinalIgnoreCase))
                items.Add(host);
        }

        return string.Join(";", items);
    }

    private static void WriteAuthJson(string apiKey, List<string> messages)
    {
        var payload = new Dictionary<string, string> { ["OPENAI_API_KEY"] = apiKey };
        var json = JsonSerializer.Serialize(payload, new JsonSerializerOptions { WriteIndented = true });
        File.WriteAllText(AuthJsonPath, json + Environment.NewLine, Encoding.UTF8);
        messages.Add("已写入 auth.json");
    }

    private static void WriteConfigToml(string baseUrl, string model, string? reasoningEffort, List<string> messages)
    {
        var managedBlock = BuildManagedBlock(baseUrl, model, reasoningEffort);
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

    private static string BuildManagedBlock(string baseUrl, string model, string? reasoningEffort)
    {
        var sb = new StringBuilder();
        sb.AppendLine(MarkerStart);
        sb.AppendLine("preferred_auth_method = \"apikey\"");
        sb.AppendLine($"model = \"{EscapeTomlString(model)}\"");
        if (!string.IsNullOrWhiteSpace(reasoningEffort))
            sb.AppendLine($"model_reasoning_effort = \"{EscapeTomlString(reasoningEffort)}\"");
        sb.AppendLine($"model_provider = \"{ProviderId}\"");
        sb.AppendLine();
        sb.AppendLine($"[model_providers.{ProviderId}]");
        sb.AppendLine("name = \"DM Proxy\"");
        sb.AppendLine($"base_url = \"{EscapeTomlString(baseUrl)}\"");
        sb.AppendLine("env_key = \"OPENAI_API_KEY\"");
        sb.AppendLine("wire_api = \"responses\"");
        sb.AppendLine("supports_websockets = false");
        sb.Append(MarkerEnd);
        return sb.ToString();
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
