namespace DanceMonkey.Ppt.Models;

/// <summary>
/// 字号梯度：所有 SlideBuilder 必须从主题取字号，不允许硬编码。
/// </summary>
public sealed class PptFontScale
{
    /// <summary>封面主标题字号。</summary>
    public int DeckTitle { get; init; } = 40;

    /// <summary>封面副标题字号。</summary>
    public int DeckSubtitle { get; init; } = 18;

    /// <summary>章节分隔页主标题字号。</summary>
    public int SectionTitle { get; init; } = 32;

    /// <summary>内容页标题字号。</summary>
    public int SlideTitle { get; init; } = 26;

    /// <summary>正文/要点字号。</summary>
    public int Body { get; init; } = 16;

    /// <summary>引用/强调字号。</summary>
    public int Quote { get; init; } = 22;

    /// <summary>注释/页脚字号。</summary>
    public int Caption { get; init; } = 10;
}

/// <summary>
/// 主题色板：所有颜色以 6 位 RGB 字符串（不含 #）表达，
/// 与 ShapeCrawler 现有 ApplyFontColors 习惯保持一致。
/// </summary>
public sealed class PptPalette
{
    /// <summary>幻灯片背景色。</summary>
    public string Background { get; init; } = "FFFFFF";

    /// <summary>卡片/分组背景色。</summary>
    public string Surface { get; init; } = "F4F5F8";

    /// <summary>主标题文字色。</summary>
    public string TextPrimary { get; init; } = "1A1F2C";

    /// <summary>正文文字色。</summary>
    public string TextBody { get; init; } = "364152";

    /// <summary>辅助/注释文字色。</summary>
    public string TextMuted { get; init; } = "8B90A8";

    /// <summary>主强调色（顶部装饰条 / 编号块 / 重点 bullet）。</summary>
    public string Accent { get; init; } = "1F4FF5";

    /// <summary>辅助强调色（图标 / 副标题分隔条）。</summary>
    public string AccentSoft { get; init; } = "38B2AC";

    /// <summary>分隔线颜色。</summary>
    public string Divider { get; init; } = "E2E4EC";
}

/// <summary>
/// 主题模型：颜色 + 字号梯度 + 留白/装饰参数。
/// SlideBuilder 拿到 IPptTheme 后，应当不再触碰任何字面量颜色或字号。
/// </summary>
public interface IPptTheme
{
    /// <summary>主题唯一 ID，例如 "light-business" / "tech-blue" / "dark-premium"。</summary>
    string Id { get; }

    /// <summary>显示名称（中文）。</summary>
    string DisplayName { get; }

    /// <summary>风格短描述，供 UI 缩略卡片展示。</summary>
    string Description { get; }

    PptPalette Palette { get; }

    PptFontScale FontScale { get; }

    /// <summary>装饰横条高度（点）。</summary>
    int AccentBarHeight { get; }

    /// <summary>页边距（点，左右上下统一）。</summary>
    int PagePadding { get; }
}

/// <summary>
/// 主题默认实现：内置 record-like 形态，便于在 Themes/ 下用对象初始化器声明。
/// </summary>
public sealed class PptTheme : IPptTheme
{
    public required string Id { get; init; }
    public required string DisplayName { get; init; }
    public string Description { get; init; } = "";
    public PptPalette Palette { get; init; } = new();
    public PptFontScale FontScale { get; init; } = new();
    public int AccentBarHeight { get; init; } = 6;
    public int PagePadding { get; init; } = 48;
}
