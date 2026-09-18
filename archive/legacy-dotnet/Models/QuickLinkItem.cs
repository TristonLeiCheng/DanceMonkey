using System.Text.Json.Serialization;

namespace DesktopAssistant.Models;

public sealed class QuickLinkItem
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    [JsonPropertyName("path")]
    public string Path { get; set; } = "";

    /// <summary>分类：local / network / onedrive / sharepoint / web</summary>
    [JsonPropertyName("category")]
    public string Category { get; set; } = "local";

    /// <summary>可选描述，显示在磁贴副标题。</summary>
    [JsonPropertyName("description")]
    public string Description { get; set; } = "";

    /// <summary>自定义分组名称（留空表示不分组）。</summary>
    [JsonPropertyName("group")]
    public string Group { get; set; } = "";

    /// <summary>点击次数，用于频率排序。</summary>
    [JsonPropertyName("clickCount")]
    public int ClickCount { get; set; } = 0;

    /// <summary>最后点击时间。</summary>
    [JsonPropertyName("lastClicked")]
    public DateTime? LastClicked { get; set; }

    /// <summary>是否置顶显示。</summary>
    [JsonPropertyName("pinned")]
    public bool Pinned { get; set; } = false;

    /// <summary>用于 UI 显示的图标 emoji。</summary>
    [JsonIgnore]
    public string Icon => Category switch
    {
        "network"    => "🖧",
        "onedrive"   => "☁",
        "sharepoint" => "🔗",
        "web"        => "🌐",
        _            => "📁"
    };

    /// <summary>是否为 URL 类型的路径（SharePoint/OneDrive 网址/Web）。</summary>
    [JsonIgnore]
    public bool IsUrl => Path.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
                      || Path.StartsWith("https://", StringComparison.OrdinalIgnoreCase);

    /// <summary>是否为 UNC 网络路径。</summary>
    [JsonIgnore]
    public bool IsUnc => Path.StartsWith(@"\\", StringComparison.Ordinal);
}
