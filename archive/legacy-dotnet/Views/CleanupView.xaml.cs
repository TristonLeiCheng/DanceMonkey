using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using System.Windows;
using System.Windows.Controls;
using DesktopAssistant.Services;

namespace DesktopAssistant.Views;

public partial class CleanupView : UserControl
{
    private readonly ObservableCollection<CleanupTargetVm> _targets = new();

    public CleanupView()
    {
        InitializeComponent();
        foreach (var t in CleanupService.GetDefaultTargets())
            _targets.Add(new CleanupTargetVm(t));
        TargetsList.ItemsSource = _targets;
    }

    private async void AnalyzeBtn_OnClick(object sender, RoutedEventArgs e)
    {
        AnalyzeBtn.IsEnabled = false;
        CleanBtn.IsEnabled = false;
        LogBox.Text = "";
        var progress = new Progress<string>(s => Dispatcher.Invoke(() => LogBox.AppendText(s + Environment.NewLine)));
        try
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromMinutes(10));
            foreach (var vm in _targets)
            {
                var entry = await Task.Run(() =>
                    CleanupService.Analyze(vm.Key, vm.DisplayName, vm.RootPath, progress, cts.Token), cts.Token);
                var mb = entry.Bytes / 1024.0 / 1024.0;
                Dispatcher.Invoke(() =>
                {
                    LogBox.AppendText(
                        $"{entry.DisplayName}: {mb:F2} MB，约 {entry.FileCount} 个文件");
                    if (!string.IsNullOrEmpty(entry.Error))
                        LogBox.AppendText($" — {entry.Error}");
                    LogBox.AppendText(Environment.NewLine);
                });
            }

            Dispatcher.Invoke(() => LogBox.AppendText("分析完成。" + Environment.NewLine));
        }
        catch (OperationCanceledException)
        {
            Dispatcher.Invoke(() => LogBox.AppendText("已取消。" + Environment.NewLine));
        }
        catch (Exception ex)
        {
            Dispatcher.Invoke(() => LogBox.AppendText("错误: " + ex.Message + Environment.NewLine));
        }
        finally
        {
            AnalyzeBtn.IsEnabled = true;
            CleanBtn.IsEnabled = true;
        }
    }

    private async void CleanBtn_OnClick(object sender, RoutedEventArgs e)
    {
        var r = MessageBox.Show(
            "将删除所选目录下的文件（不删除文件夹本身）。是否继续？",
            "确认清理",
            MessageBoxButton.YesNo,
            MessageBoxImage.Warning);
        if (r != MessageBoxResult.Yes)
            return;

        AnalyzeBtn.IsEnabled = false;
        CleanBtn.IsEnabled = false;
        LogBox.Text = "";
        var progress = new Progress<string>(s => Dispatcher.Invoke(() => LogBox.AppendText(s + Environment.NewLine)));
        try
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromMinutes(30));
            var list = _targets.Select(vm => new CleanupTarget
            {
                Key = vm.Key,
                DisplayName = vm.DisplayName,
                RootPath = vm.RootPath,
                Enabled = vm.Enabled
            }).ToList();

            var lines = await CleanupService.CleanAsync(list, progress, cts.Token);
            foreach (var line in lines)
                Dispatcher.Invoke(() => LogBox.AppendText(line.Message + Environment.NewLine));
            Dispatcher.Invoke(() => LogBox.AppendText("清理流程结束。" + Environment.NewLine));
        }
        catch (OperationCanceledException)
        {
            Dispatcher.Invoke(() => LogBox.AppendText("已取消。" + Environment.NewLine));
        }
        catch (Exception ex)
        {
            Dispatcher.Invoke(() => LogBox.AppendText("错误: " + ex.Message + Environment.NewLine));
        }
        finally
        {
            AnalyzeBtn.IsEnabled = true;
            CleanBtn.IsEnabled = true;
        }
    }

    private sealed class CleanupTargetVm : INotifyPropertyChanged
    {
        public CleanupTargetVm(CleanupTarget t)
        {
            Key = t.Key;
            DisplayName = t.DisplayName;
            RootPath = t.RootPath;
            _enabled = t.Enabled;
        }

        public string Key { get; }
        public string DisplayName { get; }
        public string RootPath { get; }

        private bool _enabled;

        public bool Enabled
        {
            get => _enabled;
            set
            {
                if (_enabled == value) return;
                _enabled = value;
                OnPropertyChanged();
            }
        }

        public event PropertyChangedEventHandler? PropertyChanged;

        private void OnPropertyChanged([CallerMemberName] string? name = null) =>
            PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
    }
}
