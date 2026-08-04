using System.Runtime.ExceptionServices;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Automation.Peers;
using System.Windows.Controls;
using System.Xml.Linq;
using DesktopAssistant;
using DesktopAssistant.Models;
using DesktopAssistant.Services;
using DesktopAssistant.Views;
using Xunit;

namespace DanceMonkey.Ui.Tests;

public sealed class TodayWorkspaceInteractionTests
{
    private static readonly XNamespace XamlNamespace = "http://schemas.microsoft.com/winfx/2006/xaml";

    [Fact]
    public void FocusSession_create_uses_requested_duration_and_starts_stopped()
    {
        var session = FocusSession.Create(TimeSpan.FromMinutes(25));

        Assert.Equal(TimeSpan.FromMinutes(25), session.Duration);
        Assert.Equal(TimeSpan.FromMinutes(25), session.Remaining);
        Assert.False(session.IsRunning);
        Assert.Equal("25:00", session.DisplayTime);
    }

    [Fact]
    public void FocusSession_start_then_tick_reduces_remaining_time()
    {
        var session = FocusSession.Create(TimeSpan.FromMinutes(25))
            .Start()
            .Tick(TimeSpan.FromSeconds(1));

        Assert.True(session.IsRunning);
        Assert.Equal("24:59", session.DisplayTime);
    }

    [Fact]
    public void FocusSession_pause_prevents_tick()
    {
        var paused = FocusSession.Create(TimeSpan.FromMinutes(25))
            .Start()
            .Pause();

        Assert.Same(paused, paused.Tick(TimeSpan.FromSeconds(1)));
        Assert.Equal("25:00", paused.DisplayTime);
        Assert.False(paused.IsRunning);
    }

    [Fact]
    public void FocusSession_reset_restores_duration_and_stops()
    {
        var session = FocusSession.Create(TimeSpan.FromMinutes(25))
            .Start()
            .Tick(TimeSpan.FromMinutes(4))
            .Reset();

        Assert.Equal(session.Duration, session.Remaining);
        Assert.False(session.IsRunning);
    }

    [Fact]
    public void FocusSession_tick_clamps_at_zero_and_stops()
    {
        var session = FocusSession.Create(TimeSpan.FromSeconds(3))
            .Start()
            .Tick(TimeSpan.FromSeconds(20));

        Assert.Equal(TimeSpan.Zero, session.Remaining);
        Assert.Equal("00:00", session.DisplayTime);
        Assert.False(session.IsRunning);
    }

    [Fact]
    public void FocusSession_start_at_zero_restarts_full_duration_cleanly()
    {
        var expired = FocusSession.Create(TimeSpan.FromSeconds(3))
            .Start()
            .Tick(TimeSpan.FromSeconds(3));

        var restarted = expired.Start();

        Assert.Equal(TimeSpan.FromSeconds(3), restarted.Remaining);
        Assert.True(restarted.IsRunning);
    }

    [Fact]
    public void RefreshCoordinator_cancels_previous_request_and_rejects_stale_completion()
    {
        var coordinator = new TodayRefreshCoordinator();
        var first = coordinator.Begin();
        var second = coordinator.Begin();
        var staleSnapshot = Snapshot("stale");
        var freshSnapshot = Snapshot("fresh");

        Assert.True(first.CancellationToken.IsCancellationRequested);
        Assert.False(coordinator.Complete(first.Generation, staleSnapshot));
        Assert.True(coordinator.Complete(second.Generation, freshSnapshot));
        Assert.Same(freshSnapshot, coordinator.Snapshot);
    }

    [Fact]
    public void RefreshCoordinator_failure_keeps_last_good_snapshot()
    {
        var coordinator = new TodayRefreshCoordinator();
        var goodSnapshot = Snapshot("good");
        var initial = coordinator.Begin();
        coordinator.Complete(initial.Generation, goodSnapshot);

        var failed = coordinator.Begin();
        Assert.True(coordinator.Fail(failed.Generation, "刷新失败"));

        Assert.Same(goodSnapshot, coordinator.Snapshot);
        Assert.Equal("刷新失败", coordinator.ErrorMessage);
        Assert.False(coordinator.IsLoading);
    }

    [Fact]
    public void RefreshCoordinator_stop_cancels_and_invalidates_in_flight_request()
    {
        var coordinator = new TodayRefreshCoordinator();
        var request = coordinator.Begin();

        coordinator.Stop();

        Assert.True(request.CancellationToken.IsCancellationRequested);
        Assert.False(coordinator.Complete(request.Generation, Snapshot("late")));
        Assert.False(coordinator.IsLoading);
    }

