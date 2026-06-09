using System.Text.Json.Serialization;

namespace DesktopAssistant.Models;

/// <summary>加密前的明文 JSON 结构。</summary>
public sealed class PasswordVaultInnerDocument
{
    /// <summary>显式分组名（可包含尚无条目的空分组）；与条目中的 Group 字段合并去重后使用。</summary>
    [JsonPropertyName("groups")]
    public List<string>? Groups { get; set; }

    [JsonPropertyName("entries")]
    public List<PasswordVaultEntry> Entries { get; set; } = new();
}
