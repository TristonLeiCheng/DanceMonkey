using System.IO;
using System.Text.Json;
using DesktopAssistant.Models;

namespace DesktopAssistant.Services;

public sealed class ConfigService
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    private readonly string _configFilePath;

    public ConfigService()
    {
        var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        var dir = Path.Combine(appData, "DanceMonkey");
        Directory.CreateDirectory(dir);
        _configFilePath = Path.Combine(dir, "config.json");
        TryMigrateFromLegacyConfig(appData);
    }

    /// <summary>从旧版 DesktopAssistant 目录复制配置，避免升级后丢失设置。</summary>
    private void TryMigrateFromLegacyConfig(string appData)
    {
        if (File.Exists(_configFilePath))
            return;
        var legacy = Path.Combine(appData, "DesktopAssistant", "config.json");
        if (!File.Exists(legacy))
            return;
        try
        {
            File.Copy(legacy, _configFilePath, overwrite: false);
        }
        catch
        {
            // ignore
        }
    }

    public AppConfig Load()
    {
        if (!File.Exists(_configFilePath))
            return DefaultConfig();

        try
        {
            var json = File.ReadAllText(_configFilePath);
            var cfg = JsonSerializer.Deserialize<AppConfig>(json, JsonOptions);
            if (cfg == null)
                return DefaultConfig();
            cfg.EnsureModelProfiles();
            cfg.QuickLinks ??= new List<QuickLinkItem>();
            bool linksChanged = MergeDefaultLinks(cfg.QuickLinks);
            cfg.PromptSnippets ??= new List<PromptSnippetItem>();
            // 旧版 config 无此字段时反序列化为 0；与「关闭」区分：仅当 JSON 中不存在该键时采用默认 5 分钟
            if (cfg.PasswordVaultAutoLockMinutes == 0)
            {
                try
                {
                    using var doc = JsonDocument.Parse(json);
                    if (!doc.RootElement.TryGetProperty("passwordVaultAutoLockMinutes", out _))
                        cfg.PasswordVaultAutoLockMinutes = 5;
                }
                catch
                {
                    cfg.PasswordVaultAutoLockMinutes = 5;
                }
            }

            // 有新增默认链接时立即写回磁盘，保证下次冷启动也能看到
            if (linksChanged)
            {
                try
                {
                    var updated = JsonSerializer.Serialize(cfg, JsonOptions);
                    File.WriteAllText(_configFilePath, updated);
                }
                catch { /* ignore write failure */ }
            }

            return cfg;
        }
        catch
        {
            return DefaultConfig();
        }
    }

    /// <summary>
    /// 将系统内置默认链接合并进用户列表（按 Path 不区分大小写去重）。
    /// 返回 true 表示本次有新增条目，调用方可据此决定是否保存。
    /// </summary>
    private static bool MergeDefaultLinks(List<QuickLinkItem> existing)
    {
        var existingPaths = new HashSet<string>(
            existing.Select(q => q.Path ?? ""),
            StringComparer.OrdinalIgnoreCase);

        bool changed = false;
        foreach (var def in DefaultQuickLinks.Build())
        {
            if (!string.IsNullOrEmpty(def.Path) && !existingPaths.Contains(def.Path))
            {
                existing.Add(def);
                existingPaths.Add(def.Path);
                changed = true;
            }
        }
        return changed;
    }

    public bool Save(AppConfig config)
    {
        try
        {
            config.EnsureModelProfiles();
            var json = JsonSerializer.Serialize(config, JsonOptions);
            File.WriteAllText(_configFilePath, json);
            return true;
        }
        catch
        {
            return false;
        }
    }

    public static AppConfig DefaultConfig() => new()
    {
        Provider = "openai",
        ApiEndpoint = "",
        ApiKey = "",
        Model = "gpt-3.5-turbo",
        ModelProfiles = new List<ModelProfileItem>
        {
            new() { Name = "GPT-3.5 Turbo", Model = "gpt-3.5-turbo" },
            new() { Name = "GPT-4o Mini", Model = "gpt-4o-mini" },
            new() { Name = "GPT-4o", Model = "gpt-4o" }
        },
        PreferredUserName = "",
        FloatingIconEnabled = true,
        FloatingIconX = null,
        FloatingIconY = null,
        QuickLinks = DefaultQuickLinks.Build(), // full defaults for brand-new install
        PromptSnippets = new List<PromptSnippetItem>(),
        NotesRootPath = null,
        GraphTenantId = "common",
        GraphClientId = "",
        StartWithWindows = false,
        ClipboardHistoryEnabled = false,
        GlobalChatHotkey = "Ctrl+Shift+Q",
        QuickScreenshotHotkey = "Ctrl+Shift+S",
        RegionScreenshotHotkey = "Ctrl+Shift+R",
        NotesRestoreStickiesOnStartup = true,
        DockTheme = "ocean",
        HealthReminderEnabled = true,
        TodoReminderEnabled = true,
        TodoReminderMinutes = 30,
        WaterReminderMinutes = 45,
        MovementReminderMinutes = 60,
        LocalSttWhisperExePath = null,
        LocalSttModelPath = null,
        LocalSttLanguage = "zh",
        LocalSttThreads = 4,
        LocalSttAutoPunctuation = true,
        LocalSttTimeoutSeconds = 240,
        PasswordVaultAutoLockMinutes = 5,
        ProxyForceEnabled = false,
        ProxyForceMode = "manual",
        ProxyPacUrl = "",
        ProxyServer = "",
        ProxyPort = 8080,
        ProxyBypass = "",
        ProxyRefreshMinutes = 3,
        ProxyPacUrlShanghai = "",
        ProxyPacUrlBeijing = "",
        CodexProxyHost = "127.0.0.1",
        CodexProxyPort = 8000,
        CodexProxyTimeoutSeconds = 300,
        UpdateManifestUrl = ""
    };
}
