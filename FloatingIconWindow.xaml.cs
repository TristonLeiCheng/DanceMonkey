using System.Drawing;
using System.Drawing.Imaging;
using System.Windows;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Threading;
using DesktopAssistant.Models;
using DesktopAssistant.Services;
using MediaBrush = System.Windows.Media.Brush;
using MediaBrushes = System.Windows.Media.Brushes;
using MediaColor = System.Windows.Media.Color;
using DrawingPixelFormat = System.Drawing.Imaging.PixelFormat;
using DrawingPoint = System.Drawing.Point;
using Forms = System.Windows.Forms;
using FormsScreen = System.Windows.Forms.Screen;

namespace DesktopAssistant;

/// <summary>
/// 桌面置顶悬浮球：拖动移动，单击打开主窗口，右键菜单。
/// </summary>
public partial class FloatingIconWindow : Window
{
    private const double MoveThreshold = 6;
    private readonly MainWindow _main;
    private readonly Func<AppConfig> _loadConfig;
    private readonly Action<AppConfig> _saveConfig;

    private System.Windows.Point _pressScreen;
    private System.Windows.Vector _dragOffset;
    private bool _moved;

    private Forms.ContextMenuStrip? _contextMenu;
    private Forms.ToolStripMenuItem? _petToggleMenuItem;
    private readonly ResourceMonitorService _resourceMonitor = new();

    public FloatingIconWindow(
        MainWindow main,
        Func<AppConfig> loadConfig,
        Action<AppConfig> saveConfig)
    {
        InitializeComponent();
        _main = main;
        _loadConfig = loadConfig;
        _saveConfig = saveConfig;
    }

    protected override void OnMouseLeftButtonDown(MouseButtonEventArgs e)
    {
        base.OnMouseLeftButtonDown(e);
        CaptureMouse();
        _pressScreen = ScreenDevicePixelsToDip(PointToScreen(e.GetPosition(this)));
        _dragOffset = _pressScreen - new System.Windows.Point(Left, Top);
        _moved = false;
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        base.OnMouseMove(e);
        if (!IsMouseCaptured || e.LeftButton != MouseButtonState.Pressed)
            return;

        var now = ScreenDevicePixelsToDip(PointToScreen(e.GetPosition(this)));
        if ((now - _pressScreen).Length > MoveThreshold)
            _moved = true;

        Left = now.X - _dragOffset.X;
        Top = now.Y - _dragOffset.Y;
    }

    protected override void OnMouseLeftButtonUp(MouseButtonEventArgs e)
    {
        base.OnMouseLeftButtonUp(e);
        if (IsMouseCaptured)
            ReleaseMouseCapture();

        if (!_moved)
            _main.ShowFromTray();

        if (_moved)
            CommitPosition();

        _moved = false;
    }

