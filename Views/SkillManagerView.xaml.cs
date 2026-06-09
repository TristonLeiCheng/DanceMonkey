using System.Collections.ObjectModel;
using System.Diagnostics;
using System.Text;
using System.Windows;
using System.Windows.Controls;
using DanceMonkey.Agent.Core.Runtime;
using DesktopAssistant.Services;
using Forms = System.Windows.Forms;
using OpenFileDialog = Microsoft.Win32.OpenFileDialog;

namespace DesktopAssistant.Views;

public partial class SkillManagerView : UserControl
{
    private readonly ObservableCollection<LocalSkillFileService.SkillItem> _items = new();
    private LocalSkillFileService.SkillItem? _selected;
    private string? _editingFilePath;
    private bool _suppressSelection;

    public SkillManagerView()
    {
        InitializeComponent();
        SkillList.ItemsSource = _items;
        Loaded += (_, _) => Refresh();
    }

    /// <summary>沙箱路径变更后由主窗口调用。</summary>
    public void ReloadForSandboxChange() => Refresh();

    public void Refresh()
    {
        try
        {
            var path = LocalSkillFileService.GetManagedSkillsRoot(App.Config.Load().SandboxPath);
            PathText.Text = path;
            _items.Clear();
            foreach (var s in LocalSkillFileService.ListSkills(App.Config.Load().SandboxPath))
                _items.Add(s);
            SkillCountText.Text = string.Format(LocalizationManager.Get("SkillManager.Count"), _items.Count);
            SetStatus(string.Format(LocalizationManager.Get("SkillManager.Loaded"), _items.Count));
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, "Skill", MessageBoxButton.OK, MessageBoxImage.Warning);
            SetStatus(ex.Message);
        }

