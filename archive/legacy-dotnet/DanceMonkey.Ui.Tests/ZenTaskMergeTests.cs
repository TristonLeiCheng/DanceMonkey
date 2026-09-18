using System.Text.Json;
using DesktopAssistant.Services;
using Xunit;

namespace DanceMonkey.Ui.Tests;

public sealed class ZenTaskMergeTests
{
    [Fact]
    public void Merge_preserves_remote_completion_of_A_and_local_edit_of_B()
    {
        var baseline = new[]
        {
            Task("A", "Todo", At(8), "Task A"),
            Task("B", "Todo", At(8), "Task B")
        };
        var local = Clone(baseline);
        local[1].Title = "Locally edited B";
        local[1].UpdatedAt = At(10);
        var remote = Clone(baseline);
        remote[0].WorkflowStatus = "Completed";
        remote[0].CompletedAt = At(9);
        remote[0].UpdatedAt = At(9);

        var merged = Merge(baseline, local, remote).ToDictionary(task => task.Id);

        Assert.Equal("Completed", merged["A"].WorkflowStatus);
        Assert.Equal(At(9), merged["A"].CompletedAt);
        Assert.Equal("Locally edited B", merged["B"].Title);
        Assert.Equal(At(10), merged["B"].UpdatedAt);
    }

    [Fact]
    public void Merge_same_task_conflict_prefers_later_updated_time_and_local_on_exact_tie()
    {
        var baseline = new[] { Task("A", "Todo", At(8), "Baseline") };
        var localOlder = new[] { Task("A", "Todo", At(9), "Local older") };
        var remoteNewer = new[] { Task("A", "Completed", At(10), "Remote newer") };

        var newerResult = Assert.Single(Merge(baseline, localOlder, remoteNewer));

        Assert.Equal("Remote newer", newerResult.Title);

        var localTie = new[] { Task("A", "Todo", At(10), "Local tie") };
        var tieResult = Assert.Single(Merge(baseline, localTie, remoteNewer));

        Assert.Equal("Local tie", tieResult.Title);
    }

    [Fact]
    public void Merge_handles_deletions_and_changes_without_silent_data_loss()
    {
        var baseline = new[] { Task("A", "Todo", At(8), "Baseline") };

        Assert.Empty(Merge(baseline, [], Clone(baseline)));
        Assert.Empty(Merge(baseline, Clone(baseline), []));

        var remoteChanged = new[] { Task("A", "Completed", At(10), "Remote changed") };
        var remoteChangeResult = Assert.Single(Merge(baseline, [], remoteChanged));
        Assert.Equal("Remote changed", remoteChangeResult.Title);

        var localChanged = new[] { Task("A", "Todo", At(10), "Local changed") };
        var localChangeResult = Assert.Single(Merge(baseline, localChanged, []));
        Assert.Equal("Local changed", localChangeResult.Title);
    }

    [Fact]
    public void MergeIntoLatestEnvelope_preserves_extension_metadata()
    {
        var latest = ZenTaskFileFormat.Deserialize<ZenTaskRecord>(
            """
            {
              "SchemaVersion": 2,
              "WriterMetadata": {
                "source": "dashboard",
                "generation": 12
              },
              "Items": [
                {
                  "Id": "A",
                  "Title": "Task A",
                  "WorkflowStatus": "Completed",
                  "UpdatedAt": "2026-07-24T09:00:00",
                  "AuditTrail": []
                }
              ]
            }
            """,
            Options,
            defaultSchemaVersion: 2);
        var baseline = new[] { Task("A", "Todo", At(8), "Task A"), Task("B", "Todo", At(8), "Task B") };
        var local = Clone(baseline);
        local[1].Title = "Edited B";
        local[1].UpdatedAt = At(10);

        ZenTaskMergeHelper.MergeIntoLatestEnvelope(
            latest,
            baseline,
            local,
            task => task.Id,
            task => task.UpdatedAt,
            Equivalent);
        var saved = ZenTaskFileFormat.Serialize(latest, Options);

        using var json = JsonDocument.Parse(saved);
        var metadata = json.RootElement.GetProperty("WriterMetadata");
        Assert.Equal("dashboard", metadata.GetProperty("source").GetString());
        Assert.Equal(12, metadata.GetProperty("generation").GetInt32());
        Assert.Equal(2, json.RootElement.GetProperty("Items").GetArrayLength());
    }

    [Fact]
    public void Shared_parser_reads_legacy_bare_array_for_TodoView()
    {
        var envelope = ZenTaskFileFormat.Deserialize<ZenTaskRecord>(
            """
            [
              {
                "Id": "legacy",
                "Title": "Legacy bare-array task",
                "WorkflowStatus": "Todo",
                "AuditTrail": []
              }
            ]
            """,
            Options,
            defaultSchemaVersion: 1);

        Assert.Equal(1, envelope.SchemaVersion);
        Assert.Equal("legacy", Assert.Single(envelope.Items).Id);
    }

    [Fact]
    public void Shared_parser_defaults_missing_or_nonpositive_object_schema_and_preserves_metadata()
    {
        var missing = ZenTaskFileFormat.Deserialize<ZenTaskRecord>(
            """
            {
              "WriterMetadata": {
                "source": "legacy"
              },
              "Items": []
            }
            """,
            Options,
            defaultSchemaVersion: 2);
        var explicitZero = ZenTaskFileFormat.Deserialize<ZenTaskRecord>(
            """
            {
              "SchemaVersion": 0,
              "Items": []
            }
            """,
            Options,
            defaultSchemaVersion: 2);
        var explicitPositive = ZenTaskFileFormat.Deserialize<ZenTaskRecord>(
            """
            {
              "SchemaVersion": 7,
              "Items": []
            }
            """,
            Options,
            defaultSchemaVersion: 2);

        Assert.Equal(2, missing.SchemaVersion);
        Assert.Equal(2, explicitZero.SchemaVersion);
        Assert.Equal(7, explicitPositive.SchemaVersion);
        using var saved = JsonDocument.Parse(ZenTaskFileFormat.Serialize(missing, Options));
        Assert.Equal(
            "legacy",
            saved.RootElement.GetProperty("WriterMetadata").GetProperty("source").GetString());
    }

    private static readonly JsonSerializerOptions Options = new()
    {
        PropertyNameCaseInsensitive = true,
        WriteIndented = true
    };

    private static IReadOnlyList<ZenTaskRecord> Merge(
        IReadOnlyList<ZenTaskRecord> baseline,
        IReadOnlyList<ZenTaskRecord> local,
        IReadOnlyList<ZenTaskRecord> remote) =>
        ZenTaskMergeHelper.Merge(
            baseline,
            local,
            remote,
            task => task.Id,
            task => task.UpdatedAt,
            Equivalent);

    private static bool Equivalent(ZenTaskRecord left, ZenTaskRecord right) =>
        JsonSerializer.Serialize(left, Options) == JsonSerializer.Serialize(right, Options);

    private static ZenTaskRecord[] Clone(IEnumerable<ZenTaskRecord> tasks) =>
        JsonSerializer.Deserialize<ZenTaskRecord[]>(
            JsonSerializer.Serialize(tasks, Options),
            Options)!;

    private static ZenTaskRecord Task(
        string id,
        string status,
        DateTime updatedAt,
        string title) =>
        new()
        {
            Id = id,
            Title = title,
            WorkflowStatus = status,
            CreatedAt = At(8),
            UpdatedAt = updatedAt,
            AuditTrail = []
        };

    private static DateTime At(int hour) => new(2026, 7, 24, hour, 0, 0);
}
