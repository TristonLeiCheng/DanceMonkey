namespace DanceMonkey.Agent.Core.Models;

/// <summary>
/// 一次 Agent 会话。包含对话历史、当前模式、工作目录等运行时状态。
/// 可序列化为 JSON 持久化（用于 <c>/resume</c>）。
/// </summary>
public sealed class AgentSession
{
    /// <summary>会话唯一 ID。</summary>
    public string Id { get; init; } = Guid.NewGuid().ToString("N")[..12];

    /// <summary>创建时间（UTC）。</summary>
    public DateTime CreatedUtc { get; init; } = DateTime.UtcNow;

    /// <summary>最后更新时间（UTC）。</summary>
    public DateTime UpdatedUtc { get; set; } = DateTime.UtcNow;

    /// <summary>人类可读标题，缺省时取首条用户消息前 40 字。</summary>
    public string? Title { get; set; }

    /// <summary>会话使用的模型名（可被 /model 切换）。</summary>
    public string? Model { get; set; }

    /// <summary>当前权限模式。</summary>
    public AgentMode Mode { get; set; } = AgentMode.Ask;

    /// <summary>工作目录（绝对路径）。默认指向沙箱。</summary>
    public string WorkingDirectory { get; set; } = "";

    /// <summary>额外授权的工作目录（对应 <c>claude --add-dir</c>）。</summary>
    public List<string> AdditionalWorkingDirectories { get; init; } = new();

    /// <summary>对话历史（不含 system）。</summary>
    public List<AgentMessage> Messages { get; init; } = new();

    /// <summary>已获用户本会话授权的作用域（Scope 字符串）。</summary>
    public HashSet<string> AllowedScopes { get; init; } = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>当前会话启用的 Skill 名称（为空时默认启用全部已加载 Skill）。</summary>
    public HashSet<string> EnabledSkills { get; init; } = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>累计消耗的近似 token 数（仅用于 UI 显示，非计费凭证）。</summary>
    public long ApproxTokens { get; set; }
}
