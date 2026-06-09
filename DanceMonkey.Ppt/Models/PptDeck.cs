namespace DanceMonkey.Ppt.Models;

/// <summary>
/// 顶层演示文稿模型。AI 大纲产出、导入器结果、UI 编辑后的状态都收敛到这一层。
/// 与旧的 <c>DanceMonkey.Ppt.Models.PptOutline</c> 并存：迁移期内提供互转，逐步替换。
/// </summary>
public sealed class PptDeck
{
    /// <summary>主标题（封面使用）。</summary>
    public string? Title { get; set; }

    /// <summary>副标题（封面副标题，可选）。</summary>
    public string? Subtitle { get; set; }

    /// <summary>目标受众（用于提示词与封面副标题候选）。</summary>
    public string? Audience { get; set; }

    /// <summary>演示目的（informational / persuasive / training ...）。</summary>
    public string? Purpose { get; set; }

    /// <summary>作者或发布方（封面/结尾署名使用）。</summary>
    public string? Author { get; set; }

    /// <summary>主题 ID（必须由 IPptThemeProvider 已注册），缺省时由渲染器回落到默认主题。</summary>
    public string? ThemeId { get; set; }

    /// <summary>
    /// 章节列表。允许「单章节」情形（所有页放进一个章节），此时渲染器可选择不渲染章节分隔页。
    /// </summary>
    public List<PptSection> Sections { get; set; } = new();

    /// <summary>
    /// 便利方法：拉平所有 slide，用于不在意章节结构的下游（例如简单渲染器）。
    /// </summary>
    public IEnumerable<PptSlide> EnumerateSlides()
    {
        foreach (var section in Sections)
        {
            foreach (var slide in section.Slides)
                yield return slide;
        }
    }
}
