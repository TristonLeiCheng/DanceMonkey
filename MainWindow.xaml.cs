using System.ComponentModel;
using System.Linq;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Threading;
using DesktopAssistant.Controllers;
using DesktopAssistant.Services;
using DesktopAssistant.Views;
using Forms = System.Windows.Forms;

namespace DesktopAssistant;

public partial class MainWindow : Window
{
    private NoteService.ContinuousScreenshotSession? _continuousScreenshotSession;
    private ContinuousScreenshotOverlayWindow? _continuousScreenshotOverlay;
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    private static extern IntPtr FindWindow(string? lpClassName, string? lpWindowName);
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    private static extern IntPtr FindWindowEx(IntPtr parentHandle, IntPtr childAfter, string? className, string? windowTitle);
    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    private const int WM_GETMINMAXINFO = 0x0024;

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MINMAXINFO
    {
        public POINT ptReserved;
        public POINT ptMaxSize;
        public POINT ptMaxPosition;
        public POINT ptMinTrackSize;
        public POINT ptMaxTrackSize;
    }

    private GlobalChatWindow? _globalChat;
    private HwndSource? _hwndSource;
    private readonly GlobalHotkeyController _hotkeys;

    private readonly NetworkMonitorView _networkMonitorView = new();
    private readonly CleanupView _cleanupView = new();
    private readonly CodexProxyView _codexProxyView = new();
    private readonly QuickAccessView _quickAccessView = new();
    private readonly AiChatView _aiChatView = new();
    private readonly NotesView _notesView = new();
    private readonly PptWorkspaceView _pptWorkspaceView = new();
    private readonly TodoView _todoView = new();
    private readonly PdfToolsView _pdfToolsView = new();
    private readonly FileToolsView _fileToolsView = new();
    private readonly DanceView _danceView = new();
    private readonly MeetingAssistantView _meetingAssistantView = new();
    private readonly FileManagerView _fileManagerView = new();
    private readonly PasswordVaultView _passwordVaultView = new();
    private readonly SettingsView _settingsView = new();
    private readonly HomepageView _homepageView = new();
    private readonly ProcessDiagnosticsView _processDiagnosticsView = new();
    private readonly HealthReminderService _healthReminder = new();
    private readonly ProxyEnforcementService _proxyEnforcement = new();

    private readonly Button[] _navButtons;
    private readonly TrayController _tray;
    private FloatingIconWindow? _floating;
    private DockWindow? _dock;
    private DesktopPetWindow? _petWindow;
    private bool _exitRequested;
    private bool _clipboardMonitor;
    private readonly DispatcherTimer _clipboardTimer;
    private readonly DispatcherTimer _networkAlertTimer;
    private readonly DispatcherTimer _resourceMonitorTimer;
    private readonly ResourceMonitorService _resourceMonitor = new();
    private TaskbarResourceStripWindow? _taskbarResourceStripWindow;
    private bool _networkTrayOk = true;
    private bool _sidebarCollapsed;
    private bool _healthReminderPopupOpen;

