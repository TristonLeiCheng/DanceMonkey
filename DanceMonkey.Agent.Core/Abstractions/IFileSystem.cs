namespace DanceMonkey.Agent.Core.Abstractions;

/// <summary>
/// 文件系统抽象。实现负责把相对路径解析为受控的绝对路径
/// （例如 WPF 端用 <c>SandboxFileService</c> 约束在沙箱内）。
/// 所有路径越界应抛 <see cref="UnauthorizedAccessException"/>。
/// </summary>
public interface IFileSystem
{
    /// <summary>当前工作目录的绝对路径（给用户展示用）。</summary>
    string WorkingDirectory { get; }

    bool FileExists(string relativePath);
    bool DirectoryExists(string relativePath);

    /// <summary>读取文本文件。实现可按需截断大文件（返回前 N 行并在末尾附 "[truncated]"）。</summary>
    Task<string> ReadTextAsync(string relativePath, int maxBytes, CancellationToken ct);

    /// <summary>整体写入文本。目录不存在会自动创建。</summary>
    Task WriteTextAsync(string relativePath, string content, CancellationToken ct);

    /// <summary>在指定文件中把 <paramref name="oldText"/>（首次出现）替换为 <paramref name="newText"/>。</summary>
    /// <returns>被替换的字符数。</returns>
    Task<int> ReplaceInFileAsync(string relativePath, string oldText, string newText, CancellationToken ct);

    Task DeleteFileAsync(string relativePath, CancellationToken ct);
    Task CreateDirectoryAsync(string relativePath, CancellationToken ct);

    /// <summary>列目录，返回相对路径列表（子目录以 "/" 结尾）。</summary>
    Task<IReadOnlyList<string>> ListDirectoryAsync(string? relativePath, CancellationToken ct);

    /// <summary>生成目录树文本，用于注入 system prompt。</summary>
    string RenderTree(int maxDepth = 3);

    /// <summary>
    /// 将受控相对路径解析为绝对路径（目录或文件）。用于 grep、shell 的 cwd 等需直接访问 OS 的场景。
    /// </summary>
    string ResolveAbsolute(string relativePath);

    /// <summary>判断绝对路径是否仍在本文件系统允许的根目录之下（防路径逃逸）。</summary>
    bool IsAllowedAbsolute(string absolutePath);
}
