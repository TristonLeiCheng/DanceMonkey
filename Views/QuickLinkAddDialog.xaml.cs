using System.Windows;
using System.Windows.Controls;
using DesktopAssistant.Models;
using DesktopAssistant.Services;

namespace DesktopAssistant.Views;

public partial class QuickLinkAddDialog : Window
{
    public QuickLinkItem? Result { get; private set; }

    // ── Constructor (add mode) ──
    public QuickLinkAddDialog() : this(null) { }

    // ── Constructor (edit mode) ──
    public QuickLinkAddDialog(QuickLinkItem? editItem)
    {
        InitializeComponent();

        if (editItem != null)
        {
            Title = L("QuickAccess.EditLinkTitle");
            DialogTitleBlock.Text = L("QuickAccess.EditLinkTitle");

            NameBox.Text  = editItem.Name;
            PathBox.Text  = editItem.Path;
            DescBox.Text  = editItem.Description;
            GroupBox.Text = editItem.Group;

            foreach (ComboBoxItem item in CategoryCombo.Items)
            {
                if (item.Tag as string == editItem.Category)
                {
                    item.IsSelected = true;
                    break;
                }
            }
        }
    }

    private string SelectedCategory =>
        (CategoryCombo.SelectedItem as ComboBoxItem)?.Tag as string ?? "local";

    private void Category_OnChanged(object sender, SelectionChangedEventArgs e)
    {
        if (PathHint == null || BrowseBtn == null) return;

        var cat = SelectedCategory;
        BrowseBtn.Visibility = cat == "local" ? Visibility.Visible : Visibility.Collapsed;

        PathHint.Text = cat switch
        {
            "network"    => L("QuickAccess.PathHintNetwork"),
            "sharepoint" => L("QuickAccess.PathHintSharePoint"),
            "onedrive"   => L("QuickAccess.PathHintOneDrive"),
            "web"        => L("QuickAccess.PathHintWeb"),
            _            => L("QuickAccess.PathHintLocal")
        };
    }

    private void Browse_OnClick(object sender, RoutedEventArgs e)
    {
        var dlg = new System.Windows.Forms.FolderBrowserDialog();
        if (dlg.ShowDialog() == System.Windows.Forms.DialogResult.OK)
        {
            PathBox.Text = dlg.SelectedPath;
            if (string.IsNullOrWhiteSpace(NameBox.Text))
                NameBox.Text = System.IO.Path.GetFileName(dlg.SelectedPath);
        }
    }

    private void Confirm_OnClick(object sender, RoutedEventArgs e)
    {
        var name = NameBox.Text.Trim();
        var path = PathBox.Text.Trim();

        if (string.IsNullOrWhiteSpace(name) || string.IsNullOrWhiteSpace(path))
        {
            MessageBox.Show(L("QuickAccess.ValidationError"), AppBranding.DisplayName,
                MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        Result = new QuickLinkItem
        {
            Name        = name,
            Path        = path,
            Category    = SelectedCategory,
            Description = DescBox.Text.Trim(),
            Group       = GroupBox.Text.Trim()
        };
        DialogResult = true;
    }

    private static string L(string key) => LocalizationManager.Get(key);
}
