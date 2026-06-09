using System.Collections.ObjectModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Threading;
using DesktopAssistant.Models;
using DanceMonkey.Ppt.Models;
using DanceMonkey.Ppt.Services;
using DesktopAssistant.Services;
using Markdig;
using Microsoft.Web.WebView2.Core;
using Microsoft.Win32;

namespace DesktopAssistant.Views;

internal enum NotesEditorPaneMode
{
    /// <summary>Obsidian 风：CodeMirror 单栏，标题行语法高亮。</summary>
    Live,
    Split,
    Read
}

public partial class NotesView : UserControl
{
    private NoteService? _notes;
    private string? _currentPath;
    private bool _dirty;
    private bool _previewInited;

    // ── Inspector（右侧检视器）状态 ──
    private bool _inspectorVisible;
    private double _inspectorSavedWidth = 280;
    private bool _loadingInspector;
    private readonly DispatcherTimer _inspectorDebounce = new() { Interval = TimeSpan.FromMilliseconds(700) };

    private bool _previewWebMessageHooked;
    /// <summary>Live 编辑器右键时从 contextMenuRequest 消息保存的选中文字，供后续「创建双链」使用。</summary>
    private string _liveEditorContextMenuSelectedText = "";

    /// <summary>笔记编辑区视图：<see cref="NotesEditorPaneMode.Live"/> 单栏实时 Markdown（默认）、Split 分栏、Read 仅预览。</summary>
    private NotesEditorPaneMode _paneMode = NotesEditorPaneMode.Live;

    private bool _liveEditorEventsHooked;
    private bool _syncingFromLiveEditor;
    private bool _loadingEditor;
    /// <summary>RefreshTree 清空/重建树时会同步触发 SelectedItemChanged；抑制期间避免把编辑器清空或覆盖 BindCurrentNote。</summary>
    private int _treeRefreshSuppressDepth;
    /// <summary>右键按下（隧道阶段）为 true，用于区分右键改选与左键改选，避免「未保存」MessageBox 与 ContextMenu 抢焦点导致假死/崩溃。</summary>
    private bool _treeRightButtonDown;
    /// <summary>树节点右键菜单处于打开态；用于阻止菜单生命周期内触发预览刷新。</summary>
    private bool _treeContextMenuOpen;
    /// <summary>右键在有未保存内容时改选：菜单关闭后把树选中项恢复为当前笔记路径。</summary>
    private string? _restoreTreeSelectionAfterContextMenu;
    /// <summary>右键改选时推迟 WebView2 预览刷新，避免 NavigateToString 与原生 ContextMenu 并发导致 WebView2 进程崩溃。</summary>
    private bool _deferNotePreviewUntilTreeMenuClosed;
    private readonly DispatcherTimer _previewDebounce = new() { Interval = TimeSpan.FromMilliseconds(320) };
    /// <summary>首行一级标题 → 磁盘文件名：停顿后重命名，避免每个字符都碰文件系统。</summary>
    private readonly DispatcherTimer _firstHeadingRenameDebounce = new() { Interval = TimeSpan.FromMilliseconds(500) };
    private readonly ObservableCollection<NoteTreeNode> _treeRoots = new();

    // ── 异步搜索 ──
    private readonly DispatcherTimer _searchDebounce = new() { Interval = TimeSpan.FromMilliseconds(320) };
    private CancellationTokenSource? _searchCts;
    private List<NoteSearchMatch> _currentSnippets = new();

    // ── 左侧面板折叠状态 ──
    private bool _leftPanelCollapsed;
    private double _leftPanelSavedWidth = 268;
    private static readonly MarkdownPipeline MdPipeline = new MarkdownPipelineBuilder()
        .UseAdvancedExtensions()
        .Build();

    // ── Auto-save timer (5 秒空闲后自动保存) ──
    private readonly DispatcherTimer _autoSaveTimer = new() { Interval = TimeSpan.FromSeconds(5) };
    // ── 周期自动保存兜底（持续输入时也会定时落盘） ──
    private readonly DispatcherTimer _periodicAutoSaveTimer = new() { Interval = TimeSpan.FromMinutes(1) };

    // ── Undo / Redo 文本快照栈 ──
    private const int MaxUndoSnapshots = 50;
    private readonly List<string> _undoStack = new();
    private int _undoIndex = -1;
    private bool _undoRedoInProgress;
    private AudioCaptureService? _noteDictationCapture;
    private CancellationTokenSource? _noteDictationCts;
    private bool _noteDictating;
    private int _noteDictationSegments;
    private readonly SemaphoreSlim _noteDictationSemaphore = new(1, 1);
    private bool _renameFromHeadingInProgress;

    public NotesView()
    {
        InitializeComponent();
        NotesTree.ItemsSource = _treeRoots;

        // ── Command bindings for Ctrl+S / Ctrl+Z / Ctrl+Y ──
        CommandBindings.Add(new CommandBinding(ApplicationCommands.Save, (_, _) => PerformSave()));
        CommandBindings.Add(new CommandBinding(ApplicationCommands.Undo, (_, _) => PerformUndo(), (_, ea) => ea.CanExecute = CanUndo));
        CommandBindings.Add(new CommandBinding(ApplicationCommands.Redo, (_, _) => PerformRedo(), (_, ea) => ea.CanExecute = CanRedo));

        // ── Auto-save: 5 秒空闲后静默保存 ──
        _autoSaveTimer.Tick += (_, _) =>
        {
            _autoSaveTimer.Stop();
            PerformAutoSave();
        };
        _periodicAutoSaveTimer.Tick += (_, _) => PerformAutoSave();

        Loaded += (_, _) =>
        {
            ReloadServiceAndList();
            InitNoteAiCombo();
            LoadNotesPaneModeFromConfig();
            ApplyNotesEditorPaneLayout();
            _periodicAutoSaveTimer.Start();
            if (_paneMode == NotesEditorPaneMode.Live)
                _ = EnsureLiveEditorThenPushAsync();
        };
        Unloaded += (_, _) =>
        {
            _autoSaveTimer.Stop();
            _periodicAutoSaveTimer.Stop();
            _firstHeadingRenameDebounce.Stop();
            PerformAutoSave();
            StopRealtimeDictation();
        };
        _previewDebounce.Tick += async (_, _) =>
        {
            _previewDebounce.Stop();
            await RefreshPreviewAsync();
        };

        // 搜索防抖：输入停顿 320ms 后触发异步搜索
        _searchDebounce.Tick += async (_, _) =>
        {
            _searchDebounce.Stop();
            await PerformSearchAsync();
        };

        // Inspector 防抖：编辑 700ms 后写回 frontmatter
        _inspectorDebounce.Tick += (_, _) =>
        {
            _inspectorDebounce.Stop();
            ApplyInspectorChangesToEditor();
        };

        _firstHeadingRenameDebounce.Tick += (_, _) =>
        {
            _firstHeadingRenameDebounce.Stop();
            TryApplyRenameFromFirstHeading();
        };
    }

    public void ReloadServiceAndList()
    {
        var cfg = App.Config.Load();
        _notes = new NoteService(cfg.NotesRootPath);
        RefreshTree(selectPath: _currentPath);
    }

    /// <summary>重新加载笔记树并选中指定 .md（用于截图保存等到笔记后跳转）。</summary>
    public void ReloadAndSelectNote(string fullPath)
    {
        var cfg = App.Config.Load();
        _notes = new NoteService(cfg.NotesRootPath);
        if (string.IsNullOrWhiteSpace(fullPath)) return;
        var normalized = Path.GetFullPath(fullPath);
        // 有搜索词时 BuildFilteredTree 可能不含刚写入的文件，选不中；跳转时临时用全量树
        RefreshTree(selectPath: normalized, useFullTree: true);
        // 树在父级未展开时子节点尚无 TreeViewItem，无法仅靠选中来加载；必须直接读盘打开，再展开高亮树。
        var pathCopy = normalized;
        Dispatcher.BeginInvoke(() =>
        {
            if (_notes == null) return;
            if (!File.Exists(pathCopy) || !_notes.IsUnderRoot(pathCopy)) return;
            if (!RequestLoadNoteInEditorByPath(pathCopy))
                return;
            if (!TrySelectPathByExpanding(pathCopy))
                TrySelectPath(pathCopy);
        }, DispatcherPriority.ApplicationIdle);
    }

    /// <summary>供主窗口工具栏调用。</summary>
    public void ToolbarTodayNote() => ExecuteTodayNote();

    public void ToolbarNewNote() => ExecuteNewNote();

    public void ToolbarNewFolder() => ExecuteNewFolder();

    public void ToolbarQuickCapture() => ExecuteQuickCapture();

    public void ToolbarNewSticky() => ExecuteNewSticky();

    public void ToolbarRefresh() => ReloadServiceAndList();

    public void ToolbarExportZip() => ExecuteExportZip();

    public void ToolbarImportZip() => ExecuteImportZip();

    public void ToolbarOpenFolder() => ExecuteOpenRootFolder();

    private void InitNoteAiCombo()
    {
        NoteAiActionCombo.Items.Clear();
        foreach (NoteAiAction a in Enum.GetValues<NoteAiAction>())
            NoteAiActionCombo.Items.Add(new ComboBoxItem
            {
                Content = NoteAiService.GetDisplayName(a),
                Tag = a
            });
        if (NoteAiActionCombo.Items.Count > 0)
            NoteAiActionCombo.SelectedIndex = 0;
        SetNoteAiControlsEnabled(false);
    }

    private void SetNoteAiControlsEnabled(bool enabled)
    {
        if (!enabled && _noteDictating)
            StopRealtimeDictation();
        NoteAiActionCombo.IsEnabled = enabled;
        NoteAiRunBtn.IsEnabled = enabled;
        NoteSttBtn.IsEnabled = enabled;
        GeneratePptBtn.IsEnabled = enabled;
        SendToPptWorkspaceBtn.IsEnabled = enabled;
        ExportHtmlBtn.IsEnabled = enabled;
        VersionHistoryBtn.IsEnabled = enabled;
    }

    private void RefreshTree(string? selectPath = null, bool useFullTree = false)
    {
        if (_notes == null) return;

        var expandedFolders = CollectExpandedFolderPaths();

        _treeRefreshSuppressDepth++;
        try
        {
            _treeRoots.Clear();
            var searchText = SearchBox.Text?.Trim();
            var searchContent = SearchContentToggle.IsChecked == true;
            var root = useFullTree || string.IsNullOrWhiteSpace(searchText)
                ? _notes.BuildTree()
                : _notes.BuildFilteredTree(searchText, searchContent);
            _treeRoots.Add(root);

            // 树未展开时子级 TreeViewItem 尚不存在，TrySelectPath 会失败；用 ApplicationIdle + 逐级展开。
            // 必须在 TrySelectPath* 之前解除抑制，否则 SelectedItemChanged 会跳过、编辑器不加载。
            Dispatcher.BeginInvoke(() =>
            {
                try
                {
                    RestoreExpandedFolderPaths(expandedFolders);
                }
                finally
                {
                    _treeRefreshSuppressDepth--;
                }
                if (!string.IsNullOrEmpty(selectPath))
                {
                    if (!TrySelectPathByExpanding(selectPath))
                        TrySelectPath(selectPath);
                }
            }, DispatcherPriority.ApplicationIdle);
        }
        catch
        {
            _treeRefreshSuppressDepth--;
            throw;
        }
    }

    private HashSet<string> CollectExpandedFolderPaths()
    {
        var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        void Walk(TreeViewItem? item)
        {
            if (item == null) return;
            if (item.DataContext is NoteTreeNode n && n.Children.Count > 0 && item.IsExpanded)
                set.Add(n.FullPath);
            foreach (var o in item.Items)
            {
                var child = item.ItemContainerGenerator.ContainerFromItem(o) as TreeViewItem;
                Walk(child);
            }
        }

        foreach (var o in NotesTree.Items)
        {
            var tvi = NotesTree.ItemContainerGenerator.ContainerFromItem(o) as TreeViewItem;
            Walk(tvi);
        }

        return set;
    }

    private void RestoreExpandedFolderPaths(HashSet<string> paths)
    {
        if (_treeRoots.Count == 0 || paths.Count == 0)
            return;
        var dataRoot = _treeRoots[0];
        NotesTree.UpdateLayout();

        foreach (var path in paths.OrderBy(p => p.Length))
        {
            var chain = FindPathChain(dataRoot, path);
            if (chain == null) continue;
            ItemsControl parent = NotesTree;
            foreach (var node in chain)
            {
                parent.UpdateLayout();
                var tvi = parent.ItemContainerGenerator.ContainerFromItem(node) as TreeViewItem;
                if (tvi == null)
                    break;
                tvi.IsExpanded = true;
                parent = tvi;
            }
        }
    }

    private static List<NoteTreeNode>? FindPathChain(NoteTreeNode n, string targetFullPath)
    {
        if (n.FullPath.Equals(targetFullPath, StringComparison.OrdinalIgnoreCase))
            return new List<NoteTreeNode> { n };
        foreach (var c in n.Children)
        {
            var sub = FindPathChain(c, targetFullPath);
            if (sub != null)
            {
                var list = new List<NoteTreeNode> { n };
                list.AddRange(sub);
                return list;
            }
        }

        return null;
    }

    private void TrySelectPath(string fullPath)
    {
        foreach (TreeViewItem? item in GetTreeViewItems(NotesTree))
        {
            if (item.DataContext is NoteTreeNode n &&
                string.Equals(n.FullPath, fullPath, StringComparison.OrdinalIgnoreCase))
            {
                item.IsSelected = true;
                item.Focus();
                return;
            }
        }
    }

    /// <summary>沿数据层路径逐级展开 TreeView 再选中（解决折叠分支下子项容器尚未生成、TrySelectPath 无效的问题）。</summary>
    private bool TrySelectPathByExpanding(string fullPath)
    {
        if (string.IsNullOrEmpty(fullPath) || _treeRoots.Count == 0)
            return false;

        var dataRoot = _treeRoots[0];
        var chain = FindPathChain(dataRoot, fullPath);
        if (chain == null || chain.Count == 0)
            return false;

        NotesTree.UpdateLayout();
        ItemsControl? parent = NotesTree;
        for (var i = 0; i < chain.Count; i++)
        {
            var node = chain[i];
            if (parent == null)
                return false;
            parent.UpdateLayout();
            var tvi = parent.ItemContainerGenerator.ContainerFromItem(node) as TreeViewItem;
            if (tvi == null)
                return false;
            if (i < chain.Count - 1)
            {
                tvi.IsExpanded = true;
                tvi.UpdateLayout();
            }
            else
            {
                tvi.IsSelected = true;
                tvi.Focus();
                return true;
            }

            parent = tvi;
        }

        return false;
    }

