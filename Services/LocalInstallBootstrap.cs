using System.Diagnostics;
using System.IO;
using System.Text;
using System.Windows.Forms;

namespace DesktopAssistant.Services;

/// <summary>
/// 从 UNC 或带版本号的解压目录启动时，自动复制/跳转到本机固定目录
/// <c>%LOCALAPPDATA%\DanceMonkey\app</c>，避免双击无反应（UNC 禁止执行）或升级后仍点旧路径。
/// </summary>
public static class LocalInstallBootstrap
{
    /// <summary>
    /// 若已 spawn 本机固定目录下的进程，返回 true，调用方应直接 exit。
    /// </summary>
    public static bool TryRelaunchFromCanonicalInstall(string[]? args)
    {
        var exePath = Environment.ProcessPath;
        if (string.IsNullOrWhiteSpace(exePath) || !File.Exists(exePath))
            return false;

        var currentDir = AppInstallPathService.CurrentInstallDirectory;
        var canonicalDir = AppInstallPathService.CanonicalInstallDirectory;
        var exeName = Path.GetFileName(exePath);
        var canonicalExe = Path.Combine(canonicalDir, exeName);

        if (AppInstallPathService.PathsEqual(currentDir, canonicalDir))
            return false;

        var fromUnc = IsUncPath(currentDir);
        var fromVersioned = AppInstallPathService.LooksVersionedInstallDirectory(currentDir);
        if (!fromUnc && !fromVersioned)
            return false;

        try
        {
            Directory.CreateDirectory(canonicalDir);

            if (File.Exists(canonicalExe))
            {
                var canonicalVer = ReadExeVersion(canonicalExe);
                var currentVer = ReadExeVersion(exePath);

                // 固定目录已有同版本或更新版本：直接启动，避免用旧解压目录覆盖新安装
                if (canonicalVer != null && currentVer != null && canonicalVer >= currentVer)
                    return TryStartProcess(canonicalExe, canonicalDir, args);
            }

            var copyCode = RobocopyMirror(currentDir, canonicalDir);
            if (copyCode > 7)
            {
                ShowBootstrapError(
                    $"无法复制到本机安装目录（robocopy 退出码 {copyCode}）。\n\n" +
                    $"源：{currentDir}\n目标：{canonicalDir}");
                return false;
            }

            if (!File.Exists(canonicalExe))
            {
                ShowBootstrapError($"复制完成但未找到：{canonicalExe}");
                return false;
            }

            WriteRedirectHint(currentDir, canonicalExe);
            return TryStartProcess(canonicalExe, canonicalDir, args);
        }
        catch (Exception ex)
        {
            ShowBootstrapError($"启动引导失败：{ex.Message}\n\n请尝试运行同目录下的「启动 DanceMonkey.bat」。");
            return false;
        }
    }

    private static bool TryStartProcess(string exePath, string workingDirectory, string[]? args)
    {
        var psi = new ProcessStartInfo
        {
            FileName = exePath,
            WorkingDirectory = workingDirectory,
            UseShellExecute = true,
        };

        if (args is { Length: > 0 })
        {
            foreach (var arg in args)
                psi.ArgumentList.Add(arg);
        }

        Process.Start(psi);
        return true;
    }

    private static int RobocopyMirror(string sourceDir, string destDir)
    {
        var psi = new ProcessStartInfo
        {
            FileName = "robocopy.exe",
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        psi.ArgumentList.Add(sourceDir);
        psi.ArgumentList.Add(destDir);
        psi.ArgumentList.Add("/E");
        psi.ArgumentList.Add("/R:2");
        psi.ArgumentList.Add("/W:1");
        psi.ArgumentList.Add("/NFL");
        psi.ArgumentList.Add("/NDL");
        psi.ArgumentList.Add("/NJH");
        psi.ArgumentList.Add("/NJS");
        psi.ArgumentList.Add("/NP");

        using var process = Process.Start(psi);
        if (process == null)
            return 8;

        process.WaitForExit(120_000);
        return process.ExitCode;
    }

    private static Version? ReadExeVersion(string exePath)
    {
        try
        {
            var fvi = FileVersionInfo.GetVersionInfo(exePath);
            return AppVersionService.TryParseVersion(fvi.FileVersion)
                   ?? AppVersionService.TryParseVersion(fvi.ProductVersion);
        }
        catch
        {
            return null;
        }
    }

    private static bool IsUncPath(string path)
    {
        if (string.IsNullOrWhiteSpace(path))
            return false;

        try
        {
            if (path.StartsWith(@"\\", StringComparison.Ordinal))
                return true;

            var root = Path.GetPathRoot(path);
            if (string.IsNullOrEmpty(root))
                return false;

            var di = new DriveInfo(root);
            return di.DriveType == DriveType.Network;
        }
        catch
        {
            return path.StartsWith(@"\\", StringComparison.Ordinal);
        }
    }

    private static void WriteRedirectHint(string previousDir, string canonicalExe)
    {
        try
        {
            var hintPath = Path.Combine(previousDir, "请使用本机安装目录启动.txt");
            var sb = new StringBuilder();
            sb.AppendLine("DanceMonkey 已安装到本机固定目录，请从以下位置启动：");
            sb.AppendLine();
            sb.AppendLine(canonicalExe);
            sb.AppendLine();
            sb.AppendLine("或双击同目录下的「启动 DanceMonkey.bat」。");
            File.WriteAllText(hintPath, sb.ToString(), Encoding.UTF8);

            var batPath = Path.Combine(previousDir, "启动 DanceMonkey.bat");
            if (!File.Exists(batPath))
            {
                var bat = "@echo off\r\n" +
                          $"start \"\" \"{canonicalExe}\"\r\n";
                File.WriteAllText(batPath, bat, Encoding.UTF8);
            }
        }
        catch
        {
            // 提示文件写入失败不应阻止启动
        }
    }

    private static void ShowBootstrapError(string message)
    {
        try
        {
            MessageBox.Show(
                message + "\n\n日志目录：\n" + StartupDiagnostics.LogFilePath,
                "DanceMonkey 启动",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }
        catch
        {
            // ignore
        }
    }
}
