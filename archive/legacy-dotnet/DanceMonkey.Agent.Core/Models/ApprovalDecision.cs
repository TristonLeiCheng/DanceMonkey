namespace DanceMonkey.Agent.Core.Models;

/// <summary>
/// 用户对 <see cref="ApprovalRequest"/> 的答复。
/// </summary>
public enum ApprovalDecision
{
    /// <summary>拒绝，此次操作终止；Agent 应向模型回报"被拒绝"。</summary>
    Reject = 0,

    /// <summary>仅本次允许。</summary>
    AllowOnce = 1,

    /// <summary>本会话期间，同作用域（Scope）的后续同类操作都允许。</summary>
    AllowSessionScope = 2,

    /// <summary>永久允许（写入白名单配置），用户可在设置中撤销。</summary>
    AllowAlways = 3,
}