        _selected = null;
        _editingFilePath = null;
        ClearEditor();
        UpdateEditorEnabled();
    }

    private void BtnRefresh_OnClick(object sender, RoutedEventArgs e) => Refresh();

    private void BtnOpenFolder_OnClick(object sender, RoutedEventArgs e)
    {
        try
        {
            var path = LocalSkillFileService.GetManagedSkillsRoot(App.Config.Load().SandboxPath);
            Process.Start(new ProcessStartInfo
            {
                FileName = "explorer.exe",
                Arguments = path,
                UseShellExecute = true,
            });
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, "Skill", MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }

    private void SkillList_OnSelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_suppressSelection) return;
        if (SkillList.SelectedItem is not LocalSkillFileService.SkillItem item)
        {
            _selected = null;
            _editingFilePath = null;
            ClearEditor();
            UpdateEditorEnabled();
            return;
        }

        _selected = item;
        _editingFilePath = item.SkillFilePath;
        UpdateSelectedMetadata(item);
        try
        {
            ContentBox.Text = File.ReadAllText(item.SkillFilePath, Encoding.UTF8);
        }
        catch
        {
            ContentBox.Text = "";
        }
        UpdateEditorEnabled();
    }

    private void UpdateEditorEnabled()
    {
        var has = _selected != null && !string.IsNullOrWhiteSpace(_editingFilePath);
        BtnSave.IsEnabled = has;
        BtnDelete.IsEnabled = has;
        if (!has)
        {
            SelectedNameText.Text = LocalizationManager.Get("SkillManager.NoSelection");
            SelectedDescriptionText.Text = "";
            SelectedMetaText.Text = "";
        }
    }

    private void BtnSave_OnClick(object sender, RoutedEventArgs e)
    {
        if (string.IsNullOrWhiteSpace(_editingFilePath) || _selected == null) return;
        try
        {
            LocalSkillFileService.OverwriteSkillFile(_editingFilePath, ContentBox.Text);
            var selectedName = _selected.Name;
            Refresh();
            ReselectByName(selectedName);
            SetStatus(LocalizationManager.Get("SkillManager.Saved"));
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, "Skill", MessageBoxButton.OK, MessageBoxImage.Warning);
            SetStatus(ex.Message);
        }
    }

    private void BtnDelete_OnClick(object sender, RoutedEventArgs e)
    {
        if (_selected == null) return;
        if (MessageBox.Show(
                string.Format(LocalizationManager.Get("SkillManager.ConfirmDelete"), _selected.Name),
                LocalizationManager.Get("SkillManager.DeleteTitle"),
                MessageBoxButton.YesNo,
                MessageBoxImage.Question) != MessageBoxResult.Yes)
            return;
        try
        {
            LocalSkillFileService.DeleteSkill(_selected.DirectoryPath);
            _selected = null;
            _editingFilePath = null;
            ClearEditor();
            UpdateEditorEnabled();
            Refresh();
            SetStatus(LocalizationManager.Get("SkillManager.Deleted"));
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, "Skill", MessageBoxButton.OK, MessageBoxImage.Warning);
            SetStatus(ex.Message);
        }
    }

    private void BtnAdd_OnClick(object sender, RoutedEventArgs e)
    {
        var name = NewNameBox.Text?.Trim() ?? "";
        var description = NewDescriptionBox.Text?.Trim() ?? "";
        var body = NewBodyBox.Text?.Trim() ?? "";
        if (string.IsNullOrWhiteSpace(name))
        {
            MessageBox.Show(LocalizationManager.Get("SkillManager.NameRequired"), "Skill", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }
        try
        {
            LocalSkillFileService.SaveNewSkill(App.Config.Load().SandboxPath, name, body, description);
            NewNameBox.Clear();
            NewDescriptionBox.Clear();
            NewBodyBox.Clear();
            Refresh();
            ReselectByName(SkillCatalog.SanitizeSkillName(name));
            SetStatus(LocalizationManager.Get("SkillManager.Created"));
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, "Skill", MessageBoxButton.OK, MessageBoxImage.Warning);
            SetStatus(ex.Message);
        }
    }

    private void BtnTemplate_OnClick(object sender, RoutedEventArgs e)
    {
        var name = NewNameBox.Text?.Trim();
        if (string.IsNullOrWhiteSpace(name))
            name = "new-skill";
        NewBodyBox.Text = LocalSkillFileService.BuildSkillTemplate(name, NewDescriptionBox.Text);
        SetStatus(LocalizationManager.Get("SkillManager.TemplateInserted"));
    }

    private void BtnImport_OnClick(object sender, RoutedEventArgs e)
    {
        var source = ImportSourceBox.Text?.Trim() ?? "";
        if (string.IsNullOrWhiteSpace(source))
        {
            MessageBox.Show(LocalizationManager.Get("SkillManager.ImportRequired"), "Skill", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }

        try
        {
            var imported = LocalSkillFileService.ImportSkill(App.Config.Load().SandboxPath, source);
            ImportSourceBox.Clear();
            Refresh();
            ReselectByName(imported.Name);
            SetStatus(string.Format(LocalizationManager.Get("SkillManager.Imported"), imported.Name));
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, "Skill", MessageBoxButton.OK, MessageBoxImage.Warning);
            SetStatus(ex.Message);
        }
    }

    private void BtnBrowseImportFile_OnClick(object sender, RoutedEventArgs e)
    {
        var dlg = new OpenFileDialog
        {
            Title = LocalizationManager.Get("SkillManager.SelectSkillFile"),
            Filter = "Skill Markdown|SKILL.md;*.md|All files|*.*",
            CheckFileExists = true
        };
        if (dlg.ShowDialog() == true)
            ImportSourceBox.Text = dlg.FileName;
    }

    private void BtnBrowseImportFolder_OnClick(object sender, RoutedEventArgs e)
    {
        using var dlg = new Forms.FolderBrowserDialog
        {
            Description = LocalizationManager.Get("SkillManager.SelectSkillFolder"),
            UseDescriptionForTitle = true
        };
        if (dlg.ShowDialog() == Forms.DialogResult.OK)
            ImportSourceBox.Text = dlg.SelectedPath;
    }

    private void ReselectByName(string name)
    {
        _suppressSelection = true;
        try
        {
            var item = _items.FirstOrDefault(x => string.Equals(x.Name, name, StringComparison.OrdinalIgnoreCase));
            if (item == null) return;
            SkillList.SelectedItem = item;
            SkillList.ScrollIntoView(item);
            _selected = item;
            _editingFilePath = item.SkillFilePath;
            UpdateSelectedMetadata(item);
            try { ContentBox.Text = File.ReadAllText(item.SkillFilePath, Encoding.UTF8); }
            catch { }
            UpdateEditorEnabled();
        }
        finally
        {
            _suppressSelection = false;
        }
    }

    private void ClearEditor()
    {
        ContentBox.Text = "";
        SelectedNameText.Text = LocalizationManager.Get("SkillManager.NoSelection");
        SelectedDescriptionText.Text = "";
        SelectedMetaText.Text = "";
    }

    private void UpdateSelectedMetadata(LocalSkillFileService.SkillItem item)
    {
        SelectedNameText.Text = item.Name;
        SelectedDescriptionText.Text = item.DisplaySummary;

        var lines = new List<string>
        {
            item.MetadataLine,
            item.SkillFilePath
        };
        SelectedMetaText.Text = string.Join(Environment.NewLine, lines.Where(x => !string.IsNullOrWhiteSpace(x)));
    }

    private void SetStatus(string? text)
    {
        if (StatusText != null)
            StatusText.Text = text ?? "";
    }
}
