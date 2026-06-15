using System.Text.RegularExpressions;

namespace DesktopAssistant.Services;

/// <summary>
/// 解析应用安装目录。升级时若当前目录名含版本号，则迁移到无版本号的固定目录，避免文件夹名与程序版本不一致。
/// </summary>
public static class AppInstallPathService
{
    private static readonly Regex VersionedFolderPattern = new(
        @"(?:^|[\-_])(?:v)?(\d+\.\d+(?:\.\d+)?)(?:[\-_]|$)|win-x64|DanceMonkey-win",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled);

    /// <summary>推荐的无版本号安装目录（与 tools/Install-LocalRun.bat 一致）。</summary>
    public static string CanonicalInstallDirectory =>
        NormalizeDirectory(Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "DanceMonkey",
            "app"));

    public static string CurrentInstallDirectory =>
        NormalizeDirectory(AppContext.BaseDirectory);

    /// <summary>
    /// 升级目标目录：版本化目录 → 迁移到 <see cref="CanonicalInstallDirectory"/>；否则就地升级。
    /// </summary>
    public static string ResolveUpdateInstallDirectory()
    {
        var current = CurrentInstallDirectory;
        return LooksVersionedInstallDirectory(current)
            ? CanonicalInstallDirectory
            : current;
    }

    /// <summary>目录名是否像带版本号的解压包目录（如 DanceMonkey-win-x64-1.3.0）。</summary>
    public static bool LooksVersionedInstallDirectory(string? directoryPath)
    {
        if (string.IsNullOrWhiteSpace(directoryPath))
            return false;

        var name = Path.GetFileName(NormalizeDirectory(directoryPath));
        if (string.IsNullOrWhiteSpace(name))
            return false;

        // 固定目录 app / DanceMonkey 等不算版本化
        if (name.Equals("app", StringComparison.OrdinalIgnoreCase) ||
            name.Equals("DanceMonkey", StringComparison.OrdinalIgnoreCase))
            return false;

        return VersionedFolderPattern.IsMatch(name);
    }

    public static bool PathsEqual(string? left, string? right) =>
        string.Equals(
            NormalizeDirectory(left),
            NormalizeDirectory(right),
            StringComparison.OrdinalIgnoreCase);

    public static string NormalizeDirectory(string? path)
    {
        if (string.IsNullOrWhiteSpace(path))
            return "";

        try
        {
            return Path.GetFullPath(path)
                .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        }
        catch
        {
            return path.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        }
    }
}
