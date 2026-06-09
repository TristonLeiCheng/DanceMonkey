using System.Windows;

namespace DesktopAssistant.Services;

/// <summary>
/// Manages runtime language switching via merged ResourceDictionary.
/// Supported: "zh-CN", "en-US".
/// </summary>
public static class LocalizationManager
{
    private const string DictUriPrefix = "Resources/Lang.";
    private const string DictUriSuffix = ".xaml";
    private static string _currentLang = "zh-CN";

    public static string CurrentLanguage => _currentLang;

    /// <summary>Initializes localization by loading the specified language dictionary into Application resources.</summary>
    public static void Initialize(string language)
    {
        _currentLang = NormalizeLang(language);
        ApplyLanguage(_currentLang);
    }

    /// <summary>Switches the UI language at runtime.</summary>
    public static void SwitchLanguage(string language)
    {
        var lang = NormalizeLang(language);
        if (lang == _currentLang) return;
        _currentLang = lang;
        ApplyLanguage(lang);
    }

    /// <summary>Gets a localized string by key from Application resources.</summary>
    public static string Get(string key)
    {
        if (Application.Current?.TryFindResource(key) is string s)
            return s;
        return key; // fallback: return key itself
    }

    /// <summary>Gets a localized string with format arguments.</summary>
    public static string Get(string key, params object[] args)
    {
        var template = Get(key);
        try { return string.Format(template, args); }
        catch { return template; }
    }

    private static void ApplyLanguage(string lang)
    {
        var app = Application.Current;
        if (app == null) return;

        var uri = new Uri($"{DictUriPrefix}{lang}{DictUriSuffix}", UriKind.Relative);
        var newDict = new ResourceDictionary { Source = uri };

        // Remove old language dictionary if present
        ResourceDictionary? toRemove = null;
        foreach (var dict in app.Resources.MergedDictionaries)
        {
            if (dict.Source != null && dict.Source.OriginalString.Contains("Lang."))
            {
                toRemove = dict;
                break;
            }
        }

        if (toRemove != null)
            app.Resources.MergedDictionaries.Remove(toRemove);

        app.Resources.MergedDictionaries.Add(newDict);
    }

    private static string NormalizeLang(string? lang) => lang?.Trim().ToLowerInvariant() switch
    {
        "en" or "en-us" or "english" => "en-US",
        _ => "zh-CN"
    };
}