    [Theory]
    [InlineData(TodayDashboardCard.Focus, "Zen Task")]
    [InlineData(TodayDashboardCard.Tasks, "Zen Task")]
    [InlineData(TodayDashboardCard.Notes, "Notes")]
    [InlineData(TodayDashboardCard.Timeline, "Meetings")]
    [InlineData(TodayDashboardCard.Timeline, "Reminders")]
    [InlineData(TodayDashboardCard.Timeline, "Zen Task")]
    public void DashboardPresentation_relevant_source_error_suppresses_success_empty_state(
        TodayDashboardCard card,
        string source)
    {
        var snapshot = Snapshot("partial", [new TodaySourceError(source, "暂不可用")]);

        Assert.True(TodayDashboardPresentation.HasSourceError(snapshot, card));
        Assert.False(TodayDashboardPresentation.ShowEmpty(snapshot, card));
    }

    [Fact]
    public void DashboardPresentation_source_error_does_not_hide_unaffected_empty_cards()
    {
        var snapshot = Snapshot("partial", [new TodaySourceError("Notes", "暂不可用")]);

        Assert.False(TodayDashboardPresentation.ShowEmpty(snapshot, TodayDashboardCard.Notes));
        Assert.True(TodayDashboardPresentation.ShowEmpty(snapshot, TodayDashboardCard.Focus));
        Assert.True(TodayDashboardPresentation.ShowEmpty(snapshot, TodayDashboardCard.Tasks));
        Assert.True(TodayDashboardPresentation.ShowEmpty(snapshot, TodayDashboardCard.Timeline));
    }

    [Fact]
    public void DashboardPresentation_combined_errors_suppress_only_affected_success_empty_states()
    {
        var snapshot = Snapshot(
            "partial",
            [
                new TodaySourceError("Zen Task", "任务暂不可用"),
                new TodaySourceError("Meetings", "会议暂不可用")
            ]);

        Assert.False(TodayDashboardPresentation.ShowEmpty(snapshot, TodayDashboardCard.Focus));
        Assert.False(TodayDashboardPresentation.ShowEmpty(snapshot, TodayDashboardCard.Tasks));
        Assert.False(TodayDashboardPresentation.ShowEmpty(snapshot, TodayDashboardCard.Timeline));
        Assert.True(TodayDashboardPresentation.ShowEmpty(snapshot, TodayDashboardCard.Notes));
    }

    [Fact]
    public void DashboardPresentation_global_warning_requires_multiple_distinct_failed_sources()
    {
        Assert.False(
            TodayDashboardPresentation.ShowGlobalWarning(
                Snapshot("single", [new TodaySourceError("Notes", "one")])));
        Assert.False(
            TodayDashboardPresentation.ShowGlobalWarning(
                Snapshot(
                    "same-source",
                    [
                        new TodaySourceError("Notes", "one"),
                        new TodaySourceError("Notes", "two")
                    ])));
        Assert.True(
            TodayDashboardPresentation.ShowGlobalWarning(
                Snapshot(
                    "multiple",
                    [
                        new TodaySourceError("Notes", "one"),
                        new TodaySourceError("Meetings", "two")
                    ])));
    }

    [Theory]
    [InlineData(TodayDashboardCard.Focus, "Zen Task", "当前专注")]
    [InlineData(TodayDashboardCard.Timeline, "Meetings", "今日时间线")]
    [InlineData(TodayDashboardCard.Tasks, "Zen Task", "待处理任务")]
    [InlineData(TodayDashboardCard.Notes, "Notes", "最近笔记")]
    public void DashboardPresentation_source_error_message_names_its_card(
        TodayDashboardCard card,
        string source,
        string cardLabel)
    {
        var snapshot = Snapshot("partial", [new TodaySourceError(source, "暂不可用")]);

        Assert.StartsWith(
            $"{cardLabel}：",
            TodayDashboardPresentation.SourceErrorMessage(snapshot, card),
            StringComparison.Ordinal);
    }

    [Fact]
    public void FocusSessionLifecycle_running_session_consumes_wall_clock_time_while_away()
    {
        var lifecycle = new FocusSessionLifecycle();
        var session = FocusSession.Create(TimeSpan.FromMinutes(25)).Start();
        var unloadedAt = new DateTimeOffset(2026, 7, 24, 9, 0, 0, TimeSpan.Zero);

        lifecycle.OnUnloaded(session, unloadedAt);
        var resumed = lifecycle.OnLoaded(session, unloadedAt.AddSeconds(90));

        Assert.Equal("23:30", resumed.DisplayTime);
        Assert.True(resumed.IsRunning);
    }

