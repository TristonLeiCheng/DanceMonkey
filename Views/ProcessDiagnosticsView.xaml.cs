using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Diagnostics;
using System.Text;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Threading;
using DesktopAssistant.Models;
using DesktopAssistant.Services;
using Color = System.Windows.Media.Color;

namespace DesktopAssistant.Views;

public partial class ProcessDiagnosticsView : UserControl
{
    private int _monitorPid;
    private ProcessNode? _currentTree;
    private HashSet<int> _currentPids = new();
    private readonly ObservableCollection<ConnectionVm> _connectionVms = new();
    private readonly ObservableCollection<DnsVm> _dnsVms = new();
    private readonly DispatcherTimer _refreshTimer;
    private CancellationTokenSource? _refreshCts;
    private EtwNetworkTracer? _tracer;

    /// <summary>DataGrid 绑定的连接视图模型。</summary>
    public sealed class ConnectionVm
    {
        public int OwningPid { get; init; }
        public string ProcessName { get; init; } = "";
        public string Protocol { get; init; } = "";
        public string LocalDisplay { get; init; } = "";
        public string RemoteDisplay { get; init; } = "";
        public string State { get; init; } = "";
        public string SentDisplay { get; init; } = "";
        public string RecvDisplay { get; init; } = "";
    }

    /// <summary>DNS 查询记录视图模型。</summary>
    public sealed class DnsVm
    {
        public string Time { get; init; } = "";
        public string QueryName { get; init; } = "";
        public string Results { get; init; } = "";
    }

    /// <summary>进程选择器中的条目。</summary>
    private sealed class ProcessPickerItem
    {
        public int Pid { get; init; }
        public string Name { get; init; } = "";
        public string Display { get; init; } = "";
    }

    private List<ProcessPickerItem> _allProcessItems = new();

