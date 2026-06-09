namespace DanceMonkey.Ppt.Models;

/// <summary>
/// 版式提示：告诉渲染器优先使用哪一种 SlideBuilder。
/// 该提示只是「建议」，渲染器可在内容不足时降级（例如 ImageRight 没有图 → 退化为 Bullets）。
/// </summary>
public enum PptLayoutHint
{
    /// <summary>未指定，由渲染器按内容启发选择。</summary>
    Auto = 0,

    /// <summary>封面页：大标题 + 副标题。</summary>
    Title,

    /// <summary>章节分隔页：编号 + 章节标题 + 简介。</summary>
    Section,

    /// <summary>要点页：标题 + bullet 列表。</summary>
    Bullets,

    /// <summary>两栏页：标题 + 左右并列要点。</summary>
    TwoColumn,

    /// <summary>图文页：右侧或顶部展示图片，剩余空间放要点。</summary>
    ImageRight,

    /// <summary>表格页：标题 + 一张表格。</summary>
    Table,

    /// <summary>引述页：大字号引言 + 出处。</summary>
    Quote,

    /// <summary>结束页：感谢 / 联系方式 / 收束信息。</summary>
    Ending,
}
