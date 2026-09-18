using DesktopAssistant.Services;
using Forms = System.Windows.Forms;

namespace DesktopAssistant.Controllers;

public sealed class TrayController : IDisposable
{
    private readonly Func<string, string> _l;
    private readonly Action _onShowMain;
    private readonly Action<AppPage> _onShowAndSwitch;
    private readonly Action _onTogglePet;
    private readonly Action _onToggleResourceMonitor;
    private readonly Action _onQuickScreenshot;
    private readonly Action _onRegionScreenshot;
    private readonly Action _onScrollScreenshot;
    private readonly Action _onContinuousScreenshot;
    private readonly Action _onShowFloating;
    private readonly Action _onShowDock;
    private readonly Action _onExit;
    private readonly Action _onTrayMenuClosed;
    private readonly Action<string> _onApplyPac;
    private readonly Action _onApplyManualProxy;
    private readonly Action _onDisableProxyForce;

    private Forms.NotifyIcon? _icon;
    private Forms.ToolStripMenuItem? _cpu;
    private Forms.ToolStripMenuItem? _mem;
    private Forms.ToolStripMenuItem? _disk;
    private Forms.ToolStripMenuItem? _net;
    private Forms.ToolStripMenuItem? _resourceToggle;
    private Forms.ToolStripMenuItem? _petToggle;

    public TrayController(
        Func<string, string> localize,
        Action onShowMain,
        Action<AppPage> onShowAndSwitch,
        Action onTogglePet,
        Action onToggleResourceMonitor,
        Action onQuickScreenshot,
        Action onRegionScreenshot,
        Action onScrollScreenshot,
        Action onContinuousScreenshot,
        Action onShowFloating,
        Action onShowDock,
        Action onExit,
        Action onTrayMenuClosed,
        Action<string> onApplyPac,
        Action onApplyManualProxy,
        Action onDisableProxyForce)
    {
        _l = localize;
        _onShowMain = onShowMain;
        _onShowAndSwitch = onShowAndSwitch;
        _onTogglePet = onTogglePet;
        _onToggleResourceMonitor = onToggleResourceMonitor;
        _onQuickScreenshot = onQuickScreenshot;
        _onRegionScreenshot = onRegionScreenshot;
        _onScrollScreenshot = onScrollScreenshot;
        _onContinuousScreenshot = onContinuousScreenshot;
        _onShowFloating = onShowFloating;
        _onShowDock = onShowDock;
        _onExit = onExit;
        _onTrayMenuClosed = onTrayMenuClosed;
        _onApplyPac = onApplyPac;
        _onApplyManualProxy = onApplyManualProxy;
        _onDisableProxyForce = onDisableProxyForce;
    }

