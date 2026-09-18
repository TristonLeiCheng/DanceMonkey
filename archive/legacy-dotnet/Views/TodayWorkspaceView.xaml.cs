using System.ComponentModel;
using System.Runtime.CompilerServices;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Automation.Peers;
using System.Windows.Controls;
using System.Windows.Threading;
using DesktopAssistant.Models;
using DesktopAssistant.Services;

namespace DesktopAssistant.Views;

public sealed record TodayRefreshRequest(int Generation, CancellationToken CancellationToken);

public sealed class TodayRefreshCoordinator
{
    private CancellationTokenSource? _cancellation;
    private int _generation;

    public TodayDashboardSnapshot? Snapshot { get; private set; }

    public string? ErrorMessage { get; private set; }

    public bool IsLoading { get; private set; }

    public TodayRefreshRequest Begin()
    {
        _cancellation?.Cancel();
        _cancellation?.Dispose();
        _cancellation = new CancellationTokenSource();
        IsLoading = true;
        ErrorMessage = null;
        return new TodayRefreshRequest(++_generation, _cancellation.Token);
    }

    public bool Complete(int generation, TodayDashboardSnapshot snapshot)
    {
        ArgumentNullException.ThrowIfNull(snapshot);
        if (generation != _generation || _cancellation?.IsCancellationRequested != false)
            return false;

        Snapshot = snapshot;
        ErrorMessage = null;
        IsLoading = false;
        return true;
    }

    public bool Fail(int generation, string errorMessage)
    {
        if (generation != _generation || _cancellation?.IsCancellationRequested != false)
            return false;

        ErrorMessage = errorMessage;
        IsLoading = false;
        return true;
    }

    public void Stop()
    {
        _generation++;
        _cancellation?.Cancel();
        _cancellation?.Dispose();
        _cancellation = null;
        IsLoading = false;
    }
}

public enum TodayDashboardCard
{
    Focus,
    Timeline,
    Tasks,
    Notes
}

public static class TodayDashboardPresentation
{
    public static bool ShowGlobalWarning(TodayDashboardSnapshot? snapshot) =>
        snapshot?.SourceErrors
            .Select(error => error.Source)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Take(2)
            .Count() > 1;

    public static bool HasSourceError(TodayDashboardSnapshot? snapshot, TodayDashboardCard card) =>
        snapshot?.SourceErrors.Any(error => IsRelevantSource(error.Source, card)) == true;

    public static bool ShowEmpty(TodayDashboardSnapshot? snapshot, TodayDashboardCard card)
    {
        if (snapshot is null || HasSourceError(snapshot, card))
            return false;

        return card switch
        {
            TodayDashboardCard.Focus => snapshot.FocusTask is null,
            TodayDashboardCard.Timeline => snapshot.Timeline.Count == 0,
            TodayDashboardCard.Tasks => snapshot.Tasks.Count == 0,
            TodayDashboardCard.Notes => snapshot.RecentNotes.Count == 0,
            _ => false
        };
    }

    public static string SourceErrorMessage(TodayDashboardSnapshot? snapshot, TodayDashboardCard card)
    {
        if (snapshot is null)
            return string.Empty;

        var sources = snapshot.SourceErrors
            .Where(error => IsRelevantSource(error.Source, card))
            .Select(error => error.Source)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        return sources.Length == 0
            ? string.Empty
            : $"{CardLabel(card)}：部分数据暂不可用（{string.Join("、", sources)}），当前显示已成功加载的内容。";
    }

    private static string CardLabel(TodayDashboardCard card) =>
        card switch
        {
            TodayDashboardCard.Focus => "当前专注",
            TodayDashboardCard.Timeline => "今日时间线",
            TodayDashboardCard.Tasks => "待处理任务",
            TodayDashboardCard.Notes => "最近笔记",
            _ => "今日工作台"
        };

    private static bool IsRelevantSource(string source, TodayDashboardCard card) =>
        card switch
        {
            TodayDashboardCard.Focus or TodayDashboardCard.Tasks =>
                source.Equals("Zen Task", StringComparison.OrdinalIgnoreCase),
            TodayDashboardCard.Notes =>
                source.Equals("Notes", StringComparison.OrdinalIgnoreCase),
            TodayDashboardCard.Timeline =>
                source.Equals("Meetings", StringComparison.OrdinalIgnoreCase)
                || source.Equals("Reminders", StringComparison.OrdinalIgnoreCase)
                || source.Equals("Zen Task", StringComparison.OrdinalIgnoreCase),
            _ => false
        };
}

public sealed class FocusSessionLifecycle
{
    private DateTimeOffset? _unloadedAtUtc;