    protected override void OnMouseRightButtonUp(MouseButtonEventArgs e)
    {
        base.OnMouseRightButtonUp(e);
        if (_contextMenu == null)
        {
            _contextMenu = new System.Windows.Forms.ContextMenuStrip();
            _contextMenu.Items.Add(L("Tray.Show"), null, (_, _) => _main.ShowFromTray());
            _contextMenu.Items.Add(new System.Windows.Forms.ToolStripSeparator());
            _petToggleMenuItem = new Forms.ToolStripMenuItem("开启桌面宠物模式")
            {
                CheckOnClick = false
            };
            _petToggleMenuItem.Click += (_, _) => _main.TogglePetMode();
            _contextMenu.Items.Add(_petToggleMenuItem);
            _contextMenu.Items.Add(new System.Windows.Forms.ToolStripSeparator());
            _contextMenu.Items.Add(L("Nav.AiChat"), null, (_, _) => _main.ShowAndSwitch(AppPage.AiChat));
            _contextMenu.Items.Add(L("Nav.Notes"), null, (_, _) => _main.ShowAndSwitch(AppPage.Notes));
            _contextMenu.Items.Add(L("Nav.Todo"), null, (_, _) => _main.ShowAndSwitch(AppPage.Todo));
            var toolsFloating = new Forms.ToolStripMenuItem(L("Tray.Tools"));
            toolsFloating.DropDownItems.Add(L("Nav.Network"), null, (_, _) => _main.ShowAndSwitch(AppPage.NetworkMonitor));
            toolsFloating.DropDownItems.Add(L("Nav.Cleanup"), null, (_, _) => _main.ShowAndSwitch(AppPage.Cleanup));
            _contextMenu.Items.Add(toolsFloating);
            _contextMenu.Items.Add(L("Nav.QuickAccess"), null, (_, _) => _main.ShowAndSwitch(AppPage.QuickAccess));
            _contextMenu.Items.Add(L("Nav.PdfTools"), null, (_, _) => _main.ShowAndSwitch(AppPage.PdfTools));
            _contextMenu.Items.Add(L("Nav.FileTools"), null, (_, _) => _main.ShowAndSwitch(AppPage.FileTools));
            _contextMenu.Items.Add(L("Nav.Meeting"), null, (_, _) => _main.ShowAndSwitch(AppPage.MeetingAssistant));
            _contextMenu.Items.Add(L("Nav.FileManager"), null, (_, _) => _main.ShowAndSwitch(AppPage.FileManager));
            _contextMenu.Items.Add(L("Nav.Cli"), null, (_, _) => _main.LaunchDanceMonkeyCli());
            _contextMenu.Items.Add(new Forms.ToolStripSeparator());
            _contextMenu.Items.Add(L("Tray.QuickScreenshot"), null, (_, _) => QuickScreenshot());
            _contextMenu.Items.Add(L("Tray.RegionScreenshot"), null, (_, _) => RegionScreenshot());
            _contextMenu.Items.Add(L("Tray.ScrollScreenshot"), null, (_, _) => ScrollScreenshot());
            _contextMenu.Items.Add(L("Tray.ContinuousScreenshot"), null, (_, _) => _main.StartContinuousScreenshotMode());
            _contextMenu.Items.Add(new Forms.ToolStripSeparator());
            _contextMenu.Items.Add(L("Tray.DockMode"), null, (_, _) => _main.ShowDockWindow());
            _contextMenu.Items.Add(L("Tray.HideFloating"), null, (_, _) => HideAndDisableInConfig());
            _contextMenu.Items.Add(new System.Windows.Forms.ToolStripSeparator());
            _contextMenu.Items.Add(L("Tray.Exit"), null, (_, _) => _main.QuitFromFloating());
        }


        var p = PointToScreen(e.GetPosition(this));
        _contextMenu.Show((int)p.X, (int)p.Y);
    }

    private void QuickScreenshot()
    {
        try
        {
            var screen = FormsScreen.FromPoint(Forms.Cursor.Position)
                         ?? FormsScreen.PrimaryScreen
                         ?? FormsScreen.AllScreens[0];
            var bounds = screen.Bounds;

            using var bmp = new Bitmap(bounds.Width, bounds.Height, DrawingPixelFormat.Format32bppArgb);
            using (var g = Graphics.FromImage(bmp))
            {
                g.CopyFromScreen(bounds.Left, bounds.Top, 0, 0, bounds.Size, CopyPixelOperation.SourceCopy);
            }

            var saved = ScreenshotHelper.SavePngAndClipboard(bmp, AppBranding.DisplayName, App.Config.Load().NotesRootPath);
            if (saved != null)
            {
                var p = saved;
                // ApplicationIdle：等 WinForms 右键菜单完全结束后再弹 WPF 窗，否则子窗口常被吃掉不显示
                _main.Dispatcher.BeginInvoke(
                    System.Windows.Threading.DispatcherPriority.ApplicationIdle,
                    () => _main.OpenScreenshotActions(p));
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                $"截图失败：{ex.Message}",
                AppBranding.DisplayName,
                MessageBoxButton.OK,
                MessageBoxImage.Warning);
        }
    }

