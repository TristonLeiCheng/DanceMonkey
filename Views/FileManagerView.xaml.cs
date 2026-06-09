using System.Collections.ObjectModel;
using System.Diagnostics;
using System.Text;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using DesktopAssistant.Services;

namespace DesktopAssistant.Views;

public partial class FileManagerView : UserControl
{
    private SandboxFileService? _sandbox;
    private AiFileManagerService? _aiManager;
    private readonly ObservableCollection<SandboxEntry> _entries = new();
    private string _currentRelativePath = "";
    private bool _isBusy;

    public FileManagerView()
    {
        InitializeComponent();
        FileListBox.ItemsSource = _entries;

        Loaded += (_, _) =>
        {
            EnsureServices();
            ResultBox.Text = L("FM.Welcome");
            RefreshFileList();
        };
    }

    private void EnsureServices()
    {
        var cfg = App.Config.Load();
        _sandbox = new SandboxFileService(cfg.SandboxPath);
        _aiManager = new AiFileManagerService(cfg, _sandbox);
    }

    // ═══════════════ File Browser ═══════════════

    private void RefreshFileList()
    {
        if (_sandbox == null) return;

        _entries.Clear();
        try
        {
            var path = string.IsNullOrEmpty(_currentRelativePath) ? null : _currentRelativePath;
            var items = _sandbox.ListDirectory(path);
            foreach (var item in items)
                _entries.Add(item);
        }
        catch (Exception ex)
        {
            AppendResult($"❌ 无法列出目录：{ex.Message}");
        }

        CurrentPathText.Text = string.IsNullOrEmpty(_currentRelativePath) ? "/" : $"/{_currentRelativePath}";
        UpdateStats();
    }

    private void UpdateStats()
    {
        if (_sandbox == null) return;
        var (files, dirs, bytes) = _sandbox.GetStats();
        StatsText.Text = L("FM.StatsFormat", files, dirs, FormatSize(bytes));
    }

    private void BtnRefreshTree_OnClick(object sender, RoutedEventArgs e)
    {
        EnsureServices();
        RefreshFileList();
    }

    private void BtnNavUp_OnClick(object sender, RoutedEventArgs e)
    {
        if (string.IsNullOrEmpty(_currentRelativePath)) return;

        var parent = Path.GetDirectoryName(_currentRelativePath);
        _currentRelativePath = parent ?? "";
        RefreshFileList();
    }

    private void FileListBox_OnDoubleClick(object sender, MouseButtonEventArgs e)
    {
        if (FileListBox.SelectedItem is not SandboxEntry entry) return;

        if (entry.IsDirectory)
        {
            _currentRelativePath = entry.RelativePath;
            RefreshFileList();
        }
        else
        {
            ViewFileContent(entry);
        }
    }

    private void FileListBox_OnSelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        // 可扩展：选中时显示文件信息
    }

    private void BtnViewFile_OnClick(object sender, RoutedEventArgs e)
    {
        if (FileListBox.SelectedItem is SandboxEntry entry && !entry.IsDirectory)
            ViewFileContent(entry);
    }

    private void ViewFileContent(SandboxEntry entry)
    {
        if (_sandbox == null) return;
        try
        {
            var content = _sandbox.ReadFile(entry.RelativePath);
            var preview = content.Length > 5000 ? content[..5000] + "\n\n…（内容过长，已截断）" : content;
            AppendResult($"📄 {entry.Name}（{entry.SizeDisplay}）：\n─────────────────────\n{preview}\n─────────────────────");
        }
        catch (Exception ex)
        {
            AppendResult($"❌ 读取失败：{ex.Message}");
        }
    }

    private void BtnDeleteSelected_OnClick(object sender, RoutedEventArgs e)
    {
        if (_sandbox == null || FileListBox.SelectedItem is not SandboxEntry entry) return;

        var what = entry.IsDirectory ? L("FM.ConfirmDeleteFolder", entry.Name) : L("FM.ConfirmDeleteFile", entry.Name);
        if (MessageBox.Show(what, L("FM.ConfirmDelete"),
                MessageBoxButton.YesNo, MessageBoxImage.Question) != MessageBoxResult.Yes)
            return;

        try
        {
            if (entry.IsDirectory)
                _sandbox.DeleteDirectory(entry.RelativePath, recursive: true);
            else
                _sandbox.DeleteFile(entry.RelativePath);

            AppendResult($"✅ 已删除：{entry.Name}");
            RefreshFileList();
        }
        catch (Exception ex)
        {
            AppendResult($"❌ 删除失败：{ex.Message}");
        }
    }

    private void BtnOpenSandbox_OnClick(object sender, RoutedEventArgs e)
    {
        if (_sandbox == null) return;
        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = _sandbox.SandboxRoot,
                UseShellExecute = true
            });
        }
        catch { }
    }

    // ═══════════════ AI Command Panel ═══════════════

    private async void BtnSend_OnClick(object sender, RoutedEventArgs e)
    {
        await ExecuteAiCommandAsync();
    }

    private async void InputBox_OnKeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter && Keyboard.Modifiers == ModifierKeys.None)
        {
            e.Handled = true;
            await ExecuteAiCommandAsync();
        }
    }

    private async Task ExecuteAiCommandAsync()
    {
        if (_isBusy || _aiManager == null) return;

        var input = InputBox.Text.Trim();
        if (string.IsNullOrEmpty(input)) return;

        _isBusy = true;
        BtnSend.IsEnabled = false;
        StatusText.Text = L("FM.Processing");
        InputBox.Text = "";

        AppendResult($"\n👤 {input}");

        try
        {
            var result = await _aiManager.ProcessCommandAsync(input);

            if (result.Operations.Count > 0)
            {
                var sb = new StringBuilder();
                sb.AppendLine($"\n🤖 {result.Message}");
                foreach (var op in result.Operations)
                {
                    var icon = op.Success ? "✅" : "❌";
                    sb.AppendLine($"  {icon} [{op.Operation}] {op.Message}");
                }
                AppendResult(sb.ToString().TrimEnd());
            }
            else
            {
                AppendResult($"\n🤖 {result.Message}");
            }

            RefreshFileList();
        }
        catch (Exception ex)
        {
            AppendResult($"\n❌ 执行失败：{ex.Message}");
        }
        finally
        {
            _isBusy = false;
            BtnSend.IsEnabled = true;
            StatusText.Text = "";
        }
    }

    private void BtnQuickList_OnClick(object sender, RoutedEventArgs e)
    {
        if (_sandbox == null) return;
        var tree = _sandbox.GetDirectoryTree(maxDepth: 4);
        AppendResult($"\n{L("FM.SandboxTree")}\n{tree}");
    }

    private void BtnClearResult_OnClick(object sender, RoutedEventArgs e)
    {
        ResultBox.Text = L("FM.ChatCleared") + "\n";
    }

    // ═══════════════ Helpers ═══════════════

    private void AppendResult(string text)
    {
        ResultBox.Text += text + "\n";
        ResultBox.ScrollToEnd();
    }

    private static string FormatSize(long bytes) => bytes switch
    {
        < 1024 => $"{bytes} B",
        < 1024 * 1024 => $"{bytes / 1024.0:F1} KB",
        _ => $"{bytes / (1024.0 * 1024.0):F1} MB"
    };

    private static string L(string key) => LocalizationManager.Get(key);
    private static string L(string key, params object[] args) => LocalizationManager.Get(key, args);
}
