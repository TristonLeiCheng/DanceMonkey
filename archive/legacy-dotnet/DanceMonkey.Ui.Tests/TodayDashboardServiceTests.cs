using System.Text;
using DesktopAssistant.Models;
using DesktopAssistant.Services;
using Xunit;

namespace DanceMonkey.Ui.Tests;

public sealed class TodayDashboardServiceTests
{
    private static readonly DateTime Friday = new(2026, 7, 24);

    [Fact]
    public async Task LoadAsync_combines_tasks_meetings_reminders_and_notes()
    {
        var service = new TodayDashboardService(HealthyLoaders());

        var snapshot = await service.LoadAsync(At(8, 0), CancellationToken.None);

        Assert.Equal("focus", snapshot.FocusTask?.Title);
        Assert.Equal(
            ["09:30|Meeting|review", "10:00|Reminder|water", "13:30|Task|focus"],
            snapshot.Timeline.Select(item => $"{item.Time:HH:mm}|{item.Source}|{item.Title}"));
        Assert.Equal(@"C:\notes\plan.md", Assert.Single(snapshot.RecentNotes).FullPath);
        Assert.Empty(snapshot.SourceErrors);
    }

    [Theory]
    [InlineData("Tasks", "Zen Task")]
    [InlineData("Meetings", "Meetings")]
    [InlineData("Reminders", "Reminders")]
    [InlineData("Notes", "Notes")]
    public async Task LoadAsync_isolates_each_failed_source(string failedLoader, string expectedSource)
    {
        var service = new TodayDashboardService(LoadersFailing(failedLoader));

        var snapshot = await service.LoadAsync(At(8, 0), CancellationToken.None);

        var error = Assert.Single(snapshot.SourceErrors);
        Assert.Equal(expectedSource, error.Source);
        Assert.Equal(ExpectedError(expectedSource), error.Message);

        if (failedLoader != "Tasks")
            Assert.Contains(snapshot.Tasks, item => item.Id == "focus");
        if (failedLoader != "Meetings")
            Assert.Contains(snapshot.Timeline, item => item.Source == TodayTimelineSource.Meeting);
        if (failedLoader != "Reminders")
            Assert.Contains(snapshot.Timeline, item => item.Source == TodayTimelineSource.Reminder);
        if (failedLoader != "Notes")
            Assert.Contains(snapshot.RecentNotes, item => item.FullPath == @"C:\notes\plan.md");
    }

    [Fact]
    public async Task LoadAsync_reports_multiple_failures_without_losing_healthy_sources()
    {
        var healthy = HealthyLoaders();
        var service = new TodayDashboardService(
            healthy with
            {
                LoadTasks = () => throw new IOException("tasks unavailable"),
                LoadNotes = () => throw new UnauthorizedAccessException("notes unavailable")
            });

        var snapshot = await service.LoadAsync(At(8, 0), CancellationToken.None);

        Assert.Equal(
            ["Zen Task|任务数据加载失败", "Notes|笔记数据加载失败"],
            snapshot.SourceErrors.Select(error => $"{error.Source}|{error.Message}"));
        Assert.Equal(
            [TodayTimelineSource.Meeting, TodayTimelineSource.Reminder],
            snapshot.Timeline.Select(item => item.Source));
    }

    [Fact]
    public async Task LoadAsync_propagates_loader_cancellation_without_source_error()
    {
        var healthy = HealthyLoaders();
        var service = new TodayDashboardService(
            healthy with
            {
                LoadMeetings = () => throw new OperationCanceledException("cancelled by loader")
            });

        var exception = await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => service.LoadAsync(At(8, 0), CancellationToken.None));

