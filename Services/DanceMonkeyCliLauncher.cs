using System.Diagnostics;
using System.IO;
using System.Windows;
using DesktopAssistant;

namespace DesktopAssistant.Services;

/// <summary>
/// 启动与主程序同目录发布的 <c>dancemonkey.exe</c>（命令行 Agent）。
/// </summary>
public static class DanceMonkeyCliLauncher
{
    /// <summary>尝试启动 CLI；失败时提示用户。</summary>
    public static void TryStart(string? dialogTitle = null)
    {
        var title = string.IsNullOrWhiteSpace(dialogTitle) ? AppBranding.DisplayName : dialogTitle;
        var baseDir = AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var currentExe = Process.GetCurrentProcess().MainModule?.FileName;
        var candidates = new[]
        {
            Path.Combine(baseDir, "cli", "dancemonkey.exe"),
            Path.Combine(baseDir, "dancemonkey.exe"),
        };

        foreach (var path in candidates)
        {
            if (!File.Exists(path)) continue;
            if (!string.IsNullOrWhiteSpace(currentExe) &&
                string.Equals(Path.GetFullPath(path), Path.GetFullPath(currentExe), StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }
            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = path,
                    WorkingDirectory = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                    UseShellExecute = true,
                });
                return;
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    $"无法启动 CLI：{ex.Message}\n\n路径：{path}",
                    title,
                    MessageBoxButton.OK,
                    MessageBoxImage.Warning);
                return;
            }
        }

        MessageBox.Show(
            "未找到 dancemonkey.exe。\n\n请使用 publish 脚本发布完整包（主目录或 cli 子目录下应包含 dancemonkey.exe），或从源码将 DanceMonkey.Cli 发布到程序目录。",
            title,
            MessageBoxButton.OK,
            MessageBoxImage.Information);
    }
}
