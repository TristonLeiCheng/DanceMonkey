using DanceMonkey.Ppt.Abstractions;
using DanceMonkey.Ppt.Models;
using DanceMonkey.Ppt.Themes;

namespace DanceMonkey.Ppt.Services;

/// <summary>
/// 默认主题注册中心。内置四套：浅色商务（默认）、科技蓝、深色高端、暖色杂志。
/// 实例可作为单例使用；后续如需用户自定义主题，可在此处接入「从沙箱目录读 JSON 主题」。
/// </summary>
public sealed class PptThemeProvider : IPptThemeProvider
{
    private readonly Dictionary<string, IPptTheme> _byId;
    private readonly List<IPptTheme> _ordered;
    private readonly IPptTheme _default;

    public PptThemeProvider()
    {
        _ordered = new List<IPptTheme>
        {
            LightBusinessTheme.Create(),
            TechBlueTheme.Create(),
            DarkPremiumTheme.Create(),
            WarmMagazineTheme.Create(),
        };

        _byId = _ordered.ToDictionary(t => t.Id, StringComparer.OrdinalIgnoreCase);
        _default = _ordered[0];
    }

    public IPptTheme Default => _default;

    public IReadOnlyList<IPptTheme> List() => _ordered;

    public IPptTheme Resolve(string? themeId)
    {
        if (!string.IsNullOrWhiteSpace(themeId) && _byId.TryGetValue(themeId, out var theme))
            return theme;
        return _default;
    }
}
