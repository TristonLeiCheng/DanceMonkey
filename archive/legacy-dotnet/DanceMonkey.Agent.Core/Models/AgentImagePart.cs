namespace DanceMonkey.Agent.Core.Models;

/// <summary>用户消息附带的图片（OpenAI 兼容 vision / 多模态）。</summary>
public sealed class AgentImagePart
{
    public required byte[] Data { get; init; }
    public required string MimeType { get; init; }
}
