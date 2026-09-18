using System.Collections.ObjectModel;
using System.Net.NetworkInformation;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Threading;
using DesktopAssistant.Models;
using DesktopAssistant.Services;

namespace DesktopAssistant.Views;

public partial class NetworkMonitorView : UserControl
{
    private readonly DispatcherTimer _autoTimer;
    private CancellationTokenSource? _refreshCts;

    public NetworkMonitorView()
    {
        InitializeComponent();
        StatusDot.Fill = new SolidColorBrush(System.Windows.Media.Color.FromRgb(0x9E, 0x9E, 0x9E));

        _autoTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(60) };
        _autoTimer.Tick += (_, _) => _ = RunRefreshAsync();

        Loaded += OnLoaded;
        Unloaded += OnUnloaded;
    }

    private void OnLoaded(object sender, RoutedEventArgs e)
    {
        NetworkChange.NetworkAvailabilityChanged -= OnNetworkAvailabilityChanged;
        NetworkChange.NetworkAvailabilityChanged += OnNetworkAvailabilityChanged;
        AutoRefreshCheck.Checked -= AutoRefreshCheck_OnChanged;
        AutoRefreshCheck.Checked += AutoRefreshCheck_OnChanged;
        AutoRefreshCheck.Unchecked -= AutoRefreshCheck_OnChanged;
        AutoRefreshCheck.Unchecked += AutoRefreshCheck_OnChanged;
    }

    private void OnUnloaded(object sender, RoutedEventArgs e)
    {
        NetworkChange.NetworkAvailabilityChanged -= OnNetworkAvailabilityChanged;
        AutoRefreshCheck.Checked -= AutoRefreshCheck_OnChanged;
        AutoRefreshCheck.Unchecked -= AutoRefreshCheck_OnChanged;
        _autoTimer.Stop();
        _refreshCts?.Cancel();
    }

    private void OnNetworkAvailabilityChanged(object? sender, EventArgs e)
    {
        Dispatcher.BeginInvoke(() => _ = RunRefreshAsync());
    }

    private void AutoRefreshCheck_OnChanged(object sender, RoutedEventArgs e)
    {
        if (AutoRefreshCheck.IsChecked == true)
            _autoTimer.Start();
        else
            _autoTimer.Stop();
    }

    public void RequestRefresh() => _ = RunRefreshAsync();

    private async void RefreshBtn_OnClick(object sender, RoutedEventArgs e) => await RunRefreshAsync();

    private async Task RunRefreshAsync()
    {
        _refreshCts?.Cancel();
        _refreshCts = new CancellationTokenSource();
        var token = _refreshCts.Token;

        RefreshBtn.IsEnabled = false;
        BusyText.Visibility = Visibility.Visible;

        try
        {
            var available = NetworkMonitorService.GetIsNetworkAvailable();
            StatusTitle.Text = available ? "当前网络可用" : "当前网络不可用";
            StatusDot.Fill = new SolidColorBrush(available
                ? System.Windows.Media.Color.FromRgb(0x2E, 0x7D, 0x32)
                : System.Windows.Media.Color.FromRgb(0xC6, 0x28, 0x28));
            StatusTime.Text = $"最近检测：{DateTime.Now:yyyy-MM-dd HH:mm:ss}";

            var adapters = NetworkMonitorService.GetAdapters();
            AdapterList.ItemsSource = new ObservableCollection<NetworkAdapterRow>(adapters);
            NoAdapterText.Visibility = adapters.Count == 0 ? Visibility.Visible : Visibility.Collapsed;

            var cfg = App.Config.Load();
            var probes = await NetworkMonitorService.RunProbesAsync(cfg, token).ConfigureAwait(true);
            ProbeList.ItemsSource = new ObservableCollection<ProbeRow>(probes);
        }
        catch (OperationCanceledException)
        {
            // ignore
        }
        catch (Exception ex)
        {
            StatusTitle.Text = "检测过程出错";
            StatusDot.Fill = new SolidColorBrush(System.Windows.Media.Color.FromRgb(0xC6, 0x28, 0x28));
            StatusTime.Text = ex.Message;
        }
        finally
        {
            BusyText.Visibility = Visibility.Collapsed;
            RefreshBtn.IsEnabled = true;
        }
    }
}
