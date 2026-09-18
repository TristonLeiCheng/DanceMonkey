using System.Text.Json;
using DesktopAssistant.Services;
using Xunit;

namespace DanceMonkey.Ui.Tests;

public sealed class ZenTaskStoreDashboardTests : IDisposable
{
    private readonly string _notesRoot = Path.Combine(
        Path.GetTempPath(),
        "DanceMonkey.Ui.Tests",
        Guid.NewGuid().ToString("N"));

    [Fact]
    public void SaveTasks_and_LoadTasks_preserve_dashboard_dates_in_envelope_json()
    {
        var store = new ZenTaskStore(_notesRoot);
        var start = new DateTime(2026, 7, 24, 9, 30, 0);
        var end = new DateTime(2026, 7, 24, 10, 45, 0);
        var completed = new DateTime(2026, 7, 24, 11, 0, 0);
        var task = Task("task-1");
        task.StartDate = start;
        task.EndDate = end;
        task.CompletedAt = completed;

        store.SaveTasks([task]);

        using var json = JsonDocument.Parse(File.ReadAllText(store.TaskFilePath));
        Assert.Equal(2, json.RootElement.GetProperty("SchemaVersion").GetInt32());
        Assert.Single(json.RootElement.GetProperty("Items").EnumerateArray());

        var loaded = Assert.Single(store.LoadTasks());
        Assert.Equal(start, loaded.StartDate);
        Assert.Equal(end, loaded.EndDate);
        Assert.Equal(completed, loaded.CompletedAt);
    }

    [Fact]
    public void SetCompletion_marks_task_completed_with_timestamp_and_audit_entry()
    {
        var store = StoreWith(Task("task-1"));
        var now = new DateTime(2026, 7, 24, 12, 34, 0);

        var changed = store.SetCompletion("task-1", true, now);

        Assert.True(changed);
        var task = Assert.Single(store.LoadTasks());
        Assert.Equal("Completed", task.WorkflowStatus);
        Assert.Equal(now, task.CompletedAt);
        Assert.Equal(now, task.UpdatedAt);
        Assert.Contains($"{now:yyyy-MM-dd HH:mm} status -> Completed", task.AuditTrail);
    }

    [Fact]
    public void SetCompletion_reopens_task_and_appends_audit_without_losing_history()
    {
        var store = StoreWith(Task("task-1"));
        var completedAt = new DateTime(2026, 7, 24, 12, 34, 0);
        var reopenedAt = completedAt.AddHours(1);
        Assert.True(store.SetCompletion("task-1", true, completedAt));

        var changed = store.SetCompletion("task-1", false, reopenedAt);

        Assert.True(changed);
        var task = Assert.Single(store.LoadTasks());
        Assert.Equal("Todo", task.WorkflowStatus);
        Assert.Null(task.CompletedAt);
        Assert.Equal(reopenedAt, task.UpdatedAt);
        Assert.Equal(
            [
                "existing audit",
                $"{completedAt:yyyy-MM-dd HH:mm} status -> Completed",
                $"{reopenedAt:yyyy-MM-dd HH:mm} status -> Todo"
            ],
            task.AuditTrail);
    }

    [Fact]
    public void SetCompletion_for_unknown_id_returns_false_without_rewriting_task_json()
    {
        var store = StoreWith(Task("task-1"));
        var before = File.ReadAllText(store.TaskFilePath);

        var changed = store.SetCompletion("missing", true, new DateTime(2026, 7, 24, 12, 34, 0));

        Assert.False(changed);
        Assert.Equal(before, File.ReadAllText(store.TaskFilePath));
    }

    [Fact]
    public void SetCompletion_matches_ids_case_insensitively_and_initializes_null_legacy_audit()
    {
        var store = new ZenTaskStore(_notesRoot);
        Directory.CreateDirectory(Path.GetDirectoryName(store.TaskFilePath)!);
        File.WriteAllText(
            store.TaskFilePath,
            """
            {
              "SchemaVersion": 2,
              "Items": [
                {
                  "Id": "Task-ONE",
                  "Title": "Legacy task",
                  "WorkflowStatus": "Todo",
                  "AuditTrail": null
                }
              ]
            }
            """);
        var now = new DateTime(2026, 7, 24, 12, 34, 0);

        var changed = store.SetCompletion("task-one", true, now);

        Assert.True(changed);
        var task = Assert.Single(store.LoadTasks());
        Assert.Equal("Completed", task.WorkflowStatus);
        Assert.Equal([$"{now:yyyy-MM-dd HH:mm} status -> Completed"], task.AuditTrail);
    }

