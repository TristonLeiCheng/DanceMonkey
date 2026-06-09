using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using DesktopAssistant.Services;

namespace DesktopAssistant.Views;

/// <summary>
/// 双链笔记选择器对话框。
/// 列出全库所有笔记（带相对路径），支持搜索过滤，
/// 并根据同名笔记数量智能生成最短唯一链接文本。
/// </summary>
public partial class WikiLinkPickerDialog : Window
{
    private readonly IReadOnlyList<NotePickerItem> _allItems;

    /// <summary>用户确认后推荐的双链文本（不含 [[ ]] 括号）。</summary>
    public string? SelectedLinkText { get; private set; }

    /// <summary>用户确认后选中的笔记完整路径。</summary>
    public string? SelectedFullPath { get; private set; }

    public WikiLinkPickerDialog(IReadOnlyList<NotePickerItem> allNotes, string prefilter = "")
    {
        InitializeComponent();
        _allItems = allNotes;
        if (!string.IsNullOrEmpty(prefilter))
        {
            SearchBox.Text = prefilter;
            SearchPlaceholder.Visibility = System.Windows.Visibility.Collapsed;
            SearchBox.SelectAll();
        }
        ApplyFilter(prefilter);
        SearchBox.Focus();
    }

    private void ApplyFilter(string keyword)
    {
        var kw = keyword.Trim();
        var filtered = string.IsNullOrEmpty(kw)
            ? _allItems
            : (IEnumerable<NotePickerItem>)_allItems.Where(x =>
                x.Stem.Contains(kw, StringComparison.OrdinalIgnoreCase) ||
                x.RelativePath.Contains(kw, StringComparison.OrdinalIgnoreCase));

        NoteList.ItemsSource = filtered.ToList();

        // 如果只剩一条，自动选中
        if (NoteList.Items.Count == 1)
            NoteList.SelectedIndex = 0;
        else
            UpdatePreview();
    }

    private void SearchBox_TextChanged(object sender, TextChangedEventArgs e)
    {
        SearchPlaceholder.Visibility = string.IsNullOrEmpty(SearchBox.Text)
            ? System.Windows.Visibility.Visible
            : System.Windows.Visibility.Collapsed;
        ApplyFilter(SearchBox.Text);
    }

    private void NoteList_SelectionChanged(object sender, SelectionChangedEventArgs e)
        => UpdatePreview();

    private void NoteList_MouseDoubleClick(object sender, MouseButtonEventArgs e)
    {
        if (NoteList.SelectedItem is NotePickerItem)
            ConfirmAndClose();
    }

    private void UpdatePreview()
    {
        if (NoteList.SelectedItem is NotePickerItem item)
        {
            PreviewText.Text = $"[[{item.SuggestedLinkText}]]";
            OkBtn.IsEnabled = true;
        }
        else
        {
            PreviewText.Text = "（请选择笔记）";
            OkBtn.IsEnabled = false;
        }
    }

    private void Ok_OnClick(object sender, RoutedEventArgs e) => ConfirmAndClose();

    private void Cancel_OnClick(object sender, RoutedEventArgs e) => DialogResult = false;

    private void ConfirmAndClose()
    {
        if (NoteList.SelectedItem is not NotePickerItem item) return;
        SelectedLinkText = item.SuggestedLinkText;
        SelectedFullPath = item.FullPath;
        DialogResult = true;
    }
}