    /// <summary>不依赖树节点存在与否，从磁盘打开 .md 到编辑器（与树选中后加载行为一致，含未保存提示）。</summary>
    private bool RequestLoadNoteInEditorByPath(string fullPath)
    {
        if (_notes == null || string.IsNullOrEmpty(fullPath))
            return false;
        if (!File.Exists(fullPath) || !_notes.IsUnderRoot(fullPath))
            return false;

        if (!ConfirmSaveBeforeContinue())
            return false;

        try
        {
            var text = _notes.Read(fullPath);
            SetEditorTextWithoutDirtyMark(text);
            _currentPath = fullPath;
            EditorTitle.Text = Path.GetFileName(fullPath);
            _dirty = false;
            SaveBtn.IsEnabled = true;
            RenameBtn.IsEnabled = true;
            DeleteBtn.IsEnabled = true;
            SetNoteAiControlsEnabled(true);
            SchedulePreviewAfterTreeSelection();
            UpdateDirtyIndicator();
            RefreshInspectorFromCurrent();
            return true;
        }
        catch (Exception ex)
        {
            MessageBox.Show($"无法读取：{ex.Message}", "错误", MessageBoxButton.OK, MessageBoxImage.Error);
            return false;
        }
    }

    private static IEnumerable<TreeViewItem> GetTreeViewItems(ItemsControl parent)
    {
        foreach (var o in parent.Items)
        {
            var t = parent.ItemContainerGenerator.ContainerFromItem(o) as TreeViewItem;
            if (t == null) continue;
            yield return t;
            foreach (var c in GetTreeViewItems(t))
                yield return c;
        }
    }

    private void SearchBox_OnTextChanged(object sender, TextChangedEventArgs e)
    {
        _searchDebounce.Stop();
        _searchDebounce.Start();
        SetSearchStatus("typing");
    }

    // ════════════════════════════════════════════════════════════════
    //  异步全文搜索（S1）
    // ════════════════════════════════════════════════════════════════

    private async Task PerformSearchAsync()
    {
        if (_notes == null) return;

        // 取消上一次未完成的搜索
        _searchCts?.Cancel();
        _searchCts?.Dispose();
        _searchCts = new CancellationTokenSource();
        var ct = _searchCts.Token;

        var searchText = SearchBox.Text?.Trim();
        var searchContent = SearchContentToggle.IsChecked == true;

        // 空搜索：恢复完整树，隐藏片段面板
        if (string.IsNullOrWhiteSpace(searchText))
        {
            RefreshTree(selectPath: _currentPath);
            HideSnippetPanel();
            SetSearchStatus("idle");
            return;
        }

        SetSearchStatus("searching");

        try
        {
            // 文件名/路径搜索始终在后台线程，避免阻塞 UI
            var notes = _notes;
            var root = await Task.Run(() => notes.BuildFilteredTree(searchText, false), ct).ConfigureAwait(true);
            if (ct.IsCancellationRequested) return;

            // 更新树（已回到 UI 线程）
            var expandedFolders = CollectExpandedFolderPaths();
            _treeRefreshSuppressDepth++;
            _treeRoots.Clear();
            _treeRoots.Add(root);

            Dispatcher.BeginInvoke(() =>
            {
                try
                {
                    RestoreExpandedFolderPaths(expandedFolders);
                }
                finally
                {
                    _treeRefreshSuppressDepth--;
                }
                if (!string.IsNullOrEmpty(_currentPath) &&
                    !TrySelectPathByExpanding(_currentPath))
                    TrySelectPath(_currentPath);
            }, DispatcherPriority.ApplicationIdle);

            if (ct.IsCancellationRequested) return;

            // 全文搜索：额外读取内容并提取摘要片段
            if (searchContent)
            {
                SetSearchStatus("searching-content");
                var snippets = await Task.Run(() => notes.SearchWithSnippets(searchText, ct), ct).ConfigureAwait(true);
                if (ct.IsCancellationRequested) return;

                _currentSnippets = snippets;
                if (snippets.Count > 0)
                    ShowSnippetPanel(snippets, searchText);
                else
                    HideSnippetPanel();

                SetSearchStatus("done", snippets.Count);
            }
            else
            {
                HideSnippetPanel();
                SetSearchStatus("done");
            }
        }
        catch (OperationCanceledException) { }
        catch (Exception ex)
        {
            SetSearchStatus("error");
            _ = ex; // 忽略错误，不弹窗（搜索失败不应打断用户）
        }
    }

    private void SetSearchStatus(string state, int resultCount = 0)
    {
        if (SearchStatusText == null) return;
        switch (state)
        {
            case "idle":
                SearchStatusText.Visibility = Visibility.Collapsed;
                break;
            case "typing":
                SearchStatusText.Text = "输入中…";
                SearchStatusText.Foreground = new System.Windows.Media.SolidColorBrush(
                    System.Windows.Media.Color.FromRgb(0x9C, 0xA0, 0xB0));
                SearchStatusText.Visibility = Visibility.Visible;
                break;
            case "searching":
                SearchStatusText.Text = "搜索文件名…";
                SearchStatusText.Foreground = new System.Windows.Media.SolidColorBrush(
                    System.Windows.Media.Color.FromRgb(0x9C, 0xA0, 0xB0));
                SearchStatusText.Visibility = Visibility.Visible;
                break;
            case "searching-content":
                SearchStatusText.Text = "全文搜索中，请稍候…";
                SearchStatusText.Foreground = new System.Windows.Media.SolidColorBrush(
                    System.Windows.Media.Color.FromRgb(0x4F, 0x6E, 0xF7));
                SearchStatusText.Visibility = Visibility.Visible;
                break;
            case "done":
                if (resultCount > 0)
                {
                    SearchStatusText.Text = $"找到 {resultCount} 处全文匹配";
                    SearchStatusText.Foreground = new System.Windows.Media.SolidColorBrush(
                        System.Windows.Media.Color.FromRgb(0x05, 0x96, 0x69));
                    SearchStatusText.Visibility = Visibility.Visible;
                }
                else
                {
                    SearchStatusText.Visibility = Visibility.Collapsed;
                }
                break;
            case "error":
                SearchStatusText.Text = "搜索出错";
                SearchStatusText.Foreground = new System.Windows.Media.SolidColorBrush(
                    System.Windows.Media.Color.FromRgb(0xDC, 0x26, 0x26));
                SearchStatusText.Visibility = Visibility.Visible;
                break;
        }
    }

    private void ShowSnippetPanel(List<NoteSearchMatch> snippets, string query)
    {
        SnippetCountText.Text = $"全文匹配 · {snippets.Count} 个文件";
        SnippetList.ItemsSource = snippets;
        SnippetPanel.Visibility = Visibility.Visible;
    }

    private void HideSnippetPanel()
    {
        SnippetPanel.Visibility = Visibility.Collapsed;
        SnippetList.ItemsSource = null;
    }

    private void SnippetClose_OnClick(object sender, RoutedEventArgs e)
    {
        HideSnippetPanel();
        if (SearchContentToggle.IsChecked == true)
            SearchContentToggle.IsChecked = false;
    }

