using DanceMonkey.Agent.Core.Abstractions;
using DanceMonkey.Agent.Core.Models;
using DanceMonkey.Agent.Core.Tools;

namespace DanceMonkey.Agent.Core.Runtime;

/// <summary>
/// 审批决策层：按 <see cref="AgentMode"/> 与会话白名单先做判断，仅在必要时才转给 UI。
/// </summary>
public sealed class ModeAwareApprovalService : IApprovalService
{
    private readonly IApprovalPrompt _prompt;

    /// <summary>
    /// Auto 模式下无需审批就可以执行的 shell 命令模板（大小写不敏感）。
    /// 典型：只读或幂等开发命令。
    /// </summary>
    public HashSet<string> AutoShellScopes { get; } = new(StringComparer.OrdinalIgnoreCase)
    {
        "git status", "git diff", "git log", "git branch",
        "dotnet build", "dotnet test", "dotnet restore",
        "npm test", "npm run", "npm list",
        "ls", "dir", "pwd", "echo", "cat", "type",
        "node --version", "python --version", "dotnet --version",
    };

    public ModeAwareApprovalService(IApprovalPrompt prompt)
    {
        _prompt = prompt;
    }

    public Task<ApprovalDecision> RequestAsync(ApprovalRequest request, AgentSession session, CancellationToken ct)
    {
        // 只读工具永远放行（AgentRunner 层也会短路，这里是双保险）
        if (request.Risk == ToolRiskLevel.ReadOnly)
            return Task.FromResult(ApprovalDecision.AllowOnce);

        // 危险操作永远走 UI 弹窗，无视模式
        if (request.Risk == ToolRiskLevel.Dangerous)
            return _prompt.AskAsync(request, session, ct);

        // 会话级白名单命中 → 直接放行
        if (!string.IsNullOrEmpty(request.Scope) && session.AllowedScopes.Contains(request.Scope))
            return Task.FromResult(ApprovalDecision.AllowOnce);

        switch (session.Mode)
        {
            case AgentMode.Plan:
                // Plan 模式在 AgentRunner 已被提前拦截；此处兜底拒绝
                return Task.FromResult(ApprovalDecision.Reject);

            case AgentMode.Auto:
                if (request.Risk == ToolRiskLevel.Write)
                    return Task.FromResult(ApprovalDecision.AllowOnce);

                if (request.Risk == ToolRiskLevel.Shell)
                {
                    var cmdScope = (request.Scope ?? "").Replace("run_shell:", "", StringComparison.OrdinalIgnoreCase).Trim();
                    var summaryScope = ExtractScopeFromSummary(request.Summary);
                    if (RunShellTool.IsDangerousCommand(request.Summary) || RunShellTool.IsDangerousCommand(cmdScope))
                        return Task.FromResult(ApprovalDecision.Reject);

                    foreach (var allowed in AutoShellScopes)
                    {
                        if (cmdScope.Equals(allowed, StringComparison.OrdinalIgnoreCase) ||
                            summaryScope.Equals(allowed, StringComparison.OrdinalIgnoreCase))
                            return Task.FromResult(ApprovalDecision.AllowOnce);
                    }
                }

                return _prompt.AskAsync(request, session, ct);

            case AgentMode.Ask:
            default:
                return _prompt.AskAsync(request, session, ct);
        }
    }

    private static string ExtractScopeFromSummary(string? summary)
    {
        if (string.IsNullOrWhiteSpace(summary)) return "";
        const string prefix = "执行命令:";
        var text = summary.Trim();
        if (text.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            text = text[prefix.Length..].Trim();
        return RunShellTool.BuildApprovalScopeHint(text);
    }
}
