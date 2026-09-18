using System.Reflection;
using System.Text.RegularExpressions;

namespace DesktopAssistant.Services;

public static class AppVersionService
{
    public static string GetCurrentVersionText()
    {
        var assembly = Assembly.GetEntryAssembly() ?? typeof(AppVersionService).Assembly;
        var version = assembly.GetName().Version;
        if (version != null)
        {
            var build = version.Build >= 0 ? version.Build : 0;
            return $"{version.Major}.{version.Minor}.{build}";
        }

        var informational = assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
        return string.IsNullOrWhiteSpace(informational)
            ? "0.0.0"
            : NormalizeVersionText(informational);
    }

    public static string GetSidebarVersionLabel() => $"v{GetCurrentVersionText()} · .NET 8";

    public static Version? TryParseVersion(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
            return null;

        var normalized = NormalizeVersionText(value);
        return Version.TryParse(normalized, out var version) ? version : null;
    }

    private static string NormalizeVersionText(string value)
    {
        var cleaned = value.Trim();
        var plusIndex = cleaned.IndexOf('+');
        if (plusIndex >= 0)
            cleaned = cleaned[..plusIndex];

        var match = Regex.Match(cleaned, "\\d+(?:\\.\\d+){0,3}");
        return match.Success ? match.Value : cleaned;
    }
}
