using Microsoft.Win32;

namespace DesktopAssistant.Services;

public static class StartupService
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "DanceMonkey";

    public static bool IsEnabled()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKey, writable: false);
            var v = key?.GetValue(ValueName) as string;
            return !string.IsNullOrEmpty(v);
        }
        catch
        {
            return false;
        }
    }

    public static void SetEnabled(bool enabled)
    {
        var exe = Environment.ProcessPath;
        if (string.IsNullOrEmpty(exe))
            return;

        // 从带版本号的解压目录启用开机启动时，指向固定安装目录，避免后续升级路径不一致。
        if (enabled && AppInstallPathService.LooksVersionedInstallDirectory(AppInstallPathService.CurrentInstallDirectory))
        {
            var canonicalExe = Path.Combine(AppInstallPathService.CanonicalInstallDirectory, Path.GetFileName(exe));
            if (File.Exists(canonicalExe))
                exe = canonicalExe;
        }

        using var key = Registry.CurrentUser.CreateSubKey(RunKey, writable: true);
        if (key == null) return;

        if (enabled)
            key.SetValue(ValueName, $"\"{exe}\"");
        else
            key.DeleteValue(ValueName, throwOnMissingValue: false);
    }
}