    private void SnippetItem_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        // 点击搜索结果片段 → 在树中选中对应文件
        if (sender is FrameworkElement fe && fe.DataContext is NoteSearchMatch match)
        {
            TrySelectPath(match.FilePath);
        }
    }

    private void SchedulePreviewAfterTreeSelection()
    {
        // 路由顺序因主题/设备而异：同时判断标志与鼠标键，避免仍与 ContextMenu 并发调用 WebView2。
        if (_treeRightButtonDown || _treeContextMenuOpen || Mouse.RightButton == MouseButtonState.Pressed)
        {
            _deferNotePreviewUntilTreeMenuClosed = true;
            return;
        }

        _previewDebounce.Stop();
        _previewDebounce.Start();
    }

    private void NotesTree_PreviewMouseRightButtonDown(object sender, MouseButtonEventArgs e)
    {
        _treeRightButtonDown = true;

        // 统一走手动右键菜单流程：绕开 WPF 默认 ContextMenuService（某些环境会抛 UnsetValue 崩溃）。
        if (e.OriginalSource is DependencyObject dep)
        {
            var item = FindParent<TreeViewItem>(dep);
            if (item != null)
            {
                _treeContextMenuOpen = true;
                _deferNotePreviewUntilTreeMenuClosed = true;
                item.IsSelected = true;
                item.Focus();

                if (TryFindResource("TreeNodeContextMenu") is ContextMenu ctx)
                {
                    ctx.PlacementTarget = item;
                    ctx.IsOpen = true;
                }

                e.Handled = true;
                return;
            }
        }

        // 未命中树节点时，立即清除右键态，避免后续左键流程被误判。
        if (!_treeContextMenuOpen)
            _treeRightButtonDown = false;
    }

    private void NotesTree_OnSelectedItemChanged(object sender, RoutedPropertyChangedEventArgs<object> e)
    {
        if (_treeRefreshSuppressDepth > 0)
            return;

        // 右键会改选 TreeViewItem 以打开上下文菜单；此时弹出「未保存」模态框会与 ContextMenu 争用焦点，易导致界面卡死或崩溃。
        if (_dirty && _currentPath != null && (_treeRightButtonDown || _treeContextMenuOpen))
        {
            _restoreTreeSelectionAfterContextMenu = _currentPath;
            return;
        }

        if (_treeContextMenuOpen)
            return;

        if (!ConfirmSaveBeforeContinue())
        {
            if (!string.IsNullOrEmpty(_currentPath))
                TrySelectPath(_currentPath);
            return;
        }

        if (NotesTree.SelectedItem is not NoteTreeNode node || _notes == null)
        {
            SetEditorTextWithoutDirtyMark("");
            _currentPath = null;
            EditorTitle.Text = "选择左侧 .md 文件";
            _dirty = false;
            RenameBtn.IsEnabled = false;
            DeleteBtn.IsEnabled = false;
            SaveBtn.IsEnabled = false;
            SetNoteAiControlsEnabled(false);
            SchedulePreviewAfterTreeSelection();
            UpdateDirtyIndicator();
            RefreshInspectorFromCurrent();
            return;
        }

        RenameBtn.IsEnabled = true;
        DeleteBtn.IsEnabled = true;

        if (node.IsFolder)
        {
            _currentPath = null;
            SetEditorTextWithoutDirtyMark("");
            EditorTitle.Text = $"文件夹：{node.Name}";
            _dirty = false;
            SaveBtn.IsEnabled = false;
            SetNoteAiControlsEnabled(false);
            SchedulePreviewAfterTreeSelection();
            UpdateDirtyIndicator();
            RefreshInspectorFromCurrent();
            return;
        }

        try
        {
            var text = _notes.Read(node.FullPath);
            SetEditorTextWithoutDirtyMark(text);
            _currentPath = node.FullPath;
            EditorTitle.Text = node.Name;
            _dirty = false;
            SaveBtn.IsEnabled = true;
            SetNoteAiControlsEnabled(true);
            SchedulePreviewAfterTreeSelection();
            UpdateDirtyIndicator();
            RefreshInspectorFromCurrent();
        }
        catch (Exception ex)
        {
            MessageBox.Show($"无法读取：{ex.Message}", "错误", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void SetEditorTextWithoutDirtyMark(string text)
    {
        _loadingEditor = true;
        try
        {
            EditorBox.Text = text;
        }
        finally
        {
            _loadingEditor = false;
        }

        // 打开新文件时重置 undo 栈并压入初始快照
        ResetUndoStack(text);

        if (_paneMode == NotesEditorPaneMode.Live)
            _ = EnsureLiveEditorThenPushAsync();
    }

    private void EditorBox_OnTextChanged(object sender, TextChangedEventArgs e)
    {
        if (_undoRedoInProgress)
            return; // undo/redo 操作不触发快照

        if (!_loadingEditor && _currentPath == null && _notes != null && !_syncingFromLiveEditor)
            TryMaterializeUntitledNoteInSelectedFolder(EditorBox.Text ?? "");

        if (_syncingFromLiveEditor)
        {
            if (!_loadingEditor && _currentPath != null)
                _dirty = true;
            UpdateWordCountBar(EditorBox.Text ?? "");
            UpdateDirtyIndicator();
            _autoSaveTimer.Stop();
            if (_dirty && _currentPath != null)
                _autoSaveTimer.Start();
            _inspectorDebounce.Stop();
            _inspectorDebounce.Start();
            ScheduleMaybeRenameFromFirstHeading();
            return;
        }

        if (!_loadingEditor && _currentPath != null)
            _dirty = true;
        if (_loadingEditor)
            return;

        // 记录 undo 快照
        PushUndoSnapshot(EditorBox.Text ?? "");

        // 重置自动保存计时器
        _autoSaveTimer.Stop();
        if (_dirty && _currentPath != null)
            _autoSaveTimer.Start();

        // #16 更新字数/阅读时间统计
        UpdateWordCountBar(EditorBox.Text ?? "");

        // 顶部"未保存"指示
        UpdateDirtyIndicator();

        _previewDebounce.Stop();
        _previewDebounce.Start();
        ScheduleMaybeRenameFromFirstHeading();
    }

    private void ScheduleMaybeRenameFromFirstHeading()
    {
        if (_notes == null || string.IsNullOrEmpty(_currentPath) || _loadingEditor || _renameFromHeadingInProgress)
            return;
        _firstHeadingRenameDebounce.Stop();
        _firstHeadingRenameDebounce.Start();
    }

    /// <summary>首行 <c># 标题</c> 与当前 .md 文件名不一致时，自动重命名（同目录重名则 <c>_1</c> 递增）。</summary>
    private void TryApplyRenameFromFirstHeading()
    {
        if (_notes == null || string.IsNullOrEmpty(_currentPath) || _renameFromHeadingInProgress)
            return;
        if (!File.Exists(_currentPath))
            return;

        var md = EditorBox.Text ?? "";
        if (!NoteService.TryGetFirstLineH1Title(md, out var rawTitle))
            return;

        try
        {
            var newPath = _notes.TryRenameMarkdownFileFromHeadingTitle(_currentPath, rawTitle);
            if (string.Equals(newPath, _currentPath, StringComparison.OrdinalIgnoreCase))
                return;

            _renameFromHeadingInProgress = true;
            try
            {
                _currentPath = newPath;
                EditorTitle.Text = Path.GetFileName(newPath);
                RefreshTree(selectPath: newPath);
                if (_paneMode == NotesEditorPaneMode.Live)
                    _ = EnsureLiveEditorThenPushAsync();
            }
            finally
            {
                _renameFromHeadingInProgress = false;
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show($"无法根据首行标题重命名：{ex.Message}", "笔记", MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }

    /// <summary>顶部标题栏右侧的"● 未保存"指示器。</summary>
    private void UpdateDirtyIndicator()
    {
        if (DirtyIndicator == null) return;
        DirtyIndicator.Visibility = _dirty ? Visibility.Visible : Visibility.Collapsed;
    }

    private void EditorBox_CreateWikiLink_Click(object sender, RoutedEventArgs e)
    {
        if (_notes == null) return;
        var selectedText = EditorBox.SelectedText;
        var owner = Window.GetWindow(this);
        var allNotes = _notes.ListAllNotesForPicker();
        var dlg = new WikiLinkPickerDialog(allNotes, selectedText.Trim()) { Owner = owner };
        if (dlg.ShowDialog() != true || dlg.SelectedLinkText == null) return;

        var target = dlg.SelectedLinkText;
        var display = selectedText.Trim();
        string wikiText;
        if (!string.IsNullOrEmpty(display) && !string.Equals(display, target, StringComparison.OrdinalIgnoreCase))
            wikiText = $"[[{target}|{display}]]";
        else
            wikiText = $"[[{target}]]";

        if (!string.IsNullOrEmpty(selectedText))
        {
            var start = EditorBox.SelectionStart;
            EditorBox.Text = EditorBox.Text.Remove(start, EditorBox.SelectionLength).Insert(start, wikiText);
            EditorBox.CaretIndex = start + wikiText.Length;
        }
        else
        {
            var i = EditorBox.CaretIndex;
            EditorBox.Text = EditorBox.Text.Insert(i, wikiText);
            EditorBox.CaretIndex = i + wikiText.Length;
        }
        EditorBox.Focus();
        if (_currentPath != null) _dirty = true;
    }

    private void InsertMdTodo_OnClick(object sender, RoutedEventArgs e) => InsertAtEditorCaret("- [ ] ");

    private void InsertMdBullet_OnClick(object sender, RoutedEventArgs e) => InsertAtEditorCaret("- ");

    private void InsertMdOrdered_OnClick(object sender, RoutedEventArgs e) => InsertAtEditorCaret("1. ");

    // ── 新增格式化工具栏按钮 ──

    private void InsertMdBold_OnClick(object sender, RoutedEventArgs e) => WrapSelection("**", "**", "粗体文字");
    private void InsertMdItalic_OnClick(object sender, RoutedEventArgs e) => WrapSelection("*", "*", "斜体文字");
    private void InsertMdCode_OnClick(object sender, RoutedEventArgs e) => WrapSelection("`", "`", "code");
    private void InsertMdHeading_OnClick(object sender, RoutedEventArgs e) => InsertAtLineStart("## ");
    private void InsertMdQuote_OnClick(object sender, RoutedEventArgs e) => InsertAtLineStart("> ");
    private void InsertMdHr_OnClick(object sender, RoutedEventArgs e) => InsertAtEditorCaret("\n---\n");
    private void InsertMdLink_OnClick(object sender, RoutedEventArgs e)
    {
        var sel = EditorBox.SelectedText;
        if (_paneMode == NotesEditorPaneMode.Live)
        {
            if (!string.IsNullOrEmpty(sel))
                PushInsertToLiveEditor($"[{sel}](url)");
            else
                InsertAtEditorCaret("[链接文字](url)");
            return;
        }

        if (!string.IsNullOrEmpty(sel))
        {
            var start = EditorBox.SelectionStart;
            var replacement = $"[{sel}](url)";
            EditorBox.Text = EditorBox.Text.Remove(start, EditorBox.SelectionLength).Insert(start, replacement);
            EditorBox.CaretIndex = start + sel.Length + 3; // position on "url"
            EditorBox.Select(start + sel.Length + 3, 3);
        }
        else
            InsertAtEditorCaret("[链接文字](url)");
        EditorBox.Focus();
    }
    private void InsertMdImage_OnClick(object sender, RoutedEventArgs e) => InsertAtEditorCaret("![描述](image.png)");
    private void InsertMdTable_OnClick(object sender, RoutedEventArgs e) =>
        InsertAtEditorCaret("\n| 列1 | 列2 | 列3 |\n|------|------|------|\n|      |      |      |\n");

    /// <summary>将选中文本用前后标记包裹；若无选中则插入占位文字。</summary>
    private void WrapSelection(string before, string after, string placeholder)
    {
        if (_paneMode == NotesEditorPaneMode.Live)
        {
            var sel = EditorBox.SelectedText;
            if (!string.IsNullOrEmpty(sel))
                PushInsertToLiveEditor(before + sel + after);
            else
                PushInsertToLiveEditor(before + placeholder + after);
            if (_currentPath != null)
                _dirty = true;
            _autoSaveTimer.Stop();
            if (_dirty && _currentPath != null)
                _autoSaveTimer.Start();
            LiveEditorWeb.Focus();
            return;
        }

        var sel2 = EditorBox.SelectedText;
        if (!string.IsNullOrEmpty(sel2))
        {
            var start = EditorBox.SelectionStart;
            var replacement = before + sel2 + after;
            EditorBox.Text = EditorBox.Text.Remove(start, EditorBox.SelectionLength).Insert(start, replacement);
            EditorBox.CaretIndex = start + replacement.Length;
        }
        else
        {
            var i = EditorBox.CaretIndex;
            var ins = before + placeholder + after;
            EditorBox.Text = EditorBox.Text.Insert(i, ins);
            EditorBox.Select(i + before.Length, placeholder.Length);
        }
        EditorBox.Focus();
        if (_currentPath != null) _dirty = true;
    }

    /// <summary>在当前行首插入前缀（如 ## 、> ）。</summary>
    private void InsertAtLineStart(string prefix)
    {
        if (_paneMode == NotesEditorPaneMode.Live)
        {
            PushInsertToLiveEditor(prefix);
            if (_currentPath != null)
                _dirty = true;
            _autoSaveTimer.Stop();
            if (_dirty && _currentPath != null)
                _autoSaveTimer.Start();
            LiveEditorWeb.Focus();
            return;
        }

        var text = EditorBox.Text ?? "";
        var caret = EditorBox.CaretIndex;
        var lineStart = text.LastIndexOf('\n', Math.Max(0, caret - 1));
        lineStart = lineStart < 0 ? 0 : lineStart + 1;
        EditorBox.Text = text.Insert(lineStart, prefix);
        EditorBox.CaretIndex = lineStart + prefix.Length;
        EditorBox.Focus();
        if (_currentPath != null) _dirty = true;
    }

    private void NoteAiRun_OnClick(object sender, RoutedEventArgs e)
    {
        if (_notes == null || string.IsNullOrEmpty(_currentPath))
        {
            MessageBox.Show("请先打开一篇 .md 笔记。", "笔记 AI", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }

        var cfg = App.Config.Load();
        if (string.IsNullOrWhiteSpace(cfg.ApiKey))
        {
            MessageBox.Show("请先在「设置」中配置 API 密钥与端点（与智能对话相同）。", "笔记 AI",
                MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        var action = GetSelectedNoteAiAction();
        var body = EditorBox.Text ?? "";
        if (string.IsNullOrWhiteSpace(body))
        {
            MessageBox.Show("当前笔记内容为空。", "笔记 AI", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }

        var userMessage = NoteAiService.BuildUserMessage(action, body);
        var owner = Window.GetWindow(this);

        // 打开 AI 结果预览窗口（流式输出 + 对比原文）
        var win = new NoteAiResultWindow(body, action, cfg, userMessage) { Owner = owner };
        var accepted = win.ShowDialog();

        if (accepted != true) return;

        var textOut = win.ResultText;
        if (string.IsNullOrWhiteSpace(textOut)) return;

        if (win.IsAppendMode)
        {
            // 追加到文末
            var title = NoteAiService.GetDisplayName(action);
            EditorBox.Text = body + $"\n\n---\n\n## AI · {title}\n\n{textOut}\n";
            EditorBox.CaretIndex = EditorBox.Text.Length;
        }
        else
        {
            // 接受替换
            SetEditorTextWithoutDirtyMark(textOut.EndsWith('\n') ? textOut : textOut + "\n");
        }

        _dirty = true;
        _previewDebounce.Stop();
        _previewDebounce.Start();
    }

    private void NoteStt_OnClick(object sender, RoutedEventArgs e)
    {
        if (_noteDictating)
        {
            StopRealtimeDictation();
            return;
        }

        if (_notes == null || string.IsNullOrEmpty(_currentPath))
        {
            MessageBox.Show("请先选择一个 Markdown 文件。", "实时听写", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }

        var cfg = App.Config.Load();
        var options = BuildLocalSttOptionsFromConfig(cfg, fallbackLanguage: "zh");
        if (!LocalSpeechToTextService.ValidateOptions(options, out var validationError))
        {
            MessageBox.Show(
                $"{validationError}\n\n请先在“设置 → 本地语音转文字（离线）”中配置 whisper.cpp 与模型路径。",
                "实时听写", MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        try
        {
            _noteDictationSegments = 0;
            _noteDictationCts = new CancellationTokenSource();
            _noteDictationCapture = new AudioCaptureService(AudioCaptureService.AudioSource.Microphone, segmentSeconds: 4);
            _noteDictationCapture.SegmentReady += NoteDictation_OnSegmentReady;
            _noteDictationCapture.ErrorOccurred += NoteDictation_OnError;
            _noteDictationCapture.Start();

            if (!_noteDictationCapture.IsRecording)
            {
                StopRealtimeDictation();
                MessageBox.Show("无法启动麦克风，请检查设备权限。", "实时听写", MessageBoxButton.OK, MessageBoxImage.Warning);
                return;
            }

            _noteDictating = true;
            NoteSttBtn.Content = "⏹ 停止听写";
            NoteSttStatusText.Text = "听写中…";
            NoteSttStatusText.Foreground = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(0x16, 0xA3, 0x4A));
        }
        catch (Exception ex)
        {
            StopRealtimeDictation();
            MessageBox.Show($"启动听写失败：{ex.Message}", "实时听写", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void NoteDictation_OnError(string message)
    {
        _ = Dispatcher.BeginInvoke(() =>
        {
            NoteSttStatusText.Text = "听写异常";
            NoteSttStatusText.Foreground = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(0xDC, 0x26, 0x26));
            MessageBox.Show(message, "实时听写", MessageBoxButton.OK, MessageBoxImage.Warning);
            StopRealtimeDictation();
        });
    }

    private void NoteDictation_OnSegmentReady(byte[] wavBytes, int segmentIndex)
    {
        if (!_noteDictating || _noteDictationCts == null)
            return;

        var ct = _noteDictationCts.Token;
        var cfg = App.Config.Load();
        var options = BuildLocalSttOptionsFromConfig(cfg, fallbackLanguage: "zh");
        if (!LocalSpeechToTextService.ValidateOptions(options, out var validationError))
        {
            _ = Dispatcher.BeginInvoke(() =>
            {
                NoteSttStatusText.Text = "配置无效";
                NoteSttStatusText.Foreground = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(0xDC, 0x26, 0x26));
                MessageBox.Show(validationError, "实时听写", MessageBoxButton.OK, MessageBoxImage.Warning);
                StopRealtimeDictation();
            });
            return;
        }

        _ = Task.Run(async () =>
        {
            await _noteDictationSemaphore.WaitAsync(ct).ConfigureAwait(false);
            try
            {
                var tmpWav = Path.Combine(Path.GetTempPath(), $"dm_notes_rt_{DateTime.Now:yyyyMMdd_HHmmss}_{segmentIndex}_{Guid.NewGuid():N}.wav");
                SpeechToTextResult result;
                try
                {
                    await File.WriteAllBytesAsync(tmpWav, wavBytes, ct).ConfigureAwait(false);
                    result = await LocalSpeechToTextService.TranscribeFileAsync(tmpWav, options, ct).ConfigureAwait(false);
                }
                finally
                {
                    try { if (File.Exists(tmpWav)) File.Delete(tmpWav); } catch { }
                }

                _ = Dispatcher.BeginInvoke(() =>
                {
                    if (!_noteDictating) return;
                    if (!result.Success)
                    {
                        NoteSttStatusText.Text = $"听写失败：{result.Error}";
                        NoteSttStatusText.Foreground = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(0xDC, 0x26, 0x26));
                        return;
                    }

                    var text = result.Text.Trim();
                    if (string.IsNullOrWhiteSpace(text))
                        return;
                    if (EditorBox.CaretIndex > 0 && !char.IsWhiteSpace(EditorBox.Text[Math.Max(0, EditorBox.CaretIndex - 1)]))
                        InsertAtEditorCaret(" ");
                    InsertAtEditorCaret(text + " ");
                    _noteDictationSegments++;
                    NoteSttStatusText.Text = $"听写中… 已转 {_noteDictationSegments} 段";
                    NoteSttStatusText.Foreground = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(0x16, 0xA3, 0x4A));
                });
            }
            catch (OperationCanceledException)
            {
                // ignored
            }
            catch (Exception ex)
            {
                _ = Dispatcher.BeginInvoke(() =>
                {
                    NoteSttStatusText.Text = "听写异常";
                    NoteSttStatusText.Foreground = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(0xDC, 0x26, 0x26));
                    MessageBox.Show($"实时听写失败：{ex.Message}", "实时听写", MessageBoxButton.OK, MessageBoxImage.Warning);
                });
            }
            finally
            {
                _noteDictationSemaphore.Release();
            }
        }, ct);
    }

    private void StopRealtimeDictation()
    {
        _noteDictating = false;
        _noteDictationCts?.Cancel();
        _noteDictationCts?.Dispose();
        _noteDictationCts = null;

        if (_noteDictationCapture != null)
        {
            _noteDictationCapture.SegmentReady -= NoteDictation_OnSegmentReady;
            _noteDictationCapture.ErrorOccurred -= NoteDictation_OnError;
            _noteDictationCapture.Dispose();
            _noteDictationCapture = null;
        }

        NoteSttBtn.Content = "🎤 开始听写";
        if (_noteDictationSegments > 0)
        {
            NoteSttStatusText.Text = $"已停止 · 共 {_noteDictationSegments} 段";
            NoteSttStatusText.Foreground = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(0x64, 0x74, 0x8B));
        }
        else
        {
            NoteSttStatusText.Text = "";
        }
    }

    private async void GeneratePpt_OnClick(object sender, RoutedEventArgs e)
    {
        if (_notes == null || string.IsNullOrEmpty(_currentPath))
        {
            MessageBox.Show("请先打开一篇 .md 笔记。", "生成 PPT", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }

        var cfg = App.Config.Load();
        if (string.IsNullOrWhiteSpace(cfg.ApiKey))
        {
            MessageBox.Show("请先在「设置」中配置 API 密钥与端点（与智能对话相同）。", "生成 PPT", MessageBoxButton.OK,
                MessageBoxImage.Warning);
            return;
        }

        var body = EditorBox.Text ?? "";
        if (string.IsNullOrWhiteSpace(body))
        {
            MessageBox.Show("当前笔记内容为空。", "生成 PPT", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }

        var defaultName = Path.GetFileNameWithoutExtension(_currentPath);
        if (string.IsNullOrEmpty(defaultName))
            defaultName = "演示文稿";
        var dlg = new SaveFileDialog
        {
            Filter = "PowerPoint 演示文稿|*.pptx",
            FileName = defaultName + ".pptx",
            Title = "保存生成的演示文稿",
            AddExtension = true,
            DefaultExt = ".pptx"
        };
        if (dlg.ShowDialog() != true)
            return;

        GeneratePptBtn.IsEnabled = false;
        Mouse.OverrideCursor = Cursors.Wait;
        try
        {
            // P1：走新的 PPT 大模块（DanceMonkey.Ppt）。
            // 行为保持与旧路径一致——仍使用旧 prompt schema，仍走 ShapeCrawler，但渲染主题化、可扩展。
            var module = DesktopPptModuleFactory.CreateForDesktop(cfg);
            var request = new PptGenerationRequest
            {
                SourceKind = PptSourceKind.Markdown,
                Source = body,
                ThemeId = "dark-premium", // 与旧深色视觉保持一致；P4 工作台 UI 上线后允许用户切换
            };

            var result = await module
                .GenerateFromSourceAsync(request, dlg.FileName)
                .ConfigureAwait(true);

            if (!result.Success)
            {
                MessageBox.Show(result.Error ?? "生成失败。", "生成 PPT", MessageBoxButton.OK, MessageBoxImage.Error);
                return;
            }

            var savedPath = result.OutputFilePath ?? dlg.FileName;
            var open = MessageBox.Show(
                $"已保存：\n{savedPath}\n\n是否在 PowerPoint 中打开？",
                "生成 PPT",
                MessageBoxButton.YesNo,
                MessageBoxImage.Information);
            if (open == MessageBoxResult.Yes)
            {
                try
                {
                    Process.Start(new ProcessStartInfo { FileName = savedPath, UseShellExecute = true });
                }
                catch (Exception ex)
                {
                    MessageBox.Show($"无法打开文件：{ex.Message}", "生成 PPT", MessageBoxButton.OK, MessageBoxImage.Warning);
                }
            }
        }
        finally
        {
            Mouse.OverrideCursor = null;
            GeneratePptBtn.IsEnabled = true;
        }
    }

    /// <summary>将当前笔记正文送入「PPT 工作台」，由用户在工作台选主题、改大纲、再渲染。</summary>
    private void SendToPptWorkspace_OnClick(object sender, RoutedEventArgs e)
    {
        if (_notes == null || string.IsNullOrEmpty(_currentPath))
        {
            MessageBox.Show("请先打开一篇 .md 笔记。", "PPT 工作台", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }
        var body = EditorBox.Text ?? "";
        if (string.IsNullOrWhiteSpace(body))
        {
            MessageBox.Show("当前笔记内容为空。", "PPT 工作台", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }

        if (Window.GetWindow(this) is not MainWindow main)
        {
            MessageBox.Show("无法定位主窗口。", "PPT 工作台", MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        main.OpenPptWorkspaceWithMarkdown(body, hintTopic: Path.GetFileNameWithoutExtension(_currentPath));
    }

    private NoteAiAction GetSelectedNoteAiAction()
    {
        if (NoteAiActionCombo.SelectedItem is ComboBoxItem c && c.Tag is NoteAiAction a)
            return a;
        return NoteAiAction.Organize;
    }

    private void InsertAtEditorCaret(string text)
    {
        if (_paneMode == NotesEditorPaneMode.Live)
        {
            PushInsertToLiveEditor(text);
            if (_currentPath != null)
                _dirty = true;
            _autoSaveTimer.Stop();
            if (_dirty && _currentPath != null)
                _autoSaveTimer.Start();
            LiveEditorWeb.Focus();
            return;
        }

        var i = EditorBox.CaretIndex;
        EditorBox.Text = EditorBox.Text.Insert(i, text);
        EditorBox.CaretIndex = i + text.Length;
        EditorBox.Focus();
        if (_currentPath != null)
            _dirty = true;
    }

    private void BtnPreviewViewOnly_OnClick(object sender, RoutedEventArgs e)
    {
        SetNotesPaneMode(NotesEditorPaneMode.Read);
    }

    private void BtnPreviewEditSplit_OnClick(object sender, RoutedEventArgs e)
    {
        SetNotesPaneMode(NotesEditorPaneMode.Split);
    }

    private void ApplyNotesEditorPaneLayout()
    {
        var read = _paneMode == NotesEditorPaneMode.Read;
        var live = _paneMode == NotesEditorPaneMode.Live;

        PreviewHeaderLabel.Text = read ? "阅读" : "预览";
        BtnPreviewViewOnly.Visibility = read ? Visibility.Collapsed : Visibility.Visible;
        BtnPreviewEditSplit.Visibility = read ? Visibility.Visible : Visibility.Collapsed;
        EditorToolbarRow.Visibility = read ? Visibility.Collapsed : Visibility.Visible;

        TbReadModeLabel.Text = _paneMode switch
        {
            NotesEditorPaneMode.Live => "实时",
            NotesEditorPaneMode.Split => "分栏",
            _ => "阅读"
        };

        if (live)
        {
            ClassicEditorRoot.Visibility = Visibility.Collapsed;
            LiveEditorHost.Visibility = Visibility.Visible;
        }
        else
        {
            ClassicEditorRoot.Visibility = Visibility.Visible;
            LiveEditorHost.Visibility = Visibility.Collapsed;

            if (read)
            {
                EditorColumn.Width = new GridLength(0);
                EditorColumn.MinWidth = 0;
                EditorBox.Visibility = Visibility.Collapsed;
                EditorPreviewSplitter.Visibility = Visibility.Collapsed;
            }
            else
            {
                EditorColumn.Width = new GridLength(1, GridUnitType.Star);
                EditorColumn.MinWidth = 140;
                EditorBox.Visibility = Visibility.Visible;
                EditorPreviewSplitter.Visibility = Visibility.Visible;
            }
        }

        UpdateUndoRedoButtons();
    }

    private void LoadNotesPaneModeFromConfig()
    {
        var raw = App.Config.Load().NotesEditorViewMode?.Trim().ToLowerInvariant() ?? "live";
        _paneMode = raw switch
        {
            "split" => NotesEditorPaneMode.Split,
            "read" => NotesEditorPaneMode.Read,
            _ => NotesEditorPaneMode.Live
        };
    }

    private void SaveNotesPaneModeToConfig()
    {
        var cfg = App.Config.Load();
        cfg.NotesEditorViewMode = _paneMode switch
        {
            NotesEditorPaneMode.Split => "split",
            NotesEditorPaneMode.Read => "read",
            _ => "live"
        };
        App.Config.Save(cfg);
    }

    /// <summary>切换实时 / 分栏 / 阅读（顶部工具栏循环或预览栏按钮）。</summary>
    private void SetNotesPaneMode(NotesEditorPaneMode mode, bool persist = true)
    {
        _paneMode = mode;
        if (persist)
            SaveNotesPaneModeToConfig();
        ApplyNotesEditorPaneLayout();
        if (mode == NotesEditorPaneMode.Live)
            _ = EnsureLiveEditorThenPushAsync();
        else
            _ = RefreshPreviewAsync();
    }

    private async Task EnsureLiveEditorThenPushAsync()
    {
        await EnsureLiveEditorAsync();
        await PushMarkdownToLiveEditorAsync(EditorBox.Text ?? "");
        _ = Dispatcher.BeginInvoke(RequestLiveEditorInputFocus, DispatcherPriority.ApplicationIdle);
    }

    /// <summary>让 WebView2 内 contenteditable 获得焦点，便于中文 IME 在刚进入页面时即可附着。</summary>
    private void RequestLiveEditorInputFocus()
    {
        if (_paneMode != NotesEditorPaneMode.Live)
            return;
        if (LiveEditorWeb?.CoreWebView2 == null)
            return;
        try
        {
            LiveEditorWeb.Focus();
            _ = LiveEditorWeb.CoreWebView2.ExecuteScriptAsync("document.getElementById('editor')?.focus?.();");
        }
        catch
        {
            // ignore
        }
    }

    private async Task EnsureLiveEditorAsync()
    {
        await LiveEditorWeb.EnsureCoreWebView2Async(null);
        if (!_liveEditorEventsHooked && LiveEditorWeb.CoreWebView2 != null)
        {
            LiveEditorWeb.CoreWebView2.NavigationCompleted += LiveEditor_OnNavigationCompleted;
            LiveEditorWeb.CoreWebView2.WebMessageReceived += LiveEditor_OnWebMessageReceived;
            _liveEditorEventsHooked = true;
        }

        var htmlPath = Path.Combine(AppContext.BaseDirectory, "Assets", "note-live-editor.html");
        if (!File.Exists(htmlPath))
            return;

        var uri = new Uri(htmlPath);
        var cur = LiveEditorWeb.Source?.AbsoluteUri;
        if (!string.Equals(cur, uri.AbsoluteUri, StringComparison.OrdinalIgnoreCase))
            LiveEditorWeb.Source = uri;
        else
            await PushMarkdownToLiveEditorAsync(EditorBox.Text ?? "");
    }

    private async void LiveEditor_OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        if (!e.IsSuccess)
            return;
        try
        {
            await MapLiveEditorVirtualHostAsync();
            await PushMarkdownToLiveEditorAsync(EditorBox.Text ?? "");
            _ = Dispatcher.BeginInvoke(RequestLiveEditorInputFocus, DispatcherPriority.ApplicationIdle);
        }
        catch
        {
            // ignore
        }
    }

    private async Task MapLiveEditorVirtualHostAsync()
    {
        var mappedRoot = _notes?.RootPath;
        if (LiveEditorWeb.CoreWebView2 == null)
            return;
        try
        {
            if (!string.IsNullOrEmpty(mappedRoot) && Directory.Exists(mappedRoot))
            {
                LiveEditorWeb.CoreWebView2.SetVirtualHostNameToFolderMapping(
                    MarkdownHtml.NotePreviewVirtualHost,
                    mappedRoot,
                    CoreWebView2HostResourceAccessKind.Allow);
            }
            else
                LiveEditorWeb.CoreWebView2.ClearVirtualHostNameToFolderMapping(MarkdownHtml.NotePreviewVirtualHost);
        }
        catch
        {
            // 与预览一致：映射失败时仍能编辑纯文本
        }

        await Task.CompletedTask;
    }

    private Task PushMarkdownToLiveEditorAsync(string markdown)
    {
        if (LiveEditorWeb.CoreWebView2 == null)
            return Task.CompletedTask;
        try
        {
            var json = JsonSerializer.Serialize(new { type = "setMarkdown", text = markdown ?? "" });
            LiveEditorWeb.CoreWebView2.PostWebMessageAsJson(json);
        }
        catch
        {
            // ignore
        }

        return Task.CompletedTask;
    }

    private void TryApplyLiveDocChange(JsonElement payload)
    {
        if (!payload.TryGetProperty("type", out var typeEl))
            return;
        var type = typeEl.GetString();

        if (type == "ready")
        {
            // 编辑器初始化完成：把当前 EditorBox 内容下发，避免 setMarkdown("") 覆盖
            Dispatcher.BeginInvoke(() => _ = PushMarkdownToLiveEditorAsync(EditorBox.Text ?? ""),
                DispatcherPriority.Normal);
            return;
        }

        if (type == "openLink")
        {
            if (!payload.TryGetProperty("href", out var hrefEl))
                return;
            var href = hrefEl.GetString();
            if (string.IsNullOrWhiteSpace(href))
                return;
            Dispatcher.BeginInvoke(() =>
            {
                try
                {
                    Process.Start(new ProcessStartInfo
                    {
                        FileName = href,
                        UseShellExecute = true
                    });
                }
                catch
                {
                    // ignore
                }
            }, DispatcherPriority.Normal);
            return;
        }

        if (type == "openWikiLink")
        {
            if (!payload.TryGetProperty("target", out var wikiTargetEl))
                return;
            var wikiTarget = wikiTargetEl.GetString() ?? "";
            if (string.IsNullOrWhiteSpace(wikiTarget))
                return;
            Dispatcher.BeginInvoke(() => NavigateToWikiLink(wikiTarget), DispatcherPriority.Normal);
            return;
        }

        if (type == "contextMenuRequest")
        {
            payload.TryGetProperty("selectedText", out var selEl);
            var selectedText = selEl.ValueKind == JsonValueKind.String ? selEl.GetString() ?? "" : "";
            payload.TryGetProperty("hasSelection", out var hasSelEl);
            var hasSel = hasSelEl.ValueKind == JsonValueKind.True;
            Dispatcher.BeginInvoke(() => ShowLiveEditorContextMenu(selectedText, hasSel), DispatcherPriority.Normal);
            return;
        }

        if (type != "docChange")
            return;
        if (!payload.TryGetProperty("text", out var textEl))
            return;
        var text = textEl.GetString() ?? "";

        Dispatcher.BeginInvoke(() =>
        {
            // 与 EditorBox 同步，但不触发回写到 WebView2（避免循环）
            if (string.Equals(EditorBox.Text, text, StringComparison.Ordinal))
                return;

            _syncingFromLiveEditor = true;
            try
            {
                var hadPathBefore = _currentPath != null;
                EditorBox.Text = text;
                TryMaterializeUntitledNoteInSelectedFolder(text);
                if (_currentPath != null && hadPathBefore)
                    _dirty = true;
            }
            finally
            {
                _syncingFromLiveEditor = false;
            }
        }, DispatcherPriority.Normal);
    }

    private void LiveEditor_OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            var json = e.WebMessageAsJson;
            if (string.IsNullOrWhiteSpace(json))
                return;
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            if (root.ValueKind == JsonValueKind.String)
            {
                var inner = root.GetString();
                if (string.IsNullOrEmpty(inner))
                    return;
                using var innerDoc = JsonDocument.Parse(inner);
                TryApplyLiveDocChange(innerDoc.RootElement);
                return;
            }

            TryApplyLiveDocChange(root);
        }
        catch
        {
            // ignore malformed messages
        }
    }

    private void PushInsertToLiveEditor(string snippet)
    {
        if (LiveEditorWeb.CoreWebView2 == null)
            return;
        try
        {
            var json = JsonSerializer.Serialize(new { type = "insert", text = snippet });
            LiveEditorWeb.CoreWebView2.PostWebMessageAsJson(json);
        }
        catch
        {
            // ignore
        }
    }

    private async Task RefreshPreviewAsync()
    {
        try
        {
            if (_paneMode == NotesEditorPaneMode.Live)
                return;

            if (!_previewInited)
            {
                await PreviewWeb.EnsureCoreWebView2Async(null);
                _previewInited = true;
                if (!_previewWebMessageHooked && PreviewWeb.CoreWebView2 != null)
                {
                    PreviewWeb.CoreWebView2.WebMessageReceived += PreviewWeb_OnWebMessageReceived;
                    _previewWebMessageHooked = true;
                }
            }

            var noteDir = string.IsNullOrEmpty(_currentPath) ? null : Path.GetDirectoryName(_currentPath);
            var mappedRoot = _notes?.RootPath;
            if (PreviewWeb.CoreWebView2 != null)
            {
                try
                {
                    if (!string.IsNullOrEmpty(mappedRoot) && Directory.Exists(mappedRoot))
                    {
                        PreviewWeb.CoreWebView2.SetVirtualHostNameToFolderMapping(
                            MarkdownHtml.NotePreviewVirtualHost,
                            mappedRoot,
                            CoreWebView2HostResourceAccessKind.Allow);
                    }
                    else
                        PreviewWeb.CoreWebView2.ClearVirtualHostNameToFolderMapping(MarkdownHtml.NotePreviewVirtualHost);
                }
                catch
                {
                    // 部分环境映射失败时仍尝试用相对路径（可能无法显示图）
                }
            }

            var md = EditorBox.Text ?? "";
            var bodyHtml = string.IsNullOrWhiteSpace(md)
                ? "<p style=\"color:#6b7280;font-size:13px;margin:0;\">暂无内容，在左侧编辑 Markdown 即可预览。</p>"
                : BuildMarkdownBodyHtml(md, _paneMode == NotesEditorPaneMode.Read, noteDir, mappedRoot);
            const string taskToggleScript = """
<script>
(function(){
  function bind(){
    var inputs = document.querySelectorAll('li.task-list-item input[type=checkbox]');
    inputs.forEach(function(el, i) {
      el.addEventListener('change', function() {
        try {
          if (window.chrome && window.chrome.webview) {
            // 必须 post 普通对象，勿 JSON.stringify：否则宿主收到的是 JSON 字符串，WebMessageAsJson 根为 String，C# 无法按对象解析
            window.chrome.webview.postMessage({ type: 'taskToggle', index: i, checked: el.checked });
          }
        } catch (e) {}
      });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
</script>
""";
            const string wikiLinkScript = """
<script>
(function(){
  function bindWikiLinks(){
    document.querySelectorAll('a.wiki-link').forEach(function(a){
      a.addEventListener('click', function(e){
        e.preventDefault();
        try {
          var href = a.getAttribute('href') || '';
          var tgt = decodeURIComponent(href.replace(/^wikilink:/i,''));
          if (tgt && window.chrome && window.chrome.webview)
            window.chrome.webview.postMessage({ type: 'wikiLinkClick', target: tgt });
        } catch(_) {}
      });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindWikiLinks);
  else bindWikiLinks();
})();
</script>
""";
            var script = (_paneMode == NotesEditorPaneMode.Read ? taskToggleScript : "") + wikiLinkScript;
            var doc = "<!DOCTYPE html><html><head><meta charset=\"utf-8\"/><style>body{font-family:Segoe UI,system-ui,sans-serif;padding:16px;line-height:1.55;color:#1a1d26;} code,pre{font-family:Consolas,monospace;} pre{background:#f0f1f6;padding:12px;border-radius:8px;overflow:auto;} table{border-collapse:collapse;} th,td{border:1px solid #e8eaf0;padding:6px;} ul,ol{padding-left:1.35em;} ul.contains-task-list{list-style:none;padding-left:0;} li.task-list-item{margin:0.35em 0;} li.task-list-item input{margin-right:0.5em;vertical-align:middle;}</style></head><body>" +
                      bodyHtml + script + "</body></html>";
            PreviewWeb.NavigateToString(doc);
        }
        catch
        {
            // WebView2 未就绪时忽略
        }
    }

    private static string BuildMarkdownBodyHtml(string md, bool readingMode, string? noteFileDirectory, string? mappedRootDirectory)
    {
        // 预处理：去除 frontmatter YAML 块，转换 [[wiki links]]
        var processed = MarkdownHtml.StripFrontmatter(md);
        processed = MarkdownHtml.PreprocessWikiLinks(processed);
        var html = Markdown.ToHtml(processed, MdPipeline);
        if (readingMode)
            html = StripDisabledFromTaskCheckboxes(html);
        if (!string.IsNullOrEmpty(noteFileDirectory))
            html = MarkdownHtml.ResolveImageSrcForNotePreview(html, noteFileDirectory, mappedRootDirectory);
        return html;
    }

    private static string StripDisabledFromTaskCheckboxes(string html)
    {
        html = html.Replace(" disabled=\"\"", "", StringComparison.Ordinal);
        html = html.Replace(" disabled=\"disabled\"", "", StringComparison.Ordinal);
        return Regex.Replace(html, @"\sdisabled(?=[\s/>])", "", RegexOptions.IgnoreCase);
    }

    private static List<int> FindTaskListLineIndices(string md)
    {
        var lines = md.Split(new[] { "\r\n", "\r", "\n" }, StringSplitOptions.None);
        var list = new List<int>();
        for (var i = 0; i < lines.Length; i++)
        {
            if (Regex.IsMatch(lines[i], @"^\s*[*+-]\s*\[[ xX]\]\s"))
                list.Add(i);
        }

        return list;
    }

    private void PreviewWeb_OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            var json = e.WebMessageAsJson;
            if (string.IsNullOrWhiteSpace(json))
                return;

            // 先尝试解析通用 type 字段
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            JsonElement payload = root;
            if (root.ValueKind == JsonValueKind.String)
            {
                var inner = root.GetString();
                if (string.IsNullOrEmpty(inner)) return;
                using var doc2 = JsonDocument.Parse(inner);
                // 无法在 using 内返回 Element，改用本地副本
                payload = doc2.RootElement.Clone();
            }

            if (payload.TryGetProperty("type", out var typeEl))
            {
                var type = typeEl.GetString();
                if (type == "wikiLinkClick" && payload.TryGetProperty("target", out var tEl))
                {
                    var wikiTarget = tEl.GetString() ?? "";
                    if (!string.IsNullOrWhiteSpace(wikiTarget))
                        Dispatcher.BeginInvoke(() => NavigateToWikiLink(wikiTarget), DispatcherPriority.Normal);
                    return;
                }
                if (type == "taskToggle")
                {
                    if (TryReadTaskTogglePayload(payload, out var idx, out var chk))
                        Dispatcher.BeginInvoke(() => ApplyTaskToggleFromPreview(idx, chk), DispatcherPriority.Normal);
                    return;
                }
            }
        }
        catch
        {
            // 忽略格式错误
        }
    }

    private static bool TryReadTaskTogglePayload(JsonElement root, out int index, out bool done)
    {
        index = 0;
        done = false;
        if (root.GetProperty("type").GetString() != "taskToggle")
            return false;
        index = root.GetProperty("index").GetInt32();
        done = root.GetProperty("checked").GetBoolean();
        return true;
    }

    private void ApplyTaskToggleFromPreview(int taskIndex, bool done)
    {
        var md = EditorBox.Text ?? "";
        var lineIndices = FindTaskListLineIndices(md);
        if (taskIndex < 0 || taskIndex >= lineIndices.Count)
            return;
        var lines = md.Split(new[] { "\r\n", "\r", "\n" }, StringSplitOptions.None);
        var li = lineIndices[taskIndex];
        if (li < 0 || li >= lines.Length)
            return;
        var line = lines[li];
        string newLine;
        if (done)
            newLine = Regex.Replace(line, @"^(\s*[*+-]\s*)\[ \]", "$1[x]");
        else
            newLine = Regex.Replace(line, @"^(\s*[*+-]\s*)\[[xX]\]", "$1[ ]");
        if (newLine == line)
            return;

        lines[li] = newLine;
        var sep = md.Contains("\r\n", StringComparison.Ordinal) ? "\r\n" : md.Contains('\r') ? "\r" : "\n";
        var newMd = string.Join(sep, lines);
        EditorBox.Text = newMd;
        if (_currentPath != null)
            _dirty = true;
        _previewDebounce.Stop();
        _previewDebounce.Start();
    }

    /// <summary>Live 编辑器右键时展示 WPF ContextMenu（内含「创建双链」等选项）。</summary>
    private void ShowLiveEditorContextMenu(string selectedText, bool hasSelection)
    {
        _liveEditorContextMenuSelectedText = selectedText;

        var menu = new ContextMenu { PlacementTarget = LiveEditorWeb, Placement = System.Windows.Controls.Primitives.PlacementMode.MousePoint };

        // 创建双链（仅在有选中时突出，但无选中也可用——让用户输入目标名）
        var wikiItem = new MenuItem
        {
            Header = hasSelection ? $"🔗 创建双链「{TruncateLabel(selectedText, 16)}」" : "🔗 创建双链…",
            FontWeight = FontWeights.SemiBold
        };
        wikiItem.Click += (_, _) =>
        {
            menu.IsOpen = false;
            ExecuteCreateWikiLinkInLiveEditor(selectedText);
        };
        menu.Items.Add(wikiItem);

        if (hasSelection)
        {
            menu.Items.Add(new Separator());

            // 粗体 / 斜体 / 行内代码：通过 replaceSelectionWithWikiLink 同一通道，用保存选区 + 包裹替换
            void WrapViaContextMenu(string before, string after)
            {
                menu.IsOpen = false;
                SendReplaceSelectionWithCustomText(before + selectedText + after);
            }

            var boldItem = new MenuItem { Header = "**粗体**" };
            boldItem.Click += (_, _) => WrapViaContextMenu("**", "**");
            menu.Items.Add(boldItem);

            var italicItem = new MenuItem { Header = "*斜体*" };
            italicItem.Click += (_, _) => WrapViaContextMenu("*", "*");
            menu.Items.Add(italicItem);

            var codeItem = new MenuItem { Header = "`行内代码`" };
            codeItem.Click += (_, _) => WrapViaContextMenu("`", "`");
            menu.Items.Add(codeItem);
        }

        menu.IsOpen = true;
    }

    private static string TruncateLabel(string s, int maxLen)
        => s.Length <= maxLen ? s : s[..maxLen] + "…";

    /// <summary>
    /// 在 Live 编辑器中创建双链：弹出笔记选择器让用户从全库选择目标笔记，
    /// 然后发 replaceSelectionWithWikiLink 消息给 JS，用选区内容替换。
    /// </summary>
    private void ExecuteCreateWikiLinkInLiveEditor(string selectedText)
    {
        if (_notes == null) return;
        var owner = Window.GetWindow(this);
        var allNotes = _notes.ListAllNotesForPicker();
        var dlg = new WikiLinkPickerDialog(allNotes, selectedText.Trim()) { Owner = owner };
        if (dlg.ShowDialog() != true || dlg.SelectedLinkText == null) return;

        var target = dlg.SelectedLinkText;
        var display = selectedText.Trim();
        SendReplaceSelectionWithWikiLink(target, display);
    }

    /// <summary>向 Live 编辑器发送 replaceSelectionWithWikiLink 消息，让 JS 用保存的选区替换为双链。</summary>
    private void SendReplaceSelectionWithWikiLink(string target, string display)
    {
        if (LiveEditorWeb.CoreWebView2 == null) return;
        try
        {
            var json = JsonSerializer.Serialize(new { type = "replaceSelectionWithWikiLink", target, display });
            LiveEditorWeb.CoreWebView2.PostWebMessageAsJson(json);
            if (_currentPath != null) _dirty = true;
            _autoSaveTimer.Stop();
            if (_dirty && _currentPath != null) _autoSaveTimer.Start();
            LiveEditorWeb.Focus();
        }
        catch { }
    }

    /// <summary>向 Live 编辑器发送替换选区为任意文本的消息（复用 replaceSelectionWithWikiLink 通道，display 置空）。</summary>
    private void SendReplaceSelectionWithCustomText(string text)
    {
        if (LiveEditorWeb.CoreWebView2 == null) return;
        try
        {
            // 复用同一消息：target=text, display="" → JS 生成 [[text]] 的逻辑不适用，
            // 所以改用专用 type "replaceSelectionWithText"
            var json = JsonSerializer.Serialize(new { type = "replaceSelectionWithText", text });
            LiveEditorWeb.CoreWebView2.PostWebMessageAsJson(json);
            if (_currentPath != null) _dirty = true;
            _autoSaveTimer.Stop();
            if (_dirty && _currentPath != null) _autoSaveTimer.Start();
            LiveEditorWeb.Focus();
        }
        catch { }
    }

    /// <summary>按 wikilink 目标名称在笔记库内找到对应 .md 并打开；找不到时提示用户。</summary>
    private void NavigateToWikiLink(string target)
    {
        if (_notes == null || string.IsNullOrWhiteSpace(target)) return;
        var fullPath = _notes.ResolveWikiLinkTarget(target, _currentPath);
        if (fullPath == null)
        {
            MessageBox.Show($"未找到笔记「{target}」\n\n如需创建，请在笔记库中新建一个同名文件。",
                "双链 - 笔记未找到", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }
        if (!RequestLoadNoteInEditorByPath(fullPath)) return;
        if (!TrySelectPathByExpanding(fullPath))
            TrySelectPath(fullPath);
    }

    private string? GetRelativeFolderForNewNote()
    {
        if (_notes == null) return null;
        if (NotesTree.SelectedItem is not NoteTreeNode node)
            return null;
        if (node.IsFolder)
            return Path.GetRelativePath(_notes.RootPath, node.FullPath);
        var sub = NoteService.GetSubnotesDirectoryForMarkdown(node.FullPath);
        var rel = Path.GetRelativePath(_notes.RootPath, sub);
        if (string.IsNullOrEmpty(rel) || rel == ".")
            return null;
        return rel;
    }

    /// <summary>
    /// 仅浏览到文件夹（未打开 .md）时，用户一旦在编辑器里输入非空内容，则在当前选中文件夹下创建真实 .md 并绑定，
    /// 避免「能打字但无文件、无法保存」的困扰。
    /// </summary>
    private void TryMaterializeUntitledNoteInSelectedFolder(string body)
    {
        if (_notes == null || _currentPath != null || _loadingEditor)
            return;
        if (NotesTree.SelectedItem is not NoteTreeNode node || !node.IsFolder)
            return;
        if (string.IsNullOrWhiteSpace(body))
            return;

        try
        {
            var rel = Path.GetRelativePath(_notes.RootPath, node.FullPath);
            if (string.IsNullOrEmpty(rel) || rel == ".")
                rel = null;
            var path = _notes.CreateNewNote(NoteService.DefaultNewNoteBaseName, rel, body);
            BindCurrentNote(path);
            RefreshTree(selectPath: path);
            if (_paneMode == NotesEditorPaneMode.Live)
                _ = EnsureLiveEditorThenPushAsync();
        }
        catch (Exception ex)
        {
            MessageBox.Show($"无法在文件夹中创建笔记：{ex.Message}", "笔记", MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }

    private void ExecuteTodayNote()
    {
        if (!ConfirmSaveBeforeContinue()) return;
        if (_notes == null) ReloadServiceAndList();
        if (_notes == null) return;
        try
        {
            var path = _notes.CreateTodayNote();
            BindCurrentNote(path);
            RefreshTree(selectPath: path);
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, "错误", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void ExecuteNewNote()
    {
        if (!ConfirmSaveBeforeContinue()) return;
        if (_notes == null) ReloadServiceAndList();
        if (_notes == null) return;
        try
        {
            var rel = GetRelativeFolderForNewNote();
            var path = _notes.CreateNewNote(NoteService.DefaultNewNoteBaseName, rel);
            BindCurrentNote(path);
            RefreshTree(selectPath: path);
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, "错误", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void ExecuteNewFolder()
    {
        if (_notes == null) ReloadServiceAndList();
        if (_notes == null) return;
        var owner = Window.GetWindow(this);
        var dlg = new PromptDialog("新建文件夹", "文件夹名称（不含路径）", "新建文件夹") { Owner = owner };
        if (dlg.ShowDialog() == true)
        {
            var name = dlg.ResultText?.Trim();
            if (string.IsNullOrEmpty(name)) return;
            try
            {
                string? relParent = null;
                if (NotesTree.SelectedItem is NoteTreeNode n && n.IsFolder)
                    relParent = Path.GetRelativePath(_notes.RootPath, n.FullPath);
                else if (NotesTree.SelectedItem is NoteTreeNode f && !f.IsFolder)
                {
                    var sub = NoteService.GetSubnotesDirectoryForMarkdown(f.FullPath);
                    relParent = Path.GetRelativePath(_notes.RootPath, sub);
                    if (string.IsNullOrEmpty(relParent) || relParent == ".")
                        relParent = null;
                }

                _notes.CreateFolder(relParent, name);
                RefreshTree(selectPath: _currentPath);
            }
            catch (Exception ex)
            {
                MessageBox.Show(ex.Message, "错误", MessageBoxButton.OK, MessageBoxImage.Error);
            }
        }
    }

    private void ExecuteQuickCapture()
    {
        if (_notes == null) ReloadServiceAndList();
        if (_notes == null) return;
        var owner = Window.GetWindow(this);
        var w = new QuickNoteWindow(_notes) { Owner = owner };
        w.ShowDialog();
        RefreshTree(selectPath: _currentPath);
    }

    private void ExecuteNewSticky()
    {
        if (_notes == null) ReloadServiceAndList();
        if (_notes == null) return;
        try
        {
            var path = _notes.CreateStickyNoteFile();
            var w = new StickyNoteWindow(path, _notes);
            w.Show();
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, "错误", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void ExecuteExportZip()
    {
        if (_notes == null) return;
        var dlg = new SaveFileDialog
        {
            Filter = "ZIP 压缩包|*.zip",
            FileName = $"DailyNote-{DateTime.Now:yyyyMMdd}.zip"
        };
        if (dlg.ShowDialog() == true)
        {
            try
            {
                _notes.ExportToZip(dlg.FileName);
                MessageBox.Show("导出完成。", "成功", MessageBoxButton.OK, MessageBoxImage.Information);
            }
            catch (Exception ex)
            {
                MessageBox.Show(ex.Message, "导出失败", MessageBoxButton.OK, MessageBoxImage.Error);
            }
        }
    }

    private void ExecuteImportZip()
    {
        if (_notes == null) return;
        var dlg = new OpenFileDialog { Filter = "ZIP 压缩包|*.zip" };
        if (dlg.ShowDialog() == true)
        {
            try
            {
                var folder = _notes.ImportZip(dlg.FileName);
                MessageBox.Show($"已解压到：\n{folder}", "导入完成", MessageBoxButton.OK, MessageBoxImage.Information);
                RefreshTree();
            }
            catch (Exception ex)
            {
                MessageBox.Show(ex.Message, "导入失败", MessageBoxButton.OK, MessageBoxImage.Error);
            }
        }
    }

    private void ExecuteOpenRootFolder()
    {
        if (_notes == null) return;
        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = "explorer.exe",
                Arguments = _notes.RootPath,
                UseShellExecute = true
            });
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, "错误", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void Rename_OnClick(object sender, RoutedEventArgs e)
    {
        if (_notes == null) return;
        if (NotesTree.SelectedItem is not NoteTreeNode node) return;
        var owner = Window.GetWindow(this);
        var dlg = new PromptDialog("重命名", "新名称", node.Name)
        {
            Owner = owner
        };
        if (dlg.ShowDialog() != true) return;
        var newName = dlg.ResultText?.Trim();
        if (string.IsNullOrEmpty(newName)) return;
        try
        {
            var target = _notes.Rename(node.FullPath, newName);
            if (!node.IsFolder && string.Equals(_currentPath, node.FullPath, StringComparison.OrdinalIgnoreCase))
                _currentPath = target;
            RefreshTree(selectPath: node.IsFolder ? null : target);
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, "错误", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void Save_OnClick(object sender, RoutedEventArgs e)
    {
        if (_notes == null || string.IsNullOrEmpty(_currentPath))
        {
            MessageBox.Show("请先选择要保存的 .md 文件。", "提示", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }

        if (TrySaveCurrent(showError: true, refreshTree: true))
            MessageBox.Show("已保存。", "成功", MessageBoxButton.OK, MessageBoxImage.Information);
    }

    private void Delete_OnClick(object sender, RoutedEventArgs e)
    {
        if (_notes == null) return;
        if (NotesTree.SelectedItem is not NoteTreeNode node) return;
        var msg = node.IsFolder
            ? $"确定删除整个文件夹及其中的全部内容？\n{node.FullPath}"
            : "确定删除当前笔记？";
        if (MessageBox.Show(msg, "确认", MessageBoxButton.YesNo, MessageBoxImage.Warning) != MessageBoxResult.Yes)
            return;
        try
        {
            _notes.Delete(node.FullPath);
            _currentPath = null;
            SetEditorTextWithoutDirtyMark("");
            _dirty = false;
            SetNoteAiControlsEnabled(false);
            _ = RefreshPreviewAsync();
            RefreshTree();
        }
        catch (Exception ex)
        {
            MessageBox.Show($"删除失败：{ex.Message}", "错误", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private bool ConfirmSaveBeforeContinue()
    {
        if (!_dirty || _currentPath == null) return true;
        var r = MessageBox.Show(
            "当前笔记已修改，是否保存更改？",
            "提示",
            MessageBoxButton.YesNoCancel,
            MessageBoxImage.Question);

        if (r == MessageBoxResult.Yes)
            return TrySaveCurrent(showError: true, refreshTree: false);
        return r == MessageBoxResult.No;
    }

    // ════════════════════════════════════════════════════════════════
    //  Undo / Redo helpers
    // ════════════════════════════════════════════════════════════════

    private void ResetUndoStack(string initialText)
    {
        _undoStack.Clear();
        _undoStack.Add(initialText);
        _undoIndex = 0;
        UpdateUndoRedoButtons();
    }

    private void PushUndoSnapshot(string text)
    {
        // 删掉当前位置之后的 redo 快照
        if (_undoIndex >= 0 && _undoIndex < _undoStack.Count - 1)
            _undoStack.RemoveRange(_undoIndex + 1, _undoStack.Count - _undoIndex - 1);

        // 避免重复快照
        if (_undoStack.Count > 0 && _undoStack[^1] == text)
            return;

        _undoStack.Add(text);
        if (_undoStack.Count > MaxUndoSnapshots)
            _undoStack.RemoveAt(0);
        _undoIndex = _undoStack.Count - 1;
        UpdateUndoRedoButtons();
    }

    private bool CanUndo => _undoIndex > 0;
    private bool CanRedo => _undoIndex < _undoStack.Count - 1;

    private void PerformUndo()
    {
        if (!CanUndo) return;
        _undoIndex--;
        ApplyUndoRedoSnapshot();
    }

    private void PerformRedo()
    {
        if (!CanRedo) return;
        _undoIndex++;
        ApplyUndoRedoSnapshot();
    }

    private void ApplyUndoRedoSnapshot()
    {
        _undoRedoInProgress = true;
        try
        {
            EditorBox.Text = _undoStack[_undoIndex];
            EditorBox.CaretIndex = EditorBox.Text.Length;
            if (_currentPath != null)
                _dirty = true;
        }
        finally
        {
            _undoRedoInProgress = false;
        }
        UpdateUndoRedoButtons();
        _previewDebounce.Stop();
        _previewDebounce.Start();
    }

    private void UpdateUndoRedoButtons()
    {
        if (_paneMode == NotesEditorPaneMode.Live)
        {
            UndoBtn.IsEnabled = false;
            RedoBtn.IsEnabled = false;
            return;
        }

        UndoBtn.IsEnabled = CanUndo;
        RedoBtn.IsEnabled = CanRedo;
    }

    private void Undo_OnClick(object sender, RoutedEventArgs e) => PerformUndo();
    private void Redo_OnClick(object sender, RoutedEventArgs e) => PerformRedo();

    // ════════════════════════════════════════════════════════════════
    //  Ctrl+S (silent save) & Auto-save
    // ════════════════════════════════════════════════════════════════

    private void PerformSave()
    {
        _ = TrySaveCurrent(showError: false, refreshTree: false);
    }

    private void PerformAutoSave()
    {
        _ = TrySaveCurrent(showError: false, refreshTree: false);
    }

    private bool TrySaveCurrent(bool showError, bool refreshTree)
    {
        if (_notes == null || string.IsNullOrEmpty(_currentPath) || !_dirty)
            return true;

        try
        {
            _notes.Save(_currentPath, EditorBox.Text);
            _dirty = false;
            _autoSaveTimer.Stop();
            UpdateDirtyIndicator();
            if (refreshTree)
                RefreshTree(selectPath: _currentPath);
            return true;
        }
        catch (Exception ex)
        {
            if (showError)
                MessageBox.Show($"保存失败：{ex.Message}", "错误", MessageBoxButton.OK, MessageBoxImage.Error);
            return false;
        }
    }

    // ════════════════════════════════════════════════════════════════
    //  Content search toggle
    // ════════════════════════════════════════════════════════════════

    private void SearchContentToggle_OnClick(object sender, RoutedEventArgs e)
    {
        // 切换全文搜索后触发异步搜索
        _searchDebounce.Stop();
        _searchDebounce.Start();
    }

    // ════════════════════════════════════════════════════════════════
    //  左侧面板收起 / 展开
    // ════════════════════════════════════════════════════════════════

    private void CollapseLeft_OnClick(object sender, RoutedEventArgs e)
    {
        _leftPanelCollapsed = !_leftPanelCollapsed;

        if (_leftPanelCollapsed)
        {
            // 记录当前宽度（>0 才有意义）
            if (LeftPanelCol.ActualWidth > 0)
                _leftPanelSavedWidth = LeftPanelCol.ActualWidth;

            LeftPanelCol.MinWidth = 0;
            LeftPanelCol.Width = new GridLength(0);

            // 图标改为向右（ChevronRight = 展开提示）
            CollapseLeftIcon.Text = "\uE76C";
            CollapseLeftBtn.ToolTip = "展开笔记列表";
        }
        else
        {
            LeftPanelCol.Width = new GridLength(_leftPanelSavedWidth);
            LeftPanelCol.MinWidth = 200;

            // 图标改为向左（ChevronLeft = 收起提示）
            CollapseLeftIcon.Text = "\uE76B";
            CollapseLeftBtn.ToolTip = "收起笔记列表";
        }
    }

    // ════════════════════════════════════════════════════════════════
    //  目录树折叠 / 展开
    // ════════════════════════════════════════════════════════════════

    private void CollapseAll_OnClick(object sender, RoutedEventArgs e)
    {
        foreach (var item in GetTreeViewItems(NotesTree))
            item.IsExpanded = false;
    }

    private void ExpandTopLevel_OnClick(object sender, RoutedEventArgs e)
    {
        // 只展开第一级，避免大型笔记库卡顿
        foreach (var o in NotesTree.Items)
        {
            if (NotesTree.ItemContainerGenerator.ContainerFromItem(o) is TreeViewItem tvi)
                tvi.IsExpanded = true;
        }
    }

    private static T? FindParent<T>(DependencyObject? dep) where T : DependencyObject
    {
        while (dep != null)
        {
            if (dep is T t)
                return t;
            dep = GetParentObject(dep);
        }

        return null;
    }

    /// <summary>
    /// 安全获取父节点：兼容 Visual / Visual3D / FrameworkContentElement / ContentElement。
    /// 右键命中到 TextElement 时若直接调用 VisualTreeHelper.GetParent 会抛异常。
    /// </summary>
    private static DependencyObject? GetParentObject(DependencyObject child)
    {
        if (child is FrameworkContentElement fce)
            return fce.Parent;

        if (child is ContentElement ce)
            return ContentOperations.GetParent(ce) ?? LogicalTreeHelper.GetParent(ce);

        if (child is System.Windows.Media.Visual || child is System.Windows.Media.Media3D.Visual3D)
            return System.Windows.Media.VisualTreeHelper.GetParent(child);

        return LogicalTreeHelper.GetParent(child);
    }

    // ════════════════════════════════════════════════════════════════
    //  #6 右键上下文菜单处理
    // ════════════════════════════════════════════════════════════════

    private void TreeNodeContextMenu_Opened(object sender, RoutedEventArgs e)
    {
        _treeContextMenuOpen = true;
        if (sender is not ContextMenu cm) return;
        foreach (var o in cm.Items)
        {
            if (o is not MenuItem mi || !Equals(mi.Tag, "CtxNewSubNote")) continue;
            var vis = cm.PlacementTarget is FrameworkElement fe && fe.DataContext is NoteTreeNode n && !n.IsFolder
                ? Visibility.Visible
                : Visibility.Collapsed;
            mi.Visibility = vis;
            break;
        }
    }

    private void TreeNodeContextMenu_Closed(object sender, RoutedEventArgs e)
    {
        _treeContextMenuOpen = false;
        _treeRightButtonDown = false;

        if (_deferNotePreviewUntilTreeMenuClosed)
        {
            _deferNotePreviewUntilTreeMenuClosed = false;
            Dispatcher.BeginInvoke(() =>
            {
                _previewDebounce.Stop();
                _previewDebounce.Start();
            }, DispatcherPriority.ApplicationIdle);
        }

        if (string.IsNullOrEmpty(_restoreTreeSelectionAfterContextMenu))
            return;
        var path = _restoreTreeSelectionAfterContextMenu;
        _restoreTreeSelectionAfterContextMenu = null;
        Dispatcher.BeginInvoke(() =>
        {
            if (_notes == null) return;
            TrySelectPath(path);
        }, DispatcherPriority.Background);
    }

    private void ClearPendingContextMenuSelectionRestore()
    {
        _restoreTreeSelectionAfterContextMenu = null;
    }

    private NoteTreeNode? GetContextMenuNode(object sender)
    {
        // 从 MenuItem 向上查找 ContextMenu，再取 PlacementTarget 的 DataContext
        if (sender is MenuItem mi)
        {
            // 向上遍历 Parent 链：子菜单 MenuItem → 父 MenuItem → … → ContextMenu
            object? parent = mi.Parent;
            while (parent is MenuItem pm)
                parent = pm.Parent;
            if (parent is ContextMenu ctx &&
                ctx.PlacementTarget is FrameworkElement fe &&
                fe.DataContext is NoteTreeNode n)
                return n;
        }
        // 回退到当前选中项
        return NotesTree.SelectedItem as NoteTreeNode;
    }

    private void Ctx_NewNote_Click(object sender, RoutedEventArgs e)
    {
        ClearPendingContextMenuSelectionRestore();
        if (_notes == null) return;
        var node = GetContextMenuNode(sender);
        try
        {
            string? rel = null;
            if (node != null)
                rel = node.IsFolder
                    ? Path.GetRelativePath(_notes.RootPath, node.FullPath)
                    : Path.GetRelativePath(_notes.RootPath, Path.GetDirectoryName(node.FullPath)!);
            var path = _notes.CreateNewNote(NoteService.DefaultNewNoteBaseName, rel);
            BindCurrentNote(path);
            RefreshTree(selectPath: path);
        }
        catch (Exception ex) { MessageBox.Show(ex.Message, "错误", MessageBoxButton.OK, MessageBoxImage.Error); }
    }

    private void Ctx_NewSubNote_Click(object sender, RoutedEventArgs e)
    {
        ClearPendingContextMenuSelectionRestore();
        if (_notes == null) return;
        var node = GetContextMenuNode(sender);
        if (node == null || node.IsFolder) return;
        try
        {
            var sub = NoteService.GetSubnotesDirectoryForMarkdown(node.FullPath);
            var rel = Path.GetRelativePath(_notes.RootPath, sub);
            if (string.IsNullOrEmpty(rel) || rel == ".")
                rel = null;
            var path = _notes.CreateNewNote(NoteService.DefaultNewNoteBaseName, rel);
            BindCurrentNote(path);
            RefreshTree(selectPath: path);
        }
        catch (Exception ex) { MessageBox.Show(ex.Message, "错误", MessageBoxButton.OK, MessageBoxImage.Error); }
    }

    private void Ctx_NewFolder_Click(object sender, RoutedEventArgs e)
    {
        ClearPendingContextMenuSelectionRestore();
        if (_notes == null) return;
        var node = GetContextMenuNode(sender);
        var owner = Window.GetWindow(this);
        var dlg = new PromptDialog("新建文件夹", "文件夹名称", "新建文件夹") { Owner = owner };
        if (dlg.ShowDialog() != true) return;
        var name = dlg.ResultText?.Trim();
        if (string.IsNullOrEmpty(name)) return;
        try
        {
            string? relParent = null;
            if (node != null)
            {
                if (node.IsFolder)
                    relParent = Path.GetRelativePath(_notes.RootPath, node.FullPath);
                else
                {
                    var sub = NoteService.GetSubnotesDirectoryForMarkdown(node.FullPath);
                    relParent = Path.GetRelativePath(_notes.RootPath, sub);
                    if (string.IsNullOrEmpty(relParent) || relParent == ".")
                        relParent = null;
                }
            }
            _notes.CreateFolder(relParent, name);
            RefreshTree(selectPath: _currentPath);
        }
        catch (Exception ex) { MessageBox.Show(ex.Message, "错误", MessageBoxButton.OK, MessageBoxImage.Error); }
    }

    private void Ctx_Rename_Click(object sender, RoutedEventArgs e)
    {
        ClearPendingContextMenuSelectionRestore();
        if (_notes == null) return;
        var node = GetContextMenuNode(sender);
        if (node == null) return;
        var owner = Window.GetWindow(this);
        var dlg = new PromptDialog("重命名", "新名称", node.Name) { Owner = owner };
        if (dlg.ShowDialog() != true) return;
        var newName = dlg.ResultText?.Trim();
        if (string.IsNullOrEmpty(newName)) return;
        try
        {
            var target = _notes.Rename(node.FullPath, newName);
            if (!node.IsFolder && string.Equals(_currentPath, node.FullPath, StringComparison.OrdinalIgnoreCase))
                _currentPath = target;
            RefreshTree(selectPath: node.IsFolder ? null : target);
        }
        catch (Exception ex) { MessageBox.Show(ex.Message, "错误", MessageBoxButton.OK, MessageBoxImage.Error); }
    }

    private void Ctx_CopyPath_Click(object sender, RoutedEventArgs e)
    {
        ClearPendingContextMenuSelectionRestore();
        var node = GetContextMenuNode(sender);
        if (node == null) return;
        try { Clipboard.SetText(NoteService.GetCopyPath(node.FullPath)); }
        catch { /* 剪贴板操作偶尔失败 */ }
    }

    private void Ctx_Delete_Click(object sender, RoutedEventArgs e)
    {
        ClearPendingContextMenuSelectionRestore();
        if (_notes == null) return;
        var node = GetContextMenuNode(sender);
        if (node == null) return;
        var msg = node.IsFolder
            ? $"确定删除整个文件夹及其中的全部内容？\n{node.FullPath}"
            : $"确定删除笔记 {node.Name}？";
        if (MessageBox.Show(msg, "确认删除", MessageBoxButton.YesNo, MessageBoxImage.Warning) != MessageBoxResult.Yes)
            return;
        try
        {
            _notes.Delete(node.FullPath);
            if (string.Equals(_currentPath, node.FullPath, StringComparison.OrdinalIgnoreCase))
            {
                _currentPath = null;
                SetEditorTextWithoutDirtyMark("");
                _dirty = false;
                SetNoteAiControlsEnabled(false);
            }
            _ = RefreshPreviewAsync();
            RefreshTree();
        }
        catch (Exception ex) { MessageBox.Show($"删除失败：{ex.Message}", "错误", MessageBoxButton.OK, MessageBoxImage.Error); }
    }

    private void Ctx_MoveTo_Click(object sender, RoutedEventArgs e)
    {
        ClearPendingContextMenuSelectionRestore();
        if (_notes == null) return;
        var node = GetContextMenuNode(sender);
        if (node == null) return;

        var tree = _notes.BuildTree();
        var hint = $"将「{node.Name}」移动到：";
        var owner = Window.GetWindow(this);
        var dlg = new FolderPickerDialog(tree, hint) { Owner = owner };
        if (dlg.ShowDialog() != true || string.IsNullOrEmpty(dlg.SelectedFolderPath)) return;

        // 不能移动到自身或自身子目录
        var dest = Path.GetFullPath(dlg.SelectedFolderPath);
        var src = Path.GetFullPath(node.FullPath);
        if (node.IsFolder && dest.StartsWith(src + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
        {
            MessageBox.Show("不能将文件夹移动到自身的子目录中。", "提示", MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        try
        {
            var newPath = _notes.MoveToFolder(node.FullPath, dest);
            if (!node.IsFolder && string.Equals(_currentPath, node.FullPath, StringComparison.OrdinalIgnoreCase))
                _currentPath = newPath;
            RefreshTree(selectPath: node.IsFolder ? null : newPath);
        }
        catch (Exception ex) { MessageBox.Show($"移动失败：{ex.Message}", "错误", MessageBoxButton.OK, MessageBoxImage.Error); }
    }

    private void Ctx_Duplicate_Click(object sender, RoutedEventArgs e)
    {
        ClearPendingContextMenuSelectionRestore();
        if (_notes == null) return;
        var node = GetContextMenuNode(sender);
        if (node == null || node.IsFolder) return;

        try
        {
            var dest = _notes.DuplicateMarkdownWithSubnotesFolder(node.FullPath);
            RefreshTree(selectPath: dest);
        }
        catch (Exception ex) { MessageBox.Show($"复制失败：{ex.Message}", "错误", MessageBoxButton.OK, MessageBoxImage.Error); }
    }

    private void Ctx_SetFolderColor_Click(object sender, RoutedEventArgs e)
    {
        ClearPendingContextMenuSelectionRestore();
        if (_notes == null) return;
        var node = GetContextMenuNode(sender);
        if (node == null || !node.IsFolder)
        {
            MessageBox.Show("请在文件夹上设置颜色。", "提示", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }

        if (sender is not MenuItem mi || mi.Tag is not string tag)
            return;

        try
        {
            if (string.Equals(tag, "default", StringComparison.OrdinalIgnoreCase))
            {
                _notes.ClearFolderColorCategory(node.FullPath);
            }
            else if (Enum.TryParse<NoteCategory>(tag, ignoreCase: true, out var category))
            {
                _notes.SetFolderColorCategory(node.FullPath, category);
            }
            else
            {
                return;
            }

            RefreshTree(selectPath: _currentPath ?? node.FullPath);
        }
        catch (Exception ex)
        {
            MessageBox.Show($"设置文件夹颜色失败：{ex.Message}", "错误", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void Ctx_OpenInExplorer_Click(object sender, RoutedEventArgs e)
    {
        ClearPendingContextMenuSelectionRestore();
        var node = GetContextMenuNode(sender);
        if (node == null) return;

        try
        {
            if (node.IsFolder)
                Process.Start(new ProcessStartInfo { FileName = node.FullPath, UseShellExecute = true });
            else
                Process.Start(new ProcessStartInfo { FileName = "explorer.exe", Arguments = $"/select,\"{node.FullPath}\"" });
        }
        catch { /* ignore */ }
    }

    // ════════════════════════════════════════════════════════════════
    //  #16 字数 / 阅读时间统计
    // ════════════════════════════════════════════════════════════════

    private void UpdateWordCountBar(string text)
    {
        if (WordCountBar == null) return;
        if (string.IsNullOrWhiteSpace(text))
        {
            WordCountBar.Text = "字数: 0 · 词数: 0 · 预计阅读: <1 分钟";
            return;
        }

        var chars = text.Count(c => !char.IsWhiteSpace(c));
        // 英文词数：按空白 / 标点分割
        var words = Regex.Matches(text, @"[\w]+").Count;
        // 中文字数
        var cjk = text.Count(c => c >= 0x4E00 && c <= 0x9FFF);
        // 阅读速度：中文 ~300 字/分钟，英文 ~200 词/分钟
        var minutes = Math.Max(1, (int)Math.Ceiling(cjk / 300.0 + (words - cjk) / 200.0));
        var readTime = minutes <= 1 ? "<1 分钟" : $"~{minutes} 分钟";
        WordCountBar.Text = $"字数: {chars} · 词数: {words} · 中文: {cjk} · 预计阅读: {readTime}";
    }

    // ════════════════════════════════════════════════════════════════
    //  #11 导出 HTML 单文件
    // ════════════════════════════════════════════════════════════════

    private void ExportHtml_OnClick(object sender, RoutedEventArgs e)
    {
        if (_notes == null || string.IsNullOrEmpty(_currentPath)) return;
        var defaultName = Path.GetFileNameWithoutExtension(_currentPath);
        var dlg = new SaveFileDialog
        {
            Filter = "HTML 文件|*.html",
            FileName = defaultName + ".html",
            Title = "导出为 HTML"
        };
        if (dlg.ShowDialog() != true) return;
        try
        {
            var md = EditorBox.Text ?? "";
            var bodyHtml = MarkdownHtml.ToHtmlBody(md);
            var noteDir = Path.GetDirectoryName(_currentPath);
            if (!string.IsNullOrEmpty(noteDir))
                bodyHtml = MarkdownHtml.ResolveImageSrcForNotePreview(bodyHtml, noteDir);
            var fullHtml = MarkdownHtml.WrapFullDocument(bodyHtml);
            File.WriteAllText(dlg.FileName, fullHtml, System.Text.Encoding.UTF8);
            MessageBox.Show($"已导出：{dlg.FileName}", "导出 HTML", MessageBoxButton.OK, MessageBoxImage.Information);
        }
        catch (Exception ex)
        {
            MessageBox.Show($"导出失败：{ex.Message}", "错误", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    // ════════════════════════════════════════════════════════════════
    //  #15 版本历史
    // ════════════════════════════════════════════════════════════════

    private void VersionHistory_OnClick(object sender, RoutedEventArgs e)
    {
        if (_notes == null || string.IsNullOrEmpty(_currentPath)) return;
        try
        {
            var versions = _notes.GetVersionHistory(_currentPath);
            if (versions.Count == 0)
            {
                MessageBox.Show("当前文件没有历史版本。\n（每次保存时会自动备份到 .history/ 目录）", "版本历史", MessageBoxButton.OK, MessageBoxImage.Information);
                return;
            }

            var sb = new System.Text.StringBuilder();
            sb.AppendLine($"文件：{Path.GetFileName(_currentPath)}");
            sb.AppendLine($"共 {versions.Count} 个历史版本：\n");
            for (var i = 0; i < Math.Min(versions.Count, 20); i++)
            {
                var (vPath, vTime) = versions[i];
                var info = new FileInfo(vPath);
                sb.AppendLine($"  {i + 1}. {vTime.ToLocalTime():yyyy-MM-dd HH:mm:ss}  ({info.Length / 1024.0:F1} KB)");
            }

            if (versions.Count > 20)
                sb.AppendLine($"\n  …还有 {versions.Count - 20} 个更早的版本");

            sb.AppendLine("\n是否恢复最近一个版本？（当前内容将被替换，可撤销）");

            var result = MessageBox.Show(sb.ToString(), "版本历史", MessageBoxButton.YesNo, MessageBoxImage.Question);
            if (result == MessageBoxResult.Yes)
            {
                var restored = File.ReadAllText(versions[0].Path, System.Text.Encoding.UTF8);
                EditorBox.Text = restored;
                _dirty = true;
                _previewDebounce.Stop();
                _previewDebounce.Start();
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show($"读取历史失败：{ex.Message}", "错误", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    // ════════════════════════════════════════════════════════════════
    //  #14 图片粘贴 (Ctrl+V)
    // ════════════════════════════════════════════════════════════════

    /// <summary>在编辑器获得焦点时拦截粘贴，检测剪贴板图片。需在构造函数或 Loaded 中注册。</summary>
    protected override void OnPreviewKeyDown(KeyEventArgs e)
    {
        base.OnPreviewKeyDown(e);
        if (e.Key == Key.V && Keyboard.Modifiers == ModifierKeys.Control &&
            EditorBox.IsFocused && _currentPath != null)
        {
            if (Clipboard.ContainsImage())
            {
                e.Handled = true;
                PasteImageFromClipboard();
            }
        }
    }

    private void PasteImageFromClipboard()
    {
        if (_notes == null || string.IsNullOrEmpty(_currentPath)) return;
        try
        {
            var image = Clipboard.GetImage();
            if (image == null) return;

            var noteDir = Path.GetDirectoryName(_currentPath)!;
            var imgDir = Path.Combine(noteDir, "images");
            Directory.CreateDirectory(imgDir);

            var fileName = $"paste-{DateTime.Now:yyyyMMdd-HHmmss-fff}.png";
            var filePath = Path.Combine(imgDir, fileName);

            using (var fs = new FileStream(filePath, FileMode.Create))
            {
                var encoder = new System.Windows.Media.Imaging.PngBitmapEncoder();
                encoder.Frames.Add(System.Windows.Media.Imaging.BitmapFrame.Create(image));
                encoder.Save(fs);
            }

            var mdRef = $"![](images/{fileName})";
            InsertAtEditorCaret(mdRef);
        }
        catch (Exception ex)
        {
            MessageBox.Show($"粘贴图片失败：{ex.Message}", "错误", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    // ════════════════════════════════════════════════════════════════
    //  #18 笔记模板（动态加载 Templates/ 目录下的 .md 文件）
    // ════════════════════════════════════════════════════════════════

    /// <summary>动态填充模板子菜单（延后到空闲帧，避免在菜单布局/测量过程中改 Items 集合导致异常）。</summary>
    private void TemplateSubMenu_Opened(object sender, RoutedEventArgs e)
    {
        if (sender is not MenuItem menu || _notes == null) return;
        var notes = _notes;
        Dispatcher.BeginInvoke(() =>
        {
            try
            {
                if (notes == null) return;
                menu.Items.Clear();
                var templates = notes.ListTemplates();
                if (templates.Count == 0)
                {
                    menu.Items.Add(new MenuItem { Header = "（无模板）", IsEnabled = false });
                    return;
                }

                foreach (var (name, fullPath) in templates)
                {
                    var mi = new MenuItem { Header = $"📄 {name}", Tag = fullPath };
                    mi.Click += Ctx_TemplateNote_Click;
                    menu.Items.Add(mi);
                }
            }
            catch
            {
                /* 忽略模板菜单填充失败，避免拖垮右键菜单 */
            }
        }, DispatcherPriority.ApplicationIdle);
    }

    private void Ctx_TemplateNote_Click(object sender, RoutedEventArgs e)
    {
        ClearPendingContextMenuSelectionRestore();
        if (_notes == null) return;
        if (sender is not MenuItem mi || mi.Tag is not string templatePath) return;

        try
        {
            var content = _notes.LoadTemplateContent(templatePath);
            var title = Path.GetFileNameWithoutExtension(templatePath);

            string? rel = null;
            var node = GetContextMenuNode(sender);
            if (node != null)
            {
                if (node.IsFolder)
                    rel = Path.GetRelativePath(_notes.RootPath, node.FullPath);
                else
                {
                    var sub = NoteService.GetSubnotesDirectoryForMarkdown(node.FullPath);
                    rel = Path.GetRelativePath(_notes.RootPath, sub);
                    if (string.IsNullOrEmpty(rel) || rel == ".")
                        rel = null;
                }
            }

            var path = _notes.CreateNewNote(title, rel, content);
            BindCurrentNote(path);
            RefreshTree(selectPath: path);
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, "错误", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    // ════════════════════════════════════════════════════════════════
    //  帮助按钮 — 笔记库结构说明
    // ════════════════════════════════════════════════════════════════

    private void HelpBtn_OnClick(object sender, RoutedEventArgs e)
    {
        try
        {
            var htmlPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "Assets", "note-structure-help.html");
            if (File.Exists(htmlPath))
                Process.Start(new ProcessStartInfo { FileName = htmlPath, UseShellExecute = true });
            else
                MessageBox.Show("帮助文件不存在，请重新安装或检查 Assets 目录。", "提示", MessageBoxButton.OK, MessageBoxImage.Information);
        }
        catch (Exception ex)
        {
            MessageBox.Show($"无法打开帮助：{ex.Message}", "错误", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void BindCurrentNote(string fullPath)
    {
        if (_notes == null) return;
        var text = _notes.Read(fullPath);
        SetEditorTextWithoutDirtyMark(text);
        _currentPath = fullPath;
        EditorTitle.Text = Path.GetFileName(fullPath);
        _dirty = false;
        SaveBtn.IsEnabled = true;
        RenameBtn.IsEnabled = true;
        DeleteBtn.IsEnabled = true;
        SetNoteAiControlsEnabled(true);
        _ = RefreshPreviewAsync();
        UpdateDirtyIndicator();
        RefreshInspectorFromCurrent();
    }

    // ════════════════════════════════════════════════════════════════
    //  UI state helpers for new buttons
    // ════════════════════════════════════════════════════════════════

    /// <summary>更新新增按钮的 IsEnabled 状态（被选中项变化时调用）。</summary>
    private void UpdateNewButtonStates(bool hasFile)
    {
        ExportHtmlBtn.IsEnabled = hasFile;
        VersionHistoryBtn.IsEnabled = hasFile;
    }

    private static SpeechToTextOptions BuildLocalSttOptionsFromConfig(AppConfig cfg, string fallbackLanguage)
    {
        return new SpeechToTextOptions
        {
            WhisperExePath = cfg.LocalSttWhisperExePath?.Trim() ?? "",
            ModelPath = cfg.LocalSttModelPath?.Trim() ?? "",
            Language = string.IsNullOrWhiteSpace(cfg.LocalSttLanguage) ? fallbackLanguage : cfg.LocalSttLanguage.Trim(),
            Threads = cfg.LocalSttThreads <= 0 ? 4 : cfg.LocalSttThreads,
            AutoPunctuation = cfg.LocalSttAutoPunctuation,
            TimeoutSeconds = cfg.LocalSttTimeoutSeconds < 30 ? 240 : cfg.LocalSttTimeoutSeconds
        };
    }

    // ════════════════════════════════════════════════════════════
    //  顶部 macOS Scrivener 风格工具栏 — 新建 / 速记 / 视图
    // ════════════════════════════════════════════════════════════

    private void TbNewNote_OnClick(object sender, RoutedEventArgs e) => ExecuteNewNote();
    private void TbNewFolder_OnClick(object sender, RoutedEventArgs e) => ExecuteNewFolder();
    private void TbToday_OnClick(object sender, RoutedEventArgs e) => ExecuteTodayNote();
    private void TbQuickCapture_OnClick(object sender, RoutedEventArgs e) => ExecuteQuickCapture();
    private void TbSticky_OnClick(object sender, RoutedEventArgs e) => ExecuteNewSticky();

    /// <summary>顶部视图按钮：依次切换 实时 → 分栏 → 阅读 → 实时。</summary>
    private void TbReadMode_OnClick(object sender, RoutedEventArgs e)
    {
        var next = _paneMode switch
        {
            NotesEditorPaneMode.Live => NotesEditorPaneMode.Split,
            NotesEditorPaneMode.Split => NotesEditorPaneMode.Read,
            _ => NotesEditorPaneMode.Live
        };
        SetNotesPaneMode(next);
    }

    // ════════════════════════════════════════════════════════════
    //  右侧 Inspector 检视器
    // ════════════════════════════════════════════════════════════

    private void ToggleInspector_OnClick(object sender, RoutedEventArgs e)
    {
        _inspectorVisible = !_inspectorVisible;
        ApplyInspectorVisibility();
        if (_inspectorVisible)
            RefreshInspectorFromCurrent();
    }

    private void ApplyInspectorVisibility()
    {
        if (_inspectorVisible)
        {
            InspectorCol.MinWidth = 220;
            InspectorCol.Width = new GridLength(_inspectorSavedWidth);
            InspectorSplitterCol.Width = new GridLength(6);
            InspectorPanel.Visibility = Visibility.Visible;
            InspectorSplitter.Visibility = Visibility.Visible;
        }
        else
        {
            if (InspectorCol.ActualWidth > 0)
                _inspectorSavedWidth = InspectorCol.ActualWidth;
            InspectorCol.MinWidth = 0;
            InspectorCol.Width = new GridLength(0);
            InspectorSplitterCol.Width = new GridLength(0);
            InspectorPanel.Visibility = Visibility.Collapsed;
            InspectorSplitter.Visibility = Visibility.Collapsed;
        }
    }

    /// <summary>从当前打开的笔记重新加载 Inspector 各字段（解析 frontmatter）。</summary>
    private void RefreshInspectorFromCurrent()
    {
        if (InspectorPanel == null || !_inspectorVisible) return;

        _loadingInspector = true;
        try
        {
            if (string.IsNullOrEmpty(_currentPath))
            {
                InspectorSynopsisBox.Text = "";
                InspectorNotesBox.Text = "";
                InspectorTagsBox.Text = "";
                InspectorTagsChips.ItemsSource = null;
                MetaKindText.Text = "—";
                MetaWordsText.Text = "—";
                MetaModifiedText.Text = "—";
                MetaPathText.Text = "—";
                if (OutlinksPanel != null) OutlinksPanel.ItemsSource = null;
                if (OutlinksEmptyText != null) OutlinksEmptyText.Visibility = Visibility.Visible;
                if (BacklinksPanel != null) BacklinksPanel.ItemsSource = null;
                if (BacklinksEmptyText != null) BacklinksEmptyText.Visibility = Visibility.Visible;
                return;
            }

            var fm = NoteFrontmatter.Parse(EditorBox.Text ?? "", out _);
            InspectorSynopsisBox.Text = fm.Summary;
            InspectorNotesBox.Text = fm.Notes;
            InspectorTagsBox.Text = string.Join(", ", fm.Tags);
            InspectorTagsChips.ItemsSource = fm.Tags.ToList();

            MetaKindText.Text = GetCurrentNoteKindDisplay();
            MetaWordsText.Text = ComputeInspectorWordsText(EditorBox.Text ?? "");
            try
            {
                var fi = new FileInfo(_currentPath);
                MetaModifiedText.Text = fi.Exists ? fi.LastWriteTime.ToString("yyyy-MM-dd HH:mm") : "—";
            }
            catch { MetaModifiedText.Text = "—"; }
            MetaPathText.Text = _notes != null
                ? Path.GetRelativePath(_notes.RootPath, _currentPath).Replace('\\', '/')
                : _currentPath;

            // ── 出链 / 反向链接（在 finally 之前，_loadingInspector 仍为 true 期间填充以避免二次触发） ──
            RefreshOutlinksAndBacklinks(_currentPath, EditorBox.Text ?? "");
        }
        finally
        {
            _loadingInspector = false;
        }
    }

    /// <summary>异步（Task.Run）扫描出链与反向链接，结果回到 UI 线程更新 Inspector 列表。</summary>
    private void RefreshOutlinksAndBacklinks(string notePath, string markdown)
    {
        // 出链：同步从当前正文提取，量小可直接在 UI 线程做
        var outlinks = NoteService.ExtractWikiLinkTargets(markdown);
        if (OutlinksPanel != null)
        {
            OutlinksPanel.ItemsSource = outlinks.Count > 0 ? outlinks : null;
            if (OutlinksEmptyText != null)
                OutlinksEmptyText.Visibility = outlinks.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        }

        // 反向链接：需要扫描全库文件，放到后台线程避免 UI 卡顿
        if (_notes == null || BacklinksPanel == null) return;
        var notes = _notes;
        var path = notePath;
        _ = Task.Run(() =>
        {
            try
            {
                var backlinks = notes.GetBacklinksForNote(path);
                Dispatcher.BeginInvoke(() =>
                {
                    if (!string.Equals(_currentPath, path, StringComparison.OrdinalIgnoreCase)) return;
                    BacklinksPanel.ItemsSource = backlinks.Count > 0 ? backlinks : null;
                    if (BacklinksEmptyText != null)
                        BacklinksEmptyText.Visibility = backlinks.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
                }, DispatcherPriority.Background);
            }
            catch
            {
                // 扫描失败时静默忽略
            }
        });
    }

    private void OutlinkItem_Click(object sender, RoutedEventArgs e)
    {
        if (sender is not Button btn) return;
        var target = btn.Tag as string;
        if (!string.IsNullOrWhiteSpace(target))
            NavigateToWikiLink(target);
    }

    private void BacklinkItem_Click(object sender, RoutedEventArgs e)
    {
        if (sender is not Button btn) return;
        var fullPath = btn.Tag as string;
        if (string.IsNullOrWhiteSpace(fullPath)) return;
        if (!RequestLoadNoteInEditorByPath(fullPath)) return;
        if (!TrySelectPathByExpanding(fullPath))
            TrySelectPath(fullPath);
    }

    private string GetCurrentNoteKindDisplay()
    {
        if (NotesTree.SelectedItem is not NoteTreeNode node || node.IsFolder)
            return "📄 Markdown 笔记";

        return node.Kind switch
        {
            NoteKind.Screenshot => "📷 截图笔记",
            NoteKind.AiConversation => "✨ AI 对话",
            NoteKind.AiGenerated => "★ AI 生成",
            NoteKind.Template => "T 模板",
            NoteKind.Daily => "📅 日记",
            NoteKind.Sticky => "◇ 便签",
            NoteKind.Quick => "⚡ 快速笔录",
            _ => "📄 Markdown 笔记"
        };
    }

    private static string ComputeInspectorWordsText(string text)
    {
        if (string.IsNullOrWhiteSpace(text))
            return "0 字 / 0 词";
        var chars = text.Count(c => !char.IsWhiteSpace(c));
        var words = Regex.Matches(text, @"[\w]+").Count;
        return $"{chars} 字 / {words} 词";
    }

    private void InspectorMeta_OnTextChanged(object sender, TextChangedEventArgs e)
    {
        if (_loadingInspector) return;
        if (_currentPath == null) return;
        _inspectorDebounce.Stop();
        _inspectorDebounce.Start();
    }

    /// <summary>把 Inspector 三个字段写回当前笔记的 frontmatter 块（用 EditorBox 文本流转触发 dirty/auto-save/preview）。</summary>
    private void ApplyInspectorChangesToEditor()
    {
        if (_loadingInspector || _currentPath == null) return;

        var current = EditorBox.Text ?? "";
        var fm = NoteFrontmatter.Parse(current, out var body);

        var newSummary = InspectorSynopsisBox.Text ?? "";
        var newNotes = InspectorNotesBox.Text ?? "";
        var newTags = (InspectorTagsBox.Text ?? "")
            .Split(',', StringSplitOptions.RemoveEmptyEntries)
            .Select(t => t.Trim())
            .Where(t => !string.IsNullOrWhiteSpace(t))
            .ToList();

        // 没有任何变化时跳过，避免无意义的 dirty
        if (fm.Summary == newSummary &&
            fm.Notes == newNotes &&
            fm.Tags.SequenceEqual(newTags))
            return;

        fm.Summary = newSummary;
        fm.Notes = newNotes;
        fm.Tags = newTags;

        var newText = fm.SerializeWithBody(body);
        if (newText == current) return;

        // 直接赋值会触发 EditorBox_OnTextChanged，由它把 dirty/preview/auto-save 串起来
        var caret = EditorBox.CaretIndex;
        EditorBox.Text = newText;
        EditorBox.CaretIndex = Math.Min(caret, EditorBox.Text.Length);

        // 只刷新 chips 区域，不重建文本框（避免抢焦点）
        InspectorTagsChips.ItemsSource = newTags.ToList();
    }
}
