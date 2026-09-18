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
    private const string CommentedByDanceMonkey = "# [DanceMonkey commented out]";

    private static readonly HashSet<string> ConflictingRootKeys = new(StringComparer.OrdinalIgnoreCase)
    {
        "model",
        "model_provider",
        "model_reasoning_effort",
        "model_context_window",
        "model_auto_compact_token_limit",
        "model_reasoning_summary",
        "forced_login_method",
        "cli_auth_credentials_store",
        "disable_response_storage",
    };

    private static readonly Regex ManagedBlockRegex = new(
        Regex.Escape(MarkerStart) + ".*?" + Regex.Escape(MarkerEnd),
        RegexOptions.Singleline | RegexOptions.Compiled);

    private static readonly Regex SectionHeaderRegex = new(
        @"^\s*\[[^\]]+\]\s*$",
        RegexOptions.Compiled);

    private static readonly Regex ModelProvidersSectionRegex = new(
        @"^\s*\[model_providers\.[^\]]+\]\s*$",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    private static readonly Regex RootKeyRegex = new(
        @"^\s*([\w.-]+)\s*=",
        RegexOptions.Compiled);

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

    /// <summary>移除 DanceMonkey 注入的 config.toml 配置块。</summary>
    public static ApplyResult RestoreCodexConfigDefault()
    {
        var messages = new List<string>();
        try
        {
            if (!File.Exists(ConfigTomlPath))
            {
                messages.Add("config.toml 不存在，无需恢复。");
                return new ApplyResult(true, messages);
            }

            var existing = File.ReadAllText(ConfigTomlPath, Encoding.UTF8);
            if (!ManagedBlockRegex.IsMatch(existing))
            {
                messages.Add("未找到 DanceMonkey 注入的配置块。");
                return new ApplyResult(true, messages);
            }

            var withoutManaged = RemoveManagedBlocks(existing).Trim();
            if (string.IsNullOrWhiteSpace(withoutManaged))
            {
                File.Delete(ConfigTomlPath);
                messages.Add("已移除注入配置并删除空的 config.toml。");
            }
            else
            {
                File.WriteAllText(ConfigTomlPath, withoutManaged + Environment.NewLine, Encoding.UTF8);
                messages.Add("已移除 DanceMonkey 注入的配置块。");
                messages.Add($"config.toml: {ConfigTomlPath}");
            }

            messages.Add("请完全退出并重新打开 Codex。");
            return new ApplyResult(true, messages);
        }
        catch (Exception ex)
        {
            return new ApplyResult(false, messages, ex.Message);
        }
    }

    public static string ResolveCodexModel(AppConfig config)
    {
        if (!string.IsNullOrWhiteSpace(config.Model))
            return config.Model.Trim();

        if (!string.IsNullOrWhiteSpace(config.CodexModel))
            return config.CodexModel.Trim();

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
            content = MergeConfigWithManagedBlock(existing, managedBlock, messages);
            messages.Add("已将 DM Proxy 配置写入 config.toml 顶部");
        }
        else
        {
            content = managedBlock + Environment.NewLine;
            messages.Add("已创建 config.toml");
        }

        File.WriteAllText(ConfigTomlPath, content, Encoding.UTF8);
    }

    private static string MergeConfigWithManagedBlock(string existing, string managedBlock, List<string> messages)
    {
        var withoutManaged = RemoveManagedBlocks(existing);
        var (commentedCount, remainder) = CommentOutConflictingConfig(withoutManaged);

        if (commentedCount > 0)
            messages.Add($"已注释 {commentedCount} 行可能冲突的旧配置（model / model_provider / model_providers 等）");

        remainder = remainder.Trim();
        if (string.IsNullOrWhiteSpace(remainder))
            return managedBlock + Environment.NewLine;

        return managedBlock + Environment.NewLine + Environment.NewLine + remainder + Environment.NewLine;
    }

    private static string RemoveManagedBlocks(string content) =>
        ManagedBlockRegex.Replace(content, "").Trim();

    private static (int CommentedCount, string Content) CommentOutConflictingConfig(string content)
    {
        if (string.IsNullOrWhiteSpace(content))
            return (0, "");

        var lines = content.Replace("\r\n", "\n").Split('\n');
        var result = new List<string>(lines.Length);
        var commentedCount = 0;
        var inModelProviderSection = false;

        foreach (var rawLine in lines)
        {
            var line = rawLine.TrimEnd('\r');
            var trimmedStart = line.TrimStart();

            if (trimmedStart.Length == 0)
            {
                result.Add(line);
                continue;
            }

            if (trimmedStart.StartsWith('#'))
            {
                result.Add(line);
                if (inModelProviderSection && SectionHeaderRegex.IsMatch(line))
                    inModelProviderSection = false;
                continue;
            }

            if (ModelProvidersSectionRegex.IsMatch(line))
            {
                inModelProviderSection = true;
                result.Add(CommentOutLine(line));
                commentedCount++;
                continue;
            }

            if (inModelProviderSection)
            {
                if (SectionHeaderRegex.IsMatch(line))
                {
                    inModelProviderSection = false;
                }
                else
                {
                    result.Add(CommentOutLine(line));
                    commentedCount++;
                    continue;
                }
            }

            var keyMatch = RootKeyRegex.Match(line);
            if (keyMatch.Success && ConflictingRootKeys.Contains(keyMatch.Groups[1].Value))
            {
                result.Add(CommentOutLine(line));
                commentedCount++;
                continue;
            }

            result.Add(line);
        }

        return (commentedCount, string.Join(Environment.NewLine, result));
    }

    private static string CommentOutLine(string line)
    {
        if (string.IsNullOrWhiteSpace(line))
            return line;

        var index = 0;
        while (index < line.Length && char.IsWhiteSpace(line[index]))
            index++;

        if (index < line.Length && line[index] == '#')
            return line;

        var indent = line[..index];
        var body = line[index..];
        return $"{indent}{CommentedByDanceMonkey} {body}";
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

    private static string EscapeTomlString(string value) =>
        value.Replace("\\", "\\\\").Replace("\"", "\\\"");
}