    [Fact]
    public void FocusSessionLifecycle_paused_session_does_not_consume_time_while_away()
    {
        var lifecycle = new FocusSessionLifecycle();
        var paused = FocusSession.Create(TimeSpan.FromMinutes(25))
            .Start()
            .Tick(TimeSpan.FromMinutes(2))
            .Pause();
        var unloadedAt = new DateTimeOffset(2026, 7, 24, 9, 0, 0, TimeSpan.Zero);

        lifecycle.OnUnloaded(paused, unloadedAt);
        var resumed = lifecycle.OnLoaded(paused, unloadedAt.AddMinutes(10));

        Assert.Same(paused, resumed);
        Assert.Equal("23:00", resumed.DisplayTime);
    }

    [Fact]
    public void FocusSessionLifecycle_stops_at_zero_when_session_expires_while_away()
    {
        var lifecycle = new FocusSessionLifecycle();
        var session = FocusSession.Create(TimeSpan.FromSeconds(30)).Start();
        var unloadedAt = new DateTimeOffset(2026, 7, 24, 9, 0, 0, TimeSpan.Zero);

        lifecycle.OnUnloaded(session, unloadedAt);
        var resumed = lifecycle.OnLoaded(session, unloadedAt.AddMinutes(2));

        Assert.Equal("00:00", resumed.DisplayTime);
        Assert.False(resumed.IsRunning);
    }

    [Fact]
    public void FocusSessionLifecycle_repeated_load_does_not_apply_elapsed_time_twice()
    {
        var lifecycle = new FocusSessionLifecycle();
        var session = FocusSession.Create(TimeSpan.FromMinutes(25)).Start();
        var unloadedAt = new DateTimeOffset(2026, 7, 24, 9, 0, 0, TimeSpan.Zero);

        lifecycle.OnUnloaded(session, unloadedAt);
        var firstLoad = lifecycle.OnLoaded(session, unloadedAt.AddSeconds(90));
        var repeatedLoad = lifecycle.OnLoaded(firstLoad, unloadedAt.AddMinutes(4));

        Assert.Same(firstLoad, repeatedLoad);
        Assert.Equal("23:30", repeatedLoad.DisplayTime);
    }

    [Fact]
    public void FocusTimerController_delayed_dispatcher_tick_subtracts_actual_elapsed_time()
    {
        var time = new ManualTimeProvider();
        var controller = new FocusSessionTimerController(time);
        var session = controller.Start(FocusSession.Create(TimeSpan.FromMinutes(25)));

        time.Advance(TimeSpan.FromSeconds(10));
        session = controller.Tick(session);

        Assert.Equal("24:50", session.DisplayTime);
    }

    [Fact]
    public void FocusTimerController_pause_resume_and_reset_refresh_monotonic_anchor()
    {
        var time = new ManualTimeProvider();
        var controller = new FocusSessionTimerController(time);
        var session = controller.Start(FocusSession.Create(TimeSpan.FromMinutes(25)));
        time.Advance(TimeSpan.FromSeconds(7));
        session = controller.Pause(session);
        time.Advance(TimeSpan.FromMinutes(2));
        session = controller.Start(session);
        time.Advance(TimeSpan.FromSeconds(3));
        session = controller.Tick(session);

        Assert.Equal("24:50", session.DisplayTime);

        session = controller.Reset(session);
        time.Advance(TimeSpan.FromSeconds(20));
        session = controller.Tick(session);
        Assert.Equal("25:00", session.DisplayTime);
        Assert.False(session.IsRunning);
    }

    [Fact]
    public void FocusTimerController_reconciles_unloaded_elapsed_time_and_expiry_once()
    {
        var time = new ManualTimeProvider();
        var controller = new FocusSessionTimerController(time);
        var session = controller.Start(FocusSession.Create(TimeSpan.FromSeconds(30)));
        time.Advance(TimeSpan.FromSeconds(5));
        session = controller.OnUnloaded(session);
        time.Advance(TimeSpan.FromSeconds(40));
        session = controller.OnLoaded(session);
        var repeatedLoad = controller.OnLoaded(session);

        Assert.Equal("00:00", session.DisplayTime);
        Assert.False(session.IsRunning);
        Assert.Same(session, repeatedLoad);
    }

