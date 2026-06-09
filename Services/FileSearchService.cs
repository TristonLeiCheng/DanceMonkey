using System.Collections.Concurrent;

namespace DesktopAssistant.Services;

public sealed class FileSearchHit
{
    public required string FullPath { get; init; }
    public required string Name { get; init; }
    public long LengthBytes { get; init; }
    public DateTime CreationUtc { get; init; }
    public DateTime LastWriteUtc { get; init; }
}

/// <summary>在指定目录内按文件名关键字搜索（可选子目录），结果有上限。</summary>
public static class FileSearchService
{
    public static List<FileSearchHit> Search(
        string rootDirectory,
        string nameKeyword,
        bool includeSubfolders,
        int maxResults = 500,
        IProgress<string>? progress = null,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(rootDirectory) || !Directory.Exists(rootDirectory))
            throw new DirectoryNotFoundException("目录不存在。");

        var keyword = nameKeyword.Trim();
        var comparer = StringComparison.OrdinalIgnoreCase;
        var results = new List<FileSearchHit>(Math.Min(maxResults, 64));
        var opts = new EnumerationOptions
        {
            RecurseSubdirectories = includeSubfolders,
            IgnoreInaccessible = true,
            AttributesToSkip = FileAttributes.System
        };

        progress?.Report("正在扫描…");
        foreach (var path in Directory.EnumerateFiles(rootDirectory, "*", opts))
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (results.Count >= maxResults)
                break;

            var name = Path.GetFileName(path);
            if (keyword.Length > 0 &&
                name.IndexOf(keyword, comparer) < 0 &&
                path.IndexOf(keyword, comparer) < 0)
                continue;

            try
            {
                var fi = new FileInfo(path);
                results.Add(new FileSearchHit
                {
                    FullPath = path,
                    Name = name,
                    LengthBytes = fi.Length,
                    CreationUtc = fi.CreationTimeUtc,
                    LastWriteUtc = fi.LastWriteTimeUtc
                });
            }
            catch
            {
                // 跳过无法访问的文件
            }
        }

        progress?.Report($"完成，共 {results.Count} 条（最多 {maxResults}）");
        return results;
    }
}
