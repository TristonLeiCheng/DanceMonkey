namespace DanceMonkey.Agent.Core.Models;

/// <summary>会话中的一条消息。角色对齐 OpenAI Chat Completions 语义。</summary>
public sealed class AgentMessage
{
    /// <summary>角色：system / user / assistant / tool。</summary>
    public required string Role { get; init; }

    /// <summary>文本内容（工具消息时填工具输出）。</summary>
    public required string Content { get; init; }

    /// <summary>若本条为 <c>tool</c> 角色，记录对应工具名，便于追溯。</summary>
    public string? ToolName { get; init; }

    /// <summary>时间戳（UTC），用于会话持久化与 UI 显示。</summary>
    public DateTime TimestampUtc { get; init; } = DateTime.UtcNow;

    /// <summary>
    /// 用户消息附带的图片（仅内存；不写入 autosave）。
    /// 工具循环首轮 LLM 调用后会清除，避免后续步骤重复发送 base64。
    /// </summary>
    public List<AgentImagePart>? Images { get; set; }

    public bool HasImages => Images is { Count: > 0 };

    public void ClearImages() => Images = null;

    public static AgentMessage System(string text) =>
        new() { Role = "system", Content = text };

    public static AgentMessage User(string text, IReadOnlyList<AgentImagePart>? images = null)
    {
        List<AgentImagePart>? list = null;
        if (images is { Count: > 0 })
        {
            list = images
                .Where(i => i.Data is { Length: > 0 })
                .Select(i => new AgentImagePart
                {
                    Data = i.Data,
                    MimeType = string.IsNullOrWhiteSpace(i.MimeType) ? "image/png" : i.MimeType.Trim(),
                })
                .ToList();
            if (list.Count == 0)
                list = null;
        }

        return new() { Role = "user", Content = text, Images = list };
    }

    public static AgentMessage Assistant(string text) =>
        new() { Role = "assistant", Content = text };

    public static AgentMessage Tool(string toolName, string output) =>
        new() { Role = "tool", Content = output, ToolName = toolName };
}
