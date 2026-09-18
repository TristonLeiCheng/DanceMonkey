using System.Diagnostics;
using DesktopAssistant.Models;

namespace DesktopAssistant.Services;

public interface ITodayDashboardService
{
    Task<TodayDashboardSnapshot> LoadAsync(DateTime now, CancellationToken cancellationToken);

    Task<bool> SetTaskCompletionAsync(
        string taskId,
        bool completed,
        DateTime now,
        CancellationToken cancellationToken);
}

public sealed record TodayDashboardLoaders(
    Func<IReadOnlyList<ZenTaskRecord>> LoadTasks,
    Func<IReadOnlyList<MeetingRecord>> LoadMeetings,
    Func<IReadOnlyList<ReminderDefinition>> LoadReminders,
    Func<IReadOnlyList<TodayNoteDocument>> LoadNotes,
    Func<string, bool, DateTime, bool>? SetTaskCompletion = null);

public sealed record TodayDashboardLoaderFactory(
    Func<AppConfig> LoadConfig,
    Func<AppConfig, CancellationToken, IReadOnlyList<ZenTaskRecord>> LoadTasks,
    Func<AppConfig, CancellationToken, IReadOnlyList<MeetingRecord>> LoadMeetings,
    Func<AppConfig, CancellationToken, IReadOnlyList<ReminderDefinition>> LoadReminders,
    Func<AppConfig, CancellationToken, IReadOnlyList<TodayNoteDocument>> LoadNotes,
    Func<AppConfig, string, bool, DateTime, CancellationToken, bool>? SetTaskCompletion = null);

public sealed class TodayDashboardService : ITodayDashboardService
{
    private const int RecentNoteLimit = 2;

