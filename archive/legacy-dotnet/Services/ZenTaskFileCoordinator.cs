using System.Collections.Concurrent;
using System.Text;

namespace DesktopAssistant.Services;

internal static class ZenTaskFileCoordinator
{
    private static readonly ConcurrentDictionary<string, object> PathLocks =
        new(StringComparer.OrdinalIgnoreCase);

    public static T ExecuteLocked<T>(string path, Func<T> action)
    {
        var lockObject = PathLocks.GetOrAdd(Path.GetFullPath(path), static _ => new object());
        lock (lockObject)
            return action();
    }

    public static void ExecuteLocked(string path, Action action) =>
        ExecuteLocked(
            path,
            () =>
            {
                action();
                return true;
            });

    public static void AtomicWriteAllText(string path, string content) =>
        ExecuteLocked(
            path,
            () =>
            {
                var directory = Path.GetDirectoryName(path);
                if (string.IsNullOrWhiteSpace(directory))
                    throw new InvalidOperationException("目标目录无效。");
                Directory.CreateDirectory(directory);

                var tempPath = Path.Combine(
                    directory,
                    $".{Path.GetFileName(path)}.{Guid.NewGuid():N}.tmp");
                try
                {
                    File.WriteAllText(tempPath, content, new UTF8Encoding(false));
                    if (File.Exists(path))
                        File.Replace(tempPath, path, null, ignoreMetadataErrors: true);
                    else
                        File.Move(tempPath, path);
                }
                finally
                {
                    try
                    {
                        File.Delete(tempPath);
                    }
                    catch (IOException)
                    {
                    }
                    catch (UnauthorizedAccessException)
                    {
                    }
                }
            });
}
