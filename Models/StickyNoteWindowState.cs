using System.Text.Json.Serialization;

namespace DesktopAssistant.Models;

/// <summary>桌面便签窗口位置与关联文件（持久化到 AppData）。</summary>
public sealed class StickyNoteWindowState
{
    [JsonPropertyName("filePath")]
    public string FilePath { get; set; } = "";

    [JsonPropertyName("left")]
    public double Left { get; set; }

    [JsonPropertyName("top")]
    public double Top { get; set; }

    [JsonPropertyName("width")]
    public double Width { get; set; } = 300;

    [JsonPropertyName("height")]
    public double Height { get; set; } = 280;

    [JsonPropertyName("topmost")]
    public bool Topmost { get; set; } = true;

    /// <summary>便签背景预设键，与 <see cref="StickyNoteThemes"/> 一致。</summary>
    [JsonPropertyName("bgPreset")]
    public string? BackgroundPreset { get; set; }
}