        Assert.Equal("cancelled by loader", exception.Message);
    }

    [Fact]
    public async Task LoadAsync_honors_pre_cancelled_token_before_invoking_sources()
    {
        var invoked = false;
        var service = new TodayDashboardService(
            new TodayDashboardLoaders(
                LoadTasks: () =>
                {
                    invoked = true;
                    return Array.Empty<ZenTaskRecord>();
                },
                LoadMeetings: () => Array.Empty<MeetingRecord>(),
                LoadReminders: () => Array.Empty<ReminderDefinition>(),
                LoadNotes: () => Array.Empty<TodayNoteDocument>()));
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => service.LoadAsync(At(8, 0), cancellation.Token));

        Assert.False(invoked);
    }

    [Fact]
    public async Task LoadAsync_does_not_expose_exception_paths_in_source_errors()
    {
        var secretPath = @"C:\Users\private\salary.md";
        var service = new TodayDashboardService(
            HealthyLoaders() with
            {
                LoadNotes = () => throw new IOException($"Cannot read {secretPath}")
            });

        var snapshot = await service.LoadAsync(At(8, 0), CancellationToken.None);

        var error = Assert.Single(snapshot.SourceErrors);
        Assert.Equal("笔记数据加载失败", error.Message);
        Assert.DoesNotContain(secretPath, error.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData("Zen Task")]
    [InlineData("Meetings")]
    [InlineData("Reminders")]
    [InlineData("Notes")]
    public async Task LoadAsync_filters_null_elements_and_preserves_healthy_items(string source)
    {
        var service = new TodayDashboardService(LoadersWithNullElement(source));

        var snapshot = await service.LoadAsync(At(8, 0), CancellationToken.None);

        var error = Assert.Single(snapshot.SourceErrors);
        Assert.Equal(source, error.Source);
        Assert.Equal(ExpectedError(source), error.Message);
        Assert.Equal("focus", snapshot.FocusTask?.Title);
        Assert.Contains(snapshot.Timeline, item => item.Title == "review");
        Assert.Contains(snapshot.Timeline, item => item.Title == "water");
        Assert.Contains(snapshot.RecentNotes, item => item.FullPath == @"C:\notes\plan.md");
    }

    [Fact]
    public async Task LoaderFactory_captures_one_config_snapshot_per_load()
    {
        var currentRoot = "root-one";
        var configLoadCount = 0;
        var observedRoots = new List<string?>();
        var observationGate = new object();
        void Observe(AppConfig config)
        {
            lock (observationGate)
                observedRoots.Add(config.NotesRootPath);
        }

        var service = new TodayDashboardService(
            new TodayDashboardLoaderFactory(
                LoadConfig: () =>
                {
                    configLoadCount++;
                    return new AppConfig { NotesRootPath = currentRoot };
                },
                LoadTasks: (config, _) =>
                {
                    Observe(config);
                    return
                    [
                        new ZenTaskRecord
                        {
                            Id = config.NotesRootPath!,
                            Title = config.NotesRootPath!,
                            WorkflowStatus = "Todo",
                            CreatedAt = Day(1),
                            UpdatedAt = Day(24)
                        }
                    ];
                },
                LoadMeetings: (config, _) =>
                {
                    Observe(config);
                    return Array.Empty<MeetingRecord>();
                },
                LoadReminders: (config, _) =>
                {
                    Observe(config);
                    return Array.Empty<ReminderDefinition>();
                },
                LoadNotes: (config, _) =>
                {
                    Observe(config);
                    return Array.Empty<TodayNoteDocument>();
                }));

        var first = await service.LoadAsync(At(8, 0), CancellationToken.None);
        currentRoot = "root-two";
        var second = await service.LoadAsync(At(9, 0), CancellationToken.None);

        Assert.Equal(2, configLoadCount);
        Assert.Equal("root-one", first.FocusTask?.Title);
        Assert.Equal("root-two", second.FocusTask?.Title);
        Assert.Equal(
            ["root-one", "root-one", "root-one", "root-one",
             "root-two", "root-two", "root-two", "root-two"],
            observedRoots);
    }

    [Fact]
    public async Task SetTaskCompletionAsync_delegates_exact_arguments_and_returns_result()
    {
        string? actualId = null;
        bool? actualCompleted = null;
        DateTime? actualNow = null;
        var expectedNow = At(11, 42);
        var service = new TodayDashboardService(
            HealthyLoaders() with
            {
                SetTaskCompletion = (id, completed, now) =>
                {
                    actualId = id;
                    actualCompleted = completed;
                    actualNow = now;
                    return true;
                }
            });

        var result = await service.SetTaskCompletionAsync(
            "task-42",
            completed: true,
            expectedNow,
            CancellationToken.None);

        Assert.True(result);
        Assert.Equal("task-42", actualId);
        Assert.True(actualCompleted);
        Assert.Equal(expectedNow, actualNow);
    }

    [Fact]
    public async Task SetTaskCompletionAsync_honors_cancellation_before_invocation()
    {
        var invoked = false;
        var service = new TodayDashboardService(
            HealthyLoaders() with
            {
                SetTaskCompletion = (_, _, _) =>
                {
                    invoked = true;
                    return true;
                }
            });
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => service.SetTaskCompletionAsync("focus", true, At(8, 0), cancellation.Token));

        Assert.False(invoked);
    }

    [Fact]
    public async Task SetTaskCompletionAsync_returns_false_when_delegate_is_absent()
    {
        var service = new TodayDashboardService(HealthyLoaders() with { SetTaskCompletion = null });

        var result = await service.SetTaskCompletionAsync(
            "focus",
            completed: true,
            At(8, 0),
            CancellationToken.None);

        Assert.False(result);
    }

    [Fact]
    public void LoadNotesFromRoot_recurses_reads_utf8_and_excludes_internal_trees()
    {
        using var directory = new TemporaryDirectory();
        var nested = Directory.CreateDirectory(Path.Combine(directory.Path, "nested")).FullName;
        var firstPath = Path.Combine(directory.Path, "first.md");
        var secondPath = Path.Combine(nested, "second.MD");
        var ignoredPath = Path.Combine(nested, "ignored.txt");
        var templateDirectory = Directory.CreateDirectory(Path.Combine(directory.Path, "Templates")).FullName;
        var historyDirectory = Directory.CreateDirectory(Path.Combine(nested, ".HiStOrY")).FullName;
        var templatePath = Path.Combine(templateDirectory, "template.md");
        var historyPath = Path.Combine(historyDirectory, "old.md");
        File.WriteAllText(firstPath, "# 第一篇\n你好", Encoding.UTF8);
        File.WriteAllText(secondPath, "# Second\nRésumé", Encoding.UTF8);
        File.WriteAllText(ignoredPath, "ignore me", Encoding.UTF8);
        File.WriteAllText(templatePath, "# Template", Encoding.UTF8);
        File.WriteAllText(historyPath, "# Old revision", Encoding.UTF8);
        var firstWriteTime = new DateTime(2026, 7, 23, 9, 15, 0, DateTimeKind.Local);
        var secondWriteTime = new DateTime(2026, 7, 24, 10, 45, 0, DateTimeKind.Local);
        File.SetLastWriteTime(firstPath, firstWriteTime);
        File.SetLastWriteTime(secondPath, secondWriteTime);
        File.SetLastWriteTime(templatePath, secondWriteTime.AddHours(2));
        File.SetLastWriteTime(historyPath, secondWriteTime.AddHours(1));

        var notes = TodayDashboardService.LoadNotesFromRoot(directory.Path, CancellationToken.None);

        Assert.Equal(2, notes.Count);
        var first = Assert.Single(notes, note => note.FullPath == firstPath);
        Assert.Equal(File.GetLastWriteTime(firstPath), first.LastWriteTime);
        Assert.Equal("# 第一篇\n你好", first.Markdown);
        var second = Assert.Single(notes, note => note.FullPath == secondPath);
        Assert.Equal(File.GetLastWriteTime(secondPath), second.LastWriteTime);
        Assert.Equal("# Second\nRésumé", second.Markdown);
    }

    [Fact]
    public void LoadRecentNotes_skips_unreadable_candidates_and_stops_after_two_usable_notes()
    {
        using var directory = new TemporaryDirectory();
        var candidates = Enumerable.Range(1, 6)
            .Select(index => new NoteFileInfo
            {
                FullPath = Path.Combine(directory.Path, $"{index}.md"),
                FileName = $"{index}.md",
                LastWriteUtc = At(12 - index, 0).ToUniversalTime()
            })
            .ToArray();
        var readPaths = new List<string>();

        var notes = TodayDashboardService.LoadRecentNotes(
            directory.Path,
            candidates,
            path =>
            {
                readPaths.Add(path);
                return Path.GetFileName(path) switch
                {
                    "1.md" => throw new FileNotFoundException("disappeared", path),
                    "2.md" => throw new UnauthorizedAccessException("locked"),
                    _ => $"# {Path.GetFileNameWithoutExtension(path)}"
                };
            },
            CancellationToken.None);

        Assert.Equal(["3.md", "4.md"], notes.Select(note => Path.GetFileName(note.FullPath)));
        Assert.Equal(["1.md", "2.md", "3.md", "4.md"], readPaths.Select(Path.GetFileName));
    }

    private static TodayDashboardLoaders HealthyLoaders() =>
        new(
            LoadTasks: () =>
            [
                new ZenTaskRecord
                {
                    Id = "focus",
                    Title = "focus",
                    Project = "Dashboard",
                    WorkflowStatus = "Todo",
                    StartDate = At(13, 30),
                    DueDate = Day(23),
                    CreatedAt = Day(1),
                    UpdatedAt = Day(24)
                }
            ],
            LoadMeetings: () =>
            [
                new MeetingRecord
                {
                    Id = "review",
                    Title = "review",
                    StartTime = At(9, 30),
                    Status = MeetingStatus.Planned
                }
            ],
            LoadReminders: () =>
            [
                new ReminderDefinition
                {
                    Id = "water",
                    Title = "water",
                    Schedule = new ReminderSchedule
                    {
                        Kind = ReminderRepeatKind.Daily,
                        Times = ["10:00"]
                    }
                }
            ],
            LoadNotes: () =>
            [
                new TodayNoteDocument(@"C:\notes\plan.md", At(7, 0), "# Plan\nNext step")
            ]);

    private static TodayDashboardLoaders LoadersFailing(string failedLoader)
    {
        var healthy = HealthyLoaders();
        return healthy with
        {
            LoadTasks = failedLoader == "Tasks"
                ? () => throw new IOException("Tasks unavailable")
                : healthy.LoadTasks,
            LoadMeetings = failedLoader == "Meetings"
                ? () => throw new IOException("Meetings unavailable")
                : healthy.LoadMeetings,
            LoadReminders = failedLoader == "Reminders"
                ? () => throw new IOException("Reminders unavailable")
                : healthy.LoadReminders,
            LoadNotes = failedLoader == "Notes"
                ? () => throw new IOException("Notes unavailable")
                : healthy.LoadNotes
        };
    }

    private static TodayDashboardLoaders LoadersWithNullElement(string source)
    {
        var healthy = HealthyLoaders();
        return healthy with
        {
            LoadTasks = source == "Zen Task"
                ? () => new ZenTaskRecord[] { null!, healthy.LoadTasks()[0] }
                : healthy.LoadTasks,
            LoadMeetings = source == "Meetings"
                ? () => new MeetingRecord[] { null!, healthy.LoadMeetings()[0] }
                : healthy.LoadMeetings,
            LoadReminders = source == "Reminders"
                ? () => new ReminderDefinition[] { null!, healthy.LoadReminders()[0] }
                : healthy.LoadReminders,
            LoadNotes = source == "Notes"
                ? () => new TodayNoteDocument[] { null!, healthy.LoadNotes()[0] }
                : healthy.LoadNotes
        };
    }

    private static string ExpectedError(string source) => source switch
    {
        "Zen Task" => "任务数据加载失败",
        "Meetings" => "会议数据加载失败",
        "Reminders" => "提醒数据加载失败",
        "Notes" => "笔记数据加载失败",
        _ => throw new ArgumentOutOfRangeException(nameof(source))
    };

    private static DateTime At(int hour, int minute) => Friday.AddHours(hour).AddMinutes(minute);

    private static DateTime Day(int day) => new(2026, 7, day);

    private sealed class TemporaryDirectory : IDisposable
    {
        public TemporaryDirectory()
        {
            Path = System.IO.Path.Combine(
                System.IO.Path.GetTempPath(),
                $"DanceMonkey.TodayDashboardServiceTests.{Guid.NewGuid():N}");
            Directory.CreateDirectory(Path);
        }

        public string Path { get; }

        public void Dispose()
        {
            if (Directory.Exists(Path))
                Directory.Delete(Path, recursive: true);
        }
    }
}
