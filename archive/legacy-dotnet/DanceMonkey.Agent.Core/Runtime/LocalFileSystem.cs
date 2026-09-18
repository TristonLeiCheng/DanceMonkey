using System.Text;
using DanceMonkey.Agent.Core.Abstractions;

namespace DanceMonkey.Agent.Core.Runtime;

/// <summary>
/// <see cref="IFileSystem"/> 的本地实现：把所有操作约束到单一 <c>rootPath</c> 之下，
/// 任何越界路径抛 <see cref="UnauthorizedAccessException"/>。
/// 也可由 WPF 端复用（把 SandboxFileService.SandboxRoot 传进来即可）。
/// </summary>
public sealed class LocalFileSystem : IFileSystem
{
    private readonly string _root;

    public LocalFileSystem(string rootPath)
    {
        if (string.IsNullOrWhiteSpace(rootPath))
            throw new ArgumentException("rootPath 不能为空", nameof(rootPath));
        _root = Path.GetFullPath(rootPath);
        Directory.CreateDirectory(_root);
    }

    public string WorkingDirectory => _root;

    public bool FileExists(string relativePath) => File.Exists(Resolve(relativePath));
    public bool DirectoryExists(string relativePath) => Directory.Exists(Resolve(relativePath));

    public async Task<string> ReadTextAsync(string relativePath, int maxBytes, CancellationToken ct)
    {
        var abs = Resolve(relativePath);
        if (!File.Exists(abs)) throw new FileNotFoundException(relativePath);

        var info = new FileInfo(abs);
        if (info.Length <= maxBytes)
            return await File.ReadAllTextAsync(abs, Encoding.UTF8, ct).ConfigureAwait(false);

        // 截断读取：读前 maxBytes 字节，并附标记
        using var fs = new FileStream(abs, FileMode.Open, FileAccess.Read, FileShare.Read);
        var buf = new byte[maxBytes];
        int read = await fs.ReadAsync(buf.AsMemory(0, maxBytes), ct).ConfigureAwait(false);
        var text = Encoding.UTF8.GetString(buf, 0, read);
        return text + $"\n\n[... 文件已截断，总 {info.Length} 字节，仅展示前 {read} 字节 ...]";
    }

    public async Task WriteTextAsync(string relativePath, string content, CancellationToken ct)
    {
        var abs = Resolve(relativePath);
        var dir = Path.GetDirectoryName(abs);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        await File.WriteAllTextAsync(abs, content, new UTF8Encoding(false), ct).ConfigureAwait(false);
    }

    public async Task<int> ReplaceInFileAsync(string relativePath, string oldText, string newText, CancellationToken ct)
    {
        var abs = Resolve(relativePath);
        if (!File.Exists(abs)) throw new FileNotFoundException(relativePath);
        var original = await File.ReadAllTextAsync(abs, Encoding.UTF8, ct).ConfigureAwait(false);
        var idx = original.IndexOf(oldText, StringComparison.Ordinal);
        if (idx < 0) return 0;
        var updated = original[..idx] + newText + original[(idx + oldText.Length)..];
        await File.WriteAllTextAsync(abs, updated, new UTF8Encoding(false), ct).ConfigureAwait(false);
        return oldText.Length;
    }

    public Task DeleteFileAsync(string relativePath, CancellationToken ct)
    {
        var abs = Resolve(relativePath);
        if (File.Exists(abs)) File.Delete(abs);
        return Task.CompletedTask;
    }

    public Task CreateDirectoryAsync(string relativePath, CancellationToken ct)
    {
        Directory.CreateDirectory(Resolve(relativePath));
        return Task.CompletedTask;
    }

    public Task<IReadOnlyList<string>> ListDirectoryAsync(string? relativePath, CancellationToken ct)
    {
        var abs = string.IsNullOrEmpty(relativePath) ? _root : Resolve(relativePath);
        if (!Directory.Exists(abs)) throw new DirectoryNotFoundException(relativePath ?? "/");

        var list = new List<string>();
        foreach (var d in Directory.GetDirectories(abs))
            list.Add(Path.GetFileName(d) + "/");
        foreach (var f in Directory.GetFiles(abs))
        {
            var fi = new FileInfo(f);
            list.Add($"{fi.Name}  ({FormatSize(fi.Length)})");
        }
        return Task.FromResult<IReadOnlyList<string>>(list);
    }

    public string RenderTree(int maxDepth = 3)
    {
        var sb = new StringBuilder();
        sb.Append(Path.GetFileName(_root)).AppendLine("/");
        BuildTree(_root, sb, "", 0, maxDepth);
        return sb.ToString().TrimEnd();
    }

    public string ResolveAbsolute(string relativePath) => Resolve(relativePath);

    public bool IsAllowedAbsolute(string absolutePath)
    {
        var full = Path.GetFullPath(absolutePath);
        var root = _root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        return full.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) ||
               full.Equals(root, StringComparison.OrdinalIgnoreCase);
    }

    // ──────────────── internals ────────────────

    private string Resolve(string relative)
    {
        if (string.IsNullOrWhiteSpace(relative))
            throw new ArgumentException("路径不能为空");
        var cleaned = relative.Replace('/', Path.DirectorySeparatorChar).TrimStart(Path.DirectorySeparatorChar);
        var full = Path.GetFullPath(Path.Combine(_root, cleaned));
        if (!full.StartsWith(_root, StringComparison.OrdinalIgnoreCase))
            throw new UnauthorizedAccessException($"路径越界: {relative}");
        return full;
    }

    private static void BuildTree(string dir, StringBuilder sb, string indent, int depth, int maxDepth)
    {
        if (depth >= maxDepth) return;
        string[] children;
        try
        {
            var dirs = Directory.GetDirectories(dir);
            var files = Directory.GetFiles(dir);
            children = dirs.Concat(files).ToArray();
        }
        catch { return; }

        for (int i = 0; i < children.Length; i++)
        {
            var isLast = i == children.Length - 1;
            var connector = isLast ? "└── " : "├── ";
            var childIndent = isLast ? "    " : "│   ";
            var name = Path.GetFileName(children[i]);
            if (Directory.Exists(children[i]))
            {
                sb.Append(indent).Append(connector).Append(name).AppendLine("/");
                BuildTree(children[i], sb, indent + childIndent, depth + 1, maxDepth);
            }
            else
            {
                sb.Append(indent).Append(connector).AppendLine(name);
            }
        }
    }

    private static string FormatSize(long bytes) => bytes switch
    {
        < 1024 => $"{bytes} B",
        < 1024 * 1024 => $"{bytes / 1024.0:F1} KB",
        _ => $"{bytes / (1024.0 * 1024.0):F1} MB",
    };
}
