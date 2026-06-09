using System.Text.Json;
using System.Text.Json.Serialization;

namespace DanceMonkey.Cli;

/// <summary>
/// 极简配置读取器，仅抽取 CLI 所需字段（与 WPF 端共用 %AppData%\DanceMonkey\config.json）。
/// 故意不引用 <c>DesktopAssistant.Models.AppConfig</c>，避免拉入 WPF 依赖。
/// </summary>
internal sealed class CliConfig
{
    [JsonPropertyName("provider")] public string Provider { get; set; } = "openai";
    [JsonPropertyName("apiEndpoint")] public string ApiEndpoint { get; set; } = "";
    [JsonPropertyName("apiKey")] public string ApiKey { get; set; } = "";
    [JsonPropertyName("model")] public string Model { get; set; } = "gpt-4o-mini";
    [JsonPropertyName("modelProfiles")] public List<CliModelProfile> ModelProfiles { get; set; } = new();
    [JsonPropertyName("cliMaxTokens")] public int CliMaxTokens { get; set; } = 8192;
    [JsonPropertyName("sandboxPath")] public string? SandboxPath { get; set; }

    /// <summary>与 WPF 端 <c>AppConfig.NotesRootPath</c> 相同；留空则默认「文档\NoteVault」。</summary>
    [JsonPropertyName("notesRootPath")] public string? NotesRootPath { get; set; }

    public static string ResolveConfigPath()
    {
        var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        return Path.Combine(appData, "DanceMonkey", "config.json");
    }

    public static CliConfig Load()
    {
        var path = ResolveConfigPath();
        if (!File.Exists(path))
        {
            var empty = new CliConfig();
            CliEnvironment.ApplyTo(empty);
            empty.NormalizeModels();
            return empty;
        }

        try
        {
            var json = File.ReadAllText(path);
            var opts = new JsonSerializerOptions
            {
                PropertyNameCaseInsensitive = true,
            };
            var cfg = JsonSerializer.Deserialize<CliConfig>(json, opts) ?? new CliConfig();
            cfg.NormalizeModels();
            CliEnvironment.ApplyTo(cfg);
            cfg.NormalizeModels();
            return cfg;
        }
        catch
        {
            var cfg = new CliConfig();
            CliEnvironment.ApplyTo(cfg);
            cfg.NormalizeModels();
            return cfg;
        }
    }

    public string ResolveModel(string? selector = null)
    {
        var value = string.IsNullOrWhiteSpace(selector) ? Model : selector.Trim();
        var matched = ModelProfiles.FirstOrDefault(m =>
            string.Equals(m.Name, value, StringComparison.OrdinalIgnoreCase) ||
            string.Equals(m.Model, value, StringComparison.OrdinalIgnoreCase));
        return string.IsNullOrWhiteSpace(matched?.Model)
            ? (string.IsNullOrWhiteSpace(value) ? "gpt-4o-mini" : value)
            : matched.Model.Trim();
    }

    private void NormalizeModels()
    {
        Model = string.IsNullOrWhiteSpace(Model) ? "gpt-4o-mini" : Model.Trim();
        ModelProfiles ??= new List<CliModelProfile>();

        var normalized = new List<CliModelProfile>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var item in ModelProfiles)
        {
            var model = item.Model?.Trim() ?? "";
            if (model.Length == 0 || !seen.Add(model))
                continue;

            var name = item.Name?.Trim() ?? "";
            normalized.Add(new CliModelProfile
            {
                Name = string.IsNullOrWhiteSpace(name) ? model : name,
                Model = model
            });
        }

        if (!seen.Contains(Model))
            normalized.Insert(0, new CliModelProfile { Name = Model, Model = Model });

        ModelProfiles = normalized;
    }

    public string ResolveSandboxRoot()
    {
        if (!string.IsNullOrWhiteSpace(SandboxPath) && Directory.Exists(SandboxPath))
            return SandboxPath!;

        var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        var fallback = Path.Combine(appData, "DanceMonkey", "Sandbox");
        Directory.CreateDirectory(fallback);
        return fallback;
    }
}

internal sealed class CliModelProfile
{
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("model")] public string Model { get; set; } = "";
}