    [Fact]
    public async Task RefreshController_duplicate_loaded_navigation_and_timer_requests_are_single_flight()
    {
        var service = new DeferredTodayDashboardService();
        var controller = new TodayRefreshController(service, () => DateTime.Now);

        var navigation = controller.RequestAsync(TodayRefreshTrigger.Navigation);
        var loaded = controller.RequestAsync(TodayRefreshTrigger.Loaded);
        var timer = controller.RequestAsync(TodayRefreshTrigger.Timer);

        Assert.Equal(1, service.LoadCallCount);
        Assert.Equal(1, service.MaxConcurrentLoads);

        service.CompleteLoad(0, Snapshot("fresh"));
        await Task.WhenAll(navigation, loaded, timer);

        Assert.Equal(1, service.LoadCallCount);
        Assert.Equal("fresh", controller.Snapshot?.DateLabel);
    }

    [Fact]
    public async Task RefreshController_loaded_immediately_after_completed_navigation_reuses_fresh_result()
    {
        var service = new DeferredTodayDashboardService();
        var now = new DateTime(2026, 7, 24, 9, 0, 0);
        var controller = new TodayRefreshController(service, () => now);
        var navigation = controller.RequestAsync(TodayRefreshTrigger.Navigation);
        service.CompleteLoad(0, Snapshot("navigation"));
        await navigation;

        var loaded = controller.RequestAsync(TodayRefreshTrigger.Loaded);
        if (service.LoadCallCount > 1)
            service.CompleteLoad(1, Snapshot("duplicate"));
        await loaded;

        Assert.Equal(1, service.LoadCallCount);
        Assert.Equal("navigation", controller.Snapshot?.DateLabel);
    }

    [Fact]
    public async Task RefreshController_explicit_requests_coalesce_to_one_follow_up_without_overlap()
    {
        var service = new DeferredTodayDashboardService();
        var controller = new TodayRefreshController(service, () => DateTime.Now);

        var first = controller.RequestAsync(TodayRefreshTrigger.Navigation);
        var manual = controller.RequestAsync(TodayRefreshTrigger.Manual);
        var settings = controller.RequestAsync(TodayRefreshTrigger.Settings);
        Assert.Equal(1, service.LoadCallCount);

        service.CompleteLoad(0, Snapshot("first"));
        await service.WaitForLoadCountAsync(2);
        Assert.Equal(1, service.MaxConcurrentLoads);
        service.CompleteLoad(1, Snapshot("second"));
        await Task.WhenAll(first, manual, settings);

        Assert.Equal(2, service.LoadCallCount);
        Assert.Equal("second", controller.Snapshot?.DateLabel);
    }

    [Fact]
    public async Task RefreshController_unload_suppresses_late_apply_even_when_loader_ignores_cancellation()
    {
        var service = new DeferredTodayDashboardService();
        var controller = new TodayRefreshController(service, () => DateTime.Now);
        var refresh = controller.RequestAsync(TodayRefreshTrigger.Loaded);

        controller.Stop();
        service.CompleteLoad(0, Snapshot("late"));
        await refresh;

        Assert.Null(controller.Snapshot);
        Assert.False(controller.IsLoading);
    }

    [Fact]
    public async Task TaskWriteController_old_lifetime_completion_is_stale_and_gate_is_released()
    {
        var service = new DeferredTodayDashboardService();
        var controller = new TodayTaskWriteController(service);
        using var lifetime = new CancellationTokenSource();
        var currentGeneration = 1L;

        var write = controller.WriteAsync(
            "task",
            true,
            DateTime.Now,
            lifetime.Token,
            () => currentGeneration == 1);
        currentGeneration = 2;
        lifetime.Cancel();
        service.CompleteWrite(0, true);

        Assert.Equal(TodayTaskWriteOutcome.Stale, await write);
        Assert.Equal(0, controller.ActiveGateCount);
    }

    [Fact]
    public async Task TaskWriteController_serializes_rapid_intents_without_rolling_back_superseded_intent()
    {
        var service = new DeferredTodayDashboardService();
        var controller = new TodayTaskWriteController(service);

        var check = controller.WriteAsync(
            "task",
            true,
            DateTime.Now,
            CancellationToken.None,
            () => true);
        var uncheck = controller.WriteAsync(
            "task",
            false,
            DateTime.Now,
            CancellationToken.None,
            () => true);

        Assert.Equal([true], service.WriteIntents);
        service.CompleteWrite(0, false);
        await service.WaitForWriteCountAsync(2);
        Assert.Equal([true, false], service.WriteIntents);
        service.CompleteWrite(1, true);

        Assert.Equal(TodayTaskWriteOutcome.Stale, await check);
        Assert.Equal(TodayTaskWriteOutcome.Applied, await uncheck);
        Assert.Equal(0, controller.ActiveGateCount);
    }