    public void Start()
    {
        if (_icon != null)
            return;

        var trayIcon = TrayIconHelper.TryCreateIconFromPackIco(
            new Uri("pack://application:,,,/Assets/logo.ico", UriKind.Absolute));

        _icon = new Forms.NotifyIcon
        {
            Icon = trayIcon ?? System.Drawing.SystemIcons.Application,
            Visible = true,
            Text = AppBranding.DisplayName
        };

        var menu = new Forms.ContextMenuStrip();
        menu.Items.Add(_l("Tray.Show"), null, (_, _) => _onShowMain());
        menu.Items.Add(new Forms.ToolStripSeparator());

        _cpu = new Forms.ToolStripMenuItem("CPU: --") { Enabled = false };
        _mem = new Forms.ToolStripMenuItem("内存: --") { Enabled = false };
        _disk = new Forms.ToolStripMenuItem("磁盘: --") { Enabled = false };
        _net = new Forms.ToolStripMenuItem("网络: ↓ -- / ↑ --") { Enabled = false };
        menu.Items.Add(_cpu);
        menu.Items.Add(_mem);
        menu.Items.Add(_disk);
        menu.Items.Add(_net);

        _resourceToggle = new Forms.ToolStripMenuItem("关闭资源监控") { CheckOnClick = false };
        _resourceToggle.Click += (_, _) => _onToggleResourceMonitor();
        menu.Items.Add(_resourceToggle);


        _petToggle = new Forms.ToolStripMenuItem("开启桌面宠物模式") { CheckOnClick = false };
        _petToggle.Click += (_, _) => _onTogglePet();
        menu.Items.Add(_petToggle);

        menu.Items.Add(new Forms.ToolStripSeparator());
        menu.Items.Add(_l("Nav.AiChat"), null, (_, _) => _onShowAndSwitch(AppPage.AiChat));
        menu.Items.Add(_l("Nav.Notes"), null, (_, _) => _onShowAndSwitch(AppPage.Notes));
        menu.Items.Add(_l("Nav.Ppt"), null, (_, _) => _onShowAndSwitch(AppPage.Ppt));
        menu.Items.Add(_l("Nav.Todo"), null, (_, _) => _onShowAndSwitch(AppPage.Todo));

        var toolsTray = new Forms.ToolStripMenuItem(_l("Tray.Tools"));
        toolsTray.DropDownItems.Add(_l("Nav.Network"), null, (_, _) => _onShowAndSwitch(AppPage.NetworkMonitor));
        toolsTray.DropDownItems.Add(_l("Nav.Cleanup"), null, (_, _) => _onShowAndSwitch(AppPage.Cleanup));
        menu.Items.Add(toolsTray);

        menu.Items.Add(_l("Nav.QuickAccess"), null, (_, _) => _onShowAndSwitch(AppPage.QuickAccess));
        menu.Items.Add(_l("Nav.PdfTools"), null, (_, _) => _onShowAndSwitch(AppPage.PdfTools));
        menu.Items.Add(_l("Nav.FileTools"), null, (_, _) => _onShowAndSwitch(AppPage.FileTools));
        menu.Items.Add(_l("Nav.Meeting"), null, (_, _) => _onShowAndSwitch(AppPage.MeetingAssistant));
        menu.Items.Add(_l("Nav.FileManager"), null, (_, _) => _onShowAndSwitch(AppPage.FileManager));
        menu.Items.Add(_l("Nav.Settings"), null, (_, _) => _onShowAndSwitch(AppPage.Settings));

        var proxyTray = new Forms.ToolStripMenuItem("代理快速切换");
        proxyTray.DropDownItems.Add("切到上海 PAC", null, (_, _) => _onApplyPac("shanghai"));
        proxyTray.DropDownItems.Add("切到北京 PAC", null, (_, _) => _onApplyPac("beijing"));
        proxyTray.DropDownItems.Add("切到手动代理", null, (_, _) => _onApplyManualProxy());
        proxyTray.DropDownItems.Add(new Forms.ToolStripSeparator());
        proxyTray.DropDownItems.Add("关闭强制代理", null, (_, _) => _onDisableProxyForce());
        menu.Items.Add(proxyTray);

        menu.Items.Add(new Forms.ToolStripSeparator());
        menu.Items.Add(_l("Tray.QuickScreenshot"), null, (_, _) => _onQuickScreenshot());
        menu.Items.Add(_l("Tray.RegionScreenshot"), null, (_, _) => _onRegionScreenshot());
        menu.Items.Add(_l("Tray.ScrollScreenshot"), null, (_, _) => _onScrollScreenshot());
        menu.Items.Add(_l("Tray.ContinuousScreenshot"), null, (_, _) => _onContinuousScreenshot());
        menu.Items.Add(new Forms.ToolStripSeparator());
        menu.Items.Add(_l("Tray.ShowFloating"), null, (_, _) => _onShowFloating());
        menu.Items.Add(_l("Tray.DockMode"), null, (_, _) => _onShowDock());
        menu.Items.Add(new Forms.ToolStripSeparator());
        menu.Items.Add(_l("Tray.Exit"), null, (_, _) => _onExit());

        menu.Closed += (_, _) => _onTrayMenuClosed();

        _icon.ContextMenuStrip = menu;
        _icon.MouseClick += (_, args) =>
        {
            if (args.Button == Forms.MouseButtons.Left)
                _onShowMain();
        };
    }

    public void ShowTip(string title, string text, int ms = 2500, Forms.ToolTipIcon icon = Forms.ToolTipIcon.Info)
    {
        _icon?.ShowBalloonTip(ms, title, text, icon);
    }

    public void SetTooltip(string text)
    {
        if (_icon == null) return;
        _icon.Text = text;
    }

    public void SetResourceMenuVisible(bool visible)
    {
        if (_cpu != null) _cpu.Visible = visible;
        if (_mem != null) _mem.Visible = visible;
        if (_disk != null) _disk.Visible = visible;
        if (_net != null) _net.Visible = visible;
    }

    public void UpdateResourceSnapshot(ResourceSnapshot snap, string networkLine, string tooltipText)
    {
        if (_cpu != null) { _cpu.Visible = true; _cpu.Text = $"CPU: {snap.CpuPercent:F0}%"; }
        if (_mem != null) { _mem.Visible = true; _mem.Text = $"内存: {snap.MemoryPercent:F0}%"; }
        if (_disk != null) { _disk.Visible = true; _disk.Text = $"磁盘: {snap.DiskUsedPercent:F0}%"; }
        if (_net != null) { _net.Visible = true; _net.Text = networkLine; }
        SetTooltip(tooltipText);
    }

    public void SetResourceToggleState(bool enabled)
    {
        if (_resourceToggle == null) return;
        _resourceToggle.Checked = enabled;
        _resourceToggle.Text = enabled ? "关闭资源监控" : "开启资源监控";
    }

    public void SetPetToggleState(bool enabled)
    {
        if (_petToggle == null) return;
        _petToggle.Checked = enabled;
        _petToggle.Text = enabled ? "关闭桌面宠物模式" : "开启桌面宠物模式";
    }

    public void Stop()
    {
        if (_icon == null) return;
        _icon.Visible = false;
        _icon.Dispose();
        _icon = null;
    }

    public void Dispose()
    {
        try { Stop(); } catch { /* best effort */ }
    }
}

