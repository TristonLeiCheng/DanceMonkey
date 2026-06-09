using System.Text.Json.Serialization;

namespace DesktopAssistant.Models;

/// <summary>智能对话页可选的「标题 + 系统提示词」预设。</summary>
public sealed class PromptSnippetItem
{
    [JsonPropertyName("title")]
    public string Title { get; set; } = "";

    [JsonPropertyName("systemPrompt")]
    public string SystemPrompt { get; set; } = "";

    /// <summary>设置页列表展示用，不写入 config。</summary>
    [JsonIgnore]
    public string Preview =>
        string.IsNullOrEmpty(SystemPrompt)
            ? ""
            : (SystemPrompt.Length > 72 ? SystemPrompt[..72] + "…" : SystemPrompt);
}