    public void OnUnloaded(FocusSession session, DateTimeOffset nowUtc)
    {
        ArgumentNullException.ThrowIfNull(session);
        if (session.IsRunning)
            _unloadedAtUtc ??= nowUtc.ToUniversalTime();
        else
            _unloadedAtUtc = null;
    }

    public FocusSession OnLoaded(FocusSession session, DateTimeOffset nowUtc)
    {
        ArgumentNullException.ThrowIfNull(session);
        if (_unloadedAtUtc is not { } unloadedAt)
            return session;

        _unloadedAtUtc = null;
        var elapsed = nowUtc.ToUniversalTime() - unloadedAt;
        return elapsed > TimeSpan.Zero
            ? session.Tick(elapsed)
            : session;
    }
}

public sealed class FocusSessionTimerController
{
    private readonly TimeProvider _timeProvider;
    private long? _monotonicAnchor;
    private DateTimeOffset? _unloadedAtUtc;

    public FocusSessionTimerController(TimeProvider? timeProvider = null) =>
        _timeProvider = timeProvider ?? TimeProvider.System;

    public FocusSession Start(FocusSession session)
    {
        var started = session.Start();
        _unloadedAtUtc = null;
        _monotonicAnchor = _timeProvider.GetTimestamp();
        return started;
    }

    public FocusSession Tick(FocusSession session) =>
        ReconcileMonotonic(session);

    public FocusSession Pause(FocusSession session)
    {
        var reconciled = ReconcileMonotonic(session).Pause();
        _monotonicAnchor = null;
        _unloadedAtUtc = null;
        return reconciled;
    }

    public FocusSession Reset(FocusSession session)
    {
        _monotonicAnchor = null;
        _unloadedAtUtc = null;
        return session.Reset();
    }

    public FocusSession OnUnloaded(FocusSession session)
    {
        var reconciled = ReconcileMonotonic(session);
        _monotonicAnchor = null;
        _unloadedAtUtc = reconciled.IsRunning
            ? _timeProvider.GetUtcNow()
            : null;
        return reconciled;
    }

    public FocusSession OnLoaded(FocusSession session)
    {
        var reconciled = session;
        if (_unloadedAtUtc is { } unloadedAt && session.IsRunning)
        {
            var elapsed = _timeProvider.GetUtcNow() - unloadedAt;
            if (elapsed > TimeSpan.Zero)
                reconciled = session.Tick(elapsed);
        }

        _unloadedAtUtc = null;
        _monotonicAnchor = reconciled.IsRunning
            ? _timeProvider.GetTimestamp()
            : null;
        return reconciled;
    }

    private FocusSession ReconcileMonotonic(FocusSession session)
    {
        if (!session.IsRunning)
        {
            _monotonicAnchor = null;
            return session;
        }

        var now = _timeProvider.GetTimestamp();
        if (_monotonicAnchor is not { } anchor)
        {
            _monotonicAnchor = now;
            return session;
        }

        _monotonicAnchor = now;
        var elapsed = _timeProvider.GetElapsedTime(anchor, now);
        return elapsed > TimeSpan.Zero
            ? session.Tick(elapsed)
            : session;
    }
}

public enum TodayRefreshTrigger
{
    Loaded,
    Navigation,
    Timer,
    Manual,
    Settings,
    TaskWrite
}

public sealed class TodayRefreshController
{
    private readonly object _sync = new();
    private readonly ITodayDashboardService _service;
    private readonly Func<DateTime> _now;
    private CancellationTokenSource? _lifetimeCancellation;
    private TaskCompletionSource<object?>? _drain;
    private long _lifetimeGeneration;
    private long _activeGeneration;
    private long _lastLifecycleCompletionGeneration;
    private bool _active;
    private bool _queued;
    private TodayRefreshTrigger _activeTrigger;
    private TodayRefreshTrigger? _queuedTrigger;
    private TodayRefreshTrigger? _lastLifecycleTrigger;
    private DateTime? _lastLifecycleCompletionAt;

    public TodayRefreshController(ITodayDashboardService service, Func<DateTime>? now = null)
    {
        _service = service ?? throw new ArgumentNullException(nameof(service));
        _now = now ?? (() => DateTime.Now);
    }

    public TodayDashboardSnapshot? Snapshot { get; private set; }

    public string? ErrorMessage { get; private set; }

    public bool IsLoading { get; private set; }

    public Task RequestAsync(TodayRefreshTrigger trigger)
    {
        Task task;
        var startWorker = false;
        lock (_sync)
        {
            EnsureLifetimeLocked();
            if (_active)
            {
                if (IsExplicit(trigger) || _activeGeneration != _lifetimeGeneration)
                {
                    _queued = true;
                    _queuedTrigger = trigger;
                }
                return _drain!.Task;
            }

            if (CanReuseLifecycleResultLocked(trigger))
                return Task.CompletedTask;

            _active = true;
            _activeGeneration = _lifetimeGeneration;
            _activeTrigger = trigger;
            IsLoading = true;
            ErrorMessage = null;
            _drain = new TaskCompletionSource<object?>(
                TaskCreationOptions.RunContinuationsAsynchronously);
            task = _drain.Task;
            startWorker = true;
        }

        if (startWorker)
            _ = RunLoopAsync();
        return task;
    }

