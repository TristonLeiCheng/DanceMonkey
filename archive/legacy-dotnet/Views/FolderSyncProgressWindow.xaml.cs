using System.ComponentModel;
using System.Windows;
using DesktopAssistant.Models;

namespace DesktopAssistant.Views;

public partial class FolderSyncProgressWindow : Window
{
    private readonly CancellationTokenSource _cancellation = new();
    private bool _completed;

    public FolderSyncProgressWindow(string profileName, FolderSyncPreview preview)
    {
        InitializeComponent();
        Title = AppBranding.DisplayName + " - 文件夹同步";
        TitleText.Text = string.IsNullOrWhiteSpace(profileName) ? "正在同步文件夹" : $"正在同步：{profileName}";
        SummaryText.Text = preview.Summary;
        SyncProgressBar.Maximum = Math.Max(1, preview.Items.Count);
        SyncProgressBar.Value = 0;
        PercentText.Text = "0%";
    }

    public CancellationToken CancellationToken => _cancellation.Token;

    public void UpdateProgress(FolderSyncProgress progress)
    {
        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.BeginInvoke(() => UpdateProgress(progress));
            return;
        }

        SyncProgressBar.Maximum = Math.Max(1, progress.TotalOperations);
        SyncProgressBar.Value = Math.Min(progress.CompletedOperations, (int)SyncProgressBar.Maximum);
        PercentText.Text = $"{progress.Percent:F0}%";
        CurrentText.Text = string.IsNullOrWhiteSpace(progress.StatusText)
            ? progress.CurrentPath
            : progress.StatusText;

        if (progress.IsCompleted)
        {
            _completed = true;
            CancelButton.Content = "关闭";
            CancelButton.IsEnabled = true;
        }
    }

    public void MarkCompleted(FolderSyncRunResult result)
    {
        var total = Math.Max(1, result.Preview.Items.Count);
        var completed = result.Cancelled
            ? (int)SyncProgressBar.Value
            : result.Preview.Items.Count == 0 ? total : result.Preview.Items.Count;

        UpdateProgress(new FolderSyncProgress
        {
            TotalOperations = total,
            CompletedOperations = completed,
            StatusText = result.Summary,
            IsCompleted = true,
            IsCancelled = result.Cancelled
        });
    }

    public void MarkFailed(string message)
    {
        UpdateProgress(new FolderSyncProgress
        {
            TotalOperations = Math.Max(1, (int)SyncProgressBar.Maximum),
            CompletedOperations = (int)SyncProgressBar.Value,
            StatusText = "同步失败：" + message,
            IsCompleted = true
        });
    }

    private void Cancel_OnClick(object sender, RoutedEventArgs e)
    {
        if (_completed)
        {
            Close();
            return;
        }

        _cancellation.Cancel();
        CancelButton.IsEnabled = false;
        CancelButton.Content = "正在取消...";
        CurrentText.Text = "取消请求已发送，当前文件处理完成后停止。";
    }

    protected override void OnClosing(CancelEventArgs e)
    {
        if (!_completed)
        {
            e.Cancel = true;
            if (!_cancellation.IsCancellationRequested)
                Cancel_OnClick(this, new RoutedEventArgs());
            return;
        }

        _cancellation.Dispose();
        base.OnClosing(e);
    }
}
