using System.IO;
using Microsoft.Win32;

namespace DesktopAssistant.Services;

public static class QuickAccessPaths
{
    /// <summary>检测常见本机文件夹（桌面/文档/下载）。</summary>
    public static IReadOnlyList<(string Name, string Path, string Category)> DetectLocalFolders()
    {
        var list = new List<(string Name, string Path, string Category)>();
        var profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);

        var desktop = Environment.GetFolderPath(Environment.SpecialFolder.Desktop);
        if (Directory.Exists(desktop))
            list.Add(("桌面", desktop, "local"));

        var docs = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
        if (Directory.Exists(docs))
            list.Add(("文档", docs, "local"));

        var downloads = Path.Combine(profile, "Downloads");
        if (Directory.Exists(downloads))
            list.Add(("下载", downloads, "local"));

        return list;
    }

    /// <summary>检测 OneDrive 同步根目录（个人 + 企业）。</summary>
    public static IReadOnlyList<(string Name, string Path, string Category)> DetectOneDriveFolders()
    {
        var list = new List<(string Name, string Path, string Category)>();
        var profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);

        // 通用名称探测
        foreach (var name in new[] { "OneDrive", "OneDrive - Personal" })
        {
            var p = Path.Combine(profile, name);
            if (Directory.Exists(p))
                list.Add((name, p, "onedrive"));
        }

        // 注册表探测 OneDrive Business 帐号
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\OneDrive\Accounts");
            if (key != null)
            {
                foreach (var sub in key.GetSubKeyNames())
                {
                    using var acct = key.OpenSubKey(sub);
                    var folder = acct?.GetValue("UserFolder") as string;
                    var displayName = acct?.GetValue("DisplayName") as string;
                    if (!string.IsNullOrEmpty(folder) && Directory.Exists(folder))
                    {
                        var label = string.IsNullOrEmpty(displayName)
                            ? $"OneDrive ({sub})"
                            : $"OneDrive - {displayName}";
                        if (list.All(x => !x.Path.Equals(folder, StringComparison.OrdinalIgnoreCase)))
                            list.Add((label, folder, "onedrive"));
                    }
                }
            }
        }
        catch
        {
            // 注册表访问失败忽略
        }

        // 用户目录下带 "OneDrive -" 前缀的文件夹（企业同步常见命名）
        try
        {
            foreach (var dir in Directory.EnumerateDirectories(profile, "OneDrive - *"))
            {
                if (list.All(x => !x.Path.Equals(dir, StringComparison.OrdinalIgnoreCase)))
                    list.Add((Path.GetFileName(dir), dir, "onedrive"));
            }
        }
        catch
        {
            // ignore
        }

        return list;
    }

    /// <summary>检测已映射的网络驱动器。</summary>
    public static IReadOnlyList<(string Name, string Path, string Category)> DetectNetworkDrives()
    {
        var list = new List<(string Name, string Path, string Category)>();
        try
        {
            foreach (var drive in DriveInfo.GetDrives())
            {
                if (drive.DriveType == DriveType.Network && drive.IsReady)
                {
                    var label = string.IsNullOrWhiteSpace(drive.VolumeLabel)
                        ? $"网络驱动器 ({drive.Name.TrimEnd('\\')})"
                        : $"{drive.VolumeLabel} ({drive.Name.TrimEnd('\\')})";
                    list.Add((label, drive.RootDirectory.FullName, "network"));
                }
            }
        }
        catch
        {
            // ignore
        }
        return list;
    }

    /// <summary>打开本地路径或网络路径。</summary>
    public static void OpenInExplorer(string path)
    {
        if (string.IsNullOrWhiteSpace(path))
            return;

        var psi = new System.Diagnostics.ProcessStartInfo
        {
            FileName = path,
            UseShellExecute = true
        };
        try { System.Diagnostics.Process.Start(psi); } catch { }
    }

    /// <summary>打开 URL（SharePoint / OneDrive 链接 / Web 链接）。</summary>
    public static void OpenUrl(string url)
    {
        if (string.IsNullOrWhiteSpace(url))
            return;

        var psi = new System.Diagnostics.ProcessStartInfo
        {
            FileName = url,
            UseShellExecute = true
        };
        try { System.Diagnostics.Process.Start(psi); } catch { }
    }

    /// <summary>根据 QuickLinkItem 打开对应路径（自动判断类型）。</summary>
    public static void Open(Models.QuickLinkItem item)
    {
        if (item.IsUrl)
            OpenUrl(item.Path);
        else
            OpenInExplorer(item.Path);
    }

    /// <summary>
    /// 为保持兼容，仍保留旧的检测接口。
    /// </summary>
    public static IReadOnlyList<(string Name, string Path)> DetectBuiltInFolders()
    {
        var all = new List<(string Name, string Path)>();
        foreach (var (n, p, _) in DetectLocalFolders()) all.Add((n, p));
        foreach (var (n, p, _) in DetectOneDriveFolders()) all.Add((n, p));
        return all;
    }
}
