using DanceMonkey.Agent.Core.Models;

namespace DanceMonkey.Agent.Core.Abstractions;

/// <summary>
/// Agent 运行过程中的事件接收器。UI（WPF 面板 / CLI 终端）实现此接口以订阅实时状态。
/// <para>所有回调<b>可能</b>在非 UI 线程被调用，UI 实现需自行切回主线程。</para>
/// </summary>
public interface IAgentSink
{
    /// <summary>模型文本流式输出：每来一块调用一次。</summary>
    void OnAssistantChunk(string chunk);

    /// <summary>本轮助手消息已完整结束（流关闭或非流式返回）。</summary>
    void OnAssistantCompleted(string fullText);

    /// <summary>工具即将开始执行（已通过审批）。</summary>
    void OnToolStart(ToolRequest request, string summary);

    /// <summary>工具执行结束。</summary>
    void OnToolEnd(ToolRequest request, ToolResult result);

    /// <summary>状态/进度信息（如 "等待用户审批…"、"已取消"）。</summary>
    void OnStatus(string message);

    /// <summary>非致命错误，Agent 仍可继续。</summary>
    void OnWarning(string message);

    /// <summary>致命错误，Agent loop 终止。</summary>
    void OnError(string message);
}
