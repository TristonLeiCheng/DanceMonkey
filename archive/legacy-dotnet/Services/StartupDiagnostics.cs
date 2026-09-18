using System.IO;
using System.Text;

namespace DesktopAssistant.Services;

/// <summary>启动阶段诊断日志（%LOCALAPPDATA%\DanceMonkey\logs\startup.log）。</summary>
internal static class StartupDiagnostics
{
    private static readonly object Gate = new();
    private static readonly string LogPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "DanceMonkey",
        "logs",
        "startup.log");

    public static bool IsDiagMode { get; private set; }

    public static void Initialize(string[]? args)
    {
        IsDiagMode = args != null && args.Any(a =>
            string.Equals(a, "--diag", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(a, "/diag", StringComparison.OrdinalIgnoreCase));

        if (string.Equals(Environment.GetEnvironmentVariable("DM_DIAG"), "1", StringComparison.Ordinal))
            IsDiagMode = true;

        try
        {
            var dir = Path.GetDirectoryName(LogPath);
            if (!string.IsNullOrEmpty(dir))
                Directory.CreateDirectory(dir);
            File.WriteAllText(LogPath,
                $"========== DanceMonkey startup {DateTime.Now:yyyy-MM-dd HH:mm:ss.fff} =========={Environment.NewLine}",
                Encoding.UTF8);
        }
        catch
        {
            // ignore
        }

        Log($"OS={Environment.OSVersion}; x64={Environment.Is64BitProcess}; cwd={Environment.CurrentDirectory}");
        Log($"exe={Environment.ProcessPath}");
        if (args is { Length: > 0 })
            Log("args=" + string.Join(' ', args));
    }

    public static void Log(string message)
    {
        try
        {
            lock (Gate)
            {
                File.AppendAllText(LogPath,
                    $"[{DateTime.Now:HH:mm:ss.fff}] {message}{Environment.NewLine}",
                    Encoding.UTF8);
            }
        }
        catch
        {
            // ignore
        }
    }

    public static void Fatal(string stage, Exception ex)
    {
        Log($"FATAL@{stage}: {ex}");
        try
        {
            lock (Gate)
            {
                File.AppendAllText(LogPath, ex + Environment.NewLine, Encoding.UTF8);
            }
        }
        catch
        {
            // ignore
        }

        try
        {
            System.Windows.MessageBox.Show(
                ex.Message + "\n\n" + ex.GetType().Name + "\n\n日志:\n" + LogPath,
                "DanceMonkey 启动失败",
                System.Windows.MessageBoxButton.OK,
                System.Windows.MessageBoxImage.Error);
        }
        catch
        {
            // ignore
        }
    }

    public static string LogFilePath => LogPath;
}
