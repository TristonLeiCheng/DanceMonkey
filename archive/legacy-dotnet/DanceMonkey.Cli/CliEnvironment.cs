namespace DanceMonkey.Cli;

/// <summary>
/// 环境变量覆盖配置（优先级高于 config.json）。便于 CI/脚本注入密钥而不落盘。
/// </summary>
internal static class CliEnvironment
{
    public const string EnvApiKey = "DANCEMONKEY_API_KEY";
    public const string EnvEndpoint = "DANCEMONKEY_ENDPOINT";
    public const string EnvModel = "DANCEMONKEY_MODEL";
    public const string EnvNotesRoot = "DANCEMONKEY_NOTES_ROOT";

    /// <summary>将非空环境变量写入 <paramref name="cfg"/>（就地修改）。</summary>
    public static void ApplyTo(CliConfig cfg)
    {
        var key = Environment.GetEnvironmentVariable(EnvApiKey);
        if (!string.IsNullOrWhiteSpace(key))
            cfg.ApiKey = key.Trim();

        var ep = Environment.GetEnvironmentVariable(EnvEndpoint);
        if (!string.IsNullOrWhiteSpace(ep))
            cfg.ApiEndpoint = ep.Trim();

        var model = Environment.GetEnvironmentVariable(EnvModel);
        if (!string.IsNullOrWhiteSpace(model))
            cfg.Model = model.Trim();

        var notes = Environment.GetEnvironmentVariable(EnvNotesRoot);
        if (!string.IsNullOrWhiteSpace(notes))
            cfg.NotesRootPath = notes.Trim();
    }
}
