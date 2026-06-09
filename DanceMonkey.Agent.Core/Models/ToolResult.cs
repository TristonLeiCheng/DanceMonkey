namespace DanceMonkey.Agent.Core.Models;

/// <summary>
/// 工具执行结果。<see cref="Output"/> 会被回灌给模型作为下一轮上下文，
/// <see cref="Display"/> 则用于 UI 渲染（可带 Markdown / 彩色等人类可读格式）。
/// </summary>
public sealed class ToolResult
{
    /// <summary>是否成功执行。失败时 <see cref="Output"/> 建议填入错误原因，让模型据此纠正。</summary>
    public required bool Success { get; init; }

    /// <summary>给模型看的结果文本（纯文本，尽量精简以节省 token）。</summary>
    public required string Output { get; init; }

    /// <summary>给用户看的显示文本（可含 Markdown）。为空时 UI 退化显示 <see cref="Output"/>。</summary>
    public string? Display { get; init; }

    /// <summary>被用户拒绝时置 true。Agent 不应再重试同一操作。</summary>
    public bool Rejected { get; init; }

    public static ToolResult Ok(string output, string? display = null) =>
        new() { Success = true, Output = output, Display = display };

    public static ToolResult Fail(string reason) =>
        new() { Success = false, Output = reason, Display = $"❌ {reason}" };

    public static ToolResult RejectedByUser(string note = "用户拒绝了该操作") =>
        new() { Success = false, Output = note, Display = $"⛔ {note}", Rejected = true };
}
