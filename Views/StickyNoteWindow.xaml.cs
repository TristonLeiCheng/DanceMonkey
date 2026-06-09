using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Threading;
using DesktopAssistant.Models;
using DesktopAssistant.Services;

namespace DesktopAssistant.Views;

public partial class StickyNoteWindow : Window
{
    private readonly NoteService _notes;
    private readonly DispatcherTimer _debounce = new() { Interval = TimeSpan.FromMilliseconds(600) };
    private bool _suppressBgCombo;
    private string? _currentBgPreset;

    public string FilePath { get; }

    public StickyNoteWindow(string filePath, NoteService notes, StickyNoteWindowState? initial = null)
    {
        FilePath = filePath;
        _notes = notes;
        InitializeComponent();

        foreach (var p in StickyNoteThemes.Presets)
            BgPresetCombo.Items.Add(new ComboBoxItem { Content = p.DisplayName, Tag = p.Key });

        try
        {
            EditorBox.Text = File.Exists(filePath) ? _notes.Read(filePath) : "";
        }
        catch
        {
            EditorBox.Text = "";
        }

        SyncTitleFromContent();

        _currentBgPreset = initial?.BackgroundPreset;
        SelectBgComboByKey(_currentBgPreset);
        ApplyBackgroundPreset(_currentBgPreset);

        if (initial != null)
        {
            Left = initial.Left;
            Top = initial.Top;
            Width = Math.Max(MinWidth, initial.Width);
            Height = Math.Max(MinHeight, initial.Height);
            Topmost = initial.Topmost;
            TopmostCheck.IsChecked = initial.Topmost;
        }
        else
        {
            TopmostCheck.IsChecked = true;
        }

        _debounce.Tick += (_, _) =>
        {
            _debounce.Stop();
            SyncTitleFromContent();
            SaveQuiet();
        };

        Loaded += (_, _) => { StickyNoteManager.Register(this); };
        Closed += (_, _) =>
        {
            _debounce.Stop();
            StickyNoteManager.Unregister(this);
            SyncTitleFromContent();
            SaveQuiet();
            StickyNoteManager.SaveAllLayouts();
        };
    }

    private void SelectBgComboByKey(string? key)
    {
        _suppressBgCombo = true;
        try
        {
            var idx = 0;
            if (!string.IsNullOrWhiteSpace(key))
            {
                for (var i = 0; i < BgPresetCombo.Items.Count; i++)
                {
                    if (BgPresetCombo.Items[i] is ComboBoxItem c && c.Tag is string s &&
                        string.Equals(s, key, StringComparison.OrdinalIgnoreCase))
                    {
                        idx = i;
                        break;
                    }
                }
            }

            BgPresetCombo.SelectedIndex = idx;
        }
        finally
        {
            _suppressBgCombo = false;
        }
    }

    private void ApplyBackgroundPreset(string? key)
    {
        _currentBgPreset = string.IsNullOrWhiteSpace(key) ? StickyNoteThemes.DefaultKey : key;
        var (w, t) = StickyNoteThemes.GetColors(_currentBgPreset);
        Background = new SolidColorBrush(w);
        TitleBarBorder.Background = new SolidColorBrush(t);
    }

    private void SyncTitleFromContent()
    {
        var trimmed = EditorBox.Text.TrimStart();
        var nl = trimmed.IndexOfAny("\r\n".ToCharArray());
        var lineStr = (nl >= 0 ? trimmed[..nl] : trimmed).Trim();
        if (lineStr.StartsWith("# ", StringComparison.Ordinal))
        {
            var title = lineStr[2..].Trim();
            if (!string.IsNullOrEmpty(title))
            {
                TitleBlock.Text = title;
                Title = title;
                return;
            }
        }

        TitleBlock.Text = FallbackTitleFromPath(FilePath);
        Title = TitleBlock.Text;
    }

    private static string FallbackTitleFromPath(string filePath)
    {
        var name = Path.GetFileNameWithoutExtension(filePath);
        if (name.StartsWith("sticky-", StringComparison.OrdinalIgnoreCase))
        {
            var rest = name["sticky-".Length..];
            var dash = rest.IndexOf('-');
            if (dash == 8 && rest.Length >= 17)
            {
                var datePart = rest[..dash];
                if (datePart.Length == 8 &&
                    int.TryParse(datePart[..4], out var y) &&
                    int.TryParse(datePart.Substring(4, 2), out var m) &&
                    int.TryParse(datePart.Substring(6, 2), out var d))
                    return $"{y:D4}-{m:D2}-{d:D2}";
            }
        }

        return string.IsNullOrEmpty(name) ? DateTime.Now.ToString("yyyy-MM-dd") : name;
    }

    private void BgPresetCombo_OnSelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_suppressBgCombo || BgPresetCombo.SelectedItem is not ComboBoxItem c || c.Tag is not string key)
            return;
        ApplyBackgroundPreset(key);
        StickyNoteManager.SaveAllLayouts();
    }

    private void SaveDaily_OnClick(object sender, RoutedEventArgs e)
    {
        try
        {
            var path = _notes.SaveStickyToDailyNote(EditorBox.Text);
            MessageBox.Show($"已保存：\n{path}", "存笔记", MessageBoxButton.OK, MessageBoxImage.Information);
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, "保存失败", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void InsertTodo_OnClick(object sender, RoutedEventArgs e) => InsertAtCaret("- [ ] ");

    private void InsertBullet_OnClick(object sender, RoutedEventArgs e) => InsertAtCaret("- ");

    private void InsertOrdered_OnClick(object sender, RoutedEventArgs e) => InsertAtCaret("1. ");

    private void InsertAtCaret(string text)
    {
        var i = EditorBox.CaretIndex;
        EditorBox.Text = EditorBox.Text.Insert(i, text);
        EditorBox.CaretIndex = i + text.Length;
        EditorBox.Focus();
    }

    private void TopmostCheck_OnChanged(object sender, RoutedEventArgs e)
    {
        Topmost = TopmostCheck.IsChecked == true;
        StickyNoteManager.SaveAllLayouts();
    }

    private void Close_OnClick(object sender, RoutedEventArgs e) => Close();

    private void EditorBox_OnTextChanged(object sender, TextChangedEventArgs e)
    {
        _debounce.Stop();
        _debounce.Start();
    }

    private void SaveQuiet()
    {
        try
        {
            _notes.Save(FilePath, EditorBox.Text);
        }
        catch
        {
            // ignore autosave errors
        }
    }

    public StickyNoteWindowState BuildState() => new()
    {
        FilePath = FilePath,
        Left = Left,
        Top = Top,
        Width = Width,
        Height = Height,
        Topmost = Topmost,
        BackgroundPreset = _currentBgPreset
    };
}
