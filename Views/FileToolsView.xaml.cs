using System.Collections.ObjectModel;
using System.Diagnostics;
using System.Globalization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using DesktopAssistant.Services;
using Forms = System.Windows.Forms;

namespace DesktopAssistant.Views;

public partial class FileToolsView : UserControl
{
    private readonly ObservableCollection<SearchResultVm> _searchResults = new();
    private readonly ObservableCollection<RenamePreviewRow> _renamePreviewRows = new();
    private List<string> _renameFilePaths = new();
    private IReadOnlyList<RenamePreviewRow> _lastPreview = Array.Empty<RenamePreviewRow>();

    public FileToolsView()
    {
        InitializeComponent();
        SearchResultGrid.ItemsSource = _searchResults;
        RenamePreviewGrid.ItemsSource = _renamePreviewRows;
        SearchSubfoldersCheck.IsChecked = true;
        SearchFolderBox.Text = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
    }

    private sealed class SearchResultVm
    {
        public required string FullPath { get; init; }
        public required string Name { get; init; }
        public required string FolderDisplay { get; init; }
        public required string CreatedDisplay { get; init; }
        public required string SizeDisplay { get; init; }
        public required string ModifiedDisplay { get; init; }
    }

    private void SearchPickFolder_OnClick(object sender, RoutedEventArgs e)
    {
        using var dlg = new Forms.FolderBrowserDialog { Description = "选择要搜索的文件夹" };
        if (dlg.ShowDialog() == Forms.DialogResult.OK)
            SearchFolderBox.Text = dlg.SelectedPath;
    }