    public void Stop()
    {
        lock (_sync)
        {
            _lifetimeGeneration++;
            _lifetimeCancellation?.Cancel();
            _lifetimeCancellation?.Dispose();
            _lifetimeCancellation = null;
            _queued = false;
            _queuedTrigger = null;
            IsLoading = false;
        }
    }

    private async Task RunLoopAsync()
    {
        while (true)
        {
            long generation;
            CancellationToken cancellationToken;
            TodayRefreshTrigger trigger;
            lock (_sync)
            {
                EnsureLifetimeLocked();
                generation = _lifetimeGeneration;
                _activeGeneration = generation;
                trigger = _activeTrigger;
                cancellationToken = _lifetimeCancellation!.Token;
            }

            TodayDashboardSnapshot? loaded = null;
            string? failure = null;
            try
            {
                loaded = await _service.LoadAsync(_now(), cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                // Lifetime invalidation intentionally suppresses this completion.
            }
            catch
            {
                failure = "今日工作台刷新失败，请稍后重试。";
            }

            TaskCompletionSource<object?>? completedDrain = null;
            var continueLoop = false;
            lock (_sync)
            {
                var isCurrent = generation == _lifetimeGeneration
                                && !cancellationToken.IsCancellationRequested;
                if (isCurrent && loaded is not null)
                {
                    Snapshot = loaded;
                    ErrorMessage = null;
                    if (IsLifecycle(trigger))
                    {
                        _lastLifecycleTrigger = trigger;
                        _lastLifecycleCompletionAt = _now();
                        _lastLifecycleCompletionGeneration = generation;
                    }
                }
                else if (isCurrent && failure is not null)
                {
                    ErrorMessage = failure;
                }

                if (_queued)
                {
                    _queued = false;
                    _activeTrigger = _queuedTrigger ?? TodayRefreshTrigger.Manual;
                    _queuedTrigger = null;
                    continueLoop = true;
                }
                else
                {
                    _active = false;
                    IsLoading = false;
                    completedDrain = _drain;
                    _drain = null;
                }
            }

            if (continueLoop)
                continue;

            completedDrain?.TrySetResult(null);
            return;
        }
    }

    private void EnsureLifetimeLocked()
    {
        if (_lifetimeCancellation is not null)
            return;

        _lifetimeGeneration++;
        _lifetimeCancellation = new CancellationTokenSource();
    }

    private static bool IsExplicit(TodayRefreshTrigger trigger) =>
        trigger is TodayRefreshTrigger.Manual
            or TodayRefreshTrigger.Settings
            or TodayRefreshTrigger.TaskWrite;

    private bool CanReuseLifecycleResultLocked(TodayRefreshTrigger trigger)
    {
        if (!IsLifecycle(trigger)
            || _lastLifecycleTrigger is null
            || _lastLifecycleTrigger == trigger
            || _lastLifecycleCompletionGeneration != _lifetimeGeneration
            || _lastLifecycleCompletionAt is not { } completedAt)
            return false;

        var age = _now() - completedAt;
        return age >= TimeSpan.Zero && age <= TimeSpan.FromSeconds(1);
    }

    private static bool IsLifecycle(TodayRefreshTrigger trigger) =>
        trigger is TodayRefreshTrigger.Loaded or TodayRefreshTrigger.Navigation;
}

public enum TodayTaskWriteOutcome
{
    Applied,
    Revert,
    Stale
}

public sealed class TodayTaskWriteController
{
    private sealed class GateEntry
    {
        public SemaphoreSlim Gate { get; } = new(1, 1);

        public int References { get; set; }

        public long LatestIntent { get; set; }
    }

    private readonly object _sync = new();
    private readonly Dictionary<string, GateEntry> _gates = new(StringComparer.Ordinal);
    private readonly ITodayDashboardService _service;

    public TodayTaskWriteController(ITodayDashboardService service) =>
        _service = service ?? throw new ArgumentNullException(nameof(service));

    public int ActiveGateCount
    {
        get
        {
            lock (_sync)
                return _gates.Count;
        }
    }

    public async Task<TodayTaskWriteOutcome> WriteAsync(
        string taskId,
        bool completed,
        DateTime now,
        CancellationToken originatingToken,
        Func<bool> isOriginCurrent)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(taskId);
        ArgumentNullException.ThrowIfNull(isOriginCurrent);