    public ProcessDiagnosticsView()
    {
        InitializeComponent();
        ConnectionGrid.ItemsSource = _connectionVms;
        DnsGrid.ItemsSource = _dnsVms;

        _refreshTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(3) };
        _refreshTimer.Tick += async (_, _) => await RefreshDataAsync();
    }

    #region 拖拽

    private void DropZone_OnDragOver(object sender, DragEventArgs e)
    {
        if (e.Data.GetDataPresent(DataFormats.FileDrop))
        {
            e.Effects = DragDropEffects.Link;
            DropZone.BorderBrush = new SolidColorBrush(System.Windows.Media.Color.FromRgb(0x7C, 0x5C, 0xFC));
            DropZone.Background = new SolidColorBrush(System.Windows.Media.Color.FromRgb(0xF0, 0xEC, 0xFF));
        }
        else
        {
            e.Effects = DragDropEffects.None;
        }
        e.Handled = true;
    }

    private void DropZone_OnDragLeave(object sender, DragEventArgs e)
    {
        DropZone.BorderBrush = new SolidColorBrush(System.Windows.Media.Color.FromRgb(0xD0, 0xD5, 0xDD));
        DropZone.Background = new SolidColorBrush(System.Windows.Media.Color.FromRgb(0xFA, 0xFB, 0xFC));
    }

    private void DropZone_OnDrop(object sender, DragEventArgs e)
    {
        DropZone_OnDragLeave(sender, e);

        if (!e.Data.GetDataPresent(DataFormats.FileDrop)) return;

        var files = (string[])e.Data.GetData(DataFormats.FileDrop)!;
        var exe = files.FirstOrDefault(f =>
            f.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ||
            f.EndsWith(".lnk", StringComparison.OrdinalIgnoreCase));

        if (exe == null)
        {
            MessageBox.Show("请拖入 .exe 可执行文件或 .lnk 快捷方式。", "提示", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }

        var procs = ProcessInspectorService.FindProcessesByPath(exe);
        if (procs.Count == 0)
        {
            var name = System.IO.Path.GetFileNameWithoutExtension(exe);
            MessageBox.Show($"未找到 \"{name}\" 的运行中进程。\n请先启动该程序再拖入。", "未找到进程", MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        StartMonitoring(procs[0].Id);
    }

    private void DropZone_OnClick(object sender, MouseButtonEventArgs e)
    {
        ShowProcessPicker();
    }

    #endregion

    #region 进程选择器

    private void ShowProcessPicker()
    {
        _allProcessItems = new List<ProcessPickerItem>();
        try
        {
            foreach (var proc in Process.GetProcesses().OrderBy(p => p.ProcessName))
            {
                try
                {
                    // 跳过无窗口的系统进程
                    if (proc.MainWindowHandle == IntPtr.Zero && proc.SessionId == 0) continue;
                    var mem = proc.WorkingSet64 / (1024.0 * 1024);
                    _allProcessItems.Add(new ProcessPickerItem
                    {
                        Pid = proc.Id,
                        Name = proc.ProcessName,
                        Display = $"{proc.ProcessName}  (PID {proc.Id}, {mem:F0} MB)"
                    });
                }
                catch { }
            }
        }
        catch { }

        ProcessList.ItemsSource = _allProcessItems;
        ProcessFilterBox.Text = "";
        ProcessPickerPanel.Visibility = Visibility.Visible;
        ProcessFilterBox.Focus();
    }

    private void ProcessFilterBox_OnTextChanged(object sender, TextChangedEventArgs e)
    {
        var filter = ProcessFilterBox.Text.Trim();
        ProcessFilterPlaceholder.Visibility = string.IsNullOrEmpty(filter) ? Visibility.Visible : Visibility.Collapsed;
        if (string.IsNullOrEmpty(filter))
        {
            ProcessList.ItemsSource = _allProcessItems;
        }
        else
        {
            ProcessList.ItemsSource = _allProcessItems
                .Where(p => p.Name.Contains(filter, StringComparison.OrdinalIgnoreCase) ||
                            p.Pid.ToString().Contains(filter))
                .ToList();
        }
    }

    private void ProcessList_OnSelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (ProcessList.SelectedItem is ProcessPickerItem item)
        {
            ProcessPickerPanel.Visibility = Visibility.Collapsed;
            StartMonitoring(item.Pid);
        }
    }

    private void CloseProcessPicker_OnClick(object sender, RoutedEventArgs e)
    {
        ProcessPickerPanel.Visibility = Visibility.Collapsed;
    }

    #endregion

    #region 监控核心

    private void StartMonitoring(int pid)
    {
        StopMonitoring();
        _monitorPid = pid;

        // 构建进程树
        _currentTree = ProcessInspectorService.BuildProcessTree(pid);
        _currentPids = ProcessInspectorService.CollectAllPids(_currentTree);
        ProcessInspectorService.RefreshMetrics(_currentTree);

        // 显示 UI
        TargetProcessName.Text = $"{_currentTree.Name} (PID {pid})";
        TargetProcessDetail.Text = _currentTree.ExePath ?? "";
        MonitorHeader.Visibility = Visibility.Visible;
        TreeCard.Visibility = Visibility.Visible;
        ConnectionsCard.Visibility = Visibility.Visible;
        TrafficSummaryCard.Visibility = Visibility.Visible;
        DnsCard.Visibility = Visibility.Visible;

        // 启动 ETW 流量捕获
        StartEtwTracer();

        UpdateTreeDisplay();
        _ = RefreshDataAsync();

        if (AutoRefreshCheck.IsChecked == true)
            _refreshTimer.Start();
    }

    private void StartEtwTracer()
    {
        _tracer = new EtwNetworkTracer();
        _tracer.SetTargetPids(_currentPids);
        _tracer.Start();

        // 显示 ETW 状态
        EtwStatusBanner.Visibility = Visibility.Visible;
        if (_tracer.IsActive)
        {
            EtwStatusBanner.Background = new SolidColorBrush(Color.FromRgb(0xF0, 0xFD, 0xF4));
            EtwStatusIcon.Text = "⚡";
            EtwStatusText.Text = "实时流量捕获已启动 — 正在通过 ETW 内核事件跟踪每个连接的发送/接收字节数、DNS 查询等";
            EtwStatusText.Foreground = new SolidColorBrush(Color.FromRgb(0x05, 0x96, 0x69));
        }
        else
        {
            EtwStatusBanner.Background = new SolidColorBrush(Color.FromRgb(0xFF, 0xF7, 0xED));
            EtwStatusIcon.Text = "⚠️";
            EtwStatusText.Text = _tracer.ActivationError ?? "流量捕获未启动，仅显示连接元数据。以管理员身份运行可获取完整流量数据。";
            EtwStatusText.Foreground = new SolidColorBrush(Color.FromRgb(0xEA, 0x58, 0x0C));
        }
    }

    private void StopMonitoring()
    {
        _refreshTimer.Stop();
        _refreshCts?.Cancel();

        // 停止 ETW
        _tracer?.Stop();
        _tracer?.Dispose();
        _tracer = null;

        _monitorPid = 0;
        _currentTree = null;
        _currentPids.Clear();
        _connectionVms.Clear();
        _dnsVms.Clear();

        MonitorHeader.Visibility = Visibility.Collapsed;
        TreeCard.Visibility = Visibility.Collapsed;
        ConnectionsCard.Visibility = Visibility.Collapsed;
        AiResultCard.Visibility = Visibility.Collapsed;
        TrafficSummaryCard.Visibility = Visibility.Collapsed;
        EtwStatusBanner.Visibility = Visibility.Collapsed;
        DnsCard.Visibility = Visibility.Collapsed;
    }

    private async Task RefreshDataAsync()
    {
        if (_currentTree == null || _monitorPid == 0) return;

        _refreshCts?.Cancel();
        _refreshCts = new CancellationTokenSource();
        var ct = _refreshCts.Token;

        try
        {
            // CPU 两次采样（间隔 500ms）
            var before = ProcessInspectorService.SnapshotCpuTimes(_currentPids);
            await Task.Delay(500, ct);
            var after = ProcessInspectorService.SnapshotCpuTimes(_currentPids);
            ProcessInspectorService.ApplyCpuDelta(_currentTree, before, after, 500);
            ProcessInspectorService.RefreshMetrics(_currentTree);

            // 获取网络连接
            var connections = ProcessNetworkCaptureService.CaptureConnections(_currentPids);

            // 反向 DNS（后台，不阻塞 UI）
            _ = Task.Run(async () =>
            {
                await ProcessNetworkCaptureService.ResolveHostNamesAsync(connections, ct);
                if (!ct.IsCancellationRequested)
                    Dispatcher.InvokeAsync(() => UpdateConnectionGrid(connections));
            }, ct);

            await Dispatcher.InvokeAsync(() =>
            {
                UpdateTreeDisplay();
                UpdateConnectionGrid(connections);
            });
        }
        catch (OperationCanceledException) { }
        catch (Exception ex)
        {
            Debug.WriteLine($"[ProcessDiag] Refresh error: {ex.Message}");
        }
    }

    private void UpdateTreeDisplay()
    {
        if (_currentTree == null) return;
        var sb = new StringBuilder();
        FormatTreeNode(sb, _currentTree, "", true);
        TreeText.Text = sb.ToString().TrimEnd();
    }

    private static void FormatTreeNode(StringBuilder sb, ProcessNode node, string prefix, bool isLast)
    {
        var connector = string.IsNullOrEmpty(prefix) ? "" : (isLast ? "└── " : "├── ");
        var mem = FormatBytes(node.WorkingSetBytes);
        sb.AppendLine($"{prefix}{connector}{node.Name} (PID {node.Pid})  CPU {node.CpuPercent:F1}%  内存 {mem}  线程 {node.ThreadCount}  句柄 {node.HandleCount}");

        var childPrefix = prefix + (string.IsNullOrEmpty(prefix) ? "" : (isLast ? "    " : "│   "));
        for (var i = 0; i < node.Children.Count; i++)
            FormatTreeNode(sb, node.Children[i], childPrefix, i == node.Children.Count - 1);
    }

    private void UpdateConnectionGrid(List<ProcessConnectionRow> connections)
    {
        // 将 ETW 流量数据合并到连接行
        if (_tracer?.IsActive == true)
        {
            foreach (var c in connections)
            {
                var stats = _tracer.GetConnectionTraffic(c.OwningPid, c.LocalEndPoint, c.RemoteEndPoint);
                if (stats != null)
                {
                    c.BytesSent = stats.BytesSent;
                    c.BytesRecv = stats.BytesRecv;
                    c.PacketsSent = stats.PacketsSent;
                    c.PacketsRecv = stats.PacketsRecv;
                }
            }
        }

        _connectionVms.Clear();
        foreach (var c in connections.OrderByDescending(c => c.BytesSent + c.BytesRecv).ThenByDescending(c => c.State == "ESTABLISHED").ThenBy(c => c.OwningPid))
        {
            var remoteDisplay = c.RemoteHostName != null
                ? $"{c.RemoteHostName} ({c.RemoteEndPoint})"
                : c.RemoteEndPoint.ToString();
            _connectionVms.Add(new ConnectionVm
            {
                OwningPid = c.OwningPid,
                ProcessName = c.ProcessName,
                Protocol = c.Protocol,
                LocalDisplay = c.LocalEndPoint.ToString(),
                RemoteDisplay = remoteDisplay ?? "",
                State = c.State,
                SentDisplay = c.BytesSent > 0 ? FormatBytes(c.BytesSent) : "-",
                RecvDisplay = c.BytesRecv > 0 ? FormatBytes(c.BytesRecv) : "-",
            });
        }

        ConnectionCountText.Text = $"共 {connections.Count} 条";
        NoConnectionsText.Visibility = connections.Count == 0 ? Visibility.Visible : Visibility.Collapsed;

        // 更新流量汇总
        UpdateTrafficSummary(connections);

        // 更新 DNS 记录
        UpdateDnsGrid();
    }

    private void UpdateTrafficSummary(List<ProcessConnectionRow> connections)
    {
        if (_tracer?.IsActive == true)
        {
            var summary = _tracer.GetSummary();
            TrafficSentText.Text = FormatBytes(summary.TotalBytesSent);
            TrafficRecvText.Text = FormatBytes(summary.TotalBytesRecv);
            TrafficTotalText.Text = FormatBytes(summary.TotalBytes);
            TrafficSentPkts.Text = $"{summary.TotalPacketsSent} 包";
            TrafficRecvPkts.Text = $"{summary.TotalPacketsRecv} 包";
        }
        else
        {
            // 无 ETW 时显示连接级汇总
            var totalSent = connections.Sum(c => c.BytesSent);
            var totalRecv = connections.Sum(c => c.BytesRecv);
            TrafficSentText.Text = totalSent > 0 ? FormatBytes(totalSent) : "N/A";
            TrafficRecvText.Text = totalRecv > 0 ? FormatBytes(totalRecv) : "N/A";
            TrafficTotalText.Text = (totalSent + totalRecv) > 0 ? FormatBytes(totalSent + totalRecv) : "N/A";
            TrafficSentPkts.Text = "-";
            TrafficRecvPkts.Text = "-";
        }
        TrafficConnCount.Text = $"{connections.Count} 连接";
        DnsCountText.Text = _tracer?.IsActive == true ? _tracer.GetDnsQueries().Count.ToString() : "-";
    }

    private void UpdateDnsGrid()
    {
        if (_tracer?.IsActive != true)
        {
            NoDnsText.Visibility = Visibility.Visible;
            return;
        }

        var queries = _tracer.GetDnsQueries();
        _dnsVms.Clear();
        foreach (var d in queries.TakeLast(100))
        {
            _dnsVms.Add(new DnsVm
            {
                Time = d.Timestamp.ToString("HH:mm:ss.fff"),
                QueryName = d.QueryName,
                Results = string.IsNullOrEmpty(d.QueryResults) ? "-" : d.QueryResults,
            });
        }
        NoDnsText.Visibility = _dnsVms.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
    }

    #endregion

    #region UI 事件

    private void RefreshBtn_OnClick(object sender, RoutedEventArgs e) => _ = RefreshDataAsync();

    private void StopMonitor_OnClick(object sender, RoutedEventArgs e) => StopMonitoring();

    private void AutoRefreshCheck_Changed(object sender, RoutedEventArgs e)
    {
        if (_refreshTimer == null) return; // XAML 初始化阶段尚未创建 timer
        if (_monitorPid != 0 && AutoRefreshCheck.IsChecked == true)
            _refreshTimer.Start();
        else
            _refreshTimer.Stop();
    }

    private async void AskAiBtn_OnClick(object sender, RoutedEventArgs e)
    {
        if (_currentTree == null) return;

        AskAiBtn.IsEnabled = false;
        AskAiBtn.Content = "⏳ 分析中…";
        AiResultCard.Visibility = Visibility.Visible;
        AiResultText.Text = "正在收集诊断数据并发送给 AI 分析…";

        try
        {
            // 收集完整数据
            var connections = ProcessNetworkCaptureService.CaptureConnections(_currentPids);
            await ProcessNetworkCaptureService.ResolveHostNamesAsync(connections, CancellationToken.None);

            // 合并 ETW 流量
            if (_tracer?.IsActive == true)
            {
                foreach (var c in connections)
                {
                    var stats = _tracer.GetConnectionTraffic(c.OwningPid, c.LocalEndPoint, c.RemoteEndPoint);
                    if (stats != null)
                    {
                        c.BytesSent = stats.BytesSent;
                        c.BytesRecv = stats.BytesRecv;
                        c.PacketsSent = stats.PacketsSent;
                        c.PacketsRecv = stats.PacketsRecv;
                    }
                }
            }

            var trafficSummary = _tracer?.IsActive == true ? _tracer.GetSummary() : null;
            var dnsQueries = _tracer?.IsActive == true ? _tracer.GetDnsQueries() : null;
            var report = ProcessInspectorService.FormatTreeText(_currentTree, connections, trafficSummary, dnsQueries);

            // 发送到 GlobalChatWindow
            var mainWin = Application.Current.MainWindow as MainWindow;
            if (mainWin == null) return;

            // 用 AgentHandoff 将诊断报告发送到 AI 聊天
            var prompt = $"请分析以下进程的运行状况和网络连接，给出诊断建议：\n\n{report}";

            // 通过 GlobalChatWindow 发送
            var chatWin = FindGlobalChatWindow();
            if (chatWin != null)
            {
                chatWin.ShowAndSendDiagnostic(prompt);
                AiResultText.Text = "已发送至 AI 助手进行分析，请查看聊天窗口。";
            }
            else
            {
                // 复制到剪贴板作为后备
                Clipboard.SetText(report);
                AiResultText.Text = "诊断数据已复制到剪贴板。\n请打开 AI 聊天窗口 (Alt+Space) 粘贴并发送。\n\n" + report;
            }
        }
        catch (Exception ex)
        {
            AiResultText.Text = $"分析出错: {ex.Message}";
        }
        finally
        {
            AskAiBtn.IsEnabled = true;
            AskAiBtn.Content = "🤖 AI 诊断";
        }
    }

    private static GlobalChatWindow? FindGlobalChatWindow()
    {
        foreach (Window w in Application.Current.Windows)
        {
            if (w is GlobalChatWindow gcw) return gcw;
        }
        return null;
    }

    /// <summary>从 GlobalChatWindow 拖入文件时调用。</summary>
    public void StartMonitorFromExePath(string exePath)
    {
        var procs = ProcessInspectorService.FindProcessesByPath(exePath);
        if (procs.Count > 0)
        {
            StartMonitoring(procs[0].Id);
        }
        else
        {
            MessageBox.Show($"未找到 \"{System.IO.Path.GetFileNameWithoutExtension(exePath)}\" 的运行中进程。",
                "未找到进程", MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }

    /// <summary>从外部直接指定 PID 开始监控。</summary>
    public void StartMonitorFromPid(int pid) => StartMonitoring(pid);

    #endregion

    private static string FormatBytes(long bytes) => bytes switch
    {
        >= 1024 * 1024 * 1024 => $"{bytes / (1024.0 * 1024 * 1024):F1} GB",
        >= 1024 * 1024 => $"{bytes / (1024.0 * 1024):F1} MB",
        >= 1024 => $"{bytes / 1024.0:F1} KB",
        _ => $"{bytes} B"
    };
}
