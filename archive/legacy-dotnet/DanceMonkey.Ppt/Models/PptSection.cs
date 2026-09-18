namespace DanceMonkey.Ppt.Models;

/// <summary>
/// 章节：把多页 slide 按逻辑分组，便于渲染器在章节切换时插入「Section」分隔页，
/// 也便于工作台 UI 按章节折叠显示大纲。
/// </summary>
public sealed class PptSection
{
    /// <summary>章节标题。</summary>
    public string? Title { get; set; }

    /// <summary>章节简介（用于 Section 分隔页副标题，可选）。</summary>
    public string? Summary { get; set; }

    /// <summary>该章节包含的页（不含 Section 分隔页本身，由渲染器在切章节时插入）。</summary>
    public List<PptSlide> Slides { get; set; } = new();
}