    [Fact]
    public async Task TaskWriteController_does_not_revert_when_superseded_write_throws()
    {
        var service = new DeferredTodayDashboardService();
        var controller = new TodayTaskWriteController(service);

        var check = controller.WriteAsync(
            "task",
            true,
            DateTime.Now,
            CancellationToken.None,
            () => true);
        var uncheck = controller.WriteAsync(
            "task",
            false,
            DateTime.Now,
            CancellationToken.None,
            () => true);

        service.FailWrite(0);
        await service.WaitForWriteCountAsync(2);
        service.CompleteWrite(1, true);

        Assert.Equal(TodayTaskWriteOutcome.Stale, await check);
        Assert.Equal(TodayTaskWriteOutcome.Applied, await uncheck);
        Assert.Equal(0, controller.ActiveGateCount);
    }

    [Theory]
    [InlineData(492, 1)]
    [InlineData(712, 2)]
    [InlineData(1099, 2)]
    [InlineData(1100, 3)]
    [InlineData(1920, 3)]
    public void LayoutCoordinator_uses_expected_responsive_columns(double width, int columns) =>
        Assert.Equal(columns, TodayLayoutCoordinator.GetColumnCount(width));

    [Theory]
    [InlineData(TodayTimelineSource.Task, AppPage.Todo)]
    [InlineData(TodayTimelineSource.Meeting, AppPage.MeetingAssistant)]
    [InlineData(TodayTimelineSource.Reminder, AppPage.ScheduledReminders)]
    public void SourceRouter_preserves_exact_id_and_destination(
        TodayTimelineSource source,
        AppPage expectedPage)
    {
        var route = TodaySourceRouter.Resolve(source, "stable-id");

        Assert.Equal(expectedPage, route.Page);
        Assert.Equal("stable-id", route.Id);
    }

    [Fact]
    public void Source_views_expose_exact_id_selection_entry_points()
    {
        Assert.NotNull(typeof(TodoView).GetMethod("OpenTaskById"));
        Assert.NotNull(typeof(MeetingAssistantView).GetMethod("OpenMeetingById"));
        Assert.NotNull(typeof(ScheduledRemindersView).GetMethod("OpenReminderById"));
    }

    [Fact]
    public void Today_workspace_binds_real_snapshot_collections_without_indexed_rows()
    {
        var xaml = File.ReadAllText(ProjectPath("Views", "TodayWorkspaceView.xaml"));

        Assert.Contains("ItemsSource=\"{Binding Snapshot.Timeline}\"", xaml, StringComparison.Ordinal);
        Assert.Contains("ItemsSource=\"{Binding Snapshot.Tasks}\"", xaml, StringComparison.Ordinal);
        Assert.Contains("ItemsSource=\"{Binding Snapshot.RecentNotes}\"", xaml, StringComparison.Ordinal);
        Assert.DoesNotMatch(new Regex(@"\[[0-9]+\]", RegexOptions.CultureInvariant), xaml);
    }

    [Fact]
    public void Today_workspace_has_named_refresh_loading_error_and_empty_states()
    {
        var document = LoadTodayXaml();
        var names = document
            .Root!
            .DescendantsAndSelf()
            .Select(element => (string?)element.Attribute(XamlNamespace + "Name"))
            .Where(name => name is not null)
            .ToHashSet(StringComparer.Ordinal);

        string[] requiredNames =
        [
            "RefreshButton",
            "LoadingState",
            "ErrorState",
            "SourceWarningState",
            "FocusEmptyState",
            "TimelineEmptyState",
            "TasksEmptyState",
            "NotesEmptyState"
        ];

        Assert.All(requiredNames, name => Assert.Contains(name, names));
        string[] sourceErrorStateNames =
        [
            "FocusSourceErrorState",
            "TimelineSourceErrorState",
            "TasksSourceErrorState",
            "NotesSourceErrorState"
        ];
        Assert.All(sourceErrorStateNames, name => Assert.Contains(name, names));
        Assert.Equal(
            "{Binding ShowFocusEmpty}",
            (string?)FindNamedElement(document, "FocusEmptyState").Attribute("Tag"));
        Assert.Equal(
            "{Binding ShowTimelineEmpty}",
            (string?)FindNamedElement(document, "TimelineEmptyState").Attribute("Tag"));
        Assert.Equal(
            "{Binding ShowTasksEmpty}",
            (string?)FindNamedElement(document, "TasksEmptyState").Attribute("Tag"));
        Assert.Equal(
            "{Binding ShowNotesEmpty}",
            (string?)FindNamedElement(document, "NotesEmptyState").Attribute("Tag"));
        Assert.Contains(
            document.Descendants(),
            element => element.Name.LocalName == "Button"
                       && (string?)element.Attribute("Click") == "RefreshButton_OnClick");
    }

