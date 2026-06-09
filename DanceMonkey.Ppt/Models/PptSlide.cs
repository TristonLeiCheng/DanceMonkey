namespace DanceMonkey.Ppt.Models;

/// <summary>
/// 单页幻灯片中间表示。AI 大纲产出与导入器都会落到这一层，再交给渲染器。
/// 字段尽量宽松，以便不同来源（笔记 / PDF / Word / 仅主题）共用。
/// </summary>
public sealed class PptSlide
{
    /// <summary>页标题。</summary>
    public string? Title { get; set; }

    /// <summary>副标题或一句话补充。quote 版式时用作引述出处。</summary>
    public string? Subtitle { get; set; }

    /// <summary>建议的版式。渲染器可在内容不足时降级。</summary>
    public PptLayoutHint LayoutHint { get; set; } = PptLayoutHint.Auto;

    /// <summary>
    /// 核心结论句（≤30字）。本页去掉所有 bullets 后观众唯一能带走的信息。
    /// 由 LLM 生成，渲染器可用于页脚强调或备注展示。
    /// </summary>
    public string? KeyMessage { get; set; }

    /// <summary>要点列表（最常用字段）。twoColumn 版式时为左栏内容。</summary>
    public List<string> Bullets { get; set; } = new();

    /// <summary>
    /// 双栏版式右栏内容。仅 <see cref="PptLayoutHint.TwoColumn"/> 有意义。
    /// </summary>
    public List<string> RightBullets { get; set; } = new();

    /// <summary>较长的整段正文；Quote 版式时用作引言。</summary>
    public List<string> Paragraphs { get; set; } = new();

    /// <summary>页上承载的媒体（图片/表格）。</summary>
    public List<PptMedia> Media { get; set; } = new();

    /// <summary>演讲备注（写入 pptx 的 notes slide）。</summary>
    public string? SpeakerNotes { get; set; }

    /// <summary>
    /// 可视化建议：当页面含数字对比/趋势/占比时，LLM 建议的图表类型与数据维度说明。
    /// 仅作文字提示，由演讲者手动在 pptx 中补充图表。渲染器在演讲备注中追加此建议。
    /// </summary>
    public string? VisualSuggestion { get; set; }

    /// <summary>
    /// 旧大纲兼容：当 AI 仍输出 deckTitle/slides[].title/bullets 的最小结构时，
    /// 渲染器优先使用本对象的字段；缺失时保持空集合。
    /// </summary>
    public static PptSlide FromLegacy(string? title, IEnumerable<string>? bullets)
    {
        var slide = new PptSlide
        {
            Title = title,
            LayoutHint = PptLayoutHint.Bullets,
        };
        if (bullets != null)
            slide.Bullets.AddRange(bullets.Where(s => !string.IsNullOrWhiteSpace(s)).Select(s => s.Trim()));
        return slide;
    }
}
