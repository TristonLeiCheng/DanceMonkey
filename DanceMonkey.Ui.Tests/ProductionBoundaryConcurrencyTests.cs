using System.Collections.Concurrent;
using System.Text.Json;
using DesktopAssistant.Models;
using DesktopAssistant.Services;
using Xunit;

namespace DanceMonkey.Ui.Tests;

public sealed class ProductionBoundaryConcurrencyTests : IDisposable
{
    private readonly string _directory = Path.Combine(
        Path.GetTempPath(),
        $"DanceMonkey.ProductionBoundaryConcurrencyTests.{Guid.NewGuid():N}");

    public ProductionBoundaryConcurrencyTests()
    {
        Directory.CreateDirectory(_directory);
    }

    [Fact]
    public async Task ReminderStore_snapshots_are_deeply_detached_during_parallel_loads_and_mutations()
    {
        var path = Path.Combine(_directory, "reminders.json");
        var store = new ReminderStore(path);
        var config = ConfigService.DefaultConfig();
        store.EnsureLoaded(config);
        store.UpsertReminder(Reminder("custom", "Original"));

        var detached = store.GetRemindersSnapshot();
        var detachedCustom = Assert.Single(detached, reminder => reminder.Id == "custom");
        detachedCustom.Title = "Changed outside store";
        detachedCustom.Schedule.Times!.Add("23:59");

        var fresh = Assert.Single(store.GetRemindersSnapshot(), reminder => reminder.Id == "custom");
        Assert.Equal("Original", fresh.Title);
        Assert.Equal(["09:00"], fresh.Schedule.Times);

        var failures = new ConcurrentQueue<Exception>();
        var writers = Task.Run(() =>
        {
            for (var index = 0; index < 100; index++)
            {
                try
                {
                    store.UpsertReminder(Reminder($"custom-{index % 8}", $"Title {index}"));
                }
                catch (Exception exception)
                {
                    failures.Enqueue(exception);
                }
            }
        });
        var reloaders = Task.Run(() =>
        {
            for (var index = 0; index < 100; index++)
            {
                try
                {
                    store.EnsureLoaded(config);
                }
                catch (Exception exception)
                {
                    failures.Enqueue(exception);
                }
            }
        });
        var readers = Enumerable.Range(0, 2).Select(readerIndex => Task.Run(() =>
        {
            for (var index = 0; index < 200; index++)
            {
                try
                {
                    foreach (var reminder in store.GetRemindersSnapshot())
                    {
                        _ = reminder.Id.Length;
                        _ = reminder.Schedule.Kind.ToString();
                    }
                }
                catch (Exception exception)
                {
                    failures.Enqueue(exception);
                }
            }
        }));

        await Task.WhenAll(readers.Append(writers).Append(reloaders));

        Assert.Empty(failures);
    }

    [Fact]
    public async Task ConfigService_parallel_loads_and_saves_keep_complete_json_and_clean_temp_files()
    {
        var path = Path.Combine(_directory, "config.json");
        var service = new ConfigService(path);
        Assert.True(service.Save(Config("initial-root")));
        var failures = new ConcurrentQueue<Exception>();

        var writer = Task.Run(() =>
        {
            for (var index = 0; index < 120; index++)
            {
                try
                {
                    Assert.True(service.Save(Config($"root-{index:D3}")));
                }
                catch (Exception exception)
                {
                    failures.Enqueue(exception);
                }
            }
        });
        var readers = Enumerable.Range(0, 3).Select(readerIndex => Task.Run(() =>
        {
            for (var index = 0; index < 240; index++)
            {
                try
                {
                    var loaded = service.Load();
                    Assert.Matches("^(initial-root|root-[0-9]{3})$", loaded.NotesRootPath);
                }
                catch (Exception exception)
                {
                    failures.Enqueue(exception);
                }
            }
        }));

        await Task.WhenAll(readers.Append(writer));

        Assert.Empty(failures);
        using var document = JsonDocument.Parse(File.ReadAllText(path));
        Assert.True(document.RootElement.TryGetProperty("notesRootPath", out _));
        Assert.Empty(Directory.EnumerateFiles(_directory, ".config.json.*.tmp"));
    }

    public void Dispose()
    {
        if (Directory.Exists(_directory))
            Directory.Delete(_directory, recursive: true);
    }

    private static ReminderDefinition Reminder(string id, string title) =>
        new()
        {
            Id = id,
            Title = title,
            Schedule = new ReminderSchedule
            {
                Kind = ReminderRepeatKind.Daily,
                Times = ["09:00"]
            }
        };

    private static AppConfig Config(string root)
    {
        var config = ConfigService.DefaultConfig();
        config.NotesRootPath = root;
        return config;
    }
}