    [Fact]
    public void Today_workspace_uses_shared_scheme_one_cards_buttons_and_tokens()
    {
        var document = LoadTodayXaml();
        var xaml = File.ReadAllText(ProjectPath("Views", "TodayWorkspaceView.xaml"));

        Assert.DoesNotContain("#", xaml, StringComparison.Ordinal);
        Assert.DoesNotContain("GridOverlay", xaml, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("BrushChat", xaml, StringComparison.Ordinal);
        Assert.Contains(
            document.Descendants(),
            element => element.Name.LocalName == "Border"
                       && (string?)element.Attribute("Style") == "{StaticResource UiCard}");

        var allowedButtonStyles = new HashSet<string>(StringComparer.Ordinal)
        {
            "{StaticResource UiBtnPrimary}",
            "{StaticResource UiBtnSecondary}",
            "{StaticResource UiBtnGhost}"
        };
        var buttons = document.Descendants().Where(element => element.Name.LocalName == "Button").ToArray();
        Assert.NotEmpty(buttons);
        Assert.All(
            buttons,
            button => Assert.Contains(
                (string?)button.Attribute("Style") ?? string.Empty,
                allowedButtonStyles));
    }

    [Fact]
    public void Today_workspace_focus_progress_binds_one_way_to_read_only_session_state()
    {
        var document = LoadTodayXaml();
        var progressBar = document
            .Descendants()
            .Single(element => element.Name.LocalName == "ProgressBar"
                               && (string?)element.Attribute("Value") is string value
                               && value.Contains("FocusProgressPercent", StringComparison.Ordinal));

        Assert.Contains("Mode=OneWay", (string?)progressBar.Attribute("Value") ?? string.Empty,
            StringComparison.Ordinal);
    }

    [Fact]
    public void Today_workspace_routes_task_note_and_timeline_source_identifiers()
    {
        var document = LoadTodayXaml();

        Assert.Contains(
            document.Descendants(),
            element => element.Name.LocalName == "CheckBox"
                       && (string?)element.Attribute("Tag") == "{Binding Id}"
                       && (string?)element.Attribute("Click") == "TaskCompletion_OnClick");
        Assert.Contains(
            document.Descendants(),
            element => element.Name.LocalName == "Button"
                       && (string?)element.Attribute("Tag") == "{Binding FullPath}"
                       && (string?)element.Attribute("Click") == "NoteButton_OnClick");
        Assert.Contains(
            document.Descendants(),
            element => element.Name.LocalName == "Button"
                       && (string?)element.Attribute("Tag") == "{Binding}"
                       && (string?)element.Attribute("Click") == "SourceButton_OnClick");
    }

    [Fact]
    public void Today_workspace_contains_no_fake_sample_rows()
    {
        var xaml = File.ReadAllText(ProjectPath("Views", "TodayWorkspaceView.xaml"));

        string[] fakeSamples =
        [
            "PRD",
            "用户反馈",
            "落地页文案",
            "官网改版",
            "备份本地笔记",
            "50:00"
        ];

        Assert.All(fakeSamples, sample => Assert.DoesNotContain(sample, xaml, StringComparison.Ordinal));
    }

    [Fact]
    public void Today_workspace_is_responsive_metadata_rich_and_accessible()
    {
        var xaml = File.ReadAllText(ProjectPath("Views", "TodayWorkspaceView.xaml"));

        Assert.DoesNotContain("MinWidth=\"980\"", xaml, StringComparison.Ordinal);
        Assert.Contains("x:Name=\"TodayColumnsGrid\"", xaml, StringComparison.Ordinal);
        Assert.Contains("Text=\"{Binding EnergyLabel}\"", xaml, StringComparison.Ordinal);
        Assert.Contains("Text=\"{Binding DueLabel}\"", xaml, StringComparison.Ordinal);
        Assert.Contains("Text=\"{Binding NotesSummary}\"", xaml, StringComparison.Ordinal);
        Assert.Contains("automation:AutomationProperties.Name=\"{Binding Title}\"", xaml, StringComparison.Ordinal);
        Assert.Contains("automation:AutomationProperties.LiveSetting=\"Polite\"", xaml, StringComparison.Ordinal);
        Assert.DoesNotContain("Foreground=\"{DynamicResource BrushTextMuted}\"", xaml, StringComparison.Ordinal);
        Assert.Contains("Text=\"{Binding SourceLabel}\"", xaml, StringComparison.Ordinal);
    }

    [Fact]
    public void Today_live_region_targets_are_peer_backed_polite_text_blocks()
    {
        RunOnStaThread(() =>
        {
            var application = new Application();
            try
            {
                application.Resources.MergedDictionaries.Add(new ResourceDictionary
                {
                    Source = new Uri(
                        "pack://application:,,,/DanceMonkey;component/Themes/DesignTokens.xaml",
                        UriKind.Absolute)
                });
                application.Resources.MergedDictionaries.Add(new ResourceDictionary
                {
                    Source = new Uri(
                        "pack://application:,,,/DanceMonkey;component/Themes/Controls.xaml",
                        UriKind.Absolute)
                });

                var view = new TodayWorkspaceView(new DeferredTodayDashboardService());
                string[] targetNames =
                [
                    "LoadingStatusText",
                    "ErrorStatusText",
                    "SourceWarningStatusText",
                    "FocusSourceErrorStatusText",
                    "FocusEmptyState",
                    "TimelineSourceErrorStatusText",
                    "TimelineEmptyState",
                    "TasksSourceErrorStatusText",
                    "TasksEmptyState",
                    "NotesSourceErrorStatusText",
                    "NotesEmptyState"
                ];

                foreach (var targetName in targetNames)
                {
                    var textBlock = Assert.IsType<TextBlock>(view.FindName(targetName));
                    Assert.Equal(
                        AutomationLiveSetting.Polite,
                        AutomationProperties.GetLiveSetting(textBlock));

                    var firstMessage = $"{targetName} 当前消息";
                    textBlock.Text = firstMessage;
                    var peer = Assert.IsAssignableFrom<TextBlockAutomationPeer>(
                        TodayLiveRegionAutomation.GetPeer(textBlock));
                    Assert.Equal(firstMessage, peer.GetName());

                    var updatedMessage = $"{targetName} 已更新消息";
                    textBlock.Text = updatedMessage;
                    Assert.Equal(updatedMessage, peer.GetName());
                    Assert.Equal(targetName, AutomationProperties.GetAutomationId(textBlock));
                }

                string[] peerlessContainerNames =
                [
                    "LoadingState",
                    "ErrorState",
                    "SourceWarningState",
                    "FocusSourceErrorState",
                    "TimelineSourceErrorState",
                    "TasksSourceErrorState",
                    "NotesSourceErrorState"
                ];
                foreach (var containerName in peerlessContainerNames)
                {
                    var container = Assert.IsType<Border>(view.FindName(containerName));
                    Assert.Equal(
                        AutomationLiveSetting.Off,
                        AutomationProperties.GetLiveSetting(container));
                }

                var peerlessContainer = new Border();
                AutomationProperties.SetLiveSetting(
                    peerlessContainer,
                    AutomationLiveSetting.Polite);
                Assert.Null(UIElementAutomationPeer.CreatePeerForElement(peerlessContainer));
                Assert.Null(TodayLiveRegionAutomation.GetPeer(peerlessContainer));
                view.DataContext = null;

                var visibleTarget = new TextBlock { Text = "刷新完成" };
                AutomationProperties.SetAutomationId(visibleTarget, "RefreshStatus");
                AutomationProperties.SetLiveSetting(
                    visibleTarget,
                    AutomationLiveSetting.Polite);
                var host = new Window
                {
                    Content = visibleTarget,
                    ShowActivated = false,
                    ShowInTaskbar = false,
                    WindowStyle = WindowStyle.ToolWindow,
                    Width = 1,
                    Height = 1,
                    Opacity = 0
                };
                try
                {
                    host.Show();
                    AutomationEvents? raisedEvent = null;
                    AutomationPeer? raisedPeer = null;
                    var peer = Assert.IsAssignableFrom<TextBlockAutomationPeer>(
                        TodayLiveRegionAutomation.GetPeer(visibleTarget));
                    var previousName = peer.GetName();
                    visibleTarget.Text = "刷新完成，当前数据已更新";

                    Assert.True(TodayLiveRegionAutomation.RaiseChangedIfVisible(
                        visibleTarget,
                        (peer, automationEvent) =>
                        {
                            raisedPeer = peer;
                            raisedEvent = automationEvent;
                        }));
                    Assert.NotNull(raisedPeer);
                    Assert.Equal(AutomationEvents.LiveRegionChanged, raisedEvent);
                    Assert.NotEqual(previousName, peer.GetName());
                    Assert.Contains("当前数据已更新", peer.GetName(), StringComparison.Ordinal);
                }
                finally
                {
                    host.Close();
                }
            }
            finally
            {
                application.Shutdown();
            }
        });
    }

    private static XDocument LoadTodayXaml() =>
        XDocument.Load(ProjectPath("Views", "TodayWorkspaceView.xaml"), LoadOptions.PreserveWhitespace);

    private static TodayDashboardSnapshot Snapshot(
        string label,
        IReadOnlyList<TodaySourceError>? sourceErrors = null) =>
        new(
            DateTime.Now,
            label,
            null,
            0,
            0,
            0,
            [],
            [],
            new TodayDigest("摘要", string.Empty, string.Empty, "打开"),
            [],
            sourceErrors ?? []);

    private static XElement FindNamedElement(XDocument document, string name) =>
        document
            .Descendants()
            .Single(element => (string?)element.Attribute(XamlNamespace + "Name") == name);

    private static void RunOnStaThread(Action action)
    {
        Exception? failure = null;
        var thread = new Thread(() =>
        {
            try
            {
                action();
            }
            catch (Exception ex)
            {
                failure = ex;
            }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        thread.Join();

        if (failure is not null)
            ExceptionDispatchInfo.Capture(failure).Throw();
    }

    private sealed class ManualTimeProvider : TimeProvider
    {
        private DateTimeOffset _utcNow = new(2026, 7, 24, 0, 0, 0, TimeSpan.Zero);
        private long _timestamp;

        public override long TimestampFrequency => TimeSpan.TicksPerSecond;

        public override DateTimeOffset GetUtcNow() => _utcNow;

        public override long GetTimestamp() => _timestamp;

        public void Advance(TimeSpan elapsed)
        {
            _utcNow += elapsed;
            _timestamp += elapsed.Ticks;
        }
    }

    private sealed class DeferredTodayDashboardService : ITodayDashboardService
    {
        private readonly List<TaskCompletionSource<TodayDashboardSnapshot>> _loads = [];
        private readonly List<TaskCompletionSource<bool>> _writes = [];
        private int _concurrentLoads;

        public int LoadCallCount => _loads.Count;

        public int WriteCallCount => _writes.Count;

        public int MaxConcurrentLoads { get; private set; }

        public IReadOnlyList<bool> WriteIntents { get; private set; } = [];

        public async Task<TodayDashboardSnapshot> LoadAsync(
            DateTime now,
            CancellationToken cancellationToken)
        {
            var completion = new TaskCompletionSource<TodayDashboardSnapshot>(
                TaskCreationOptions.RunContinuationsAsynchronously);
            _loads.Add(completion);
            _concurrentLoads++;
            MaxConcurrentLoads = Math.Max(MaxConcurrentLoads, _concurrentLoads);
            try
            {
                return await completion.Task;
            }
            finally
            {
                _concurrentLoads--;
            }
        }

        public async Task<bool> SetTaskCompletionAsync(
            string taskId,
            bool completed,
            DateTime now,
            CancellationToken cancellationToken)
        {
            WriteIntents = WriteIntents.Append(completed).ToArray();
            var completion = new TaskCompletionSource<bool>(
                TaskCreationOptions.RunContinuationsAsynchronously);
            _writes.Add(completion);
            return await completion.Task;
        }

        public void CompleteLoad(int index, TodayDashboardSnapshot snapshot) =>
            _loads[index].SetResult(snapshot);

        public void CompleteWrite(int index, bool result) =>
            _writes[index].SetResult(result);

        public void FailWrite(int index) =>
            _writes[index].SetException(new InvalidOperationException("write failed"));

        public async Task WaitForLoadCountAsync(int count)
        {
            for (var attempt = 0; attempt < 100 && LoadCallCount < count; attempt++)
                await Task.Yield();
            Assert.Equal(count, LoadCallCount);
        }

        public async Task WaitForWriteCountAsync(int count)
        {
            for (var attempt = 0; attempt < 100 && WriteCallCount < count; attempt++)
                await Task.Yield();
            Assert.Equal(count, WriteCallCount);
        }
    }

    private static string ProjectPath(params string[] segments)
    {
        var root = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", ".."));
        return Path.Combine([root, .. segments]);
    }
}
