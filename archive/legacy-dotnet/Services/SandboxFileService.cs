using System.Text;

namespace DesktopAssistant.Services;

/// <summary>
/// 沙箱文件服务：所有文件操作限制在指定沙箱目录内，防止越权访问。
/// 支持创建、读取、写入、删除、重命名、移动、列出目录等操作。
/// </summary>
public sealed class SandboxFileService
{
    private readonly string _sandboxRoot;

    /// <summary>沙箱根目录的完整路径。</summary>
    public string SandboxRoot => _sandboxRoot;

    public SandboxFileService(string? sandboxPath = null)
    {
        if (string.IsNullOrWhiteSpace(sandboxPath))
        {
            var appData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            sandboxPath = Path.Combine(appData, "DanceMonkey", "Sandbox");
        }

        _sandboxRoot = Path.GetFullPath(sandboxPath);
        Directory.CreateDirectory(_sandboxRoot);
    }

    /// <summary>将用户提供的相对/绝对路径解析为沙箱内的安全绝对路径。</summary>
    /// <exception cref="UnauthorizedAccessException">路径逃逸出沙箱时抛出。</exception>
    public string ResolveSafePath(string relativePath)
    {
        if (string.IsNullOrWhiteSpace(relativePath))
            throw new ArgumentException("路径不能为空。");

        // 去掉前导分隔符，避免拼接时跳到根目录
        var cleaned = relativePath.Replace('/', '\\').TrimStart('\\');

        var full = Path.GetFullPath(Path.Combine(_sandboxRoot, cleaned));

        if (!full.StartsWith(_sandboxRoot, StringComparison.OrdinalIgnoreCase))
            throw new UnauthorizedAccessException($"路径越界：不允许访问沙箱目录外的文件。");

        return full;
    }

    // ═══════════════ 文件操作 ═══════════════

    /// <summary>创建或覆盖文件。</summary>
    public string CreateFile(string relativePath, string content)
    {
        var path = ResolveSafePath(relativePath);
        var dir = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        File.WriteAllText(path, content, Encoding.UTF8);
        return path;
    }

    /// <summary>追加内容到文件。</summary>
    public string AppendFile(string relativePath, string content)
    {
        var path = ResolveSafePath(relativePath);
        if (!File.Exists(path))
            return CreateFile(relativePath, content);
        File.AppendAllText(path, content, Encoding.UTF8);
        return path;
    }

    /// <summary>读取文件内容。</summary>
    public string ReadFile(string relativePath)
    {
        var path = ResolveSafePath(relativePath);
        if (!File.Exists(path))
            throw new FileNotFoundException($"文件不存在：{relativePath}");
        return File.ReadAllText(path, Encoding.UTF8);
    }

    /// <summary>删除文件。</summary>
    public void DeleteFile(string relativePath)
    {
        var path = ResolveSafePath(relativePath);
        if (File.Exists(path)) File.Delete(path);
    }

    /// <summary>重命名文件（同目录）。</summary>
    public string RenameFile(string relativePath, string newName)
    {
        var path = ResolveSafePath(relativePath);
        if (!File.Exists(path))
            throw new FileNotFoundException($"文件不存在：{relativePath}");

        var dir = Path.GetDirectoryName(path)!;
        var newPath = Path.Combine(dir, SanitizeFileName(newName));
        newPath = ResolveSafePath(Path.GetRelativePath(_sandboxRoot, newPath));

        if (File.Exists(newPath))
            throw new IOException($"目标文件已存在：{newName}");

        File.Move(path, newPath);
        return newPath;
    }

    /// <summary>移动文件到沙箱内其他目录。</summary>
    public string MoveFile(string relativePath, string targetDir)
    {
        var srcPath = ResolveSafePath(relativePath);
        if (!File.Exists(srcPath))
            throw new FileNotFoundException($"文件不存在：{relativePath}");

        var destDir = ResolveSafePath(targetDir);
        Directory.CreateDirectory(destDir);
        var destPath = Path.Combine(destDir, Path.GetFileName(srcPath));

        if (File.Exists(destPath))
            throw new IOException($"目标位置已存在同名文件：{Path.GetFileName(srcPath)}");

        File.Move(srcPath, destPath);
        return destPath;
    }

    // ═══════════════ 目录操作 ═══════════════

    /// <summary>创建目录。</summary>
    public string CreateDirectory(string relativePath)
    {
        var path = ResolveSafePath(relativePath);
        Directory.CreateDirectory(path);
        return path;
    }

    /// <summary>删除空目录。</summary>
    public void DeleteDirectory(string relativePath, bool recursive = false)
    {
        var path = ResolveSafePath(relativePath);
        if (Directory.Exists(path))
            Directory.Delete(path, recursive);
    }