    public MainWindow()
    {
        InitializeComponent();
        VersionLabel.Text = AppVersionService.GetSidebarVersionLabel();

        _navButtons =
        [
            NavAiChat, NavNotes, NavPpt, NavTodo, NavQuickAccess, NavHomepage, NavMeeting, NavFileManager, NavFileTools,
            NavPdfTools, NavCleanup, NavCodexProxy, NavNetwork, NavPasswordVault, NavProcessDiag, NavDance, NavSettings
        ];


        _danceView.PetModeChanged   += (_, _) => SyncPetMode();

        StateChanged += (_, _) => UpdateMaximizeCaption();
        UpdateMaximizeCaption();

        _floating = new FloatingIconWindow(
            this,
            () => App.Config.Load(),
            cfg => App.Config.Save(cfg));
        _settingsView.SettingsSaved += OnSettingsSaved;
        _quickAccessView.CreateFolderSyncRequested += (path, name) =>
        {
            ShowAndSwitch(AppPage.Settings);
            _settingsView.PrefillFolderSyncProfile(path, name);
        };

        _clipboardTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1.2) };
        _clipboardTimer.Tick += (_, _) =>
        {
            if (_clipboardMonitor)
                App.ClipboardHistory.Tick();
        };
        _clipboardTimer.Start();

        _networkAlertTimer = new DispatcherTimer { Interval = TimeSpan.FromMinutes(3) };
        _networkAlertTimer.Tick += (_, _) =>
        {
            var ok = NetworkMonitorService.GetIsNetworkAvailable();
            if (!ok && _networkTrayOk)
                _tray.ShowTip(AppBranding.DisplayName, L("Tray.NetworkUnavailable"), 6000, Forms.ToolTipIcon.Warning);
            _networkTrayOk = ok;
        };
        _networkAlertTimer.Start();

        var sec = Math.Clamp(App.Config.Load().TaskbarResourceMonitorIntervalSeconds, 1, 10);
        _resourceMonitorTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(sec) };
        _resourceMonitorTimer.Tick += (_, _) => UpdateTrayResourceMonitor();
        _resourceMonitorTimer.Start();

        _hotkeys = new GlobalHotkeyController(
            getHotkeyStrings: () =>
            {
                var cfg = App.Config.Load();
                var global = string.IsNullOrWhiteSpace(cfg.GlobalChatHotkey) ? "Ctrl+Shift+Q" : cfg.GlobalChatHotkey;
                var quick = string.IsNullOrWhiteSpace(cfg.QuickScreenshotHotkey) ? "Ctrl+Shift+S" : cfg.QuickScreenshotHotkey;
                var region = string.IsNullOrWhiteSpace(cfg.RegionScreenshotHotkey) ? "Ctrl+Shift+R" : cfg.RegionScreenshotHotkey;
                return (global, quick, region);
            },
            onGlobalChat: ToggleGlobalChat,
            onQuickScreenshot: TrayQuickScreenshot,
            onRegionScreenshot: TrayRegionScreenshot);

        _tray = new TrayController(
            localize: L,
            onShowMain: ShowFromTray,
            onShowAndSwitch: ShowAndSwitch,
            onTogglePet: TogglePetMode,
            onToggleResourceMonitor: ToggleTaskbarResourceMonitor,
            onQuickScreenshot: TrayQuickScreenshot,
            onRegionScreenshot: TrayRegionScreenshot,
            onScrollScreenshot: TrayScrollScreenshot,
            onContinuousScreenshot: StartContinuousScreenshotMode,
            onShowFloating: ShowFloatingFromTray,
            onShowDock: ShowDockWindow,
            onExit: QuitApplication,
            onTrayMenuClosed: () =>
                Dispatcher.BeginInvoke(DispatcherPriority.Background, new Action(RestoreTaskbarResourceStripAfterTrayMenu)),
            onApplyPac: ApplyPacFromTray,
            onApplyManualProxy: ApplyManualProxyFromTray,
            onDisableProxyForce: DisableProxyForceFromTray);

        Loaded += (_, _) =>
        {
            RefreshClipboardMonitorFlag();
            SyncPetMode();
            InitGlobalChatHotkey();
            if (App.Config.Load().NotesRestoreStickiesOnStartup)
            {
                var notes = new NoteService(App.Config.Load().NotesRootPath);
                StickyNoteManager.RestoreFromDisk(notes);
            }

            Dispatcher.BeginInvoke(
                new Action(() => _floating?.ApplyPlacement()),
                DispatcherPriority.ApplicationIdle);

            InitHealthReminder();
            RefreshProxyEnforcement();
        };

        SwitchPage(AppPage.Notes);

        _tray.Start();
        SyncTrayResourceToggleMenuState();
        UpdateTrayResourceMonitor();
    }

    private void OnSettingsSaved(object? sender, EventArgs e)
    {
        _floating?.ApplyPlacement();
        RefreshClipboardMonitorFlag();
        SyncPetMode();
        _notesView.ReloadServiceAndList();
        _quickAccessView.RefreshFromConfig();
        _aiChatView.ReloadPromptSnippets();
        _aiChatView.ReloadModelSelector();
        _hotkeys.Register(); // re-register in case hotkey changed
        RefreshHealthReminder();
        _todoView.ReloadReminderSettings();
        RefreshProxyEnforcement();
        _settingsView.ReloadSkillManagerForSandboxChange();
        RefreshResourceMonitorInterval();
        SyncTrayResourceToggleMenuState();
        UpdateTrayResourceMonitor();
    }

    public void TogglePetMode()
    {
        var cfg = App.Config.Load();
        cfg.PetModeEnabled = !cfg.PetModeEnabled;
        if (!App.Config.Save(cfg))
        {
            _tray.ShowTip(AppBranding.DisplayName, "桌面宠物模式切换失败。", 3000, Forms.ToolTipIcon.Error);
            return;
        }

        SyncPetMode();
        var text = cfg.PetModeEnabled ? "桌面宠物模式已开启" : "桌面宠物模式已关闭";
        _tray.ShowTip(AppBranding.DisplayName, text, 2000, Forms.ToolTipIcon.Info);
    }

    /// <summary>同步桌面宠物窗口（右下角，替代悬浮球）。</summary>
    public void SyncPetMode()
    {
        var cfg = App.Config.Load();
        SleepPreventionService.SetEnabled(cfg.PetModeEnabled);
        SyncTrayPetMenuState();
        if (cfg.PetModeEnabled)
        {
            _floating?.Hide();

            if (_petWindow == null)
            {
                _petWindow = new DesktopPetWindow(
                    this,
                    () => App.Config.Load(),
                    c => App.Config.Save(c));
                _petWindow.Closed += (_, _) => _petWindow = null;
            }

            _petWindow.ApplyPlacement();
            _petWindow.ApplyAnimal(cfg.PetAnimal);
            _petWindow.ApplySize(cfg.PetDisplaySize);
            _petWindow.RefreshTaskReminderSettings();
        }
        else
        {
            if (_petWindow != null)
            {
                try { _petWindow.Close(); } catch { /* ignore */ }
                _petWindow = null;
            }

            _floating?.ApplyPlacement();
        }
    }

    private void SyncTrayPetMenuState()
    {
        var enabled = App.Config.Load().PetModeEnabled;
        _tray.SetPetToggleState(enabled);
    }

    private void ToggleTaskbarResourceMonitor()
    {
        var cfg = App.Config.Load();
        cfg.TaskbarResourceMonitorEnabled = !cfg.TaskbarResourceMonitorEnabled;
        if (!App.Config.Save(cfg))
        {
            _tray.ShowTip(AppBranding.DisplayName, "资源监控切换失败。", 3000, Forms.ToolTipIcon.Error);
            return;
        }

        SyncTrayResourceToggleMenuState();
        UpdateTrayResourceMonitor();
        var text = cfg.TaskbarResourceMonitorEnabled ? "资源监控已开启" : "资源监控已关闭";
        _tray.ShowTip(AppBranding.DisplayName, text, 2000, Forms.ToolTipIcon.Info);
    }

    private void SyncTrayResourceToggleMenuState()
    {
        var enabled = App.Config.Load().TaskbarResourceMonitorEnabled;
        _tray.SetResourceToggleState(enabled);
    }

    private void RefreshClipboardMonitorFlag() =>
        _clipboardMonitor = App.Config.Load().ClipboardHistoryEnabled;

    private void RefreshResourceMonitorInterval()
    {
        var sec = Math.Clamp(App.Config.Load().TaskbarResourceMonitorIntervalSeconds, 1, 10);
        _resourceMonitorTimer.Interval = TimeSpan.FromSeconds(sec);
    }

    private void UpdateTrayResourceMonitor()
    {
        var cfg = App.Config.Load();
        var enabled = cfg.TaskbarResourceMonitorEnabled;
        if (!enabled)
        {
            _tray.SetResourceMenuVisible(false);
            _tray.SetTooltip(AppBranding.DisplayName);
            _taskbarResourceStripWindow?.Hide();
            return;
        }

        var snap = _resourceMonitor.Capture();
        _tray.UpdateResourceSnapshot(
            snap,
            networkLine: $"网络: ↓ {FormatRate(snap.DownloadKbps)} / ↑ {FormatRate(snap.UploadKbps)}",
            tooltipText: BuildTrayTooltipText(snap));
        UpdateTaskbarResourceStrip(snap);
    }

    private void UpdateTaskbarResourceStrip(ResourceSnapshot snap)
    {
        if (_taskbarResourceStripWindow == null)
        {
            _taskbarResourceStripWindow = new TaskbarResourceStripWindow();
            _taskbarResourceStripWindow.LocationChanged += (_, _) => SaveTaskbarResourceStripPlacement();
            var cfg = App.Config.Load();
            if (cfg.TaskbarResourceMonitorWindowX.HasValue && cfg.TaskbarResourceMonitorWindowY.HasValue)
            {
                _taskbarResourceStripWindow.Left = cfg.TaskbarResourceMonitorWindowX.Value;
                _taskbarResourceStripWindow.Top = cfg.TaskbarResourceMonitorWindowY.Value;
            }
            else
            {
                PositionTaskbarResourceStrip(_taskbarResourceStripWindow);
            }
        }
        _taskbarResourceStripWindow.UpdateDisplay(
            FormatRate(snap.UploadKbps),
            FormatRate(snap.DownloadKbps),
            $"{snap.CpuPercent:F0}%",
            $"{snap.MemoryPercent:F0}%");
        if (_taskbarResourceStripWindow.WindowState != WindowState.Normal)
            _taskbarResourceStripWindow.WindowState = WindowState.Normal;
        if (!_taskbarResourceStripWindow.IsVisible)
            _taskbarResourceStripWindow.Show();
        _taskbarResourceStripWindow.Topmost = false;
        _taskbarResourceStripWindow.Topmost = true;
    }

    private void RestoreTaskbarResourceStripAfterTrayMenu()
    {
        if (!App.Config.Load().TaskbarResourceMonitorEnabled || _taskbarResourceStripWindow == null)
            return;

        var cfg = App.Config.Load();
        if (!cfg.TaskbarResourceMonitorWindowX.HasValue || !cfg.TaskbarResourceMonitorWindowY.HasValue)
            PositionTaskbarResourceStrip(_taskbarResourceStripWindow);
        if (!_taskbarResourceStripWindow.IsVisible)
            _taskbarResourceStripWindow.Show();

        // 托盘菜单关闭后可能导致 Z-Order 被压到任务栏后面，主动提回顶层。
        _taskbarResourceStripWindow.Topmost = false;
        _taskbarResourceStripWindow.Topmost = true;
    }

    private void SaveTaskbarResourceStripPlacement()
    {
        if (_taskbarResourceStripWindow == null)
            return;
        var cfg = App.Config.Load();
        cfg.TaskbarResourceMonitorWindowX = _taskbarResourceStripWindow.Left;
        cfg.TaskbarResourceMonitorWindowY = _taskbarResourceStripWindow.Top;
        App.Config.Save(cfg);
    }

    private static void PositionTaskbarResourceStrip(TaskbarResourceStripWindow win)
    {
        var screen = Forms.Screen.PrimaryScreen ?? Forms.Screen.AllScreens.FirstOrDefault();
        if (screen == null)
            return;
        var bounds = screen.Bounds;
        var work = screen.WorkingArea;

        var x = work.Left + (work.Width - win.Width) / 2d;
        var y = work.Bottom - win.Height - 6d;

        if (work.Bottom < bounds.Bottom) // bottom taskbar
        {
            y = work.Bottom + Math.Max(0, (bounds.Bottom - work.Bottom - win.Height) / 2d);
            if (TryGetTaskbarChevronRect(out var chevron))
                x = chevron.Left - win.Width - 6d;
            else
                x = bounds.Right - win.Width - 170d;
        }
        else if (work.Top > bounds.Top) // top taskbar
            y = bounds.Top + Math.Max(0, (work.Top - bounds.Top - win.Height) / 2d);
        else if (work.Left > bounds.Left) // left taskbar
            x = bounds.Left + Math.Max(0, (work.Left - bounds.Left - win.Width) / 2d);
        else if (work.Right < bounds.Right) // right taskbar
            x = work.Right + Math.Max(0, (bounds.Right - work.Right - win.Width) / 2d);

        var minX = bounds.Left + 4d;
        var maxX = bounds.Right - win.Width - 4d;
        win.Left = Math.Clamp(x, minX, Math.Max(minX, maxX));
        win.Top = y;
    }

    private static bool TryGetTaskbarChevronRect(out RECT rect)
    {
        rect = default;
        var tray = FindWindow("Shell_TrayWnd", null);
        if (tray == IntPtr.Zero) return false;

        var notify = FindWindowEx(tray, IntPtr.Zero, "TrayNotifyWnd", null);
        if (notify == IntPtr.Zero) return false;

        var sysPager = FindWindowEx(notify, IntPtr.Zero, "SysPager", null);
        var scanRoot = sysPager != IntPtr.Zero ? sysPager : notify;

        var child = IntPtr.Zero;
        RECT? best = null;
        while (true)
        {
            child = FindWindowEx(scanRoot, child, "Button", null);
            if (child == IntPtr.Zero) break;
            if (!GetWindowRect(child, out var rc)) continue;

            var w = rc.Right - rc.Left;
            var h = rc.Bottom - rc.Top;
            if (w <= 0 || h <= 0 || w > 60 || h > 60) continue;

            if (best == null || rc.Left < best.Value.Left)
                best = rc;
        }

        if (best == null) return false;
        rect = best.Value;
        return true;
    }

    private static string FormatRate(double kbps) =>
        kbps >= 1024 ? $"{kbps / 1024d:F1} MB/s" : $"{kbps:F0} KB/s";

    private static string BuildTrayTooltipText(ResourceSnapshot snap)
    {
        var text = $"CPU {snap.CpuPercent:F0}% | MEM {snap.MemoryPercent:F0}% | DISK {snap.DiskUsedPercent:F0}%";
        return text.Length <= 63 ? text : text[..63];
    }

    private void InitHealthReminder()
    {
        _healthReminder.ReminderTriggered += type =>
        {
            Dispatcher.Invoke(() =>
            {
                ShowHealthReminderPopup(type);
            });
        };
        RefreshHealthReminder();
    }

    private void ShowHealthReminderPopup(HealthReminderType type)
    {
        if (_healthReminderPopupOpen)
            return;

        _healthReminderPopupOpen = true;
        try
        {
            var win = new HealthReminderWindow(type, _healthReminder)
            {
                ShowActivated = true,
                Topmost = true,
                WindowStartupLocation = WindowStartupLocation.CenterScreen
            };

            win.SourceInitialized += (_, _) => TrySetForegroundWindow(win);
            win.Loaded += (_, _) =>
            {
                win.Activate();
                TrySetForegroundWindow(win);
            };
            win.ContentRendered += (_, _) =>
            {
                win.Topmost = true;
                win.Activate();
                TrySetForegroundWindow(win);
            };

            win.ShowDialog();
        }
        finally
        {
            _healthReminderPopupOpen = false;
        }
    }

    private void RefreshHealthReminder()
    {
        var cfg = App.Config.Load();
        _healthReminder.Enabled = cfg.HealthReminderEnabled;
        _healthReminder.WaterIntervalMinutes = cfg.WaterReminderMinutes;
        _healthReminder.SedentaryThresholdMinutes = cfg.MovementReminderMinutes;
        _healthReminder.Restart();
    }

    private void RefreshProxyEnforcement()
    {
        var cfg = App.Config.Load();
        _proxyEnforcement.StartOrUpdate(cfg);
    }

    private void ApplyPacFromTray(string city)
    {
        var cfg = App.Config.Load();
        var pac = string.Equals(city, "beijing", StringComparison.OrdinalIgnoreCase)
            ? (cfg.ProxyPacUrlBeijing ?? "").Trim()
            : (cfg.ProxyPacUrlShanghai ?? "").Trim();

        if (string.IsNullOrWhiteSpace(pac))
        {
            _tray.ShowTip(AppBranding.DisplayName, "未配置 PAC 地址，请先在设置页填写。", 4000, Forms.ToolTipIcon.Warning);
            return;
        }

        cfg.ProxyForceEnabled = true;
        cfg.ProxyForceMode = "pac";
        cfg.ProxyPacUrl = pac;

        if (!App.Config.Save(cfg))
        {
            _tray.ShowTip(AppBranding.DisplayName, "保存代理配置失败。", 4000, Forms.ToolTipIcon.Error);
            return;
        }

        RefreshProxyEnforcement();
        var cityText = string.Equals(city, "beijing", StringComparison.OrdinalIgnoreCase) ? "北京" : "上海";
        _tray.ShowTip(AppBranding.DisplayName, $"已切换到{cityText} PAC，并启用强制刷新。", 4000, Forms.ToolTipIcon.Info);
    }

    private void ApplyManualProxyFromTray()
    {
        var cfg = App.Config.Load();
        if (string.IsNullOrWhiteSpace(cfg.ProxyServer))
        {
            _tray.ShowTip(AppBranding.DisplayName, "未配置手动代理地址，请先在设置页填写。", 4000, Forms.ToolTipIcon.Warning);
            return;
        }

        cfg.ProxyForceEnabled = true;
        cfg.ProxyForceMode = "manual";

        if (!App.Config.Save(cfg))
        {
            _tray.ShowTip(AppBranding.DisplayName, "保存代理配置失败。", 4000, Forms.ToolTipIcon.Error);
            return;
        }

        RefreshProxyEnforcement();
        _tray.ShowTip(AppBranding.DisplayName, "已切换到手动代理，并启用强制刷新。", 4000, Forms.ToolTipIcon.Info);
    }

    private void DisableProxyForceFromTray()
    {
        var cfg = App.Config.Load();
        cfg.ProxyForceEnabled = false;
        if (!App.Config.Save(cfg))
        {
            _tray.ShowTip(AppBranding.DisplayName, "保存代理配置失败。", 4000, Forms.ToolTipIcon.Error);
            return;
        }

        RefreshProxyEnforcement();
        _tray.ShowTip(AppBranding.DisplayName, "已关闭强制代理。", 3500, Forms.ToolTipIcon.Info);
    }

    private void TitleBar_OnMouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        if (e.ClickCount == 2)
        {
            ToggleMaximize();
            return;
        }

        try
        {
            DragMove();
        }
        catch (InvalidOperationException)
        {
            // 无鼠标捕获时可能抛出，忽略
        }
    }

    private void CaptionMinimize_OnClick(object sender, RoutedEventArgs e)
    {
        WindowState = WindowState.Minimized;
    }

    private void CaptionMaximize_OnClick(object sender, RoutedEventArgs e)
    {
        ToggleMaximize();
    }

    private void CaptionClose_OnClick(object sender, RoutedEventArgs e)
    {
        Close();
    }

    private void ToggleMaximize()
    {
        WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;
    }

    private void UpdateMaximizeCaption()
    {
        if (BtnCaptionMaximize == null)
            return;
        var max = WindowState == WindowState.Maximized;
        BtnCaptionMaximize.Content = max ? "\uE923" : "\uE922";
        BtnCaptionMaximize.ToolTip = max ? L("TitleBar.Restore") : L("TitleBar.Maximize");
    }

    private void NavButton_OnClick(object sender, RoutedEventArgs e)
    {
        if (sender is not Button btn) return;
        var page = ParseAppPage(btn.Tag);
        SwitchPage(page);
    }

    private static AppPage ParseAppPage(object? tag)
    {
        if (tag is string s && Enum.TryParse<AppPage>(s, ignoreCase: true, out var p))
            return p;
        return AppPage.Notes;
    }

    private void BtnOpenSettings_OnClick(object sender, RoutedEventArgs e)
    {
        SwitchPage(AppPage.Settings);
    }

    // ═══════════════ Sidebar Collapse / Expand ═══════════════

    private void BtnSidebarToggle_OnClick(object sender, RoutedEventArgs e)
    {
        _sidebarCollapsed = !_sidebarCollapsed;
        ApplySidebarState();
    }

    private void ApplySidebarState()
    {
        const double expandedWidth = 228;
        const double collapsedWidth = 56;

        SidebarColumn.Width = new GridLength(_sidebarCollapsed ? collapsedWidth : expandedWidth);

        var vis = _sidebarCollapsed ? Visibility.Collapsed : Visibility.Visible;

        // Toggle text labels in nav buttons (hide text, keep icon)
        foreach (var btn in _navButtons)
        {
            if (btn.Content is StackPanel sp)
            {
                btn.Padding = _sidebarCollapsed ? new Thickness(0) : new Thickness(14, 0, 14, 0);
                btn.HorizontalContentAlignment = _sidebarCollapsed ? HorizontalAlignment.Center : HorizontalAlignment.Stretch;
                if (sp.Children.Count > 1)
                    sp.Children[1].Visibility = vis;
                if (sp.Children.Count > 0 && sp.Children[0] is TextBlock icon)
                {
                    icon.Width = _sidebarCollapsed ? double.NaN : 24;
                    icon.Margin = _sidebarCollapsed ? new Thickness(0) : new Thickness(0, 0, 8, 0);
                    icon.TextAlignment = TextAlignment.Center;
                }
            }
        }

        // When collapsed: hide expander headers but keep children visible
        if (_sidebarCollapsed)
        {
            NavWorkbenchExpander.IsExpanded = true;
            NavFuncExpander.IsExpanded = true;
            NavToolsExpander.IsExpanded = true;
            NavSystemExpander.IsExpanded = true;
            NavOtherExpander.IsExpanded = true;
        }
        // Collapse mode: hide expander headers via template trigger.
        NavWorkbenchExpander.Tag = _sidebarCollapsed ? "collapsed" : null;
        NavFuncExpander.Tag = _sidebarCollapsed ? "collapsed" : null;
        NavToolsExpander.Tag = _sidebarCollapsed ? "collapsed" : null;
        NavSystemExpander.Tag = _sidebarCollapsed ? "collapsed" : null;
        NavOtherExpander.Tag = _sidebarCollapsed ? "collapsed" : null;

        // Brand area
        BrandTextPanel.Visibility = vis;
        BrandSeparator.Visibility = vis;
        BrandHeaderPanel.Margin = _sidebarCollapsed
            ? new Thickness(8, 12, 8, 0)
            : new Thickness(16, 16, 16, 0);
        BrandHeaderPanel.HorizontalAlignment = _sidebarCollapsed ? HorizontalAlignment.Center : HorizontalAlignment.Stretch;
        BrandLogo.Margin = _sidebarCollapsed ? new Thickness(0) : new Thickness(0, 0, 10, 0);

        // Version label
        VersionLabel.Visibility = vis;

        // Update toggle button tooltip
        BtnSidebarToggle.ToolTip = _sidebarCollapsed ? L("Nav.ExpandSidebar") : L("Nav.CollapseSidebar");
    }

    private void NotesToolbar_Today_OnClick(object sender, RoutedEventArgs e) => _notesView.ToolbarTodayNote();

    private void NotesToolbar_NewNote_OnClick(object sender, RoutedEventArgs e) => _notesView.ToolbarNewNote();

    private void NotesToolbar_NewFolder_OnClick(object sender, RoutedEventArgs e) => _notesView.ToolbarNewFolder();

    private void NotesToolbar_QuickCapture_OnClick(object sender, RoutedEventArgs e) => _notesView.ToolbarQuickCapture();

    private void NotesToolbar_Sticky_OnClick(object sender, RoutedEventArgs e) => _notesView.ToolbarNewSticky();

    private void NotesToolbar_Refresh_OnClick(object sender, RoutedEventArgs e) => _notesView.ToolbarRefresh();

    private void NotesToolbar_ExportZip_OnClick(object sender, RoutedEventArgs e) => _notesView.ToolbarExportZip();

    private void NotesToolbar_ImportZip_OnClick(object sender, RoutedEventArgs e) => _notesView.ToolbarImportZip();

    private void NotesToolbar_OpenFolder_OnClick(object sender, RoutedEventArgs e) => _notesView.ToolbarOpenFolder();

    private void NotesToolbar_More_OnClick(object sender, RoutedEventArgs e)
    {
        if (sender is not Button b || b.ContextMenu == null)
            return;
        b.ContextMenu.PlacementTarget = b;
        b.ContextMenu.Placement = PlacementMode.Bottom;
        b.ContextMenu.IsOpen = true;
    }

    private void UpdatePageChrome(AppPage page)
    {
        PageTitleBar.Text = page switch
        {
            AppPage.AiChat => L("Nav.AiChat"),
            AppPage.Notes => L("Nav.Notes"),
            AppPage.Ppt => L("Nav.Ppt"),
            AppPage.Todo => L("Nav.Todo"),
            AppPage.Translate => L("Nav.Translate"),
            AppPage.Email => L("Nav.Email"),
            (AppPage)4 => L("Nav.AiChat"),  // legacy Chat -> AiChat
            AppPage.NetworkMonitor => L("Nav.Network"),
            AppPage.Cleanup => L("Nav.Cleanup"),
            AppPage.CodexProxy => L("Nav.CodexProxy"),
            AppPage.PasswordVault => L("Nav.PasswordVault"),
            AppPage.QuickAccess => L("Nav.QuickAccess"),
            AppPage.PdfTools => L("Nav.PdfTools"),
            AppPage.FileTools => L("Nav.FileTools"),
            AppPage.Dance => L("Nav.Dance"),
            AppPage.MeetingAssistant => L("Nav.Meeting"),
            AppPage.FileManager => L("Nav.FileManager"),
            AppPage.Skills => L("Nav.Settings"),
            AppPage.PersonalHomepage => L("Nav.Homepage"),
            AppPage.ProcessDiagnostics => "进程诊断",
            AppPage.Settings => L("Nav.Settings"),
            _ => AppBranding.DisplayName
        };
        BtnOpenSettings.Visibility = page == AppPage.Settings ? Visibility.Collapsed : Visibility.Visible;
        NotesToolbarPanel.Visibility = page == AppPage.Notes ? Visibility.Visible : Visibility.Collapsed;
    }

    public void SwitchPage(AppPage page)
    {
        PageHost.Content = page switch
        {
            AppPage.AiChat => _aiChatView,
            AppPage.Notes => _notesView,
            AppPage.Ppt => _pptWorkspaceView,
            AppPage.Todo => _todoView,
            AppPage.Translate => _aiChatView,
            AppPage.Email => _aiChatView,
            (AppPage)4 => _aiChatView,  // legacy Chat -> AiChat
            AppPage.NetworkMonitor => _networkMonitorView,
            AppPage.Cleanup => _cleanupView,
            AppPage.CodexProxy => _codexProxyView,
            AppPage.PasswordVault => _passwordVaultView,
            AppPage.QuickAccess => _quickAccessView,
            AppPage.PdfTools => _pdfToolsView,
            AppPage.FileTools => _fileToolsView,
            AppPage.Dance => _danceView,
            AppPage.MeetingAssistant => _meetingAssistantView,
            AppPage.FileManager => _fileManagerView,
            AppPage.Skills => _settingsView,
            AppPage.PersonalHomepage => _homepageView,
            AppPage.ProcessDiagnostics => _processDiagnosticsView,
            AppPage.Settings => _settingsView,
            _ => _notesView
        };

        switch (page)
        {
            case AppPage.Translate:
                _aiChatView.ShowTranslateMode();
                break;
            case AppPage.Email:
                _aiChatView.ShowEmailMode();
                break;
            case AppPage.AiChat:
            case (AppPage)4:
                _aiChatView.ShowChatMode();
                break;
        }

        if (page == AppPage.Skills)
            _settingsView.ShowSkillsSettings();
        if (page == AppPage.NetworkMonitor)
            _networkMonitorView.RequestRefresh();
        if (page == AppPage.QuickAccess)
            _quickAccessView.RefreshFromConfig();
        if (page == AppPage.Notes)
            _notesView.ReloadServiceAndList();
        if (page == AppPage.Todo)
            _todoView.Reload();
        if (page == AppPage.Dance)
            _danceView.LoadFromDisk();
        if (page == AppPage.Settings)
            _settingsView.LoadFromDisk();
        if (page == AppPage.PasswordVault)
            _passwordVaultView.OnNavigatedTo();
        if (page == AppPage.PersonalHomepage)
            _homepageView.OnNavigatedTo();
        if (page == AppPage.AiChat || page == (AppPage)4)
            _aiChatView.ApplyHandoffIfPending();
        if (page == AppPage.Email)
            _aiChatView.ApplyEmailHandoffIfPending();

        SyncNavExpandersForPage(page);
        SetActiveNav(page);
        UpdatePageChrome(page);
    }

    /// <summary>进入某页时自动展开对应侧栏分组，避免子项被收起后找不到。</summary>
    private void SyncNavExpandersForPage(AppPage page)
    {
        if (page is AppPage.AiChat or AppPage.Email or AppPage.Notes or AppPage.Ppt or AppPage.Todo or AppPage.QuickAccess or AppPage.PersonalHomepage)
            NavWorkbenchExpander.IsExpanded = true;
        if (page is AppPage.MeetingAssistant)
            NavFuncExpander.IsExpanded = true;
        if (page is AppPage.FileManager or AppPage.FileTools or AppPage.PdfTools)
            NavToolsExpander.IsExpanded = true;
        if (page is AppPage.NetworkMonitor or AppPage.Cleanup or AppPage.CodexProxy or AppPage.PasswordVault or AppPage.ProcessDiagnostics)
            NavSystemExpander.IsExpanded = true;
        if (page is AppPage.Dance)
            NavOtherExpander.IsExpanded = true;
    }

    /// <summary>映射 AppPage → _navButtons 索引（跳过已废弃的 Chat=4）。</summary>
    private static readonly Dictionary<AppPage, int> NavButtonIndex = new()
    {
        [AppPage.AiChat] = 0,
        [AppPage.Notes] = 1,
        [AppPage.Ppt] = 2,
        [AppPage.Todo] = 3,
        [AppPage.QuickAccess] = 4,
        [AppPage.PersonalHomepage] = 5,
        [AppPage.Email] = 0,
        [AppPage.MeetingAssistant] = 6,
        [AppPage.Translate] = 0,
        [AppPage.FileManager] = 7,
        [AppPage.FileTools] = 8,
        [AppPage.PdfTools] = 9,
        [AppPage.Cleanup] = 10,
        [AppPage.CodexProxy] = 11,
        [AppPage.NetworkMonitor] = 12,
        [AppPage.PasswordVault] = 13,
        [AppPage.ProcessDiagnostics] = 14,
        [AppPage.Dance] = 15,
        [AppPage.Settings] = 16,
        [AppPage.Skills] = 16,
    };

    private void SetActiveNav(AppPage page)
    {
        var activeIdx = NavButtonIndex.GetValueOrDefault(page, -1);
        for (var i = 0; i < _navButtons.Length; i++)
            UpdateNavVisual(_navButtons[i], i == activeIdx);
    }

    private static void UpdateNavVisual(Button btn, bool active) =>
        NavButtonHelper.SetIsNavActive(btn, active);

    public void ShowFromTray()
    {
        Show();
        if (WindowState == WindowState.Minimized)
            WindowState = WindowState.Normal;
        Activate();
    }

    /// <summary>从其它视图（例如 NotesView）打开 PPT 工作台并预填 Markdown 正文。</summary>
    public void OpenPptWorkspaceWithMarkdown(string markdown, string? hintTopic = null)
    {
        SwitchPage(AppPage.Ppt);
        Dispatcher.BeginInvoke(new Action(() =>
        {
            _pptWorkspaceView.LoadSource(markdown, hintTopic);
        }), DispatcherPriority.ApplicationIdle);
    }

    public void ShowAndSwitch(AppPage page)
    {
        Show();
        if (WindowState == WindowState.Minimized)
            WindowState = WindowState.Normal;
        Activate();
        SwitchPage(page);
    }

    public async void OpenCodexProxyFromDock()
    {
        ShowAndSwitch(AppPage.CodexProxy);
        await _codexProxyView.StartProxyFromShortcutAsync();
    }

    /// <summary>从 GlobalChatWindow 拖入 exe 时跳转到进程诊断页。</summary>
    public void StartProcessDiagFromExe(string exePath)
    {
        _processDiagnosticsView.StartMonitorFromExePath(exePath);
    }

    /// <summary>启动与主程序同目录发布的 dancemonkey.exe（命令行 Agent）。</summary>
    public void LaunchDanceMonkeyCli() => DanceMonkeyCliLauncher.TryStart();

    private void ShowFloatingFromTray()
    {
        var cfg = App.Config.Load();
        cfg.FloatingIconEnabled = true;
        cfg.PetModeEnabled = false;
        App.Config.Save(cfg);
        SyncPetMode();
    }

    /// <summary>显示桌面 Dock 模式卡片。</summary>
    public void ShowDockWindow()
    {
        if (_dock == null)
            _dock = new DockWindow(this);
        _dock.ShowDock();
    }

    public void ShowTrayTip(string title, string text, int ms = 2500)
    {
        _tray.ShowTip(title, text, ms, Forms.ToolTipIcon.Info);
    }

    /// <summary>Dock「Task」模式：快速添加一条默认属性的 Zen Task。</summary>
    public void QuickAddZenTaskFromDock(string title)
    {
        _todoView.QuickAddDefaultZenTask(title);
        ShowTrayTip(AppBranding.DisplayName, $"{L("Dock.ZenTaskAdded")}{title}");
    }

    /// <summary>截图保存后打开操作窗口（复制 / 存笔记 / AI / OCR）。</summary>
    public void OpenScreenshotActions(string imagePath)
    {
        if (string.IsNullOrWhiteSpace(imagePath) || !File.Exists(imagePath))
            return;

        var w = new ScreenshotResultWindow(imagePath, mdPath =>
        {
            ShowAndSwitch(AppPage.Notes);
            _notesView.ReloadAndSelectNote(mdPath);
        });

        // 必须挂到「当前可见」的 WPF 窗口上：主窗口在托盘里隐藏时作 Owner 会导致子窗口不显示；
        // 悬浮球始终置顶可见，作 Owner 最稳妥。
        if (IsVisible && Visibility == Visibility.Visible && WindowState != WindowState.Minimized)
            w.Owner = this;
        else if (_petWindow is { IsVisible: true })
            w.Owner = _petWindow;
        else if (_floating is { IsVisible: true })
            w.Owner = _floating;
        else
            w.WindowStartupLocation = WindowStartupLocation.CenterScreen;

        w.ShowInTaskbar = true;
        w.ShowActivated = true;
        w.Topmost = true;
        w.SourceInitialized += (_, _) => TrySetForegroundWindow(w);
        w.ContentRendered += (_, _) => TrySetForegroundWindow(w);
        w.Show();
        w.Activate();
        Dispatcher.BeginInvoke(DispatcherPriority.ApplicationIdle, () => { w.Topmost = false; });
        TrySetForegroundWindow(w);
    }

    /// <summary>框选工具栏「AI」：对临时截图文件进行分析（不经过结果预览窗）。</summary>
    public void RunScreenshotAiFromRegion(string imagePath)
    {
        _ = RunScreenshotAiFromRegionAsync(imagePath);
    }

    private async Task RunScreenshotAiFromRegionAsync(string imagePath)
    {
        var owner = TryGetScreenshotActionOwner();
        await ScreenshotAnalysisHelper.RunAiAnalysisAsync(imagePath, owner, AppBranding.DisplayName)
            .ConfigureAwait(true);
    }

    /// <summary>框选工具栏「OCR」。</summary>
    public void RunScreenshotOcrFromRegion(string imagePath)
    {
        _ = RunScreenshotOcrFromRegionAsync(imagePath);
    }

    private async Task RunScreenshotOcrFromRegionAsync(string imagePath)
    {
        var owner = TryGetScreenshotActionOwner();
        await ScreenshotAnalysisHelper.RunOcrAsync(imagePath, owner, AppBranding.DisplayName)
            .ConfigureAwait(true);
    }

    private Window? TryGetScreenshotActionOwner()
    {
        if (IsVisible && Visibility == Visibility.Visible && WindowState != WindowState.Minimized)
            return this;
        if (_petWindow is { IsVisible: true })
            return _petWindow;
        if (_floating is { IsVisible: true })
            return _floating;
        return null;
    }

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    private static void TrySetForegroundWindow(Window window)
    {
        try
        {
            var helper = new WindowInteropHelper(window);
            if (helper.Handle != IntPtr.Zero)
                SetForegroundWindow(helper.Handle);
        }
        catch
        {
            // 忽略
        }
    }

    public void QuitFromFloating() => QuitApplication();

    private void TrayQuickScreenshot()
    {
        try
        {
            var screen = Forms.Screen.FromPoint(Forms.Cursor.Position)
                         ?? Forms.Screen.PrimaryScreen
                         ?? Forms.Screen.AllScreens[0];
            var bounds = screen.Bounds;

            using var bmp = new System.Drawing.Bitmap(bounds.Width, bounds.Height,
                System.Drawing.Imaging.PixelFormat.Format32bppArgb);
            using (var g = System.Drawing.Graphics.FromImage(bmp))
            {
                g.CopyFromScreen(bounds.Left, bounds.Top, 0, 0, bounds.Size,
                    System.Drawing.CopyPixelOperation.SourceCopy);
            }

            var saved = ScreenshotHelper.SavePngAndClipboard(bmp, AppBranding.DisplayName, App.Config.Load().NotesRootPath);
            if (saved != null)
            {
                Dispatcher.BeginInvoke(DispatcherPriority.ApplicationIdle,
                    () => OpenScreenshotActions(saved));
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show($"截图失败：{ex.Message}", AppBranding.DisplayName,
                MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }

    private void TrayRegionScreenshot()
    {
        StartRegionCapture(RegionCaptureForm.CaptureMode.Region);
    }

    private void TrayScrollScreenshot()
    {
        StartRegionCapture(RegionCaptureForm.CaptureMode.Scrolling);
    }

    public void StartContinuousScreenshotMode()
    {
        if (_continuousScreenshotOverlay is { IsVisible: true })
        {
            _continuousScreenshotOverlay.Topmost = true;
            _continuousScreenshotOverlay.Topmost = false;
            return;
        }

        try
        {
            var cfg = App.Config.Load();
            var notes = new NoteService(cfg.NotesRootPath);
            _continuousScreenshotSession = notes.StartContinuousScreenshotSession();

            _continuousScreenshotOverlay = new ContinuousScreenshotOverlayWindow();
            _continuousScreenshotOverlay.UpdateCount(0);
            _continuousScreenshotOverlay.CaptureRequested += StartContinuousRegionCapture;
            _continuousScreenshotOverlay.FinishRequested += FinishContinuousScreenshotMode;
            _continuousScreenshotOverlay.Closed += (_, _) => _continuousScreenshotOverlay = null;
            _continuousScreenshotOverlay.Left = SystemParameters.WorkArea.Right - _continuousScreenshotOverlay.Width - 24;
            _continuousScreenshotOverlay.Top = SystemParameters.WorkArea.Top + 80;
            _continuousScreenshotOverlay.Show();

            ShowTrayTip(AppBranding.DisplayName, "已进入连续截图模式（仅框选截图）。");
        }
        catch (Exception ex)
        {
            MessageBox.Show($"进入连续截图模式失败：{ex.Message}", AppBranding.DisplayName,
                MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }

    private void StartContinuousRegionCapture()
    {
        if (_continuousScreenshotSession == null)
            return;

        try
        {
            _continuousScreenshotOverlay?.Hide();
            var form = new RegionCaptureForm(
                path =>
                {
                    Dispatcher.BeginInvoke(DispatcherPriority.ApplicationIdle,
                        () => OnContinuousCaptureSaved(path));
                },
                onCancel: () =>
                {
                    Dispatcher.BeginInvoke(DispatcherPriority.ApplicationIdle, () =>
                    {
                        _continuousScreenshotOverlay?.Show();
                        _continuousScreenshotOverlay?.Activate();
                    });
                },
                onAiFromPath: null,
                onOcrFromPath: null,
                mode: RegionCaptureForm.CaptureMode.Region,
                notesRootPath: App.Config.Load().NotesRootPath);
            form.Show();
        }
        catch (Exception ex)
        {
            _continuousScreenshotOverlay?.Show();
            MessageBox.Show($"连续截图失败：{ex.Message}", AppBranding.DisplayName,
                MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }

    private void OnContinuousCaptureSaved(string imagePath)
    {
        if (_continuousScreenshotSession == null)
            return;

        var cfg = App.Config.Load();
        var notes = new NoteService(cfg.NotesRootPath);
        var index = notes.AppendScreenshotToContinuousSession(_continuousScreenshotSession, imagePath);

        _continuousScreenshotOverlay?.Show();
        _continuousScreenshotOverlay?.UpdateCount(index);
        _continuousScreenshotOverlay?.ShowSavedPulse(index);
        ShowTrayTip(AppBranding.DisplayName, $"连续截图已保存：第 {index} 张");
    }

    private void FinishContinuousScreenshotMode()
    {
        var mdPath = _continuousScreenshotSession?.MarkdownPath;
        _continuousScreenshotSession = null;

        if (_continuousScreenshotOverlay != null)
        {
            _continuousScreenshotOverlay.Close();
            _continuousScreenshotOverlay = null;
        }

        if (!string.IsNullOrWhiteSpace(mdPath) && File.Exists(mdPath))
        {
            ShowAndSwitch(AppPage.Notes);
            // 等切换页 + NotesView 完成布局后再跳转，避免树尚不存在或尚未绑定导致无法选中和打开
            var path = mdPath;
            Dispatcher.BeginInvoke(
                () => _notesView.ReloadAndSelectNote(path),
                DispatcherPriority.ApplicationIdle);
            ShowTrayTip(AppBranding.DisplayName, "连续截图已完成，已汇总到单个笔记。");
        }
    }

    private void StartRegionCapture(RegionCaptureForm.CaptureMode mode)
    {
        try
        {
            var form = new RegionCaptureForm(
                path =>
                {
                    Dispatcher.BeginInvoke(DispatcherPriority.ApplicationIdle,
                        () => OpenScreenshotActions(path));
                },
                onCancel: null,
                onAiFromPath: path =>
                {
                    Dispatcher.BeginInvoke(DispatcherPriority.ApplicationIdle,
                        () => RunScreenshotAiFromRegion(path));
                },
                onOcrFromPath: path =>
                {
                    Dispatcher.BeginInvoke(DispatcherPriority.ApplicationIdle,
                        () => RunScreenshotOcrFromRegion(path));
                },
                mode: mode,
                notesRootPath: App.Config.Load().NotesRootPath);
            form.Show();
        }
        catch (Exception ex)
        {
            var action = mode == RegionCaptureForm.CaptureMode.Scrolling ? "滚动截图" : "框选截图";
            MessageBox.Show($"{action}失败：{ex.Message}", AppBranding.DisplayName,
                MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }

    // ═══════════════ Global Chat Hotkey ═══════════════

    private void InitGlobalChatHotkey()
    {
        var helper = new WindowInteropHelper(this);
        _hotkeys.Attach(helper);
        _hwndSource = HwndSource.FromHwnd(helper.Handle);
        _hwndSource?.AddHook(WndProc);
        _hotkeys.Register();
    }

    private IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (_hotkeys.TryHandleWndProc(msg, wParam))
        {
            handled = true;
            return IntPtr.Zero;
        }

        if (msg == WM_GETMINMAXINFO && lParam != IntPtr.Zero)
        {
            // Respect the taskbar work area when the window is maximized.
            // Required because WindowStyle="None" bypasses the OS default.
            var mmi = Marshal.PtrToStructure<MINMAXINFO>(lParam);
            var screen = Forms.Screen.FromHandle(hwnd);
            var wa = screen.WorkingArea;
            // ptMaxPosition is relative to the top-left of the nearest monitor.
            mmi.ptMaxPosition.X = wa.Left - screen.Bounds.Left;
            mmi.ptMaxPosition.Y = wa.Top  - screen.Bounds.Top;
            mmi.ptMaxSize.X     = wa.Width;
            mmi.ptMaxSize.Y     = wa.Height;
            Marshal.StructureToPtr(mmi, lParam, true);
            handled = true;
        }
        return IntPtr.Zero;
    }

    private void ToggleGlobalChat()
    {
        if (_globalChat == null)
            _globalChat = new GlobalChatWindow();

        if (_globalChat.IsVisible)
        {
            _globalChat.HideWindow();
        }
        else
        {
            _globalChat.ShowAndFocus();
        }
    }

    /// <summary>从 Dock 等外部打开全局对话并自动发送问题。</summary>
    public void OpenGlobalChatWithQuestion(string question)
    {
        if (string.IsNullOrWhiteSpace(question)) return;
        if (_globalChat == null)
            _globalChat = new GlobalChatWindow();
        _globalChat.OpenWithQuestion(question);
    }

    /// <summary>截图 AI 分析完成后，将分析全文带入全局对话作追问上下文；可选附带原截图路径以便「存笔记」时一并保存图片。</summary>
    public void OpenGlobalChatWithScreenshotAnalysis(string analysisMarkdown, string? screenshotImagePath = null)
    {
        if (string.IsNullOrWhiteSpace(analysisMarkdown))
            return;
        if (_globalChat == null)
            _globalChat = new GlobalChatWindow();
        _globalChat.OpenWithScreenshotFollowUp(analysisMarkdown, screenshotImagePath);
    }

    /// <summary>从全局对话等外部保存 .md 后刷新笔记树并选中文件。</summary>
    public void RefreshNotesAfterExternalSave(string savedMarkdownPath)
    {
        if (!string.IsNullOrWhiteSpace(savedMarkdownPath))
            _notesView.ReloadAndSelectNote(savedMarkdownPath);
    }

    private void QuitApplication()
    {
        _hotkeys.Unregister();

        SleepPreventionService.SetEnabled(false);
        _proxyEnforcement.Stop();
        _resourceMonitorTimer.Stop();
        _taskbarResourceStripWindow?.Close();
        if (_petWindow != null)
            try { _petWindow.Close(); } catch { /* ignore */ }
        _exitRequested = true;
        StickyNoteManager.SaveAllLayouts();
        StickyNoteManager.CloseAll();
        _tray.Dispose();

        System.Windows.Application.Current.Shutdown();
    }

    protected override void OnClosing(CancelEventArgs e)
    {
        if (!_exitRequested)
        {
            e.Cancel = true;
            Hide();
            _tray.ShowTip(AppBranding.DisplayName, "已最小化到托盘", 1500, Forms.ToolTipIcon.Info);
            return;
        }

        base.OnClosing(e);
    }

    protected override void OnClosed(EventArgs e)
    {
        _proxyEnforcement.Stop();
        _resourceMonitorTimer.Stop();
        _taskbarResourceStripWindow?.Close();
        _tray.Dispose();

        _hotkeys.Dispose();
        base.OnClosed(e);
    }

    private static string L(string key) => LocalizationManager.Get(key);
    private static string L(string key, params object[] args) => LocalizationManager.Get(key, args);

}
