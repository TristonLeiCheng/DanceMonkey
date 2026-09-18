using DanceMonkey.Ppt.Models;

namespace DanceMonkey.Ppt.Abstractions;

/// <summary>主题注册中心。所有渲染器与 UI 通过它取主题，避免硬编码主题字面量。</summary>
public interface IPptThemeProvider
{
    /// <summary>当未指定 ThemeId 或指定不存在时使用的默认主题。</summary>
    IPptTheme Default { get; }

    /// <summary>全部已注册主题（按显示顺序）。</summary>
    IReadOnlyList<IPptTheme> List();

    /// <summary>按 ID 取主题；不存在时回落到 <see cref="Default"/>。</summary>
    IPptTheme Resolve(string? themeId);
}