        var (entry, intent) = AcquireEntry(taskId);
        var entered = false;
        try
        {
            await entry.Gate.WaitAsync(originatingToken).ConfigureAwait(false);
            entered = true;
            var updated = await _service
                .SetTaskCompletionAsync(taskId, completed, now, originatingToken)
                .ConfigureAwait(false);
            if (!isOriginCurrent()
                || originatingToken.IsCancellationRequested
                || !IsLatestIntent(entry, intent))
                return TodayTaskWriteOutcome.Stale;

            return updated
                ? TodayTaskWriteOutcome.Applied
                : TodayTaskWriteOutcome.Revert;
        }
        catch (OperationCanceledException) when (originatingToken.IsCancellationRequested)
        {
            return TodayTaskWriteOutcome.Stale;
        }
        catch
        {
            return isOriginCurrent()
                   && !originatingToken.IsCancellationRequested
                   && IsLatestIntent(entry, intent)
                ? TodayTaskWriteOutcome.Revert
                : TodayTaskWriteOutcome.Stale;
        }
        finally
        {
            if (entered)
                entry.Gate.Release();
            ReleaseEntry(taskId, entry);
        }
    }

    private (GateEntry Entry, long Intent) AcquireEntry(string taskId)
    {
        lock (_sync)
        {
            if (!_gates.TryGetValue(taskId, out var entry))
            {
                entry = new GateEntry();
                _gates.Add(taskId, entry);
            }

            entry.References++;
            entry.LatestIntent++;
            return (entry, entry.LatestIntent);
        }
    }

    private bool IsLatestIntent(GateEntry entry, long intent)
    {
        lock (_sync)
            return entry.LatestIntent == intent;
    }

    private void ReleaseEntry(string taskId, GateEntry entry)
    {
        lock (_sync)
        {
            entry.References--;
            if (entry.References != 0)
                return;

            _gates.Remove(taskId);
            entry.Gate.Dispose();
        }
    }
}

public static class TodayLayoutCoordinator
{
    public static int GetColumnCount(double availableWidth) =>
        availableWidth >= 1100
            ? 3
            : availableWidth >= 680
                ? 2
                : 1;
}

public sealed record TodaySourceRoute(AppPage Page, string Id);

public static class TodaySourceRouter
{
    public static TodaySourceRoute Resolve(TodayTimelineSource source, string id)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(id);
        return new TodaySourceRoute(
            source switch
            {
                TodayTimelineSource.Meeting => AppPage.MeetingAssistant,
                TodayTimelineSource.Reminder => AppPage.ScheduledReminders,
                _ => AppPage.Todo
            },
            id);
    }
}

public sealed class TodayAiRequestedEventArgs(string digestPrompt) : EventArgs
{
    public string DigestPrompt { get; } = digestPrompt;
}

public sealed class TodayNoteRequestedEventArgs(string fullPath) : EventArgs
{
    public string FullPath { get; } = fullPath;
}

public sealed class TodaySourceRequestedEventArgs(TodayTimelineSource source, string id) : EventArgs
{
    public TodayTimelineSource Source { get; } = source;

    public string Id { get; } = id;
}

public static class TodayLiveRegionAutomation
{
    public static AutomationPeer? GetPeer(FrameworkElement target)
    {
        if (target is not TextBlock textBlock
            || AutomationProperties.GetLiveSetting(textBlock) == AutomationLiveSetting.Off
            || string.IsNullOrWhiteSpace(AutomationProperties.GetName(textBlock))
               && string.IsNullOrWhiteSpace(textBlock.Text))
            return null;

        return UIElementAutomationPeer.FromElement(textBlock)
               ?? UIElementAutomationPeer.CreatePeerForElement(textBlock);
    }

    public static bool RaiseChangedIfVisible(
        TextBlock target,
        Action<AutomationPeer, AutomationEvents>? raiseEvent = null)
    {
        if (!target.IsVisible || GetPeer(target) is not { } peer)
            return false;

        (raiseEvent ?? RaiseAutomationEvent)(peer, AutomationEvents.LiveRegionChanged);
        return true;
    }

    private static void RaiseAutomationEvent(
        AutomationPeer peer,
        AutomationEvents automationEvent) =>
        peer.RaiseAutomationEvent(automationEvent);
}

public partial class TodayWorkspaceView : UserControl, INotifyPropertyChanged
{
    private static readonly TimeSpan FocusDuration = TimeSpan.FromMinutes(25);
    private readonly ITodayDashboardService _dashboardService;
    private readonly TodayRefreshController _refreshController;
    private readonly FocusSessionTimerController _focusTimerController = new();
    private readonly TodayTaskWriteController _taskWriteController;
    private readonly DispatcherTimer _refreshTimer;
    private readonly DispatcherTimer _focusTimer;
    private CancellationTokenSource? _lifetimeCancellation;
    private long _lifetimeGeneration;
    private TodayDashboardSnapshot? _snapshot;
    private FocusSession _focusSession = FocusSession.Create(FocusDuration);
    private bool _isLoading;
    private string? _errorMessage;
    private string _refreshStatusMessage = "正在同步今日工作台…";

