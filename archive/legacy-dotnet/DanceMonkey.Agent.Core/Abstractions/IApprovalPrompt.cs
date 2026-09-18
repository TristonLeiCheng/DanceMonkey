using DanceMonkey.Agent.Core.Models;

namespace DanceMonkey.Agent.Core.Abstractions;

/// <summary>
/// 真正"弹窗询问用户"的小接口。与 <see cref="IApprovalService"/> 的区别：
/// <see cref="IApprovalService"/> 负责<b>策略决定</b>（按模式、会话白名单等自动放行或拦截），
/// 该接口只在需要用户介入时被调用——UI 层（WPF 对话框 / CLI 交互式 prompt）实现它。
/// </summary>
public interface IApprovalPrompt
{
    Task<ApprovalDecision> AskAsync(ApprovalRequest request, AgentSession session, CancellationToken ct);
}
