namespace DanceMonkey.Ppt.Models;

/// <summary>媒体资源类别。</summary>
public enum PptMediaKind
{
    Image = 0,
    Table,
    Chart,
}

/// <summary>
/// 单页上承载的媒体资源。<see cref="Source"/> 对图片是绝对路径或相对工程路径；
/// 对表格则使用 <see cref="TableData"/> 字段；对图表预留扩展，当前不强制实现。
/// </summary>
public sealed class PptMedia
{
    public PptMediaKind Kind { get; init; } = PptMediaKind.Image;

    /// <summary>图片来源（绝对路径或资源路径）。Table/Chart 可为空。</summary>
    public string? Source { get; init; }

    /// <summary>媒体标题/图注。可为空。</summary>
    public string? Caption { get; init; }

    /// <summary>表格内容（按行）；Kind == Table 时使用。</summary>
    public IReadOnlyList<IReadOnlyList<string>>? TableData { get; init; }
}
