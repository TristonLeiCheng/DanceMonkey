using System.Text;
using DanceMonkey.Agent.Core.Abstractions;

namespace DanceMonkey.Agent.Core.Runtime;

/// <summary>
/// 双根文件系统：主工作区 + 通过 <c>notes/</c> 前缀映射的笔记库根目录。
/// CLI 与 GUI Agent 共用。
/// </summary>
public sealed class DualRootFileSystem : IFileSystem
{
    private readonly LocalFileSystem _primary;
    private readonly LocalFileSystem _notes;

    public DualRootFileSystem(string primaryRoot, string notesRoot)
    {
        _primary = new LocalFileSystem(primaryRoot);
        _notes = new LocalFileSystem(notesRoot);
    }

    /// <summary>主工作区根（无前缀路径解析到此）。</summary>
    public string PrimaryRoot => _primary.WorkingDirectory;

    /// <summary>笔记库绝对路径（工具路径前缀 <c>notes/</c>）。</summary>
    public string NotesRoot => _notes.WorkingDirectory;

    public string WorkingDirectory => _primary.WorkingDirectory;

    public string ResolveAbsolute(string relativePath)
    {
        var r = (relativePath ?? "").Replace('\\', '/').Trim();
        if (r.Equals("notes", StringComparison.OrdinalIgnoreCase))
            return NotesRoot;
        if (TryGetNotesSubpath(r, out var sub))
            return string.IsNullOrEmpty(sub) ? NotesRoot : _notes.ResolveAbsolute(sub);
        return _primary.ResolveAbsolute(relativePath!);
    }

    public bool IsAllowedAbsolute(string absolutePath)
    {
        var full = Path.GetFullPath(absolutePath);
        return _primary.IsAllowedAbsolute(full) || _notes.IsAllowedAbsolute(full);
    }

    private static bool TryGetNotesSubpath(string relativePath, out string subpath)
    {
        var r = (relativePath ?? "").Replace('\\', '/').TrimStart('/');
        if (r.StartsWith("notes/", StringComparison.OrdinalIgnoreCase))
        {
            subpath = r["notes/".Length..];
            return true;
        }
        subpath = "";
        return false;
    }

    public bool FileExists(string relativePath) =>
        TryDispatch(relativePath, (fs, rel) => fs.FileExists(rel));

    public bool DirectoryExists(string relativePath) =>
        TryDispatch(relativePath, (fs, rel) => fs.DirectoryExists(rel));

    public Task<string> ReadTextAsync(string relativePath, int maxBytes, CancellationToken ct) =>
        TryDispatch(relativePath, (fs, rel) => fs.ReadTextAsync(rel, maxBytes, ct));

    public Task WriteTextAsync(string relativePath, string content, CancellationToken ct) =>
        TryDispatch(relativePath, (fs, rel) => fs.WriteTextAsync(rel, content, ct));

    public Task<int> ReplaceInFileAsync(string relativePath, string oldText, string newText, CancellationToken ct) =>
        TryDispatch(relativePath, (fs, rel) => fs.ReplaceInFileAsync(rel, oldText, newText, ct));

    public Task DeleteFileAsync(string relativePath, CancellationToken ct) =>
        TryDispatch(relativePath, (fs, rel) => fs.DeleteFileAsync(rel, ct));

    public Task CreateDirectoryAsync(string relativePath, CancellationToken ct) =>
        TryDispatch(relativePath, (fs, rel) => fs.CreateDirectoryAsync(rel, ct));

    public Task<IReadOnlyList<string>> ListDirectoryAsync(string? relativePath, CancellationToken ct)
    {
        if (relativePath == null)
            return _primary.ListDirectoryAsync(null, ct);
        if (TryGetNotesSubpath(relativePath, out var sub))
            return _notes.ListDirectoryAsync(string.IsNullOrEmpty(sub) ? null : sub, ct);
        return _primary.ListDirectoryAsync(relativePath, ct);
    }

    public string RenderTree(int maxDepth = 3)
    {
        var sb = new StringBuilder();
        sb.AppendLine("【工作区 / 沙箱】（相对路径无前缀，默认在此）");
        sb.AppendLine($"`{PrimaryRoot}`");
        sb.AppendLine("```");
        sb.AppendLine(_primary.RenderTree(maxDepth).TrimEnd());
        sb.AppendLine("```");
        sb.AppendLine();
        sb.AppendLine("【笔记库】（相对路径须加前缀 notes/，映射到下面目录）");
        sb.AppendLine($"`{NotesRoot}`");
        sb.AppendLine("```");
        sb.AppendLine(_notes.RenderTree(maxDepth).TrimEnd());
        sb.AppendLine("```");
        return sb.ToString();
    }

    private T TryDispatch<T>(string? relativePath, Func<LocalFileSystem, string, T> fn)
    {
        if (TryGetNotesSubpath(relativePath ?? "", out var sub))
            return fn(_notes, sub);
        return fn(_primary, relativePath ?? throw new ArgumentException("路径不能为空"));
    }

    private Task<T> TryDispatch<T>(string? relativePath, Func<LocalFileSystem, string, Task<T>> fn)
    {
        if (TryGetNotesSubpath(relativePath ?? "", out var sub))
            return fn(_notes, sub);
        return fn(_primary, relativePath ?? throw new ArgumentException("路径不能为空"));
    }
}
