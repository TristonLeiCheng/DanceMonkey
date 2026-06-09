using System.Text.Json;
using System.Text.Json.Serialization;
using DanceMonkey.Agent.Core.Models;

namespace DanceMonkey.Cli;

/// <summary>CLI 会话磁盘格式（与 Agent.Core 模型解耦，避免 HashSet 等序列化细节问题）。</summary>
internal sealed class CliSessionEnvelope
{
    public int Version { get; set; } = 1;
    public DateTime SavedAtUtc { get; set; }
    public string? PrimaryRootAtSave { get; set; }
    public CliSessionSnapshot Session { get; set; } = null!;
}

internal sealed class CliSessionSnapshot
{
    public string? Id { get; set; }
    public DateTime CreatedUtc { get; set; }
    public DateTime UpdatedUtc { get; set; }
    public string? Title { get; set; }
    public string? Model { get; set; }
    public AgentMode Mode { get; set; }
    public string WorkingDirectory { get; set; } = "";
    public List<string> AdditionalWorkingDirectories { get; set; } = new();
    public List<AgentMessageSnapshot> Messages { get; set; } = new();
    public List<string> AllowedScopes { get; set; } = new();
    public List<string> EnabledSkills { get; set; } = new();
    public long ApproxTokens { get; set; }
}

internal sealed class AgentMessageSnapshot
{
    public string Role { get; set; } = "";
    public string Content { get; set; } = "";
    public string? ToolName { get; set; }
    public DateTime TimestampUtc { get; set; }
}

/// <summary>会话保存/加载、列表、自动保存。</summary>
internal static class CliSessionStore
{
    public const string AutosaveFileName = "autosave.json";

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
    };

    public static string SessionsDirectory
    {
        get
        {
            var root = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            var dir = Path.Combine(root, "DanceMonkey", "CliSessions");
            Directory.CreateDirectory(dir);
            return dir;
        }
    }

    public static string AutosavePath => Path.Combine(SessionsDirectory, AutosaveFileName);

    public static AgentSession FromSnapshot(CliSessionSnapshot s)
    {
        var messages = s.Messages.Select(m => new AgentMessage
        {
            Role = m.Role ?? "user",
            Content = m.Content ?? "",
            ToolName = m.ToolName,
            TimestampUtc = m.TimestampUtc == default ? DateTime.UtcNow : m.TimestampUtc,
        }).ToList();

        return new AgentSession
        {
            Id = string.IsNullOrWhiteSpace(s.Id) ? Guid.NewGuid().ToString("N")[..12] : s.Id!,
            CreatedUtc = s.CreatedUtc == default ? DateTime.UtcNow : s.CreatedUtc,
            UpdatedUtc = s.UpdatedUtc == default ? DateTime.UtcNow : s.UpdatedUtc,
            Title = s.Title,
            Model = s.Model,
            Mode = s.Mode,
            WorkingDirectory = s.WorkingDirectory ?? "",
            AdditionalWorkingDirectories = new List<string>(s.AdditionalWorkingDirectories),
            Messages = messages,
            AllowedScopes = new HashSet<string>(s.AllowedScopes, StringComparer.OrdinalIgnoreCase),
            EnabledSkills = new HashSet<string>(s.EnabledSkills, StringComparer.OrdinalIgnoreCase),
            ApproxTokens = s.ApproxTokens,
        };
    }

    public static CliSessionSnapshot ToSnapshot(AgentSession s) => new()
    {
        Id = s.Id,
        CreatedUtc = s.CreatedUtc,
        UpdatedUtc = s.UpdatedUtc,
        Title = s.Title,
        Model = s.Model,
        Mode = s.Mode,
        WorkingDirectory = s.WorkingDirectory,
        AdditionalWorkingDirectories = s.AdditionalWorkingDirectories.ToList(),
        Messages = s.Messages.Select(m => new AgentMessageSnapshot
        {
            Role = m.Role,
            Content = m.Content,
            ToolName = m.ToolName,
            TimestampUtc = m.TimestampUtc,
        }).ToList(),
        AllowedScopes = s.AllowedScopes.ToList(),
        EnabledSkills = s.EnabledSkills.ToList(),
        ApproxTokens = s.ApproxTokens,
    };

    public static void SaveToFile(AgentSession session, string absolutePath, string? primaryRoot)
    {
        session.UpdatedUtc = DateTime.UtcNow;
        var env = new CliSessionEnvelope
        {
            Version = 1,
            SavedAtUtc = DateTime.UtcNow,
            PrimaryRootAtSave = primaryRoot,
            Session = ToSnapshot(session),
        };
        var json = JsonSerializer.Serialize(env, JsonOpts);
        File.WriteAllText(absolutePath, json, System.Text.Encoding.UTF8);
    }

    public static AgentSession LoadFromFile(string absolutePath)
    {
        var json = File.ReadAllText(absolutePath, System.Text.Encoding.UTF8);
        var env = JsonSerializer.Deserialize<CliSessionEnvelope>(json, JsonOpts)
                  ?? throw new InvalidDataException("会话文件为空或无法解析。");
        if (env.Session == null)
            throw new InvalidDataException("会话文件缺少 session 字段。");
        return FromSnapshot(env.Session);
    }

    public static bool TryAutosave(AgentSession session, string? primaryRoot, out string? error)
    {
        try
        {
            SaveToFile(session, AutosavePath, primaryRoot);
            error = null;
            return true;
        }
        catch (Exception ex)
        {
            error = ex.Message;
            return false;
        }
    }

    public static IReadOnlyList<SessionListItem> ListSavedSessions()
    {
        var dir = SessionsDirectory;
        var list = new List<SessionListItem>();
        foreach (var path in Directory.EnumerateFiles(dir, "*.json", SearchOption.TopDirectoryOnly))
        {
            if (Path.GetFileName(path).Equals(AutosaveFileName, StringComparison.OrdinalIgnoreCase))
                continue;
            try
            {
                var fi = new FileInfo(path);
                var env = JsonSerializer.Deserialize<CliSessionEnvelope>(
                    File.ReadAllText(path, System.Text.Encoding.UTF8), JsonOpts);
                if (env?.Session == null) continue;
                list.Add(new SessionListItem(
                    Path.GetFileNameWithoutExtension(path),
                    env.Session.Id ?? "?",
                    env.Session.Title,
                    env.SavedAtUtc,
                    fi.Length));
            }
            catch
            {
                // 跳过坏文件
            }
        }

        return list.OrderByDescending(x => x.SavedAtUtc).ToList();
    }

    public static string ResolveSessionPath(string idOrFileName)
    {
        var trimmed = idOrFileName.Trim();
        if (trimmed.Equals("autosave", StringComparison.OrdinalIgnoreCase))
        {
            if (!File.Exists(AutosavePath))
                throw new FileNotFoundException("尚无自动保存文件。", AutosavePath);
            return AutosavePath;
        }

        if (trimmed.Contains(Path.DirectorySeparatorChar) || trimmed.Contains(Path.AltDirectorySeparatorChar))
        {
            var full = Path.GetFullPath(trimmed);
            if (!File.Exists(full))
                throw new FileNotFoundException("找不到会话文件。", full);
            return full;
        }

        var name = trimmed.EndsWith(".json", StringComparison.OrdinalIgnoreCase) ? trimmed : trimmed + ".json";
        var path = Path.Combine(SessionsDirectory, name);
        if (!File.Exists(path))
            throw new FileNotFoundException($"找不到会话: {name}", path);
        return path;
    }

    public static string SanitizeFileStem(string name)
    {
        var invalid = Path.GetInvalidFileNameChars();
        var sb = new System.Text.StringBuilder(name.Length);
        foreach (var c in name.Trim())
            sb.Append(invalid.Contains(c) ? '_' : c);
        var s = sb.ToString();
        return string.IsNullOrWhiteSpace(s) ? "session" : s;
    }
}

