namespace DanceMonkey.Cli;

/// <summary>
/// 将程序目录下的内置 <c>ppt_scaffold/</c> 同步到工作目录 <c>.dancemonkey/ppt_scaffold/</c>，
/// 便于 Agent 用 <c>read_file</c> 以相对路径访问（与单文件发布旁路文件布局一致）。
/// </summary>
internal static class PptScaffoldInstaller
{
    public static void EnsureInstalled(string workingDirectory)
    {
        if (string.IsNullOrWhiteSpace(workingDirectory))
            return;

        try
        {
            var src = Path.Combine(AppContext.BaseDirectory, "ppt_scaffold");
            if (!Directory.Exists(src))
                return;

            var dest = Path.Combine(workingDirectory, ".dancemonkey", "ppt_scaffold");
            Directory.CreateDirectory(dest);

            foreach (var file in Directory.EnumerateFiles(src, "*", SearchOption.AllDirectories))
            {
                var rel = Path.GetRelativePath(src, file);
                var target = Path.Combine(dest, rel);
                var targetDir = Path.GetDirectoryName(target);
                if (!string.IsNullOrEmpty(targetDir))
                    Directory.CreateDirectory(targetDir);

                File.Copy(file, target, overwrite: true);
            }
        }
        catch
        {
            // 尽力而为，不阻塞 CLI 启动
        }
    }
}
