namespace DanceMonkey.Agent.Core.Models;

/// <summary>
/// 向用户发起的一次审批请求。由 <c>IApprovalService</c> 展示给用户并返回 <see cref="ApprovalDecision"/>。
/// </summary>
public sealed class ApprovalRequest
{
    /// <summary>即将执行的工具名。</summary>
    public required string Tool { get; init; }

    /// <summary>工具风险等级。</summary>
    public required ToolRiskLevel Risk { get; init; }

    /// <summary>一句话摘要，如 "向 Notes/2026-04-21.md 写入 42 行内容"。</summary>
    public required string Summary { get; init; }

    /// <summary>
    /// 操作详情（多行可读文本）。典型内容：
    /// <list type="bullet">
    /// <item>命令执行：完整命令行与工作目录</item>
    /// <item>文件写入：目标路径与 diff 片段</item>
    /// </list>
    /// </summary>
    public string? Details { get; init; }

    /// <summary>允许用户在本次及后续同类操作之间做区分。如 "run_shell:git"。</summary>
    public string? Scope { get; init; }
}
