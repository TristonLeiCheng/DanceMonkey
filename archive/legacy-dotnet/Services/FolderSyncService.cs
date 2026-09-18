using System.Text.Json;
using System.Text.RegularExpressions;
using DesktopAssistant.Models;

namespace DesktopAssistant.Services;

public sealed class FolderSyncService
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true
    };

    private readonly string _stateRoot;
    private readonly string _logRoot;

    public FolderSyncService()
    {
        var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        _stateRoot = Path.Combine(appData, "DanceMonkey", "sync-state");
        _logRoot = Path.Combine(appData, "DanceMonkey", "sync-logs");
        Directory.CreateDirectory(_stateRoot);
        Directory.CreateDirectory(_logRoot);
    }

    public string GetLogPath(FolderSyncProfile profile)
    {
        var id = string.IsNullOrWhiteSpace(profile.Id) ? "default" : profile.Id;
        var safe = Regex.Replace(id, "[^a-zA-Z0-9_-]", "_");
        return Path.Combine(_logRoot, safe + ".log");
    }

    public string ReadRecentLog(FolderSyncProfile profile, int maxLines = 160)
    {
        var path = GetLogPath(profile);
        if (!File.Exists(path))
            return "";

        var lines = File.ReadLines(path).TakeLast(Math.Clamp(maxLines, 20, 1000));
        return string.Join(Environment.NewLine, lines);
    }

    public FolderSyncPreview Preview(FolderSyncProfile profile)
    {
        var plan = BuildPlan(profile);
        return plan.ToPreview();
    }

    public FolderSyncRunResult Run(FolderSyncProfile profile)
        => Run(profile, progress: null, cancellationToken: default);

    public FolderSyncRunResult Run(
        FolderSyncProfile profile,
        IProgress<FolderSyncProgress>? progress,
        CancellationToken cancellationToken = default)
    {
        var plan = BuildPlan(profile);
        var result = new FolderSyncRunResult { Preview = plan.ToPreview() };

        Directory.CreateDirectory(plan.MasterRoot);
        Directory.CreateDirectory(plan.SlaveRoot);
        CleanupOldTrash(plan.SlaveRoot, profile.TrashRetentionDays);

        progress?.Report(new FolderSyncProgress
        {
            TotalOperations = plan.Operations.Count,
            CompletedOperations = 0,
            StatusText = "准备同步..."
        });

        var completed = 0;
        foreach (var operation in plan.Operations)
        {
            if (cancellationToken.IsCancellationRequested)
            {
                result.Cancelled = true;
                break;
            }

            progress?.Report(new FolderSyncProgress
            {
                TotalOperations = plan.Operations.Count,
                CompletedOperations = completed,
                CurrentOperation = GetOperationDisplayName(operation),
                CurrentPath = operation.RelativePath,
                StatusText = $"{GetOperationDisplayName(operation)}：{operation.RelativePath}"
            });

            try
            {
                switch (operation.Kind)
                {
                    case SyncOperationKind.CopyToSlave:
                        CopyFile(operation.SourcePath, operation.TargetPath);
                        result.CopiedCount++;
                        break;
                    case SyncOperationKind.CopyToMaster:
                        CopyFile(operation.SourcePath, operation.TargetPath);
                        result.CopiedCount++;
                        break;
                    case SyncOperationKind.DeleteFromSlave:
                        MoveToTrash(plan.SlaveRoot, operation.TargetPath);
                        result.DeletedCount++;
                        break;
                    case SyncOperationKind.PreserveSlaveConflictThenCopyMaster:
                        var conflictPath = BuildConflictPath(operation.TargetPath);
                        CopyFile(operation.TargetPath, conflictPath);
                        CopyFile(operation.SourcePath, operation.TargetPath);
                        result.CopiedCount += 2;
                        break;
                    case SyncOperationKind.Skip:
                        result.SkippedCount++;
                        break;
                }
                completed++;
                progress?.Report(new FolderSyncProgress
                {
                    TotalOperations = plan.Operations.Count,
                    CompletedOperations = completed,
                    CurrentOperation = GetOperationDisplayName(operation),
                    CurrentPath = operation.RelativePath,
                    StatusText = $"{completed}/{plan.Operations.Count}：{operation.RelativePath}"
                });
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or NotSupportedException)
            {
                result.ErrorCount++;
                result.Errors.Add($"{operation.RelativePath}: {ex.Message}");
                completed++;
                progress?.Report(new FolderSyncProgress
                {
                    TotalOperations = plan.Operations.Count,
                    CompletedOperations = completed,
                    CurrentOperation = GetOperationDisplayName(operation),
                    CurrentPath = operation.RelativePath,
                    StatusText = $"失败：{operation.RelativePath}"
                });
            }
        }

        if (result.ErrorCount == 0 && !result.Cancelled)
            SaveState(profile, plan.MasterRoot, plan.SlaveRoot, plan.ExcludePatterns);
        AppendLog(profile, result);
        progress?.Report(new FolderSyncProgress
        {
            TotalOperations = plan.Operations.Count,
            CompletedOperations = completed,
            StatusText = result.Summary,
            IsCompleted = true,
            IsCancelled = result.Cancelled
        });
        return result;
    }

    private void AppendLog(FolderSyncProfile profile, FolderSyncRunResult result)
    {
        var lines = new List<string>
        {
            $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] {profile.Name}",
            $"Mode={profile.Mode}; ConflictPolicy={profile.ConflictPolicy}; TrashRetentionDays={profile.TrashRetentionDays}; Master={profile.MasterPath}; Slave={profile.SlavePath}",
            result.Preview.Summary,
            result.Summary
        };
        if (result.Errors.Count > 0)
            lines.AddRange(result.Errors.Select(e => "ERROR " + e));
        lines.Add("");
        File.AppendAllLines(GetLogPath(profile), lines);
    }

    private SyncPlan BuildPlan(FolderSyncProfile profile)
    {
        ValidateProfile(profile);

        var masterRoot = NormalizeRoot(profile.MasterPath);
        var slaveRoot = NormalizeRoot(profile.SlavePath);
        var excludePatterns = ParseExcludePatterns(profile.ExcludePatterns);
        var masterFiles = SnapshotDirectory(masterRoot, excludePatterns);
        var slaveFiles = Directory.Exists(slaveRoot)
            ? SnapshotDirectory(slaveRoot, excludePatterns)
            : new Dictionary<string, SyncFile>(StringComparer.OrdinalIgnoreCase);
        var previous = LoadState(profile);

        var plan = new SyncPlan(masterRoot, slaveRoot, excludePatterns);
        var allKeys = new HashSet<string>(masterFiles.Keys, StringComparer.OrdinalIgnoreCase);
        allKeys.UnionWith(slaveFiles.Keys);

        foreach (var relativePath in allKeys.OrderBy(x => x, StringComparer.OrdinalIgnoreCase))
        {
            masterFiles.TryGetValue(relativePath, out var master);
            slaveFiles.TryGetValue(relativePath, out var slave);
            previous.Files.TryGetValue(relativePath, out var previousFile);

            if (master != null && slave == null)
            {
                plan.AddCopyToSlave(master, Path.Combine(slaveRoot, relativePath));
                continue;
            }

            if (master == null && slave != null)
            {
                if (profile.Mode == FolderSyncModes.TwoWay)
                    plan.AddCopyToMaster(slave, Path.Combine(masterRoot, relativePath));
                else if (profile.DeleteExtraFiles)
                    plan.AddDeleteFromSlave(slave);
                else
                    plan.AddSkip(slave.RelativePath, "从文件夹存在额外文件，未启用删除。");
                continue;
            }

            if (master == null || slave == null || FilesMatch(master, slave))
                continue;

            if (profile.Mode == FolderSyncModes.MasterToSlave)
            {
                plan.AddCopyToSlave(master, slave.FullPath);
                continue;
            }

            var masterChanged = previousFile == null || !SameAsSnapshot(master, previousFile.Master);
            var slaveChanged = previousFile == null || !SameAsSnapshot(slave, previousFile.Slave);

            if (previousFile != null && masterChanged && slaveChanged)
            {
                plan.AddConflict(master, slave, profile.ConflictPolicy);
            }
            else if (previousFile != null && slaveChanged && !masterChanged)
            {
                plan.AddCopyToMaster(slave, master.FullPath);
            }
            else if (previousFile != null && masterChanged && !slaveChanged)
            {
                plan.AddCopyToSlave(master, slave.FullPath);
            }
            else
            {
                if (master.LastWriteUtc >= slave.LastWriteUtc)
                    plan.AddCopyToSlave(master, slave.FullPath);
                else
                    plan.AddCopyToMaster(slave, master.FullPath);
            }
        }

        return plan;
    }

    private static void ValidateProfile(FolderSyncProfile profile)
    {
        if (string.IsNullOrWhiteSpace(profile.MasterPath))
            throw new ArgumentException("主文件夹不能为空。");
        if (string.IsNullOrWhiteSpace(profile.SlavePath))
            throw new ArgumentException("从文件夹不能为空。");

        var master = NormalizeRoot(profile.MasterPath);
        var slave = NormalizeRoot(profile.SlavePath);

        if (!Directory.Exists(master))
            throw new DirectoryNotFoundException(BuildUnavailablePathMessage("主文件夹", master));

        ValidateMissingTargetRoot("从文件夹", slave);

        if (master.Equals(slave, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("主文件夹和从文件夹不能相同。");

        var masterPrefix = master + Path.DirectorySeparatorChar;
        var slavePrefix = slave + Path.DirectorySeparatorChar;
        if (slave.StartsWith(masterPrefix, StringComparison.OrdinalIgnoreCase) ||
            master.StartsWith(slavePrefix, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("主文件夹和从文件夹不能互为父子目录，避免递归同步。");
        }
    }

    private static string NormalizeRoot(string path) =>
        Path.GetFullPath(Environment.ExpandEnvironmentVariables(path.Trim()))
            .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);

    private static void ValidateMissingTargetRoot(string label, string path)
    {
        if (Directory.Exists(path))
            return;

        var root = Path.GetPathRoot(path);
        if (string.IsNullOrWhiteSpace(root) || Directory.Exists(root))
            return;

        throw new DirectoryNotFoundException(BuildUnavailablePathMessage(label, path));
    }

    private static string BuildUnavailablePathMessage(string label, string path)
    {
        if (path.StartsWith(@"\\", StringComparison.Ordinal))
            return $"{label}不可访问：{path}。请确认局域网共享盘在线、VPN/网络连接正常，并且当前账号有访问权限。";

        return $"{label}不存在或不可访问：{path}";
    }

    private static Dictionary<string, SyncFile> SnapshotDirectory(string root, IReadOnlyList<string> excludePatterns)
    {
        var result = new Dictionary<string, SyncFile>(StringComparer.OrdinalIgnoreCase);
        if (!Directory.Exists(root))
            return result;

        var pending = new Stack<string>();
        pending.Push(root);

        while (pending.Count > 0)
        {
            var dir = pending.Pop();
            IEnumerable<string> childDirs;
            IEnumerable<string> files;

            try
            {
                childDirs = Directory.EnumerateDirectories(dir).ToList();
                files = Directory.EnumerateFiles(dir).ToList();
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                continue;
            }

            foreach (var childDir in childDirs)
            {
                if (string.Equals(Path.GetFileName(childDir), ".DanceMonkeySyncTrash", StringComparison.OrdinalIgnoreCase))
                    continue;
                var relativeDir = Path.GetRelativePath(root, childDir);
                if (IsExcluded(relativeDir, excludePatterns))
                    continue;
                pending.Push(childDir);
            }

            foreach (var file in files)
            {
                var relativePath = Path.GetRelativePath(root, file);
                if (IsExcluded(relativePath, excludePatterns))
                    continue;

                try
                {
                    var info = new FileInfo(file);
                    result[relativePath] = new SyncFile(
                        relativePath,
                        file,
                        info.Length,
                        info.LastWriteTimeUtc);
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or FileNotFoundException)
                {
                    continue;
                }
            }
        }

        return result;
    }

    private static IReadOnlyList<string> ParseExcludePatterns(string? value) =>
        (value ?? "")
        .Split(new[] { ';', ',', '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
        .Concat(new[] { ".DanceMonkeySyncTrash", ".DanceMonkeySyncTrash\\*" })
        .Distinct(StringComparer.OrdinalIgnoreCase)
        .ToList();

    private static bool IsExcluded(string relativePath, IReadOnlyList<string> patterns)
    {
        var normalized = relativePath.Replace('/', '\\');
        var fileName = Path.GetFileName(normalized);
        return patterns.Any(pattern => WildcardMatch(normalized, pattern) || WildcardMatch(fileName, pattern));
    }

    private static bool WildcardMatch(string value, string pattern)
    {
        var regex = "^" + Regex.Escape(pattern.Replace('/', '\\'))
            .Replace("\\*", ".*")
            .Replace("\\?", ".") + "$";
        return Regex.IsMatch(value, regex, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    }

    private static bool FilesMatch(SyncFile left, SyncFile right) =>
        left.Length == right.Length &&
        Math.Abs((left.LastWriteUtc - right.LastWriteUtc).TotalSeconds) < 2;

    private static bool SameAsSnapshot(SyncFile current, SyncSideState? previous) =>
        previous != null &&
        current.Length == previous.Length &&
        current.LastWriteUtc.Ticks == previous.LastWriteUtcTicks;

    private static void CopyFile(string sourcePath, string targetPath)
        => RunWithRetry(() => CopyFileCore(sourcePath, targetPath));

    private static void CopyFileCore(string sourcePath, string targetPath)
    {
        var targetDir = Path.GetDirectoryName(targetPath);
        if (!string.IsNullOrWhiteSpace(targetDir))
            Directory.CreateDirectory(targetDir);

        var tempPath = targetPath + ".dancemonkey.tmp";
        File.Copy(sourcePath, tempPath, overwrite: true);
        File.SetLastWriteTimeUtc(tempPath, File.GetLastWriteTimeUtc(sourcePath));
        File.Move(tempPath, targetPath, overwrite: true);
    }

    private static void MoveToTrash(string slaveRoot, string targetPath)
        => RunWithRetry(() => MoveToTrashCore(slaveRoot, targetPath));

    private static void MoveToTrashCore(string slaveRoot, string targetPath)
    {
        if (!File.Exists(targetPath))
            return;

        var relative = Path.GetRelativePath(slaveRoot, targetPath);
        var trashPath = Path.Combine(slaveRoot, ".DanceMonkeySyncTrash", DateTime.Now.ToString("yyyyMMdd-HHmmss"), relative);
        var trashDir = Path.GetDirectoryName(trashPath);
        if (!string.IsNullOrWhiteSpace(trashDir))
            Directory.CreateDirectory(trashDir);

        File.Move(targetPath, trashPath, overwrite: true);
    }

    private static void RunWithRetry(Action operation)
    {
        IOException? last = null;
        for (var attempt = 1; attempt <= 3; attempt++)
        {
            try
            {
                operation();
                return;
            }
            catch (IOException ex) when (attempt < 3)
            {
                last = ex;
                Thread.Sleep(200 * attempt);
            }
        }

        if (last != null)
            throw last;

        operation();
    }

    private static void CleanupOldTrash(string slaveRoot, int retentionDays)
    {
        var days = Math.Clamp(retentionDays, 1, 3650);
        var trashRoot = Path.Combine(slaveRoot, ".DanceMonkeySyncTrash");
        if (!Directory.Exists(trashRoot))
            return;

        var cutoff = DateTime.Now.AddDays(-days);
        foreach (var dir in Directory.EnumerateDirectories(trashRoot))
        {
            var name = Path.GetFileName(dir);
            var time = DateTime.TryParseExact(
                name,
                "yyyyMMdd-HHmmss",
                null,
                System.Globalization.DateTimeStyles.None,
                out var parsed)
                ? parsed
                : Directory.GetCreationTime(dir);

            if (time < cutoff)
                Directory.Delete(dir, recursive: true);
        }
    }

    private static string BuildConflictPath(string originalPath)
    {
        var dir = Path.GetDirectoryName(originalPath) ?? "";
        var fileName = Path.GetFileNameWithoutExtension(originalPath);
        var ext = Path.GetExtension(originalPath);
        var suffix = $".conflict-{Environment.MachineName}-{DateTime.Now:yyyyMMdd-HHmmss}";
        return Path.Combine(dir, $"{fileName}{suffix}{ext}");
    }

    private FolderSyncState LoadState(FolderSyncProfile profile)
    {
        var path = GetStatePath(profile);
        if (!File.Exists(path))
            return new FolderSyncState();

        try
        {
            return JsonSerializer.Deserialize<FolderSyncState>(File.ReadAllText(path), JsonOptions)
                   ?? new FolderSyncState();
        }
        catch (JsonException)
        {
            return new FolderSyncState();
        }
        catch (IOException)
        {
            return new FolderSyncState();
        }
    }

    private void SaveState(FolderSyncProfile profile, string masterRoot, string slaveRoot, IReadOnlyList<string> excludePatterns)
    {
        var masterFiles = SnapshotDirectory(masterRoot, excludePatterns);
        var slaveFiles = SnapshotDirectory(slaveRoot, excludePatterns);
        var state = new FolderSyncState();
        var keys = new HashSet<string>(masterFiles.Keys, StringComparer.OrdinalIgnoreCase);
        keys.UnionWith(slaveFiles.Keys);

        foreach (var key in keys)
        {
            masterFiles.TryGetValue(key, out var master);
            slaveFiles.TryGetValue(key, out var slave);
            state.Files[key] = new SyncFileState
            {
                Master = master == null ? null : SyncSideState.From(master),
                Slave = slave == null ? null : SyncSideState.From(slave)
            };
        }

        File.WriteAllText(GetStatePath(profile), JsonSerializer.Serialize(state, JsonOptions));
    }

    private string GetStatePath(FolderSyncProfile profile)
    {
        var id = string.IsNullOrWhiteSpace(profile.Id) ? "default" : profile.Id;
        var safe = Regex.Replace(id, "[^a-zA-Z0-9_-]", "_");
        return Path.Combine(_stateRoot, safe + ".json");
    }

    private sealed record SyncFile(string RelativePath, string FullPath, long Length, DateTime LastWriteUtc);

    private enum SyncOperationKind
    {
        CopyToSlave,
        CopyToMaster,
        DeleteFromSlave,
        PreserveSlaveConflictThenCopyMaster,
        Skip
    }

    private sealed record SyncOperation(
        SyncOperationKind Kind,
        string RelativePath,
        string SourcePath,
        string TargetPath,
        long Bytes,
        string Reason,
        bool IsConflict = false);

    private sealed class SyncPlan(string masterRoot, string slaveRoot, IReadOnlyList<string> excludePatterns)
    {
        public string MasterRoot { get; } = masterRoot;
        public string SlaveRoot { get; } = slaveRoot;
        public IReadOnlyList<string> ExcludePatterns { get; } = excludePatterns;
        public List<SyncOperation> Operations { get; } = new();

        public void AddCopyToSlave(
            SyncFile source,
            string targetPath,
            string reason = "主文件夹较新或新增，复制到从文件夹",
            bool isConflict = false) =>
            Operations.Add(new SyncOperation(SyncOperationKind.CopyToSlave, source.RelativePath, source.FullPath, targetPath, source.Length, reason, isConflict));

        public void AddCopyToMaster(
            SyncFile source,
            string targetPath,
            string reason = "从文件夹较新或新增，复制到主文件夹",
            bool isConflict = false) =>
            Operations.Add(new SyncOperation(SyncOperationKind.CopyToMaster, source.RelativePath, source.FullPath, targetPath, source.Length, reason, isConflict));

        public void AddDeleteFromSlave(SyncFile target) =>
            Operations.Add(new SyncOperation(SyncOperationKind.DeleteFromSlave, target.RelativePath, "", target.FullPath, 0, "从文件夹多余文件将移动到同步回收目录"));

        public void AddConflict(SyncFile master, SyncFile slave, string? policy)
        {
            switch (policy)
            {
                case FolderSyncConflictPolicies.PreferMaster:
                    AddCopyToSlave(master, slave.FullPath, "主从两端都修改，按策略使用主文件夹版本覆盖从文件夹。", isConflict: true);
                    break;
                case FolderSyncConflictPolicies.PreferSlave:
                    AddCopyToMaster(slave, master.FullPath, "主从两端都修改，按策略使用从文件夹版本覆盖主文件夹。", isConflict: true);
                    break;
                case FolderSyncConflictPolicies.Skip:
                    Operations.Add(new SyncOperation(SyncOperationKind.Skip, master.RelativePath, "", "", 0, "主从两端都修改，按策略跳过该冲突文件。", IsConflict: true));
                    break;
                default:
                    Operations.Add(new SyncOperation(SyncOperationKind.PreserveSlaveConflictThenCopyMaster, master.RelativePath, master.FullPath, slave.FullPath, master.Length + slave.Length, "主从两端都修改，保留从文件夹冲突副本后复制主文件夹版本。", IsConflict: true));
                    break;
            }
        }

        public void AddSkip(string relativePath, string reason) =>
            Operations.Add(new SyncOperation(SyncOperationKind.Skip, relativePath, "", "", 0, reason));

        public FolderSyncPreview ToPreview()
        {
            var preview = new FolderSyncPreview();
            foreach (var operation in Operations)
            {
                preview.TotalBytes += operation.Bytes;
                preview.Items.Add(ToPreviewItem(operation));
                if (operation.IsConflict)
                    preview.ConflictCount++;

                switch (operation.Kind)
                {
                    case SyncOperationKind.CopyToSlave:
                        preview.CopyToSlaveCount++;
                        break;
                    case SyncOperationKind.CopyToMaster:
                        preview.CopyToMasterCount++;
                        break;
                    case SyncOperationKind.DeleteFromSlave:
                        preview.DeleteFromSlaveCount++;
                        break;
                    case SyncOperationKind.PreserveSlaveConflictThenCopyMaster:
                        preview.CopyToSlaveCount++;
                        break;
                    case SyncOperationKind.Skip:
                        preview.Messages.Add($"{operation.RelativePath}: {operation.Reason}");
                        break;
                }
            }
            return preview;
        }
    }

    private static FolderSyncPreviewItem ToPreviewItem(SyncOperation operation) => new()
    {
        Operation = GetOperationDisplayName(operation),
        RelativePath = operation.RelativePath,
        SourcePath = operation.SourcePath,
        TargetPath = operation.TargetPath,
        Bytes = operation.Bytes,
        Reason = operation.Reason,
        IsConflict = operation.IsConflict
    };

    private static string GetOperationDisplayName(SyncOperation operation) =>
        operation.Kind switch
        {
            SyncOperationKind.CopyToSlave => operation.IsConflict ? "冲突：主覆盖从" : "主→从复制",
            SyncOperationKind.CopyToMaster => operation.IsConflict ? "冲突：从覆盖主" : "从→主复制",
            SyncOperationKind.DeleteFromSlave => "删除从端",
            SyncOperationKind.PreserveSlaveConflictThenCopyMaster => "冲突：保留副本",
            SyncOperationKind.Skip => operation.IsConflict ? "冲突：跳过" : "跳过",
            _ => operation.Kind.ToString()
        };

    private sealed class FolderSyncState
    {
        public Dictionary<string, SyncFileState> Files { get; set; } = new(StringComparer.OrdinalIgnoreCase);
    }

    private sealed class SyncFileState
    {
        public SyncSideState? Master { get; set; }
        public SyncSideState? Slave { get; set; }
    }

    private sealed class SyncSideState
    {
        public long Length { get; set; }
        public long LastWriteUtcTicks { get; set; }

        public static SyncSideState From(SyncFile file) => new()
        {
            Length = file.Length,
            LastWriteUtcTicks = file.LastWriteUtc.Ticks
        };
    }
}
