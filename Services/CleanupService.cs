using System.IO;

namespace DesktopAssistant.Services;

public sealed class CleanupTarget
{
    public required string Key { get; init; }
    public required string DisplayName { get; init; }
    public required string RootPath { get; init; }
    public bool Enabled { get; set; } = true;
}

public sealed class CleanupAnalysisEntry
{
    public required string Key { get; init; }
    public required string DisplayName { get; init; }
    public required string Path { get; init; }
    public long Bytes { get; init; }
    public int FileCount { get; init; }
    public string? Error { get; init; }
}

public sealed class CleanupResultLine
{
    public required string Message { get; init; }
}

/// <summary>白名单临时目录分析与清理。</summary>
public static class CleanupService
{
    public static IReadOnlyList<CleanupTarget> GetDefaultTargets()
    {
        var userTemp = Path.GetTempPath();
        var winTemp = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "Temp");
        return new List<CleanupTarget>
        {
            new()
            {
                Key = "userTemp",
                DisplayName = "用户临时目录 (%TEMP%)",
                RootPath = userTemp.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
            },
            new()
            {
                Key = "winTemp",
                DisplayName = "Windows Temp（仅可删除的文件）",
                RootPath = winTemp
            }
        };
    }

    public static CleanupAnalysisEntry Analyze(string key, string displayName, string rootPath,
        IProgress<string>? progress = null, CancellationToken cancellationToken = default)
    {
        progress?.Report($"正在分析：{displayName}");
        if (string.IsNullOrWhiteSpace(rootPath) || !Directory.Exists(rootPath))
        {
            return new CleanupAnalysisEntry
            {
                Key = key,
                DisplayName = displayName,
                Path = rootPath,
                Bytes = 0,
                FileCount = 0,
                Error = "目录不存在"
            };
        }

        long bytes = 0;
        var files = 0;
        try
        {
            foreach (var file in EnumerateFilesSafe(rootPath, cancellationToken))
            {
                cancellationToken.ThrowIfCancellationRequested();
                try
                {
                    var info = new FileInfo(file);
                    if (!info.Exists) continue;
                    bytes += info.Length;
                    files++;
                }
                catch
                {
                    // skip locked
                }
            }
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            return new CleanupAnalysisEntry
            {
                Key = key,
                DisplayName = displayName,
                Path = rootPath,
                Bytes = bytes,
                FileCount = files,
                Error = ex.Message
            };
        }

        return new CleanupAnalysisEntry
        {
            Key = key,
            DisplayName = displayName,
            Path = rootPath,
            Bytes = bytes,
            FileCount = files,
            Error = null
        };
    }

    public static async Task<IReadOnlyList<CleanupResultLine>> CleanAsync(
        IReadOnlyList<CleanupTarget> targets,
        IProgress<string>? progress = null,
        CancellationToken cancellationToken = default)
    {
        var lines = new List<CleanupResultLine>();
        foreach (var t in targets.Where(x => x.Enabled))
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (string.IsNullOrWhiteSpace(t.RootPath) || !Directory.Exists(t.RootPath))
            {
                lines.Add(new CleanupResultLine { Message = $"[跳过] {t.DisplayName}：目录不存在" });
                continue;
            }

            progress?.Report($"正在清理：{t.DisplayName}");
            var (deleted, failed) = await Task.Run(() => DeleteFilesUnder(t.RootPath, progress, cancellationToken),
                cancellationToken).ConfigureAwait(false);
            lines.Add(new CleanupResultLine
            {
                Message = $"[完成] {t.DisplayName}：已删除 {deleted} 个文件，失败 {failed} 个"
            });
        }

        return lines;
    }

    private static IEnumerable<string> EnumerateFilesSafe(string root, CancellationToken cancellationToken)
    {
        var stack = new Stack<string>();
        stack.Push(root);
        while (stack.Count > 0)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var dir = stack.Pop();
            string[] subDirs;
            try
            {
                subDirs = Directory.GetDirectories(dir);
            }
            catch
            {
                continue;
            }

            foreach (var sd in subDirs)
                stack.Push(sd);

            string[] filesInDir;
            try
            {
                filesInDir = Directory.GetFiles(dir);
            }
            catch
            {
                continue;
            }

            foreach (var f in filesInDir)
                yield return f;
        }
    }

    private static (int deleted, int failed) DeleteFilesUnder(string root, IProgress<string>? progress,
        CancellationToken cancellationToken)
    {
        var deleted = 0;
        var failed = 0;
        foreach (var file in EnumerateFilesSafe(root, cancellationToken))
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                File.Delete(file);
                deleted++;
                if ((deleted & 0x3FF) == 0)
                    progress?.Report($"已删除 {deleted} 个文件…");
            }
            catch
            {
                failed++;
            }
        }

        return (deleted, failed);
    }
}
