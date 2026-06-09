using System.Collections.ObjectModel;
using System.Windows;
using System.Windows.Controls;
using DesktopAssistant.Services;
using Microsoft.Win32;
using Forms = System.Windows.Forms;

namespace DesktopAssistant.Views;

public partial class PdfToolsView : UserControl
{
    private readonly ObservableCollection<string> _mergePaths = new();
    private string? _splitSourcePath;
    private bool _webInitialized;

    public PdfToolsView()
    {
        InitializeComponent();
        MergeList.ItemsSource = _mergePaths;
        Loaded += async (_, _) => await InitWebViewAsync();
        SplitModeEach.Checked += (_, _) => SplitRangesBox.IsEnabled = false;
        SplitModeRanges.Checked += (_, _) => SplitRangesBox.IsEnabled = true;
    }

    private async Task InitWebViewAsync()
    {
        if (_webInitialized)
            return;
        try
        {
            await PdfWebView.EnsureCoreWebView2Async();
            _webInitialized = true;
        }
        catch
        {
            // WebView2 不可用时仅影响预览
        }
    }

    private async void BtnOpenPdf_OnClick(object sender, RoutedEventArgs e)
    {
        await InitWebViewAsync();
        var dlg = new OpenFileDialog
        {
            Filter = "PDF 文件|*.pdf|所有文件|*.*",
            Title = "打开 PDF"
        };
        if (dlg.ShowDialog() != true)
            return;

        var path = dlg.FileName;
        ViewPathHint.Text = path;
        try
        {
            if (PdfWebView.CoreWebView2 != null)
            {
                var uri = new Uri(path).AbsoluteUri;
                PdfWebView.CoreWebView2.Navigate(uri);
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show($"无法在窗口内打开 PDF：{ex.Message}\n可尝试用系统默认程序打开该文件。", "提示",
                MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }

    private void MergeAdd_OnClick(object sender, RoutedEventArgs e)
    {
        var dlg = new OpenFileDialog
        {
            Filter = "PDF 文件|*.pdf",
            Title = "添加 PDF",
            Multiselect = true
        };
        if (dlg.ShowDialog() != true)
            return;
        foreach (var f in dlg.FileNames)
        {
            if (!_mergePaths.Contains(f, StringComparer.OrdinalIgnoreCase))
                _mergePaths.Add(f);
        }
    }

    private void MergeRemove_OnClick(object sender, RoutedEventArgs e)
    {
        if (MergeList.SelectedItem is string s)
            _mergePaths.Remove(s);
    }

    private void MergeUp_OnClick(object sender, RoutedEventArgs e)
    {
        var idx = MergeList.SelectedIndex;
        if (idx <= 0) return;
        _mergePaths.Move(idx, idx - 1);
        MergeList.SelectedIndex = idx - 1;
    }

    private void MergeDown_OnClick(object sender, RoutedEventArgs e)
    {
        var idx = MergeList.SelectedIndex;
        if (idx < 0 || idx >= _mergePaths.Count - 1) return;
        _mergePaths.Move(idx, idx + 1);
        MergeList.SelectedIndex = idx + 1;
    }

    private async void BtnMergeRun_OnClick(object sender, RoutedEventArgs e)
    {
        if (_mergePaths.Count == 0)
        {
            MessageBox.Show("请先添加要合并的 PDF。", "提示", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }

        var save = new SaveFileDialog
        {
            Filter = "PDF|*.pdf",
            Title = "保存合并后的 PDF",
            FileName = "merged.pdf"
        };
        if (save.ShowDialog() != true)
            return;

        BtnMergeRun.IsEnabled = false;
        try
        {
            await Task.Run(() => PdfToolsService.Merge(_mergePaths.ToList(), save.FileName));
            MessageBox.Show("合并完成。", "成功", MessageBoxButton.OK, MessageBoxImage.Information);
        }
        catch (Exception ex)
        {
            MessageBox.Show($"合并失败：{ex.Message}", "错误", MessageBoxButton.OK, MessageBoxImage.Error);
        }
        finally
        {
            BtnMergeRun.IsEnabled = true;
        }
    }

    private void SplitChoose_OnClick(object sender, RoutedEventArgs e)
    {
        var dlg = new OpenFileDialog { Filter = "PDF|*.pdf", Title = "选择要分割的 PDF" };
        if (dlg.ShowDialog() != true)
            return;
        _splitSourcePath = dlg.FileName;
        SplitFileHint.Text = _splitSourcePath;
        try
        {
            var n = PdfToolsService.GetPageCount(_splitSourcePath);
            SplitFileHint.Text = $"{_splitSourcePath}（共 {n} 页）";
        }
        catch (Exception ex)
        {
            SplitFileHint.Text = $"{_splitSourcePath}（无法读取：{ex.Message}）";
        }
    }

    private void SplitOutDir_OnClick(object sender, RoutedEventArgs e)
    {
        using var dlg = new Forms.FolderBrowserDialog { Description = "选择分割后 PDF 的保存文件夹" };
        if (dlg.ShowDialog() == Forms.DialogResult.OK)
            SplitOutDir.Text = dlg.SelectedPath;
    }

    private async void BtnSplitRun_OnClick(object sender, RoutedEventArgs e)
    {
        if (string.IsNullOrEmpty(_splitSourcePath) || !File.Exists(_splitSourcePath))
        {
            MessageBox.Show("请先选择要分割的 PDF。", "提示", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }

        if (string.IsNullOrWhiteSpace(SplitOutDir.Text) || !Directory.Exists(SplitOutDir.Text))
        {
            MessageBox.Show("请选择有效的输出文件夹。", "提示", MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        var prefix = SplitPrefixBox.Text.Trim();
        BtnSplitRun.IsEnabled = false;
        try
        {
            if (SplitModeEach.IsChecked == true)
            {
                await Task.Run(() =>
                    PdfToolsService.SplitEachPage(_splitSourcePath, SplitOutDir.Text, prefix));
            }
            else
            {
                var ranges = SplitRangesBox.Text.Trim();
                if (string.IsNullOrEmpty(ranges))
                {
                    MessageBox.Show("请输入页码范围。", "提示", MessageBoxButton.OK, MessageBoxImage.Warning);
                    return;
                }

                await Task.Run(() =>
                    PdfToolsService.SplitByRanges(_splitSourcePath, SplitOutDir.Text, ranges, prefix));
            }

            MessageBox.Show("分割完成。", "成功", MessageBoxButton.OK, MessageBoxImage.Information);
        }
        catch (Exception ex)
        {
            MessageBox.Show($"分割失败：{ex.Message}", "错误", MessageBoxButton.OK, MessageBoxImage.Error);
        }
        finally
        {
            BtnSplitRun.IsEnabled = true;
        }
    }
}
