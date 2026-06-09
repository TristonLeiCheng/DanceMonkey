namespace DanceMonkey.Ppt.Models;

/// <summary>输入来源类别。</summary>
public enum PptSourceKind
{
    /// <summary>Markdown 笔记内容（字符串）。</summary>
    Markdown = 0,

    /// <summary>纯文本（字符串）。</summary>
    PlainText,

    /// <summary>PDF 文件路径。</summary>
    PdfFile,

    /// <summary>Word 文件路径（.docx / .doc）。</summary>
    WordFile,

    /// <summary>仅给主题，由 AI 自行展开。</summary>
    Topic,
}

/// <summary>
/// 单个生成请求：把来源、风格、主题、约束打包成不可变记录，便于在 UI/CLI 之间传递。
/// </summary>
public sealed record PptGenerationRequest
{
    /// <summary>来源类别。</summary>
    public required PptSourceKind SourceKind { get; init; }

    /// <summary>来源载荷：当 SourceKind 为 Markdown/PlainText/Topic 时是文本；为 PdfFile/WordFile 时是路径。</summary>
    public required string Source { get; init; }

    /// <summary>主题描述：当 SourceKind == Topic 时使用；其它来源可为空。</summary>
    public string? Topic { get; init; }

    /// <summary>目标受众（例如「公司管理层」「研发同事」）。</summary>
    public string? Audience { get; init; }

    /// <summary>演示目的（informational / persuasive / training ...）。</summary>
    public string? Purpose { get; init; }

    /// <summary>风格 / 语气（例如「专业克制」「热情活泼」）。</summary>
    public string? Tone { get; init; }

    /// <summary>期望页数（含封面与结尾）；空表示交由模型按内容决定。</summary>
    public int? TargetSlides { get; init; }

    /// <summary>主题 ID；缺省时使用 IPptThemeProvider.Default。</summary>
    public string ThemeId { get; init; } = "light-business";

    /// <summary>是否生成演讲备注（写入 notes slide）。</summary>
    public bool IncludeSpeakerNotes { get; init; } = true;

    /// <summary>是否保留来源中的图片（仅 PdfFile/WordFile 有意义）。</summary>
    public bool PreserveImages { get; init; } = true;

    /// <summary>
    /// 用户在工作台手填的附加约束（例如「不要提竞争对手 X」），会被原样追加到提示词。
    /// </summary>
    public string? AdditionalInstructions { get; init; }
}
