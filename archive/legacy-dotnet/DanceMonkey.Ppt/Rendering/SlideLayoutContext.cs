using DanceMonkey.Ppt.Models;

namespace DanceMonkey.Ppt.Rendering;

/// <summary>
/// 渲染单页时传给 SlideBuilder 的上下文：主题 + 全局页码信息 + 渲染期警告收集。
/// 让 Builder 不必关心 Deck 全局结构，也避免到处传 5~6 个参数。
/// </summary>
internal sealed class SlideLayoutContext
{
    public required IPptTheme Theme { get; init; }

    /// <summary>当前 slide 的页码（从 1 起，含封面与结尾页）。</summary>
    public required int PageNumber { get; init; }

    /// <summary>全 deck 总页数（含封面与结尾页）。</summary>
    public required int TotalPages { get; init; }

    /// <summary>在 deck 内的章节序号（0 起），仅 Section/Bullets 等内容版式有意义。</summary>
    public int SectionIndex { get; init; }

    /// <summary>章节内的页序号（0 起）。</summary>
    public int IndexInSection { get; init; }

    /// <summary>Deck 顶层标题，用于结尾页/页脚回显。</summary>
    public string? DeckTitle { get; init; }

    /// <summary>Deck 作者/署名（封面与结尾页可选用）。</summary>
    public string? Author { get; init; }

    /// <summary>渲染期收集的非致命警告（媒体加载失败、版式降级等）。</summary>
    public List<string> Warnings { get; } = new();
}
