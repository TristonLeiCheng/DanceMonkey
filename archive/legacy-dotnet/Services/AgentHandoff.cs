using DanceMonkey.Agent.Core.Models;

namespace DesktopAssistant.Services;

/// <summary>GlobalChat → 主窗 AiChat Agent 的上下文交接。</summary>
public static class AgentHandoff
{
    public static string? PendingPrompt { get; private set; }
    public static bool EnableAgent { get; private set; } = true;
    public static AgentMode? SuggestedMode { get; private set; }

    public static void Request(string prompt, bool enableAgent = true, AgentMode? suggestedMode = null)
    {
        PendingPrompt = prompt;
        EnableAgent = enableAgent;
        SuggestedMode = suggestedMode;
        AgentAuditLog.Session($"handoff queued ({prompt.Length} chars)");
    }

    public static bool TryConsume(out string prompt, out bool enableAgent, out AgentMode? suggestedMode)
    {
        prompt = PendingPrompt ?? "";
        enableAgent = EnableAgent;
        suggestedMode = SuggestedMode;
        var had = !string.IsNullOrWhiteSpace(PendingPrompt);
        PendingPrompt = null;
        SuggestedMode = null;
        return had;
    }
}