    /// <summary>列出目录内容。</summary>
    public List<SandboxEntry> ListDirectory(string? relativePath = null)
    {
        var path = string.IsNullOrWhiteSpace(relativePath)
            ? _sandboxRoot
            : ResolveSafePath(relativePath);

        if (!Directory.Exists(path))
            throw new DirectoryNotFoundException($"目录不存在：{relativePath ?? "/"}");

        var result = new List<SandboxEntry>();

        foreach (var dir in Directory.GetDirectories(path))
        {
            var di = new DirectoryInfo(dir);
            result.Add(new SandboxEntry
            {
                Name = di.Name,
                RelativePath = Path.GetRelativePath(_sandboxRoot, dir),
                IsDirectory = true,
                Size = 0,
                LastModified = di.LastWriteTime
            });
        }

        foreach (var file in Directory.GetFiles(path))
        {
            var fi = new FileInfo(file);
            result.Add(new SandboxEntry
            {
                Name = fi.Name,
                RelativePath = Path.GetRelativePath(_sandboxRoot, file),
                IsDirectory = false,
                Size = fi.Length,
                LastModified = fi.LastWriteTime
            });
        }

        return result;
    }

    /// <summary>检查文件或目录是否存在。</summary>
    public bool Exists(string relativePath)
    {
        var path = ResolveSafePath(relativePath);
        return File.Exists(path) || Directory.Exists(path);
    }

    /// <summary>获取沙箱空间使用统计。</summary>
    public (int FileCount, int DirCount, long TotalBytes) GetStats()
    {
        if (!Directory.Exists(_sandboxRoot))
            return (0, 0, 0);

        var files = Directory.GetFiles(_sandboxRoot, "*", SearchOption.AllDirectories);
        var dirs = Directory.GetDirectories(_sandboxRoot, "*", SearchOption.AllDirectories);
        long total = 0;
        foreach (var f in files)
        {
            try { total += new FileInfo(f).Length; } catch { }
        }
        return (files.Length, dirs.Length, total);
    }

    /// <summary>生成目录树的文本表示。</summary>
    public string GetDirectoryTree(string? relativePath = null, int maxDepth = 4)
    {
        var path = string.IsNullOrWhiteSpace(relativePath)
            ? _sandboxRoot
            : ResolveSafePath(relativePath);

        if (!Directory.Exists(path))
            return "(目录不存在)";

        var sb = new StringBuilder();
        sb.AppendLine(Path.GetFileName(path) + "/");
        BuildTree(path, sb, "", 0, maxDepth);
        return sb.ToString().TrimEnd();
    }

    private static void BuildTree(string dir, StringBuilder sb, string indent, int depth, int maxDepth)
    {
        if (depth >= maxDepth) return;

        var entries = new List<string>();
        try
        {
            entries.AddRange(Directory.GetDirectories(dir));
            entries.AddRange(Directory.GetFiles(dir));
        }
        catch { return; }

        for (int i = 0; i < entries.Count; i++)
        {
            var isLast = i == entries.Count - 1;
            var connector = isLast ? "└── " : "├── ";
            var childIndent = isLast ? "    " : "│   ";
            var name = Path.GetFileName(entries[i]);

            if (Directory.Exists(entries[i]))
            {
                sb.AppendLine($"{indent}{connector}{name}/");
                BuildTree(entries[i], sb, indent + childIndent, depth + 1, maxDepth);
            }
            else
            {
                var size = FormatSize(new FileInfo(entries[i]).Length);
                sb.AppendLine($"{indent}{connector}{name}  ({size})");
            }
        }
    }

    private static string FormatSize(long bytes) => bytes switch
    {
        < 1024 => $"{bytes} B",
        < 1024 * 1024 => $"{bytes / 1024.0:F1} KB",
        _ => $"{bytes / (1024.0 * 1024.0):F1} MB"
    };

    private static string SanitizeFileName(string name)
    {
        var invalid = Path.GetInvalidFileNameChars();
        var sb = new StringBuilder(name.Length);
        foreach (var c in name)
            sb.Append(invalid.Contains(c) ? '_' : c);
        return sb.ToString().Trim();
    }
}

/// <summary>沙箱内文件/目录条目。</summary>
public sealed class SandboxEntry
{
    public required string Name { get; init; }
    public required string RelativePath { get; init; }
    public required bool IsDirectory { get; init; }
    public long Size { get; init; }
    public DateTime LastModified { get; init; }

    public string TypeDisplay => IsDirectory ? "📁 文件夹" : "📄 文件";
    public string SizeDisplay => IsDirectory ? "" : FormatSize(Size);
    public string ModifiedDisplay => LastModified.ToString("yyyy-MM-dd HH:mm");

    private static string FormatSize(long bytes) => bytes switch
    {
        < 1024 => $"{bytes} B",
        < 1024 * 1024 => $"{bytes / 1024.0:F1} KB",
        _ => $"{bytes / (1024.0 * 1024.0):F1} MB"
    };
}