    private void RegionScreenshot()
    {
        StartRegionCapture(RegionCaptureForm.CaptureMode.Region);
    }

    private void ScrollScreenshot()
    {
        StartRegionCapture(RegionCaptureForm.CaptureMode.Scrolling);
    }

    private void StartRegionCapture(RegionCaptureForm.CaptureMode mode)
    {
        try
        {
            var form = new RegionCaptureForm(
                path =>
                {
                    _main.Dispatcher.BeginInvoke(
                        System.Windows.Threading.DispatcherPriority.ApplicationIdle,
                        () => _main.OpenScreenshotActions(path));
                },
                onCancel: null,
                onAiFromPath: path =>
                {
                    _main.Dispatcher.BeginInvoke(
                        System.Windows.Threading.DispatcherPriority.ApplicationIdle,
                        () => _main.RunScreenshotAiFromRegion(path));
                },
                onOcrFromPath: path =>
                {
                    _main.Dispatcher.BeginInvoke(
                        System.Windows.Threading.DispatcherPriority.ApplicationIdle,
                        () => _main.RunScreenshotOcrFromRegion(path));
                },
                mode: mode,
                notesRootPath: App.Config.Load().NotesRootPath);
            form.Show();
        }
        catch (Exception ex)
        {
            var action = mode == RegionCaptureForm.CaptureMode.Scrolling ? "滚动截图" : "框选截图";
            MessageBox.Show(
                $"{action}失败：{ex.Message}",
                AppBranding.DisplayName,
                MessageBoxButton.OK,
                MessageBoxImage.Warning);
        }
    }

    private void HideAndDisableInConfig()
    {
        var cfg = _loadConfig();
        cfg.FloatingIconEnabled = false;
        _saveConfig(cfg);
        Hide();
    }

    private void CommitPosition()
    {
        var cfg = _loadConfig();
        cfg.FloatingIconX = Left;
        cfg.FloatingIconY = Top;
        _saveConfig(cfg);
    }

    private static string L(string key) => LocalizationManager.Get(key);

    private FormsScreen TargetScreen()
    {
        if (WpfScreenPlacement.TryGetMainWindowCenterPhysical(_main, out var cx, out var cy))
        {
            return FormsScreen.FromPoint(new DrawingPoint(cx, cy))
                   ?? FormsScreen.PrimaryScreen
                   ?? FormsScreen.AllScreens[0];
        }

        return FormsScreen.PrimaryScreen ?? FormsScreen.AllScreens[0];
    }

    /// <summary><see cref="PointToScreen"/> 为物理像素，与 WPF 的 Left/Top（DIP）需转换。</summary>
    private System.Windows.Point ScreenDevicePixelsToDip(System.Windows.Point devicePixels)
    {
        var src = PresentationSource.FromVisual(this);
        if (src?.CompositionTarget != null)
            return src.CompositionTarget.TransformFromDevice.Transform(devicePixels);
        return devicePixels;
    }

    public void ApplyPlacement()
    {
        var cfg = _loadConfig();
        if (!cfg.FloatingIconEnabled || cfg.PetModeEnabled)
        {
            Hide();
            return;
        }

        var screen = TargetScreen();
        var wa = WpfScreenPlacement.GetWorkingAreaDip(screen);

        double x, y;
        if (cfg.FloatingIconX is { } sx && cfg.FloatingIconY is { } sy)
        {
            x = sx;
            y = sy;
        }
        else
        {
            const double margin = 24;
            x = wa.Right - Width - margin;
            y = wa.Bottom - Height - margin;
        }

        x = Math.Clamp(x, wa.Left, wa.Right - Width);
        y = Math.Clamp(y, wa.Top, wa.Bottom - Height);

        Left = x;
        Top = y;
        Show();
        Topmost = true;
    }
}
