using DanceMonkey.Ppt.Models;
using ShapeCrawler;
using ShapeCrawler.Presentations;

namespace DanceMonkey.Ppt.Rendering;

/// <summary>
/// 一种版式的渲染契约。每种 LayoutHint 对应一个实现。
/// 由 <see cref="ShapeCrawlerRenderer"/> 在 ShapeCrawler 的 Slide(builder => ...) 回调里调用。
/// </summary>
internal interface ISlideBuilder
{
    /// <summary>该 Builder 负责的版式提示。</summary>
    PptLayoutHint LayoutHint { get; }

    /// <summary>在给定 <see cref="DraftSlide"/> 上完成绘制；颜色、字号从 <paramref name="ctx"/>.Theme 取。</summary>
    void Build(DraftSlide draft, PptSlide slide, SlideLayoutContext ctx);
}