    [Fact]
    public void SetCompletion_preserves_todo_and_unknown_task_and_envelope_properties()
    {
        var store = new ZenTaskStore(_notesRoot);
        Directory.CreateDirectory(Path.GetDirectoryName(store.TaskFilePath)!);
        File.WriteAllText(
            store.TaskFilePath,
            """
            {
              "SchemaVersion": 2,
              "WriterMetadata": {
                "source": "todo",
                "generation": 7
              },
              "Items": [
                {
                  "Id": "task-1",
                  "Title": "Rich task",
                  "WorkflowStatus": "Todo",
                  "Checklist": [
                    {
                      "Id": "check-1",
                      "Text": "Preserve me",
                      "Done": false
                    }
                  ],
                  "Objective": "Keep customer context",
                  "KeyResult": "Ship safely",
                  "UnknownNested": {
                    "levels": [
                      {
                        "value": 42
                      }
                    ],
                    "enabled": true
                  },
                  "AuditTrail": [
                    "existing audit"
                  ]
                }
              ]
            }
            """);

        Assert.True(store.SetCompletion("task-1", true, new DateTime(2026, 7, 24, 12, 34, 0)));

        using var json = JsonDocument.Parse(File.ReadAllText(store.TaskFilePath));
        var root = json.RootElement;
        Assert.Equal("todo", root.GetProperty("WriterMetadata").GetProperty("source").GetString());
        Assert.Equal(7, root.GetProperty("WriterMetadata").GetProperty("generation").GetInt32());
        var task = root.GetProperty("Items")[0];
        Assert.Equal("Preserve me", task.GetProperty("Checklist")[0].GetProperty("Text").GetString());
        Assert.False(task.GetProperty("Checklist")[0].GetProperty("Done").GetBoolean());
        Assert.Equal("Keep customer context", task.GetProperty("Objective").GetString());
        Assert.Equal("Ship safely", task.GetProperty("KeyResult").GetString());
        Assert.Equal(42, task.GetProperty("UnknownNested").GetProperty("levels")[0].GetProperty("value").GetInt32());
        Assert.True(task.GetProperty("UnknownNested").GetProperty("enabled").GetBoolean());
    }

    [Fact]
    public async Task Concurrent_SetCompletion_calls_for_distinct_tasks_both_survive()
    {
        var store = new ZenTaskStore(_notesRoot);

        for (var iteration = 0; iteration < 40; iteration++)
        {
            store.SaveTasks([Task("task-1"), Task("task-2")]);
            using var start = new ManualResetEventSlim(false);
            var first = System.Threading.Tasks.Task.Run(() =>
            {
                start.Wait();
                return store.SetCompletion("task-1", true, new DateTime(2026, 7, 24, 12, 34, 0));
            });
            var second = System.Threading.Tasks.Task.Run(() =>
            {
                start.Wait();
                return store.SetCompletion("task-2", true, new DateTime(2026, 7, 24, 12, 35, 0));
            });

            start.Set();
            var results = await System.Threading.Tasks.Task.WhenAll(first, second);
            Assert.All(results, Assert.True);

            using var json = JsonDocument.Parse(File.ReadAllText(store.TaskFilePath));
            Assert.Equal(JsonValueKind.Object, json.RootElement.ValueKind);
            var tasks = store.LoadTasks().ToDictionary(task => task.Id);
            Assert.Equal("Completed", tasks["task-1"].WorkflowStatus);
            Assert.Equal("Completed", tasks["task-2"].WorkflowStatus);
        }

        Assert.Empty(Directory.GetFiles(Path.GetDirectoryName(store.TaskFilePath)!, "*.tmp"));
    }

    [Fact]
    public void LoadTasks_reads_legacy_bare_array()
    {
        var store = new ZenTaskStore(_notesRoot);
        Directory.CreateDirectory(Path.GetDirectoryName(store.TaskFilePath)!);
        File.WriteAllText(
            store.TaskFilePath,
            """
            [
              {
                "Id": "task-1",
                "Title": "Legacy array task",
                "WorkflowStatus": "Todo",
                "AuditTrail": []
              }
            ]
            """);

        var task = Assert.Single(store.LoadTasks());

        Assert.Equal("task-1", task.Id);
        Assert.Equal("Legacy array task", task.Title);
    }

    [Fact]
    public void LoadTasks_throws_for_malformed_json_without_rewriting_it()
    {
        var store = new ZenTaskStore(_notesRoot);
        Directory.CreateDirectory(Path.GetDirectoryName(store.TaskFilePath)!);
        const string malformed = """{ "SchemaVersion": 2, "Items": [ """;
        File.WriteAllText(store.TaskFilePath, malformed);

        Assert.ThrowsAny<JsonException>(() => store.LoadTasks());

        Assert.Equal(malformed, File.ReadAllText(store.TaskFilePath));
    }

    public void Dispose()
    {
        if (Directory.Exists(_notesRoot))
            Directory.Delete(_notesRoot, recursive: true);
    }

    private ZenTaskStore StoreWith(ZenTaskRecord task)
    {
        var store = new ZenTaskStore(_notesRoot);
        store.SaveTasks([task]);
        return store;
    }

    private static ZenTaskRecord Task(string id) =>
        new()
        {
            Id = id,
            Title = "Dashboard task",
            WorkflowStatus = "Todo",
            CreatedAt = new DateTime(2026, 7, 24, 8, 0, 0),
            UpdatedAt = new DateTime(2026, 7, 24, 8, 0, 0),
            AuditTrail = ["existing audit"]
        };
}
