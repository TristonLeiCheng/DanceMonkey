using DanceMonkey.Agent.Core.Models;

namespace DanceMonkey.Agent.Core.Abstractions;

/// <summary>
/// 审批服务：向用户展示即将执行的操作并收集决定。
/// WPF 端用对话框实现；CLI 端用交互式终端提示实现。
/// </summary>
public interface IApprovalService
{
    /// <summary>根据当前模式与会话授权状态，决定是否需要弹出审批。</summary>
    /// <param name="request">待执行操作。</param>
    /// <param name="session">当前会话（用于读取 Mode / AllowedScopes）。</param>
    /// <returns>用户的决定。当模式允许免审批时直接返回 <see cref="ApprovalDecision.AllowOnce"/>。</returns>
    Task<ApprovalDecision> RequestAsync(ApprovalRequest request, AgentSession session, CancellationToken ct);
}