    public TodayWorkspaceView(ITodayDashboardService dashboardService)
    {
        _dashboardService = dashboardService ?? throw new ArgumentNullException(nameof(dashboardService));
        _refreshController = new TodayRefreshController(_dashboardService, () => DateTime.Now);
        _taskWriteController = new TodayTaskWriteController(_dashboardService);
        InitializeComponent();
        DataContext = this;

        _refreshTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(60) };
        _refreshTimer.Tick += RefreshTimer_OnTick;
        _focusTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
        _focusTimer.Tick += FocusTimer_OnTick;
        Loaded += TodayWorkspaceView_OnLoaded;
        Unloaded += TodayWorkspaceView_OnUnloaded;
        SizeChanged += TodayWorkspaceView_OnSizeChanged;
    }

    public event PropertyChangedEventHandler? PropertyChanged;

    public event EventHandler<TodayAiRequestedEventArgs>? AiRequested;

    public event EventHandler? CaptureRequested;

    public event EventHandler? NotesRequested;

    public event EventHandler<TodayNoteRequestedEventArgs>? NoteRequested;

    public event EventHandler<TodaySourceRequestedEventArgs>? SourceRequested;

    public TodayDashboardSnapshot? Snapshot
    {
        get => _snapshot;
        private set
        {
            if (ReferenceEquals(_snapshot, value))
                return;

            _snapshot = value;
            OnPropertyChanged();
            RaiseSnapshotProperties();
            QueueSnapshotLiveRegionChanges();
        }
    }

    public string DateLabel => Snapshot?.DateLabel ?? DateTime.Now.ToString("yyyy年M月d日 dddd");

    public string WeeklyProgressLabel =>
        Snapshot?.WeeklyTotalCount > 0
            ? $"{Snapshot.WeeklyCompletedCount} / {Snapshot.WeeklyTotalCount} · {Snapshot.WeeklyProgressPercent}%"
            : "0 / 0 · 本周暂无任务记录";

    public string TaskCountLabel => $"{Snapshot?.Tasks.Count ?? 0} 项";

    public bool HasFocusTask => Snapshot?.FocusTask is not null;

    public bool HasTimeline => Snapshot?.Timeline.Count > 0;

    public bool HasTasks => Snapshot?.Tasks.Count > 0;

    public bool HasNotes => Snapshot?.RecentNotes.Count > 0;

    public bool ShowFocusEmpty =>
        TodayDashboardPresentation.ShowEmpty(Snapshot, TodayDashboardCard.Focus);

    public bool ShowTimelineEmpty =>
        TodayDashboardPresentation.ShowEmpty(Snapshot, TodayDashboardCard.Timeline);

    public bool ShowTasksEmpty =>
        TodayDashboardPresentation.ShowEmpty(Snapshot, TodayDashboardCard.Tasks);

    public bool ShowNotesEmpty =>
        TodayDashboardPresentation.ShowEmpty(Snapshot, TodayDashboardCard.Notes);

    public bool HasFocusSourceError =>
        TodayDashboardPresentation.HasSourceError(Snapshot, TodayDashboardCard.Focus);

    public bool HasTimelineSourceError =>
        TodayDashboardPresentation.HasSourceError(Snapshot, TodayDashboardCard.Timeline);

    public bool HasTasksSourceError =>
        TodayDashboardPresentation.HasSourceError(Snapshot, TodayDashboardCard.Tasks);

    public bool HasNotesSourceError =>
        TodayDashboardPresentation.HasSourceError(Snapshot, TodayDashboardCard.Notes);

    public string FocusSourceErrorMessage =>
        TodayDashboardPresentation.SourceErrorMessage(Snapshot, TodayDashboardCard.Focus);

    public string TimelineSourceErrorMessage =>
        TodayDashboardPresentation.SourceErrorMessage(Snapshot, TodayDashboardCard.Timeline);

    public string TasksSourceErrorMessage =>
        TodayDashboardPresentation.SourceErrorMessage(Snapshot, TodayDashboardCard.Tasks);

    public string NotesSourceErrorMessage =>
        TodayDashboardPresentation.SourceErrorMessage(Snapshot, TodayDashboardCard.Notes);

    public string FocusDetail
    {
        get
        {
            var task = Snapshot?.FocusTask;
            if (task is null)
                return string.Empty;

            var project = string.IsNullOrWhiteSpace(task.Project) ? "未分组" : task.Project;
            return $"{project} · {task.PriorityLabel} · {task.EnergyLabel} · {task.DueLabel}";
        }
    }

    public string FocusTimeLabel => _focusSession.DisplayTime;

    public double FocusProgressPercent => _focusSession.ProgressPercent;

    public string FocusStartPauseLabel => _focusSession.IsRunning ? "暂停" : "开始专注";

    public string DigestTitle => Snapshot?.Digest.Title ?? "本地今日摘要";

    public string DigestSubtitle => Snapshot?.Digest.Subtitle ?? "根据本地日程与任务生成";

    public string DigestBody => Snapshot?.Digest.Body ?? "刷新后查看今天的任务、日程和提醒摘要。";

    public string DigestActionLabel => Snapshot?.Digest.ActionLabel ?? "与 AI 讨论";

    public bool IsLoading
    {
        get => _isLoading;
        private set
        {
            if (SetProperty(ref _isLoading, value) && value)
                QueueLiveRegionChange(LoadingStatusText);
        }
    }

    public string RefreshStatusMessage
    {
        get => _refreshStatusMessage;
        private set => SetProperty(ref _refreshStatusMessage, value);
    }

    public string? ErrorMessage
    {
        get => _errorMessage;
        private set
        {
            if (SetProperty(ref _errorMessage, value))
            {
                OnPropertyChanged(nameof(HasError));
                if (HasError)
                    QueueLiveRegionChange(ErrorStatusText);
            }
        }
    }

    public bool HasError => !string.IsNullOrWhiteSpace(ErrorMessage);

    public string SourceWarningMessage =>
        Snapshot?.SourceErrors.Count > 0
            ? $"部分来源暂不可用：{string.Join("；", Snapshot.SourceErrors.Select(error => $"{error.Source}：{error.Message}"))}"
            : string.Empty;

    public bool HasSourceWarnings =>
        TodayDashboardPresentation.ShowGlobalWarning(Snapshot);

    public async Task RefreshAsync(TodayRefreshTrigger trigger = TodayRefreshTrigger.Manual)
    {
        var originGeneration = _lifetimeGeneration;
        RefreshStatusMessage = "正在同步今日工作台…";
        IsLoading = true;
        ErrorMessage = null;
        await _refreshController.RequestAsync(trigger);
        if (originGeneration != _lifetimeGeneration)
            return;

        Snapshot = _refreshController.Snapshot;
        ErrorMessage = _refreshController.ErrorMessage;
        if (ErrorMessage is null)
        {
            RefreshStatusMessage = "今日工作台已更新。";
            await RaiseLiveRegionChangedAfterVisibleAsync(LoadingStatusText);
        }
        IsLoading = _refreshController.IsLoading;
    }

    private void TodayWorkspaceView_OnLoaded(object sender, RoutedEventArgs e)
    {
        var resumedSession = _focusTimerController.OnLoaded(_focusSession);
        if (!ReferenceEquals(resumedSession, _focusSession))
        {
            _focusSession = resumedSession;
            RaiseFocusProperties();
        }

        _lifetimeCancellation?.Cancel();
        _lifetimeCancellation?.Dispose();
        _lifetimeGeneration++;
        _lifetimeCancellation = new CancellationTokenSource();
        _refreshTimer.Start();
        _focusTimer.Start();
        ApplyResponsiveLayout(ActualWidth);
        _ = RefreshAsync(TodayRefreshTrigger.Loaded);
    }

    private void TodayWorkspaceView_OnUnloaded(object sender, RoutedEventArgs e)
    {
        _refreshTimer.Stop();
        _focusTimer.Stop();
        _focusSession = _focusTimerController.OnUnloaded(_focusSession);
        RaiseFocusProperties();
        _refreshController.Stop();
        _lifetimeGeneration++;
        _lifetimeCancellation?.Cancel();
        _lifetimeCancellation?.Dispose();
        _lifetimeCancellation = null;
        IsLoading = false;
    }

    private void TodayWorkspaceView_OnSizeChanged(object sender, SizeChangedEventArgs e) =>
        ApplyResponsiveLayout(e.NewSize.Width);

    private void ApplyResponsiveLayout(double availableWidth)
    {
        var columns = TodayLayoutCoordinator.GetColumnCount(availableWidth);
        TodayLeftColumn.Margin = new Thickness(0);
        TodayTasksCard.Margin = new Thickness(0);
        TodayRightColumn.Margin = new Thickness(0);
        Grid.SetColumnSpan(TodayLeftColumn, 1);
        Grid.SetColumnSpan(TodayTasksCard, 1);
        Grid.SetColumnSpan(TodayRightColumn, 1);

        if (columns == 3)
        {
            TodayPrimaryColumn.Width = new GridLength(1.25, GridUnitType.Star);
            TodayFirstGutter.Width = new GridLength(16);
            TodaySecondaryColumn.Width = new GridLength(1, GridUnitType.Star);
            TodaySecondGutter.Width = new GridLength(16);
            TodayTertiaryColumn.Width = new GridLength(0.95, GridUnitType.Star);
            Grid.SetRow(TodayLeftColumn, 0);
            Grid.SetColumn(TodayLeftColumn, 0);
            Grid.SetRow(TodayTasksCard, 0);
            Grid.SetColumn(TodayTasksCard, 2);
            Grid.SetRow(TodayRightColumn, 0);
            Grid.SetColumn(TodayRightColumn, 4);
            return;
        }

        if (columns == 2)
        {
            TodayPrimaryColumn.Width = new GridLength(1, GridUnitType.Star);
            TodayFirstGutter.Width = new GridLength(16);
            TodaySecondaryColumn.Width = new GridLength(1, GridUnitType.Star);
            TodaySecondGutter.Width = new GridLength(0);
            TodayTertiaryColumn.Width = new GridLength(0);
            Grid.SetRow(TodayLeftColumn, 0);
            Grid.SetColumn(TodayLeftColumn, 0);
            Grid.SetRow(TodayTasksCard, 0);
            Grid.SetColumn(TodayTasksCard, 2);
            Grid.SetRow(TodayRightColumn, 1);
            Grid.SetColumn(TodayRightColumn, 0);
            Grid.SetColumnSpan(TodayRightColumn, 3);
            TodayRightColumn.Margin = new Thickness(0, 16, 0, 0);
            return;
        }

        TodayPrimaryColumn.Width = new GridLength(1, GridUnitType.Star);
        TodayFirstGutter.Width = new GridLength(0);
        TodaySecondaryColumn.Width = new GridLength(0);
        TodaySecondGutter.Width = new GridLength(0);
        TodayTertiaryColumn.Width = new GridLength(0);
        Grid.SetRow(TodayLeftColumn, 0);
        Grid.SetColumn(TodayLeftColumn, 0);
        Grid.SetRow(TodayTasksCard, 1);
        Grid.SetColumn(TodayTasksCard, 0);
        Grid.SetRow(TodayRightColumn, 2);
        Grid.SetColumn(TodayRightColumn, 0);
        TodayTasksCard.Margin = new Thickness(0, 16, 0, 0);
        TodayRightColumn.Margin = new Thickness(0, 16, 0, 0);
    }

    private async void RefreshTimer_OnTick(object? sender, EventArgs e) =>
        await RefreshAsync(TodayRefreshTrigger.Timer);

    private void FocusTimer_OnTick(object? sender, EventArgs e)
    {
        var next = _focusTimerController.Tick(_focusSession);
        if (ReferenceEquals(next, _focusSession))
            return;

        _focusSession = next;
        RaiseFocusProperties();
    }

    private async void RefreshButton_OnClick(object sender, RoutedEventArgs e) =>
        await RefreshAsync(TodayRefreshTrigger.Manual);

    private void FocusStartPauseButton_OnClick(object sender, RoutedEventArgs e)
    {
        _focusSession = _focusSession.IsRunning
            ? _focusTimerController.Pause(_focusSession)
            : _focusTimerController.Start(_focusSession);
        RaiseFocusProperties();
    }

    private void FocusResetButton_OnClick(object sender, RoutedEventArgs e)
    {
        _focusSession = _focusTimerController.Reset(_focusSession);
        RaiseFocusProperties();
    }

    private async void TaskCompletion_OnClick(object sender, RoutedEventArgs e)
    {
        if (sender is not CheckBox checkBox
            || checkBox.Tag is not string taskId
            || string.IsNullOrWhiteSpace(taskId))
        {
            return;
        }

        var desired = checkBox.IsChecked == true;
        var originGeneration = _lifetimeGeneration;
        var originatingToken = _lifetimeCancellation?.Token
                               ?? new CancellationToken(canceled: true);
        checkBox.IsEnabled = false;
        var outcome = await _taskWriteController.WriteAsync(
            taskId,
            desired,
            DateTime.Now,
            originatingToken,
            () => IsCurrentLifetime(originGeneration, originatingToken));
        if (!IsCurrentLifetime(originGeneration, originatingToken)
            || outcome == TodayTaskWriteOutcome.Stale)
        {
            return;
        }

        if (outcome == TodayTaskWriteOutcome.Revert)
        {
            checkBox.IsChecked = !desired;
            checkBox.IsEnabled = true;
            ErrorMessage = "任务状态保存失败，请重试。";
            return;
        }

        await RefreshAsync(TodayRefreshTrigger.TaskWrite);
        if (IsCurrentLifetime(originGeneration, originatingToken))
            checkBox.IsEnabled = true;
    }

    private bool IsCurrentLifetime(long generation, CancellationToken token) =>
        generation == _lifetimeGeneration && !token.IsCancellationRequested;

    private void TaskSourceButton_OnClick(object sender, RoutedEventArgs e)
    {
        if (sender is Button { Tag: TodayTaskItem task })
            SourceRequested?.Invoke(this, new TodaySourceRequestedEventArgs(TodayTimelineSource.Task, task.Id));
    }

    private void SourceButton_OnClick(object sender, RoutedEventArgs e)
    {
        if (sender is Button { Tag: TodayTimelineItem item })
            SourceRequested?.Invoke(this, new TodaySourceRequestedEventArgs(item.Source, item.Id));
    }

    private void NoteButton_OnClick(object sender, RoutedEventArgs e)
    {
        if (sender is Button { Tag: string fullPath } && !string.IsNullOrWhiteSpace(fullPath))
            NoteRequested?.Invoke(this, new TodayNoteRequestedEventArgs(fullPath));
    }

    private void AiButton_OnClick(object sender, RoutedEventArgs e) =>
        AiRequested?.Invoke(this, new TodayAiRequestedEventArgs(BuildDigestPrompt()));

    private void NotesButton_OnClick(object sender, RoutedEventArgs e) =>
        NotesRequested?.Invoke(this, EventArgs.Empty);

    private void CaptureButton_OnClick(object sender, RoutedEventArgs e) =>
        CaptureRequested?.Invoke(this, EventArgs.Empty);

    private string BuildDigestPrompt()
    {
        var digest = Snapshot?.Digest;
        return digest is null
            ? "请帮我规划今天的工作。"
            : $"请基于以下本地今日摘要，帮我梳理优先级和下一步行动。\n标题：{digest.Title}\n摘要：{digest.Body}";
    }

    private void RaiseSnapshotProperties()
    {
        string[] names =
        [
            nameof(DateLabel),
            nameof(WeeklyProgressLabel),
            nameof(TaskCountLabel),
            nameof(HasFocusTask),
            nameof(HasTimeline),
            nameof(HasTasks),
            nameof(HasNotes),
            nameof(ShowFocusEmpty),
            nameof(ShowTimelineEmpty),
            nameof(ShowTasksEmpty),
            nameof(ShowNotesEmpty),
            nameof(HasFocusSourceError),
            nameof(HasTimelineSourceError),
            nameof(HasTasksSourceError),
            nameof(HasNotesSourceError),
            nameof(FocusSourceErrorMessage),
            nameof(TimelineSourceErrorMessage),
            nameof(TasksSourceErrorMessage),
            nameof(NotesSourceErrorMessage),
            nameof(FocusDetail),
            nameof(DigestTitle),
            nameof(DigestSubtitle),
            nameof(DigestBody),
            nameof(DigestActionLabel),
            nameof(SourceWarningMessage),
            nameof(HasSourceWarnings)
        ];
        foreach (var name in names)
            OnPropertyChanged(name);
    }

    private void RaiseFocusProperties()
    {
        OnPropertyChanged(nameof(FocusTimeLabel));
        OnPropertyChanged(nameof(FocusProgressPercent));
        OnPropertyChanged(nameof(FocusStartPauseLabel));
    }

    private void QueueSnapshotLiveRegionChanges()
    {
        TextBlock[] targets =
        [
            SourceWarningStatusText,
            FocusSourceErrorStatusText,
            FocusEmptyState,
            TimelineSourceErrorStatusText,
            TimelineEmptyState,
            TasksSourceErrorStatusText,
            TasksEmptyState,
            NotesSourceErrorStatusText,
            NotesEmptyState
        ];
        foreach (var target in targets)
            QueueLiveRegionChange(target);
    }

    private void QueueLiveRegionChange(TextBlock target) =>
        _ = Dispatcher.InvokeAsync(
            () => TodayLiveRegionAutomation.RaiseChangedIfVisible(target),
            DispatcherPriority.Loaded);

    private async Task RaiseLiveRegionChangedAfterVisibleAsync(TextBlock target) =>
        await Dispatcher.InvokeAsync(
            () => TodayLiveRegionAutomation.RaiseChangedIfVisible(target),
            DispatcherPriority.Loaded);

    private bool SetProperty<T>(ref T field, T value, [CallerMemberName] string? propertyName = null)
    {
        if (EqualityComparer<T>.Default.Equals(field, value))
            return false;

        field = value;
        OnPropertyChanged(propertyName);
        return true;
    }

    private void OnPropertyChanged([CallerMemberName] string? propertyName = null) =>
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(propertyName));
}