internal sealed record SessionListItem(
    string FileStem,
    string SessionId,
    string? Title,
    DateTime SavedAtUtc,
    long FileSizeBytes);

/// <summary>将 <c>--session</c> 读入的会话与当前启动参数对齐。</summary>
internal static class CliSessionMerge
{
    /// <param name="cliSpecifiesMode">是否传了 <c>-y</c> 或 <c>--mode</c>；为 false 时保留文件中的模式。</param>
    public static CliSessionMergeReport ApplyAfterStartupLoad(
        AgentSession s,
        string primaryRoot,
        AgentMode cliMode,
        bool cliSpecifiesMode,
        string? modelOverride)
    {
        var report = new CliSessionMergeReport();
        if (!string.Equals(s.WorkingDirectory, primaryRoot, StringComparison.OrdinalIgnoreCase))
        {
            report.ChangedFields.Add($"workingDirectory: {s.WorkingDirectory} -> {primaryRoot}");
        }
        s.WorkingDirectory = primaryRoot;
        if (!string.IsNullOrWhiteSpace(modelOverride))
        {
            if (!string.Equals(s.Model, modelOverride, StringComparison.Ordinal))
                report.ChangedFields.Add($"model: {(s.Model ?? "default")} -> {modelOverride}");
            s.Model = modelOverride;
        }
        if (cliSpecifiesMode)
        {
            if (s.Mode != cliMode)
                report.ChangedFields.Add($"mode: {s.Mode} -> {cliMode}");
            s.Mode = cliMode;
        }
        s.UpdatedUtc = DateTime.UtcNow;
        return report;
    }
}

internal sealed class CliSessionMergeReport
{
    public List<string> ChangedFields { get; } = new();
}
