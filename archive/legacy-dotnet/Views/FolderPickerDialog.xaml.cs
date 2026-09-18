using System.Windows;
using System.Windows.Controls;
using DesktopAssistant.Models;

namespace DesktopAssistant.Views;

public partial class FolderPickerDialog : Window
{
    /// <summary>用户选中的目标文件夹完整路径。</summary>
    public string? SelectedFolderPath { get; private set; }

    public FolderPickerDialog(NoteTreeNode folderTree, string hint)
    {
        InitializeComponent();
        HintText.Text = hint;
        FolderTree.Items.Add(BuildItem(folderTree));
    }

    private static TreeViewItem BuildItem(NoteTreeNode node)
    {
        var item = new TreeViewItem
        {
            Header = $"📁 {node.Name}",
            Tag = node.FullPath,
            IsExpanded = true
        };
        foreach (var child in node.Children)
        {
            if (child.IsFolder)
                item.Items.Add(BuildItem(child));
        }
        return item;
    }

    private void FolderTree_OnSelectedItemChanged(object sender, RoutedPropertyChangedEventArgs<object> e)
    {
        if (FolderTree.SelectedItem is TreeViewItem tvi && tvi.Tag is string path)
        {
            SelectedFolderPath = path;
            OkBtn.IsEnabled = true;
        }
        else
        {
            SelectedFolderPath = null;
            OkBtn.IsEnabled = false;
        }
    }

    private void Ok_OnClick(object sender, RoutedEventArgs e)
    {
        DialogResult = true;
    }

    private void Cancel_OnClick(object sender, RoutedEventArgs e)
    {
        DialogResult = false;
    }
}
