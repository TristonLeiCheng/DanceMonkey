using DanceMonkey.Agent.Core.Models;

namespace DanceMonkey.Agent.Core.Abstractions;

/// <summary>
/// Agent 可调用的工具。实现应当是<b>无状态</b>或由依赖注入管理状态，
/// 以便被多个会话共享。单次调用的所有上下文都通过 <see cref="ToolRequest"/> 传入。
/// </summary>
public interface ITool
{
    /// <summary>工具名，小写蛇形命名（如 <c>read_file</c>）。模型按此名调用。</summary>
    string Name { get; }

    /// <summary>给模型看的工具说明（嵌入 system prompt）。要列明 JSON 参数字段。</summary>
    string Description { get; }

    /// <summary>默认风险级别。审批层据此决定是否需要用户确认。</summary>
    ToolRiskLevel Risk { get; }

    /// <summary>
    /// 生成一次调用的一句话摘要，用于 UI 展示与审批对话框。
    /// 实现可根据参数动态调整（例如 run_shell 摘要为 "$ git status"）。
    /// </summary>
    string SummarizeCall(ToolRequest request);

    /// <summary>执行工具。实现应当捕获自身异常并返回 <see cref="ToolResult.Fail"/>。</summary>
    Task<ToolResult> ExecuteAsync(ToolRequest request, CancellationToken cancellationToken);
}
