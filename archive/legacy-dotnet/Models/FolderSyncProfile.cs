using System.Text.Json.Serialization;

namespace DesktopAssistant.Models;

public static class FolderSyncModes
{
    public const string MasterToSlave = "masterToSlave";
    public const string TwoWay = "twoWay";
}

public static class FolderSyncConflictPolicies
{
    public const string KeepConflictCopy = "keepConflictCopy";
    public const string PreferMaster = "preferMaster";
    public const string PreferSlave = "preferSlave";
    public const string Skip = "skip";
}

public sealed class FolderSyncProfile
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    [JsonPropertyName("masterPath")]
    public string MasterPath { get; set; } = "";

    [JsonPropertyName("slavePath")]
    public string SlavePath { get; set; } = "";

    [JsonPropertyName("mode")]
    public string Mode { get; set; } = FolderSyncModes.MasterToSlave;

    [JsonPropertyName("enabled")]
    public bool Enabled { get; set; } = true;

    [JsonPropertyName("deleteExtraFiles")]
    public bool DeleteExtraFiles { get; set; }

    [JsonPropertyName("trashRetentionDays")]
    public int TrashRetentionDays { get; set; } = 30;

    [JsonPropertyName("conflictPolicy")]
    public string ConflictPolicy { get; set; } = FolderSyncConflictPolicies.KeepConflictCopy;

    [JsonPropertyName("autoSyncEnabled")]
    public bool AutoSyncEnabled { get; set; }

    [JsonPropertyName("autoSyncIntervalMinutes")]
    public int AutoSyncIntervalMinutes { get; set; } = 30;

    [JsonPropertyName("excludePatterns")]
    public string ExcludePatterns { get; set; } = "*.tmp;~$*;.DS_Store;Thumbs.db";

    [JsonPropertyName("lastRunAt")]
    public DateTime? LastRunAt { get; set; }

    [JsonPropertyName("lastStatus")]
    public string LastStatus { get; set; } = "";

    [JsonIgnore]
    public string ModeDisplayName => Mode == FolderSyncModes.TwoWay ? "完全同步" : "主从单向";

    [JsonIgnore]
    public string ConflictPolicyDisplayName => ConflictPolicy switch
    {
        FolderSyncConflictPolicies.PreferMaster => "冲突时主覆盖从",
        FolderSyncConflictPolicies.PreferSlave => "冲突时从覆盖主",
        FolderSyncConflictPolicies.Skip => "冲突时跳过",
        _ => "保留冲突副本"
    };

    public FolderSyncProfile Clone() => new()
    {
        Id = Id,
        Name = Name,
        MasterPath = MasterPath,
        SlavePath = SlavePath,
        Mode = Mode,
        Enabled = Enabled,
        DeleteExtraFiles = DeleteExtraFiles,
        TrashRetentionDays = TrashRetentionDays,
        ConflictPolicy = ConflictPolicy,
        AutoSyncEnabled = AutoSyncEnabled,
        AutoSyncIntervalMinutes = AutoSyncIntervalMinutes,
        ExcludePatterns = ExcludePatterns,
        LastRunAt = LastRunAt,
        LastStatus = LastStatus
    };
}

public sealed class FolderSyncPreviewItem
{
    public string Operation { get; init; } = "";
    public string RelativePath { get; init; } = "";
    public string SourcePath { get; init; } = "";
    public string TargetPath { get; init; } = "";
    public long Bytes { get; init; }
    public string Reason { get; init; } = "";
    public bool IsConflict { get; init; }

    public string SizeDisplay => FolderSyncPreview.FormatBytes(Bytes);
    public string ConflictDisplay => IsConflict ? "冲突" : "";
}

public sealed class FolderSyncPreview
{
    public int CopyToSlaveCount { get; set; }
    public int CopyToMasterCount { get; set; }
    public int DeleteFromSlaveCount { get; set; }
    public int DeleteFromMasterCount { get; set; }
    public int ConflictCount { get; set; }
    public long TotalBytes { get; set; }
    public List<FolderSyncPreviewItem> Items { get; } = new();
    public List<string> Messages { get; } = new();

    public string Summary =>
        $"主→从 {CopyToSlaveCount}，从→主 {CopyToMasterCount}，删除从端 {DeleteFromSlaveCount}，冲突 {ConflictCount}，约 {FormatBytes(TotalBytes)}";

    public static string FormatBytes(long bytes) => bytes switch
    {
        < 1024 => $"{bytes} B",
        < 1024 * 1024 => $"{bytes / 1024.0:F1} KB",
        < 1024L * 1024 * 1024 => $"{bytes / (1024.0 * 1024):F1} MB",
        _ => $"{bytes / (1024.0 * 1024 * 1024):F1} GB"
    };
}

public sealed class FolderSyncProgress
{
    public int TotalOperations { get; init; }
    public int CompletedOperations { get; init; }
    public string CurrentOperation { get; init; } = "";
    public string CurrentPath { get; init; } = "";
    public string StatusText { get; init; } = "";
    public bool IsCompleted { get; init; }
    public bool IsCancelled { get; init; }

    public double Percent => TotalOperations <= 0 ? 0 : CompletedOperations * 100.0 / TotalOperations;
}

public sealed class FolderSyncRunResult
{
    public FolderSyncPreview Preview { get; init; } = new();
    public int CopiedCount { get; set; }
    public int DeletedCount { get; set; }
    public int SkippedCount { get; set; }
    public int ErrorCount { get; set; }
    public bool Cancelled { get; set; }
    public List<string> Errors { get; } = new();

    public string Summary =>
        $"{(Cancelled ? "已取消" : "完成")}：复制 {CopiedCount}，删除 {DeletedCount}，跳过 {SkippedCount}，错误 {ErrorCount}";
}