    private static readonly IReadOnlyDictionary<string, string> StableSourceMessages =
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["Zen Task"] = "任务数据加载失败",
            ["Meetings"] = "会议数据加载失败",
            ["Reminders"] = "提醒数据加载失败",
            ["Notes"] = "笔记数据加载失败"
        };

    private readonly TodayDashboardLoaders? _loaders;
    private readonly TodayDashboardLoaderFactory? _loaderFactory;

    public TodayDashboardService(TodayDashboardLoaders loaders)
    {
        ArgumentNullException.ThrowIfNull(loaders);
        ArgumentNullException.ThrowIfNull(loaders.LoadTasks);
        ArgumentNullException.ThrowIfNull(loaders.LoadMeetings);
        ArgumentNullException.ThrowIfNull(loaders.LoadReminders);
        ArgumentNullException.ThrowIfNull(loaders.LoadNotes);
        _loaders = loaders;
    }

    public TodayDashboardService(TodayDashboardLoaderFactory loaderFactory)
    {
        ArgumentNullException.ThrowIfNull(loaderFactory);
        ArgumentNullException.ThrowIfNull(loaderFactory.LoadConfig);
        ArgumentNullException.ThrowIfNull(loaderFactory.LoadTasks);
        ArgumentNullException.ThrowIfNull(loaderFactory.LoadMeetings);
        ArgumentNullException.ThrowIfNull(loaderFactory.LoadReminders);
        ArgumentNullException.ThrowIfNull(loaderFactory.LoadNotes);
        _loaderFactory = loaderFactory;
    }

    public static TodayDashboardService CreateProduction(ReminderStore reminderStore)
    {
        ArgumentNullException.ThrowIfNull(reminderStore);

        return new TodayDashboardService(
            new TodayDashboardLoaderFactory(
                LoadConfig: DesktopAssistant.App.Config.Load,
                LoadTasks: (config, cancellationToken) =>
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    return new ZenTaskStore(config.NotesRootPath).LoadTasks();
                },
                LoadMeetings: (config, cancellationToken) =>
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    return new MeetingStore(config.NotesRootPath).LoadMeetings();
                },
                LoadReminders: (config, cancellationToken) =>
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    reminderStore.EnsureLoaded(config);
                    return reminderStore.GetRemindersSnapshot();
                },
                LoadNotes: (config, cancellationToken) =>
                    LoadNotesFromRoot(config.NotesRootPath, cancellationToken),
                SetTaskCompletion: (config, taskId, completed, now, cancellationToken) =>
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    return new ZenTaskStore(config.NotesRootPath)
                        .SetCompletion(taskId, completed, now);
                }));
    }

    public async Task<TodayDashboardSnapshot> LoadAsync(
        DateTime now,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var errors = new List<TodaySourceError>();

        IReadOnlyList<ZenTaskRecord> tasks;
        IReadOnlyList<MeetingRecord> meetings;
        IReadOnlyList<ReminderDefinition> reminders;
        IReadOnlyList<TodayNoteDocument> notes;

        if (_loaderFactory != null)
        {
            var config = await Task.Run(_loaderFactory.LoadConfig, cancellationToken)
                .ConfigureAwait(false);
            tasks = await LoadSourceAsync(
                    () => _loaderFactory.LoadTasks(config, cancellationToken),
                    "Zen Task",
                    errors,
                    cancellationToken)
                .ConfigureAwait(false);
            meetings = await LoadSourceAsync(
                    () => _loaderFactory.LoadMeetings(config, cancellationToken),
                    "Meetings",
                    errors,
                    cancellationToken)
                .ConfigureAwait(false);
            reminders = await LoadSourceAsync(
                    () => _loaderFactory.LoadReminders(config, cancellationToken),
                    "Reminders",
                    errors,
                    cancellationToken)
                .ConfigureAwait(false);
            notes = await LoadSourceAsync(
                    () => _loaderFactory.LoadNotes(config, cancellationToken),
                    "Notes",
                    errors,
                    cancellationToken)
                .ConfigureAwait(false);
        }
        else
        {
            var loaders = _loaders
                          ?? throw new InvalidOperationException("Dashboard loaders are not configured.");
            tasks = await LoadSourceAsync(
                    loaders.LoadTasks,
                    "Zen Task",
                    errors,
                    cancellationToken)
                .ConfigureAwait(false);
            meetings = await LoadSourceAsync(
                    loaders.LoadMeetings,
                    "Meetings",
                    errors,
                    cancellationToken)
                .ConfigureAwait(false);
            reminders = await LoadSourceAsync(
                    loaders.LoadReminders,
                    "Reminders",
                    errors,
                    cancellationToken)
                .ConfigureAwait(false);
            notes = await LoadSourceAsync(
                    loaders.LoadNotes,
                    "Notes",
                    errors,
                    cancellationToken)
                .ConfigureAwait(false);
        }

        cancellationToken.ThrowIfCancellationRequested();
        return TodayDashboardComposer.Compose(
            new TodayDashboardInput(tasks, meetings, reminders, notes, errors.ToArray()),
            now);
    }

    public async Task<bool> SetTaskCompletionAsync(
        string taskId,
        bool completed,
        DateTime now,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();

        if (_loaderFactory != null)
        {
            var setCompletion = _loaderFactory.SetTaskCompletion;
            if (setCompletion == null)
                return false;

            var config = await Task.Run(_loaderFactory.LoadConfig, cancellationToken)
                .ConfigureAwait(false);
            return await Task.Run(
                    () => setCompletion(
                        config,
                        taskId,
                        completed,
                        now,
                        cancellationToken),
                    cancellationToken)
                .ConfigureAwait(false);
        }

        var fixedCompletion = _loaders?.SetTaskCompletion;
        if (fixedCompletion == null)
            return false;

        return await Task.Run(
                () => fixedCompletion(taskId, completed, now),
                cancellationToken)
            .ConfigureAwait(false);
    }

    public static IReadOnlyList<TodayNoteDocument> LoadNotesFromRoot(string? notesRootPath) =>
        LoadNotesFromRoot(notesRootPath, CancellationToken.None);

    public static IReadOnlyList<TodayNoteDocument> LoadNotesFromRoot(
        string? notesRootPath,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var noteService = new NoteService(notesRootPath);
        return LoadRecentNotes(
            noteService.RootPath,
            noteService.ListAllMarkdownRecursive(),
            noteService.Read,
            cancellationToken);
    }

    public static IReadOnlyList<TodayNoteDocument> LoadRecentNotes(
        string notesRootPath,
        IEnumerable<NoteFileInfo> candidates,
        Func<string, string> readMarkdown,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(notesRootPath);
        ArgumentNullException.ThrowIfNull(candidates);
        ArgumentNullException.ThrowIfNull(readMarkdown);

        var notes = new List<TodayNoteDocument>(RecentNoteLimit);
        foreach (var candidate in candidates)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (IsExcludedNote(notesRootPath, candidate.FullPath))
                continue;

            try
            {
                var markdown = readMarkdown(candidate.FullPath);
                notes.Add(new TodayNoteDocument(
                    candidate.FullPath,
                    candidate.LastWriteUtc.ToLocalTime(),
                    markdown));
                if (notes.Count == RecentNoteLimit)
                    break;
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (IOException exception)
            {
                Trace.TraceWarning(
                    "Today dashboard skipped unreadable note {0}: {1}",
                    candidate.FullPath,
                    exception);
            }
            catch (UnauthorizedAccessException exception)
            {
                Trace.TraceWarning(
                    "Today dashboard skipped inaccessible note {0}: {1}",
                    candidate.FullPath,
                    exception);
            }
        }

        return notes.ToArray();
    }

    private static bool IsExcludedNote(string notesRootPath, string fullPath)
    {
        var relativePath = Path.GetRelativePath(notesRootPath, fullPath);
        var segments = relativePath.Split(
            new[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar },
            StringSplitOptions.RemoveEmptyEntries);
        if (segments.Length == 0)
            return false;

        if (string.Equals(segments[0], "Templates", StringComparison.OrdinalIgnoreCase))
            return true;

        return segments
            .Take(Math.Max(0, segments.Length - 1))
            .Any(segment => string.Equals(segment, ".history", StringComparison.OrdinalIgnoreCase));
    }

    private static async Task<IReadOnlyList<T>> LoadSourceAsync<T>(
        Func<IReadOnlyList<T>> loader,
        string source,
        ICollection<TodaySourceError> errors,
        CancellationToken cancellationToken)
        where T : class
    {
        cancellationToken.ThrowIfCancellationRequested();

        try
        {
            var loaded = await Task.Run(loader, cancellationToken).ConfigureAwait(false);
            if (loaded == null)
            {
                AddStableSourceError(source, errors);
                Trace.TraceWarning("Today dashboard source {0} returned a null collection.", source);
                return Array.Empty<T>();
            }

            var healthy = loaded.Where(item => item != null).ToArray();
            if (healthy.Length != loaded.Count)
            {
                AddStableSourceError(source, errors);
                Trace.TraceWarning("Today dashboard source {0} contained null elements.", source);
            }

            return healthy;
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception exception)
        {
            Trace.TraceError("Today dashboard source {0} failed: {1}", source, exception);
            AddStableSourceError(source, errors);
            return Array.Empty<T>();
        }
    }

    private static void AddStableSourceError(
        string source,
        ICollection<TodaySourceError> errors)
    {
        var message = StableSourceMessages.TryGetValue(source, out var stableMessage)
            ? stableMessage
            : "数据加载失败";
        errors.Add(new TodaySourceError(source, message));
    }
}
