using System.Text;

namespace DesktopAssistant.Services;

/// <summary>Agent 工具与审批审计日志（%LocalAppData%\DanceMonkey\logs\agent-audit.log）。</summary>
public static class AgentAuditLog
{
    private static readonly object Gate = new();

    public static string LogPath
    {
        get
        {
            var dir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "DanceMonkey",
                "logs");
            Directory.CreateDirectory(dir);
            return Path.Combine(dir, "agent-audit.log");
        }
    }

    public static void ToolStart(string tool, string summary) =>
        Write($"TOOL_START {tool} | {Sanitize(summary)}");

    public static void ToolEnd(string tool, bool success, string? detail) =>
        Write($"TOOL_END {(success ? "OK" : "FAIL")} {tool} | {Sanitize(detail ?? "")}");

    public static void Approval(string tool, string decision, string? detail = null) =>
        Write($"APPROVAL {decision} {tool} | {Sanitize(detail ?? "")}");

    public static void Session(string message) =>
        Write($"SESSION {Sanitize(message)}");

    private static void Write(string line)
    {
        try
        {
            var entry = $"[{DateTime.UtcNow:yyyy-MM-dd HH:mm:ss}Z] {line}{Environment.NewLine}";
            lock (Gate)
                File.AppendAllText(LogPath, entry, Encoding.UTF8);
        }
        catch
        {
            // 审计失败不阻塞 Agent
        }
    }

    private static string Sanitize(string s)
    {
        if (string.IsNullOrEmpty(s)) return "";
        return s.Replace('\r', ' ').Replace('\n', ' ').Trim();
    }
}