    private async void BtnSearchRun_OnClick(object sender, RoutedEventArgs e)
    {
        if (string.IsNullOrWhiteSpace(SearchFolderBox.Text) || !Directory.Exists(SearchFolderBox.Text))
        {
            MessageBox.Show("请先选择有效的文件夹。", "提示", MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        if (!int.TryParse(SearchMaxBox.Text.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var max) ||
            max < 1)
            max = 500;
        max = Math.Clamp(max, 1, 5000);

        BtnSearchRun.IsEnabled = false;
        SearchStatusText.Text = "搜索中…";
        _searchResults.Clear();

        try
        {
            var folder = SearchFolderBox.Text.Trim();
            var kw = SearchKeywordBox.Text ?? "";
            var sub = SearchSubfoldersCheck.IsChecked == true;
            var progress = new Progress<string>(s => Dispatcher.Invoke(() => SearchStatusText.Text = s));

            var hits = await Task.Run(() =>
                    FileSearchService.Search(folder, kw, sub, max, progress),
                CancellationToken.None);

            foreach (var h in hits)
            {
                _searchResults.Add(new SearchResultVm
                {
                    FullPath = h.FullPath,
                    Name = h.Name,
                    FolderDisplay = Path.GetDirectoryName(h.FullPath) ?? "",
                    CreatedDisplay = h.CreationUtc.ToLocalTime().ToString("yyyy-MM-dd HH:mm", CultureInfo.CurrentCulture),
                    SizeDisplay = FormatSize(h.LengthBytes),
                    ModifiedDisplay = h.LastWriteUtc.ToLocalTime().ToString("yyyy-MM-dd HH:mm", CultureInfo.CurrentCulture)
                });
            }

            SearchStatusText.Text = $"共 {_searchResults.Count} 条";
        }
        catch (Exception ex)
        {
            MessageBox.Show($"搜索失败：{ex.Message}", "错误", MessageBoxButton.OK, MessageBoxImage.Error);
            SearchStatusText.Text = "";
        }
        finally
        {
            BtnSearchRun.IsEnabled = true;
        }
    }

    private static string FormatSize(long bytes)
    {
        if (bytes < 1024) return $"{bytes} B";
        if (bytes < 1024 * 1024) return $"{bytes / 1024.0:F1} KB";
        return $"{bytes / (1024.0 * 1024):F1} MB";
    }

    private void SearchResultGrid_OnMouseDoubleClick(object sender, MouseButtonEventArgs e)
    {
        if (SearchResultGrid.SelectedItem is not SearchResultVm row)
            return;
        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = "explorer.exe",
                Arguments = $"/select,\"{row.FullPath}\"",
                UseShellExecute = true
            });
        }
        catch
        {
            // ignore
        }
    }

    private void RenamePickFolder_OnClick(object sender, RoutedEventArgs e)
    {
        using var dlg = new Forms.FolderBrowserDialog { Description = "选择要批量重命名的文件所在文件夹" };
        if (dlg.ShowDialog() == Forms.DialogResult.OK)
            RenameFolderBox.Text = dlg.SelectedPath;
    }

    private void RenameListFiles_OnClick(object sender, RoutedEventArgs e)
    {
        if (string.IsNullOrWhiteSpace(RenameFolderBox.Text) || !Directory.Exists(RenameFolderBox.Text))
        {
            MessageBox.Show("请先选择文件夹。", "提示", MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        var pattern = string.IsNullOrWhiteSpace(RenamePatternBox.Text) ? "*" : RenamePatternBox.Text.Trim();
        var sub = RenameSubfoldersCheck.IsChecked == true;
        var opts = sub ? SearchOption.AllDirectories : SearchOption.TopDirectoryOnly;

        try
        {
            _renameFilePaths = Directory.EnumerateFiles(RenameFolderBox.Text.Trim(), pattern, opts)
                .OrderBy(p => p, StringComparer.OrdinalIgnoreCase)
                .ToList();
            RenameListHint.Text = $"已列出 {_renameFilePaths.Count} 个文件（按路径排序）。";
            _renamePreviewRows.Clear();
            _lastPreview = Array.Empty<RenamePreviewRow>();
        }
        catch (Exception ex)
        {
            MessageBox.Show($"列出失败：{ex.Message}", "错误", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void RenamePreview_OnClick(object sender, RoutedEventArgs e)
    {
        if (_renameFilePaths.Count == 0)
        {
            MessageBox.Show("请先「列出文件」。", "提示", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }

        if (string.IsNullOrWhiteSpace(RenameFolderBox.Text))
            return;

        var prefix = RenamePrefixBox.Text ?? "";
        var suffix = RenameSuffixBox.Text ?? "";
        var find = RenameFindBox.Text ?? "";
        var replace = RenameReplaceBox.Text ?? "";
        var addIdx = RenameIndexCheck.IsChecked == true;
        if (!int.TryParse(RenameDigitsBox.Text.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var digits))
            digits = 3;
        if (!int.TryParse(RenameStartBox.Text.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var start))
            start = 1;

        var rows = BatchRenameService.Preview(
            _renameFilePaths,
            RenameFolderBox.Text.Trim(),
            prefix,
            suffix,
            find,
            replace,
            addIdx,
            digits,
            start);

        _renamePreviewRows.Clear();
        foreach (var r in rows)
            _renamePreviewRows.Add(r);
        _lastPreview = rows.ToList();
    }

    private void BtnRenameApply_OnClick(object sender, RoutedEventArgs e)
    {
        if (_lastPreview.Count == 0)
        {
            MessageBox.Show("请先生成预览。", "提示", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }

        if (MessageBox.Show("确定按预览结果重命名？此操作不易撤销。", "确认", MessageBoxButton.YesNo,
                MessageBoxImage.Warning) != MessageBoxResult.Yes)
            return;

        BtnRenameApply.IsEnabled = false;
        try
        {
            BatchRenameService.Apply(_lastPreview, out var errors);
            var msg = errors.Count == 0 ? "重命名完成。" : $"完成，但有 {errors.Count} 条提示：\n" + string.Join("\n", errors.Take(5));
            if (errors.Count > 5)
                msg += "\n…";
            MessageBox.Show(msg, errors.Count == 0 ? "成功" : "提示", MessageBoxButton.OK,
                errors.Count == 0 ? MessageBoxImage.Information : MessageBoxImage.Warning);
            RenameListFiles_OnClick(sender, e);
        }
        finally
        {
            BtnRenameApply.IsEnabled = true;
        }
    }
}
