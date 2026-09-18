using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using DanceMonkey.Agent.Core.Models;

namespace DanceMonkey.Agent.Core.Runtime;

/// <summary>Agent 会话磁盘格式（CLI / GUI 共用）。</summary>
public sealed class AgentSessionEnvelope
{
    public int Version { get; set; } = 1;
    public DateTime SavedAtUtc { get; set; }
    public string? PrimaryRootAtSave { get; set; }
    public AgentSessionSnapshot Session { get; set; } = null!;
}

public sealed class AgentSessionSnapshot
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

public sealed class AgentMessageSnapshot
{
    public string Role { get; set; } = "";
    public string Content { get; set; } = "";
    public string? ToolName { get; set; }
    public DateTime TimestampUtc { get; set; }
}

/// <summary>Agent 会话保存/加载（目录可配置：CLI / GUI 各用子文件夹）。</summary>
public static class AgentSessionStore
{
    public const string AutosaveFileName = "autosave.json";

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
    };

    public static string GetSessionsDirectory(string subFolder)
    {
        var root = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var dir = Path.Combine(root, "DanceMonkey", subFolder);
        Directory.CreateDirectory(dir);
        return dir;
    }

    public static string GuiSessionsDirectory => GetSessionsDirectory("GuiAgentSessions");
    public static string GuiAiChatSessionsDirectory => GetSessionsDirectory(Path.Combine("GuiAgentSessions", "AiChat"));
    public static string GuiGlobalChatSessionsDirectory => GetSessionsDirectory(Path.Combine("GuiAgentSessions", "GlobalChat"));
    public static string CliSessionsDirectory => GetSessionsDirectory("CliSessions");

    public static string AutosavePath(string sessionsDirectory) =>
        Path.Combine(sessionsDirectory, AutosaveFileName);

    public static AgentSession FromSnapshot(AgentSessionSnapshot s)
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

    public static AgentSessionSnapshot ToSnapshot(AgentSession s) => new()
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
        var env = new AgentSessionEnvelope
        {
            Version = 1,
            SavedAtUtc = DateTime.UtcNow,
            PrimaryRootAtSave = primaryRoot,
            Session = ToSnapshot(session),
        };
        var json = JsonSerializer.Serialize(env, JsonOpts);
        File.WriteAllText(absolutePath, json, Encoding.UTF8);
    }

    public static AgentSession LoadFromFile(string absolutePath)
    {
        var json = File.ReadAllText(absolutePath, Encoding.UTF8);
        var env = JsonSerializer.Deserialize<AgentSessionEnvelope>(json, JsonOpts)
                  ?? throw new InvalidDataException("会话文件为空或无法解析。");
        if (env.Session == null)
            throw new InvalidDataException("会话文件缺少 session 字段。");
        return FromSnapshot(env.Session);
    }

    public static bool TryAutosave(AgentSession session, string sessionsDirectory, string? primaryRoot, out string? error)
    {
        try
        {
            SaveToFile(session, AutosavePath(sessionsDirectory), primaryRoot);
            error = null;
            return true;
        }
        catch (Exception ex)
        {
            error = ex.Message;
            return false;
        }
    }

    public static bool TryLoadAutosave(string sessionsDirectory, out AgentSession? session)
    {
        session = null;
        var path = AutosavePath(sessionsDirectory);
        if (!File.Exists(path)) return false;
        try
        {
            session = LoadFromFile(path);
            return true;
        }
        catch
        {
            return false;
        }
    }

    public static void DeleteAutosave(string sessionsDirectory)
    {
        var path = AutosavePath(sessionsDirectory);
        if (File.Exists(path))
        {
            try { File.Delete(path); } catch { /* ignore */ }
        }
    }

    public static string SanitizeFileStem(string name)
    {
        var invalid = Path.GetInvalidFileNameChars();
        var sb = new StringBuilder(name.Length);
        foreach (var c in name.Trim())
            sb.Append(invalid.Contains(c) ? '_' : c);
        var s = sb.ToString();
        return string.IsNullOrWhiteSpace(s) ? "session" : s;
    }
}
