namespace DanceMonkey.Ppt.Models;

/// <summary>导入器抽取出的内容块类别。</summary>
public enum PptSourceBlockKind
{
    /// <summary>标题（带 <see cref="PptSourceBlock.Level"/> 层级，1~6）。</summary>
    Heading = 0,

    /// <summary>段落文本。</summary>
    Paragraph,

    /// <summary>列表项（无序/有序）。</summary>
    ListItem,

    /// <summary>表格（内容放 <see cref="PptSourceBlock.TableRows"/>）。</summary>
    Table,

    /// <summary>图片（路径放 <see cref="PptSourceBlock.MediaPath"/>）。</summary>
    Image,

    /// <summary>引用 / 引言块。</summary>
    Quote,
}

/// <summary>
/// 导入器输出的中间块。保留尽量薄的语义，让 AI/PptModule 决定如何切分到 slide。
/// </summary>
public sealed class PptSourceBlock
{
    public PptSourceBlockKind Kind { get; init; }

    /// <summary>Heading 时的层级（1~6）。</summary>
    public int Level { get; init; }

    /// <summary>文本内容（Heading/Paragraph/ListItem/Quote 使用）。</summary>
    public string? Text { get; init; }

    /// <summary>Image 时的本地文件路径（导入器负责把图片落盘到 assets 目录）。</summary>
    public string? MediaPath { get; init; }

    /// <summary>Table 时的二维数据。</summary>
    public IReadOnlyList<IReadOnlyList<string>>? TableRows { get; init; }
}

/// <summary>导入器统一输出：来源元数据 + 顺序块列表。</summary>
public sealed class PptSourceDocument
{
    /// <summary>来源标题（例如 PDF/Word 文档名或 Markdown 顶部 H1）。</summary>
    public string? Title { get; init; }

    /// <summary>来源说明（导入器自由填写，例如「Word docx via Office Interop」）。</summary>
    public string? OriginDescription { get; init; }

    /// <summary>顺序排列的内容块。</summary>
    public IReadOnlyList<PptSourceBlock> Blocks { get; init; } = Array.Empty<PptSourceBlock>();

    /// <summary>导入过程中产生的警告（非致命）。</summary>
    public IReadOnlyList<string> Warnings { get; init; } = Array.Empty<string>();
}
