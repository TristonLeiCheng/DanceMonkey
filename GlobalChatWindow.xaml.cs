using System.Collections.ObjectModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Text;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;
using DanceMonkey.Agent.Core.Models;
using DanceMonkey.Agent.Core.Runtime;
using DesktopAssistant.Models;
using DesktopAssistant.Services;
using Forms = System.Windows.Forms;
using Microsoft.Web.WebView2.Core;

namespace DesktopAssistant;

public partial class GlobalChatWindow : Window
{
    /// <summary>紧凑高度：须容纳标题栏 + 模式切换 +（翻译/文件）选项行 + Composer + 底部快捷键提示；
    /// 224 在「文件/翻译」模式下会把输入区裁切，故提高到约一行路径 + 输入卡的安全值。</summary>
    private const double CompactWindowHeight = 312;

    private const double ExpandedWindowHeight = 520;

    /// <summary>紧凑模式下窗口最小高度，避免用户拖得过矮导致输入框被裁切。</summary>
    private const double CompactMinWindowHeight = 280;
    private enum GlobalMode
    {
        AiChat,
        Translate,
        FileSearch
    }

    private GlobalMode _mode = GlobalMode.AiChat;
    private bool _isBusy;
    private bool _webInited;
    private bool _navigationScrollHooked;
    private bool _fileSearchExecuted;
    private string? _screenshotAnalysisContext;

    private bool _agentModeEnabled;
    private AgentMode _agentPermissionMode = AgentMode.Ask;
    private AgentSession? _agentSession;
    private bool _gcAgentPermComboProgrammatic;
    private CancellationTokenSource? _streamCts;

    /// <summary>「继续对话」时关联的截图文件（通常在「图片\Screenshots」），存笔记时复制到笔记库 Inbox/Screenshots。</summary>
    private string? _associatedScreenshotPath;

    private readonly List<ChatTurn> _turns = new();
    private readonly ObservableCollection<FileSearchRowVm> _fileHits = new();

    private sealed record ChatTurn(ChatTurnKind Kind, string Text);

    private enum ChatTurnKind
    {
        Context,
        User,
        Assistant,
        Tool,
        Error
    }

    private sealed class FileSearchRowVm
    {
        public required string Name { get; init; }
        public required string FullPath { get; init; }
        public required string FolderDisplay { get; init; }
        public required string CreatedDisplay { get; init; }
        public required string SizeDisplay { get; init; }
        public required string ModifiedDisplay { get; init; }
    }

    public GlobalChatWindow()
    {
        InitializeComponent();
        FileSearchList.ItemsSource = _fileHits;

        StateChanged += (_, _) =>
        {
            if (WindowState == WindowState.Maximized)
                ChromeRoot.Margin = new Thickness(0);
            else
                ChromeRoot.Margin = new Thickness(10);
            UpdateMaximizeButtonUi();
        };

        PreviewKeyDown += (_, e) =>
        {
            if (e.Key == Key.Escape)
            {
                HideWindow();
                e.Handled = true;
                return;
            }

            if (e.Key == Key.S && Keyboard.Modifiers == ModifierKeys.Control)
            {
                e.Handled = true;
                if (_mode == GlobalMode.AiChat)
                    SaveTranscriptToNote();
                return;
            }

            // Tab / Shift+Tab：在三种模式间循环切换（焦点在输入框时也生效）
            if (e.Key == Key.Tab && (Keyboard.Modifiers == ModifierKeys.None || Keyboard.Modifiers == ModifierKeys.Shift))
            {
                CycleMode(reverse: Keyboard.Modifiers == ModifierKeys.Shift);
                e.Handled = true;
                return;
            }

            // Ctrl+1/2/3：直达模式
            if (Keyboard.Modifiers == ModifierKeys.Control)
            {
                if (e.Key == Key.D1 || e.Key == Key.NumPad1) { SetMode(GlobalMode.AiChat); e.Handled = true; return; }
                if (e.Key == Key.D2 || e.Key == Key.NumPad2) { SetMode(GlobalMode.Translate); e.Handled = true; return; }
                if (e.Key == Key.D3 || e.Key == Key.NumPad3) { SetMode(GlobalMode.FileSearch); e.Handled = true; return; }
            }
        };

        Loaded += async (_, _) =>
        {
            try
            {
                var profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                if (!string.IsNullOrEmpty(profile))
                    FileSearchFolderBox.Text = profile;

                ApplyModeUi();
                ApplyGcAgentModeUi();
                // 首次出现时无动画地放到活动按钮上，避免从 X=0 滑过来的"假动画"
                MoveIndicatorToActive(animate: false);
                if (_mode == GlobalMode.AiChat)
                    await RefreshChatViewAsync().ConfigureAwait(true);
            }
            catch
            {
                // WebView2 未就绪时忽略
            }
        };

        UpdateMaximizeButtonUi();
    }

    private void ApplyModeUi()
    {
        var ai = _mode == GlobalMode.AiChat;
        var tr = _mode == GlobalMode.Translate;
        var fs = _mode == GlobalMode.FileSearch;

        var activeStyle = (Style)FindResource("GcSegBtnActive");
        var inactiveStyle = (Style)FindResource("GcSegBtnInactive");
        if (ModeAiBtn != null)
            ModeAiBtn.Style = ai ? activeStyle : inactiveStyle;
        if (ModeTranslateBtn != null)
            ModeTranslateBtn.Style = tr ? activeStyle : inactiveStyle;
        if (ModeFileBtn != null)
            ModeFileBtn.Style = fs ? activeStyle : inactiveStyle;

        if (TranslateLangPanel != null)
            TranslateLangPanel.Visibility = tr ? Visibility.Visible : Visibility.Collapsed;
        if (FileSearchPanel != null)
            FileSearchPanel.Visibility = fs ? Visibility.Visible : Visibility.Collapsed;
        if (AiAgentPanel != null)
            AiAgentPanel.Visibility = ai ? Visibility.Visible : Visibility.Collapsed;

        if (ChatWeb != null)
            ChatWeb.Visibility = ai ? Visibility.Visible : Visibility.Collapsed;
        if (TranslateResultPanel != null)
            TranslateResultPanel.Visibility = tr ? Visibility.Visible : Visibility.Collapsed;
        if (FileResultPanel != null)
            FileResultPanel.Visibility = fs ? Visibility.Visible : Visibility.Collapsed;

        if (SaveNoteBtn != null)
            SaveNoteBtn.Visibility = ai && _turns.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
        if (ClearBtn != null)
            ClearBtn.Visibility = ai && _turns.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
        if (ContinueMainAgentBtn != null)
        {
            ContinueMainAgentBtn.Visibility = ai && _turns.Any(t => t.Kind is ChatTurnKind.User or ChatTurnKind.Assistant)
                ? Visibility.Visible
                : Visibility.Collapsed;
        }

        if (ModeLabel == null || ComposerLeadIcon == null || InputPlaceholder == null)
            return;

        // 同步标题栏 Mode 标签 / Composer 引导图标 / Placeholder / 底部主键提示
        ModeLabel.Text = ai ? "AI 对话" : tr ? "翻译" : "文件搜索";
        ComposerLeadIcon.Text = ai ? "✦" : tr ? "🌐" : "🔍";
        ComposerLeadIcon.Foreground = ai
            ? (System.Windows.Media.Brush)new System.Windows.Media.BrushConverter().ConvertFromString("#5C7DFF")!
            : (System.Windows.Media.Brush)new System.Windows.Media.BrushConverter().ConvertFromString("#6B7084")!;
        InputPlaceholder.Text = ai
            ? "问任何问题，Enter 发送…"
            : tr
                ? "输入要翻译的原文…"
                : "输入文件名关键字（可留空列出目录内文件）";
        HintPrimary.Text = ai ? "发送" : tr ? "翻译" : "搜索";
        Title = ai ? "DanceMonkey · AI 对话" : tr ? "DanceMonkey · 翻译" : "DanceMonkey · 文件搜索";

        ResultHost.MinHeight = fs ? 300 : 220;
        UpdateInputPlaceholder();
        UpdateResultAreaVisibility();

        // 滑动指示器跟随当前活动按钮
        MoveIndicatorToActive(animate: true);

        InputBox.ToolTip = ai
            ? "输入问题，Enter 发送"
            : tr
                ? "输入要翻译的原文"
                : "输入文件名关键字（可留空列出目录内文件）";

        Dispatcher.BeginInvoke(new Action(() =>
        {
            InputBox.Focus();
            if (ai)
                InputBox.SelectAll();
        }), System.Windows.Threading.DispatcherPriority.Background);
    }

    private void UpdateInputPlaceholder()
    {
        InputPlaceholder.Visibility = string.IsNullOrEmpty(InputBox.Text)
            ? Visibility.Visible
            : Visibility.Collapsed;
    }

    private void InputBox_OnTextChanged(object sender, TextChangedEventArgs e)
    {
        UpdateInputPlaceholder();
    }

    private void CycleMode(bool reverse)
    {
        var modes = new[] { GlobalMode.AiChat, GlobalMode.Translate, GlobalMode.FileSearch };
        var idx = Array.IndexOf(modes, _mode);
        if (idx < 0) idx = 0;
        idx = reverse ? (idx - 1 + modes.Length) % modes.Length : (idx + 1) % modes.Length;
        SetMode(modes[idx]);
    }

    // ──────────────────────────────────────────────────────────
    // Segmented 滑动指示器
    // ──────────────────────────────────────────────────────────

    private void SegmentBar_OnSizeChanged(object sender, SizeChangedEventArgs e)
    {
        // 容器尺寸变化（如窗口显示后首次 layout、字体加载完毕）后重定位，无动画
        MoveIndicatorToActive(animate: false);
    }

    private void MoveIndicatorToActive(bool animate = true)
    {
        // 必须在 layout 完成后再读 ActualWidth；用 Background 优先级让本帧先完成布局
        Dispatcher.BeginInvoke(new Action(() =>
        {
            if (SegmentIndicator == null || SegmentBtnsHost == null)
                return;

            FrameworkElement activeBtn = _mode switch
            {
                GlobalMode.AiChat => ModeAiBtn,
                GlobalMode.Translate => ModeTranslateBtn,
                GlobalMode.FileSearch => ModeFileBtn,
                _ => ModeAiBtn
            };

            if (activeBtn.ActualWidth <= 0 || activeBtn.ActualHeight <= 0)
                return;

            // 目标坐标：相对于 SegmentBtnsHost（与 SegmentIndicator 在同一 Grid 单元，原点一致）
            System.Windows.Point p;
            try
            {
                p = activeBtn.TranslatePoint(new System.Windows.Point(0, 0), SegmentBtnsHost);
            }
            catch
            {
                return;
            }
            var targetX = p.X;
            var targetWidth = activeBtn.ActualWidth;

            // 首次出现时淡入
            if (SegmentIndicator.Opacity < 1)
            {
                SegmentIndicator.BeginAnimation(OpacityProperty, new DoubleAnimation
                {
                    To = 1,
                    Duration = TimeSpan.FromMilliseconds(180)
                });
            }

            if (!animate)
            {
                SegmentIndicator.BeginAnimation(WidthProperty, null);
                SegmentIndicatorTranslate.BeginAnimation(TranslateTransform.XProperty, null);
                SegmentIndicator.Width = targetWidth;
                SegmentIndicatorTranslate.X = targetX;
                return;
            }

            var ease = new CubicEase { EasingMode = EasingMode.EaseOut };
            var dur = TimeSpan.FromMilliseconds(220);
            SegmentIndicator.BeginAnimation(WidthProperty, new DoubleAnimation
            {
                To = targetWidth,
                Duration = dur,
                EasingFunction = ease
            });
            SegmentIndicatorTranslate.BeginAnimation(TranslateTransform.XProperty, new DoubleAnimation
            {
                To = targetX,
                Duration = dur,
                EasingFunction = ease
            });
        }), System.Windows.Threading.DispatcherPriority.Background);
    }

    private void UpdateResultAreaVisibility()
    {
        var show = _mode switch
        {
            // 仅在出现 AI 真正回复（或错误）后展示下方内容区，避免输入后出现残影卡片。
            GlobalMode.AiChat => _turns.Any(t => t.Kind is ChatTurnKind.Assistant or ChatTurnKind.Error),
            GlobalMode.Translate => !string.IsNullOrWhiteSpace(TranslateResultText.Text),
            GlobalMode.FileSearch => _fileSearchExecuted || _fileHits.Count > 0,
            _ => false
        };

        ResultHost.Visibility = show ? Visibility.Visible : Visibility.Collapsed;
        ResultRow.Height = show ? new GridLength(1, GridUnitType.Star) : new GridLength(0);
        EnsureWindowHeightForResult(show);
    }

    private void EnsureWindowHeightForResult(bool show)
    {
        if (WindowState != WindowState.Normal)
            return;

        MinHeight = show ? (_mode == GlobalMode.FileSearch ? 380 : 360) : CompactMinWindowHeight;
        var target = show
            ? (_mode == GlobalMode.FileSearch ? 560 : ExpandedWindowHeight)
            : CompactWindowHeight;
        if (show)
        {
            if (Height < target)
                AnimateHeight(target);
        }
        else
        {
            AnimateHeight(target);
        }
    }

    private void AnimateHeight(double target)
    {
        var current = Height;
        if (Math.Abs(current - target) < 2)
        {
            Height = target;
            return;
        }

        var anim = new DoubleAnimation
        {
            From = current,
            To = target,
            Duration = TimeSpan.FromMilliseconds(200),
            EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut }
        };
        BeginAnimation(HeightProperty, anim);
    }

    private void ShowLoadingIndicator(bool show)
    {
        if (show)
        {
            LoadingIndicator.Visibility = Visibility.Visible;
            if (LoadingIndicator.Resources["DotPulse"] is Storyboard sb)
                sb.Begin(LoadingIndicator, true);
        }
        else
        {
            if (LoadingIndicator.Resources["DotPulse"] is Storyboard sb)
                sb.Stop(LoadingIndicator);
            LoadingIndicator.Visibility = Visibility.Collapsed;
        }
    }

    private void SetMode(GlobalMode mode)
    {
        _mode = mode;
        ApplyModeUi();
        if (mode == GlobalMode.AiChat)
            _ = RefreshChatViewAsync();
    }

    private void ModeAiBtn_OnClick(object sender, RoutedEventArgs e) => SetMode(GlobalMode.AiChat);

    private void ModeTranslateBtn_OnClick(object sender, RoutedEventArgs e) => SetMode(GlobalMode.Translate);

    private void ModeFileBtn_OnClick(object sender, RoutedEventArgs e) => SetMode(GlobalMode.FileSearch);

    private void UpdateMaximizeButtonUi()
    {
        MaximizeBtn.Content = WindowState == WindowState.Maximized ? "❐" : "□";
        MaximizeBtn.ToolTip = WindowState == WindowState.Maximized ? "还原" : "最大化";
    }

    public void ShowAndFocus()
    {
        SetMode(GlobalMode.AiChat);
        Show();
        Activate();
        FadeIn();
        InputBox.Focus();
        InputBox.SelectAll();
    }

    /// <summary>打开全局对话并自动发送一个问题。</summary>
    public void OpenWithQuestion(string question)
    {
        if (string.IsNullOrWhiteSpace(question)) { ShowAndFocus(); return; }

        SetMode(GlobalMode.AiChat);
        Show();
        Activate();
        FadeIn();
        InputBox.Text = question;
        InputBox.Focus();
        InputBox.CaretIndex = question.Length;

        // 自动发送
        Dispatcher.BeginInvoke(new Action(() => _ = SendAiAsync()),
            System.Windows.Threading.DispatcherPriority.Background);
    }

    public void HideWindow()
    {
        Hide();
    }

    /// <summary>从进程诊断页发送诊断报告到 AI 聊天。</summary>
    public void ShowAndSendDiagnostic(string diagnosticPrompt)
    {
        OpenWithQuestion(diagnosticPrompt);
    }

    private void Window_OnDragOver(object sender, DragEventArgs e)
    {
        e.Effects = e.Data.GetDataPresent(DataFormats.FileDrop) ? DragDropEffects.Link : DragDropEffects.None;
        e.Handled = true;
    }

    private void Window_OnDrop(object sender, DragEventArgs e)
    {
        if (!e.Data.GetDataPresent(DataFormats.FileDrop)) return;

        var files = (string[])e.Data.GetData(DataFormats.FileDrop)!;
        var exe = files.FirstOrDefault(f =>
            f.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ||
            f.EndsWith(".lnk", StringComparison.OrdinalIgnoreCase));

        if (exe == null) return;

        // 切换到主窗口的进程诊断页
        if (Application.Current.MainWindow is MainWindow mainWin)
        {
            mainWin.ShowAndSwitch(AppPage.ProcessDiagnostics);
            mainWin.StartProcessDiagFromExe(exe);
        }
    }

    private void FadeIn()
    {
        Opacity = 0;
        var anim = new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(160))
        {
            EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut }
        };
        BeginAnimation(OpacityProperty, anim);
    }

    public void OpenWithScreenshotFollowUp(string analysisMarkdown, string? screenshotImagePath = null)
    {
        _screenshotAnalysisContext = string.IsNullOrWhiteSpace(analysisMarkdown) ? null : analysisMarkdown.Trim();
        _associatedScreenshotPath = null;
        if (!string.IsNullOrWhiteSpace(screenshotImagePath) && File.Exists(screenshotImagePath))
            _associatedScreenshotPath = Path.GetFullPath(screenshotImagePath);

        _turns.Clear();
        if (!string.IsNullOrEmpty(_screenshotAnalysisContext))
            _turns.Add(new ChatTurn(ChatTurnKind.Context, _screenshotAnalysisContext));

        SetMode(GlobalMode.AiChat);
        Show();
        Activate();
        FadeIn();
        InputBox.Text = "";
        InputBox.Focus();
    }

    private void TitleBar_OnMouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        try
        {
            DragMove();
        }
        catch (InvalidOperationException)
        {
            // ignore
        }
    }

    private void CloseBtn_OnClick(object sender, RoutedEventArgs e) => HideWindow();

    private void MaximizeBtn_OnClick(object sender, RoutedEventArgs e)
    {
        WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;
    }

    private void SaveNoteBtn_OnClick(object sender, RoutedEventArgs e) => SaveTranscriptToNote();

    private void SaveTranscriptToNote()
    {
        if (_mode != GlobalMode.AiChat || _turns.Count == 0)
        {
            MessageBox.Show("当前没有可保存的对话内容。", "存笔记", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }

        try
        {
            var cfg = App.Config.Load();
            var notes = new NoteService(cfg.NotesRootPath);
            var md = BuildMarkdownTranscript();
            var path = notes.SaveGlobalChatTranscript(md, _associatedScreenshotPath);
            var tip = string.IsNullOrEmpty(_associatedScreenshotPath)
                ? "已保存到笔记库 Inbox："
                : "已保存截图与对话文本到笔记库 Inbox：";
            MessageBox.Show($"{tip}\n{path}", "存笔记", MessageBoxButton.OK, MessageBoxImage.Information);

            if (Application.Current.MainWindow is MainWindow main)
                main.RefreshNotesAfterExternalSave(path);
        }
        catch (Exception ex)
        {
            MessageBox.Show($"保存失败：{ex.Message}", "存笔记", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private string BuildMarkdownTranscript()
    {
        var sb = new StringBuilder();
        foreach (var t in _turns)
        {
            switch (t.Kind)
            {
                case ChatTurnKind.Context:
                    sb.AppendLine("## 截图分析上下文");
                    sb.AppendLine();
                    sb.AppendLine(t.Text.TrimEnd());
                    sb.AppendLine();
                    break;
                case ChatTurnKind.User:
                    sb.AppendLine("## 你");
                    sb.AppendLine();
                    sb.AppendLine(t.Text.TrimEnd());
                    sb.AppendLine();
                    break;
                case ChatTurnKind.Assistant:
                    sb.AppendLine("## 助手");
                    sb.AppendLine();
                    sb.AppendLine(t.Text.TrimEnd());
                    sb.AppendLine();
                    break;
                case ChatTurnKind.Error:
                    sb.AppendLine("## 提示");
                    sb.AppendLine();
                    sb.AppendLine(t.Text.TrimEnd());
                    sb.AppendLine();
                    break;
            }
        }

        return sb.ToString();
    }

    private async void ClearBtn_OnClick(object sender, RoutedEventArgs e)
    {
        _turns.Clear();
        _screenshotAnalysisContext = null;
        _associatedScreenshotPath = null;
        _agentSession = null;
        AgentSessionStore.DeleteAutosave(AgentSessionStore.GuiGlobalChatSessionsDirectory);
        InputBox.Text = "";
        InputBox.Focus();
        ApplyModeUi();
        await RefreshChatViewAsync().ConfigureAwait(true);
    }

    private void InputBox_OnKeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter && !_isBusy && Keyboard.Modifiers == ModifierKeys.None)
        {
            e.Handled = true;
            _ = RunPrimaryActionAsync();
        }
    }

    private void PrimaryActionBtn_OnClick(object sender, RoutedEventArgs e)
    {
        if (!_isBusy)
            _ = RunPrimaryActionAsync();
    }

    private async Task RunPrimaryActionAsync()
    {
        switch (_mode)
        {
            case GlobalMode.AiChat:
                await SendAiAsync().ConfigureAwait(true);
                break;
            case GlobalMode.Translate:
                await TranslateAsync().ConfigureAwait(true);
                break;
            case GlobalMode.FileSearch:
                await SearchFilesAsync().ConfigureAwait(true);
                break;
        }
    }

    private async Task SendAiAsync()
    {
        var question = InputBox.Text.Trim();
        if (string.IsNullOrEmpty(question))
            return;

        var cfg = App.Config.Load();
        if (string.IsNullOrWhiteSpace(cfg.ApiKey))
        {
            _turns.Add(new ChatTurn(ChatTurnKind.Error, "请先在设置中配置 API 密钥。"));
            await RefreshChatViewAsync().ConfigureAwait(true);
            ApplyModeUi();
            return;
        }

        if (_agentModeEnabled)
        {
            await SendToAgentCoreAsync(question, cfg).ConfigureAwait(true);
            return;
        }

        _turns.Add(new ChatTurn(ChatTurnKind.User, question));
        InputBox.Text = "";
        ApplyModeUi();
        await RefreshChatViewAsync().ConfigureAwait(true);

        _isBusy = true;
        PrimaryActionBtn.Visibility = Visibility.Collapsed;
        ShowLoadingIndicator(true);
        await ShowTypingBubbleAsync().ConfigureAwait(true);

        try
        {
            var client = new OpenAiApiClient(cfg);

            var systemPrompt = string.IsNullOrWhiteSpace(cfg.GlobalChatSystemPrompt)
                ? "你是一个简洁高效的AI助手。请用简短清晰的语言回答用户的问题，必要时使用 Markdown（标题、列表、加粗）。"
                : cfg.GlobalChatSystemPrompt;

            if (!string.IsNullOrEmpty(_screenshotAnalysisContext))
                systemPrompt +=
                    "\n\n用户此前做过一次「截图 AI 分析」，你的回答必须结合上文中的分析全文与用户追问，不要忽略截图分析中的事实。";

            // 构建多轮对话历史
            var messages = new List<(string Role, string Content)>();
            foreach (var t in _turns)
            {
                switch (t.Kind)
                {
                    case ChatTurnKind.Context:
                        messages.Add(("user", $"[截图分析上下文]\n{t.Text}"));
                        messages.Add(("assistant", "好的，我已了解截图分析内容，请继续提问。"));
                        break;
                    case ChatTurnKind.User:
                        messages.Add(("user", t.Text));
                        break;
                    case ChatTurnKind.Assistant:
                        messages.Add(("assistant", t.Text));
                        break;
                }
            }

            var result = await client.CallWithHistoryAsync(messages, systemPrompt).ConfigureAwait(true);

            if (result.Success && !string.IsNullOrEmpty(result.Result))
                _turns.Add(new ChatTurn(ChatTurnKind.Assistant, result.Result));
            else
                _turns.Add(new ChatTurn(ChatTurnKind.Error, result.Error ?? "未返回内容。"));
        }
        catch (Exception ex)
        {
            _turns.Add(new ChatTurn(ChatTurnKind.Error, ex.Message));
        }
        finally
        {
            _isBusy = false;
            ShowLoadingIndicator(false);
            PrimaryActionBtn.Visibility = Visibility.Visible;
            InputBox.Focus();
        }

        ApplyModeUi();
        await RefreshChatViewAsync().ConfigureAwait(true);
    }

    private void GcAgentModeBtn_OnClick(object sender, RoutedEventArgs e)
    {
        _agentModeEnabled = !_agentModeEnabled;
        ApplyGcAgentModeUi();
        SyncGcAgentPermComboSelection();

        if (_agentModeEnabled && _agentSession == null)
            TryRestoreGcAgentAutosave(showFeedback: false);
    }

    private void ApplyGcAgentModeUi()
    {
        if (GcAgentModeBtnText == null) return;
        GcAgentModeBtnText.Text = _agentModeEnabled ? "Agent: On" : "Agent: Off";
        if (GcAgentPermCombo != null)
            GcAgentPermCombo.Visibility = _agentModeEnabled ? Visibility.Visible : Visibility.Collapsed;
    }

    private void GcAgentPermCombo_OnSelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_gcAgentPermComboProgrammatic) return;
        if (GcAgentPermCombo.SelectedItem is not ComboBoxItem item) return;
        var tag = item.Tag?.ToString() ?? "Ask";
        _agentPermissionMode = tag switch
        {
            "Plan" => AgentMode.Plan,
            "Auto" => AgentMode.Auto,
            _ => AgentMode.Ask,
        };
        if (_agentSession != null)
            _agentSession.Mode = _agentPermissionMode;
    }

    private void SyncGcAgentPermComboSelection()
    {
        if (GcAgentPermCombo == null) return;
        _gcAgentPermComboProgrammatic = true;
        try
        {
            var idx = _agentPermissionMode switch
            {
                AgentMode.Plan => 0,
                AgentMode.Auto => 2,
                _ => 1,
            };
            if (idx >= 0 && idx < GcAgentPermCombo.Items.Count)
                GcAgentPermCombo.SelectedIndex = idx;
        }
        finally
        {
            _gcAgentPermComboProgrammatic = false;
        }
    }

    private void TryRestoreGcAgentAutosave(bool showFeedback)
    {
        if (_agentSession != null) return;

        if (!AgentSessionStore.TryLoadAutosave(AgentSessionStore.GuiGlobalChatSessionsDirectory, out var session) || session == null)
            return;

        _agentSession = session;
        _agentPermissionMode = session.Mode;
        SyncGcAgentPermComboSelection();
    }

    private async Task SendToAgentCoreAsync(string question, AppConfig cfg)
    {
        _turns.Add(new ChatTurn(ChatTurnKind.User, question));
        InputBox.Text = "";
        ApplyModeUi();
        await RefreshChatViewAsync().ConfigureAwait(true);

        _isBusy = true;
        PrimaryActionBtn.Visibility = Visibility.Collapsed;
        ShowLoadingIndicator(true);

        await EnsureWebAsync().ConfigureAwait(true);
        await GuiAgentExecutor.AppendAgentStreamingBubbleAsync(ChatWeb).ConfigureAwait(true);

        _streamCts = new CancellationTokenSource();
        var ct = _streamCts.Token;
        var fullText = new StringBuilder();
        var guiSink = GuiAgentExecutor.CreateSink(Dispatcher, ChatWeb, fullText);

        try
        {
            var turn = await GuiAgentExecutor.RunTurnAsync(
                cfg, _agentSession, _agentPermissionMode, question, guiSink, ct, this,
                AgentSessionStore.GuiGlobalChatSessionsDirectory).ConfigureAwait(true);
            _agentSession = turn.Session;

            foreach (var line in GuiAgentExecutor.FormatToolEventLines(turn.ToolEvents))
                _turns.Add(new ChatTurn(ChatTurnKind.Tool, line));

            if (turn.Success && !string.IsNullOrWhiteSpace(turn.FinalAssistantText))
                _turns.Add(new ChatTurn(ChatTurnKind.Assistant, turn.FinalAssistantText));
            else if (!turn.Success)
            {
                if (!string.IsNullOrWhiteSpace(turn.FinalAssistantText))
                    _turns.Add(new ChatTurn(ChatTurnKind.Assistant, turn.FinalAssistantText));
                _turns.Add(new ChatTurn(ChatTurnKind.Error, turn.Error ?? "Agent 运行失败。"));
            }
        }
        catch (OperationCanceledException)
        {
            foreach (var line in GuiAgentExecutor.FormatToolEventLines(guiSink.ToolEvents))
                _turns.Add(new ChatTurn(ChatTurnKind.Tool, line));

            var partial = fullText.ToString();
            if (!string.IsNullOrEmpty(partial))
                _turns.Add(new ChatTurn(ChatTurnKind.Assistant, partial));
            else
                _turns.Add(new ChatTurn(ChatTurnKind.Error, "已停止生成。"));
        }
        catch (Exception ex)
        {
            _turns.Add(new ChatTurn(ChatTurnKind.Error, ex.Message));
        }
        finally
        {
            _isBusy = false;
            ShowLoadingIndicator(false);
            PrimaryActionBtn.Visibility = Visibility.Visible;
            _streamCts?.Dispose();
            _streamCts = null;
            InputBox.Focus();
        }

        ApplyModeUi();
        await RefreshChatViewAsync().ConfigureAwait(true);
    }

    private void ContinueMainAgentBtn_OnClick(object sender, RoutedEventArgs e)
    {
        var prompt = BuildMainAgentHandoffPrompt();
        AgentHandoff.Request(prompt, enableAgent: true, suggestedMode: _agentModeEnabled ? _agentPermissionMode : AgentMode.Ask);

        if (Application.Current.MainWindow is MainWindow mw)
        {
            mw.SwitchPage(AppPage.AiChat);
            mw.Activate();
            mw.Show();
        }

        HideWindow();
    }

    private string BuildMainAgentHandoffPrompt()
    {
        var sb = new StringBuilder();
        sb.AppendLine("请继续在主窗 Agent 中协助我。以下是全局对话窗口中的上下文：");
        sb.AppendLine();

        foreach (var t in _turns.TakeLast(14))
        {
            var role = t.Kind switch
            {
                ChatTurnKind.User => "用户",
                ChatTurnKind.Assistant => "助手",
                ChatTurnKind.Context => "截图上下文",
                ChatTurnKind.Tool => "工具",
                _ => "系统",
            };
            sb.AppendLine($"**{role}**:");
            sb.AppendLine(t.Text);
            sb.AppendLine();
        }

        sb.AppendLine("请基于以上上下文继续；如需操作笔记或 Zen Task，请使用 search_notes、create_note、list_tasks、add_task 等工具。");
        return sb.ToString().TrimEnd();
    }

    private static string? GetComboTag(ComboBox combo)
    {
        if (combo.SelectedItem is ComboBoxItem item && item.Tag is string s)
            return s;
        return null;
    }

    private static void SelectComboByTag(ComboBox combo, string tag)
    {
        foreach (ComboBoxItem it in combo.Items)
        {
            if (it.Tag is string t && t == tag)
            {
                combo.SelectedItem = it;
                return;
            }
        }
    }

    private static string LangNameZh(string? code) => code switch
    {
        null or "" => "",
        "auto" => "（自动识别后译向目标语）",
        "zh" => "简体中文",
        "en" => "英语",
        "ja" => "日语",
        "de" => "德语",
        "fr" => "法语",
        "es" => "西班牙语",
        "ko" => "韩语",
        _ => code
    };

    private static string BuildTranslateSystemPrompt(string? sourceCode, string targetCode)
    {
        var targetName = LangNameZh(targetCode);
        if (sourceCode == "auto")
        {
            return
                $"你是专业翻译。请将用户给出的文本翻译成「{targetName}」，保持原意、语气和段落结构；专有名词与格式尽量保留。只输出译文，不要任何解释或前缀。";
        }

        var sourceName = LangNameZh(sourceCode);
        return
            $"你是专业翻译。请将用户文本从「{sourceName}」翻译成「{targetName}」，保持段落与列表结构；若原文与目标语已一致，可仅做润色。只输出译文，不要任何解释或前缀。";
    }

    private void SwapLang_OnClick(object sender, RoutedEventArgs e)
    {
        var src = GetComboTag(SourceLangCombo);
        var tgt = GetComboTag(TargetLangCombo);
        if (src is null || tgt is null)
            return;

        if (src == "auto")
        {
            SelectComboByTag(SourceLangCombo, tgt);
            SelectComboByTag(TargetLangCombo, "zh");
            return;
        }

        SelectComboByTag(SourceLangCombo, tgt);
        SelectComboByTag(TargetLangCombo, src);
    }

    private const int TranslateMaxTokens = 8192;

    private async Task TranslateAsync()
    {
        var text = InputBox.Text.Trim();
        if (string.IsNullOrEmpty(text))
            return;

        var cfg = App.Config.Load();
        if (string.IsNullOrWhiteSpace(cfg.ApiKey))
        {
            MessageBox.Show("请先在「设置」中配置 API 密钥。", "提示", MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        var src = GetComboTag(SourceLangCombo) ?? "auto";
        var tgt = GetComboTag(TargetLangCombo) ?? "zh";
        if (src != "auto" && src == tgt)
        {
            MessageBox.Show("源语言与目标语言相同，请调整其中一项。", "提示", MessageBoxButton.OK,
                MessageBoxImage.Information);
            return;
        }

        var systemPrompt = BuildTranslateSystemPrompt(src, tgt);
        _isBusy = true;
        PrimaryActionBtn.Visibility = Visibility.Collapsed;
        ShowLoadingIndicator(true);
        TranslateResultText.Text = "";

        try
        {
            var client = new OpenAiApiClient(cfg);
            var result = await client.CallAsync(
                text,
                systemPrompt,
                maxTokens: TranslateMaxTokens,
                temperature: 0.3).ConfigureAwait(true);

            if (result.Success)
                TranslateResultText.Text = result.Result ?? "";
            else
                MessageBox.Show(result.Error ?? "未知错误", "翻译失败", MessageBoxButton.OK, MessageBoxImage.Error);
        }
        finally
        {
            _isBusy = false;
            ShowLoadingIndicator(false);
            PrimaryActionBtn.Visibility = Visibility.Visible;
            InputBox.Focus();
        }
        UpdateResultAreaVisibility();
    }

    private void CopyTranslateResult_OnClick(object sender, RoutedEventArgs e)
    {
        var t = TranslateResultText.Text;
        if (string.IsNullOrWhiteSpace(t))
        {
            MessageBox.Show("暂无译文可复制。", "提示", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }

        Clipboard.SetText(t);
        MessageBox.Show("已复制到剪贴板。", "成功", MessageBoxButton.OK, MessageBoxImage.Information);
    }

    private void FileSearchPickFolder_OnClick(object sender, RoutedEventArgs e)
    {
        using var dlg = new Forms.FolderBrowserDialog { Description = "选择要搜索的文件夹" };
        if (dlg.ShowDialog() == Forms.DialogResult.OK)
            FileSearchFolderBox.Text = dlg.SelectedPath;
    }

    private async Task SearchFilesAsync()
    {
        if (string.IsNullOrWhiteSpace(FileSearchFolderBox.Text) || !Directory.Exists(FileSearchFolderBox.Text))
        {
            MessageBox.Show("请先选择有效的文件夹。", "提示", MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        var folder = FileSearchFolderBox.Text.Trim();
        var kw = InputBox.Text.Trim();
        var sub = FileSearchSubfoldersCheck.IsChecked == true;
        const int max = 300;

        _isBusy = true;
        _fileSearchExecuted = true;
        PrimaryActionBtn.Visibility = Visibility.Collapsed;
        ShowLoadingIndicator(true);
        _fileHits.Clear();
        FileSearchStatusText.Text = "搜索中…";

        try
        {
            var progress = new Progress<string>(s => Dispatcher.Invoke(() => FileSearchStatusText.Text = s));

            var hits = await Task.Run(() =>
                    FileSearchService.Search(folder, kw, sub, max, progress),
                CancellationToken.None);

            foreach (var h in hits)
            {
                _fileHits.Add(new FileSearchRowVm
                {
                    FullPath = h.FullPath,
                    Name = h.Name,
                    FolderDisplay = Path.GetDirectoryName(h.FullPath) ?? "",
                    CreatedDisplay = h.CreationUtc.ToLocalTime().ToString("MM-dd HH:mm",
                        CultureInfo.CurrentCulture),
                    SizeDisplay = FormatFileSize(h.LengthBytes),
                    ModifiedDisplay = h.LastWriteUtc.ToLocalTime().ToString("MM-dd HH:mm",
                        CultureInfo.CurrentCulture)
                });
            }

            FileSearchStatusText.Text = $"{_fileHits.Count} 条";
            FileSearchEmptyText.Visibility = _fileHits.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        }
        catch (Exception ex)
        {
            MessageBox.Show($"搜索失败：{ex.Message}", "错误", MessageBoxButton.OK, MessageBoxImage.Error);
            FileSearchStatusText.Text = "";
            FileSearchEmptyText.Visibility = Visibility.Visible;
        }
        finally
        {
            _isBusy = false;
            ShowLoadingIndicator(false);
            PrimaryActionBtn.Visibility = Visibility.Visible;
            InputBox.Focus();
        }
        UpdateResultAreaVisibility();
    }

    private static string FormatFileSize(long bytes)
    {
        if (bytes < 1024) return $"{bytes} B";
        if (bytes < 1024 * 1024) return $"{bytes / 1024.0:F1} KB";
        return $"{bytes / (1024.0 * 1024):F1} MB";
    }

    private void FileSearchList_OnMouseDoubleClick(object sender, MouseButtonEventArgs e)
    {
        if (FileSearchList.SelectedItem is not FileSearchRowVm row)
            return;
        OpenFileAt(row.FullPath);
    }

    private void FileSearchList_OnPreviewMouseRightButtonDown(object sender, MouseButtonEventArgs e)
    {
        if (e.OriginalSource is not DependencyObject obj)
            return;
        var item = FindVisualParent<ListViewItem>(obj);
        if (item != null)
            item.IsSelected = true;
    }

    private void OpenFileMenu_OnClick(object sender, RoutedEventArgs e)
    {
        if (FileSearchList.SelectedItem is FileSearchRowVm row)
            OpenFileAt(row.FullPath);
    }

    private void OpenFileFolderMenu_OnClick(object sender, RoutedEventArgs e)
    {
        if (FileSearchList.SelectedItem is not FileSearchRowVm row)
            return;
        var folder = Path.GetDirectoryName(row.FullPath);
        if (string.IsNullOrWhiteSpace(folder) || !Directory.Exists(folder))
            return;
        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = folder,
                UseShellExecute = true
            });
        }
        catch
        {
            // ignore
        }
    }

    private void CopyFilePathMenu_OnClick(object sender, RoutedEventArgs e)
    {
        if (FileSearchList.SelectedItem is not FileSearchRowVm row)
            return;
        try
        {
            Clipboard.SetText(row.FullPath);
        }
        catch
        {
            // ignore
        }
    }

    private static void OpenFileAt(string fullPath)
    {
        if (string.IsNullOrWhiteSpace(fullPath))
            return;
        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = fullPath,
                UseShellExecute = true
            });
        }
        catch
        {
            // ignore
        }
    }

    private static T? FindVisualParent<T>(DependencyObject? child) where T : DependencyObject
    {
        while (child != null)
        {
            if (child is T target)
                return target;
            child = VisualTreeHelper.GetParent(child);
        }

        return null;
    }

    private async Task EnsureWebAsync()
    {
        if (_webInited)
            return;
        await ChatWeb.EnsureCoreWebView2Async(null).ConfigureAwait(true);
        _webInited = true;
        if (!_navigationScrollHooked && ChatWeb.CoreWebView2 != null)
        {
            ChatWeb.CoreWebView2.NavigationCompleted += OnChatNavigationCompleted;
            _navigationScrollHooked = true;
        }
    }

    /// <summary>在 WebView2 聊天区追加一个 CSS 动画「正在思考」气泡。</summary>
    private async Task ShowTypingBubbleAsync()
    {
        await EnsureWebAsync().ConfigureAwait(true);
        var js = """
(function(){
  var d=document.createElement('div');
  d.className='msg assistant';
  d.id='typing-indicator';
  d.innerHTML='<div class="label">助手</div><div class="typing-dots"><span></span><span></span><span></span></div>';
  var style=document.createElement('style');
  style.textContent=`
    .typing-dots{display:flex;align-items:center;gap:5px;padding:4px 0;}
    .typing-dots span{width:6px;height:6px;border-radius:50%;background:#9ca3af;animation:dotBounce 1.2s infinite;}
    .typing-dots span:nth-child(2){animation-delay:0.2s;}
    .typing-dots span:nth-child(3){animation-delay:0.4s;}
    @keyframes dotBounce{0%,80%,100%{opacity:0.3;transform:scale(0.8);}40%{opacity:1;transform:scale(1.2);}}
  `;
  document.head.appendChild(style);
  document.body.appendChild(d);
  window.scrollTo(0,document.documentElement.scrollHeight);
})();
""";
        if (ChatWeb.CoreWebView2 != null)
            await ChatWeb.CoreWebView2.ExecuteScriptAsync(js).ConfigureAwait(true);
    }

    private async Task RefreshChatViewAsync()
    {
        if (_mode != GlobalMode.AiChat)
            return;

        await EnsureWebAsync().ConfigureAwait(true);

        var inner = new StringBuilder();
        if (_turns.Count == 0)
        {
            inner.Append(
                "<p style=\"color:#9ca3af;margin:16px 10px;font-size:13px;\">输入问题后按 Enter 发送。</p>");
        }
        else
        {
            foreach (var t in _turns)
            {
                switch (t.Kind)
                {
                    case ChatTurnKind.Context:
                        inner.Append(
                            "<div class=\"msg context\"><div class=\"label\">截图分析上下文</div><div class=\"md\">");
                        inner.Append(MarkdownHtml.ToHtmlBody(t.Text));
                        inner.Append("</div></div>");
                        break;
                    case ChatTurnKind.User:
                        inner.Append("<div class=\"msg user\"><div class=\"label\">你</div><div>");
                        inner.Append(WebUtility.HtmlEncode(t.Text));
                        inner.Append("</div></div>");
                        break;
                    case ChatTurnKind.Assistant:
                        inner.Append("<div class=\"msg assistant\"><div class=\"label\">助手</div><div class=\"md\">");
                        inner.Append(MarkdownHtml.ToHtmlBody(t.Text));
                        inner.Append("</div></div>");
                        break;
                    case ChatTurnKind.Tool:
                        inner.Append("<div class=\"msg tool\"><div class=\"label\">工具</div><div class=\"tool-line\">");
                        inner.Append(WebUtility.HtmlEncode(t.Text));
                        inner.Append("</div></div>");
                        break;
                    case ChatTurnKind.Error:
                        inner.Append("<div class=\"msg err\"><div class=\"label\">提示</div><div>");
                        inner.Append(WebUtility.HtmlEncode(t.Text));
                        inner.Append("</div></div>");
                        break;
                }
            }
        }

        var html = MarkdownHtml.WrapChatDocument(inner.ToString());
        ChatWeb.NavigateToString(html);
    }

    private async void OnChatNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        try
        {
            if (ChatWeb.CoreWebView2 != null)
                await ChatWeb.CoreWebView2
                    .ExecuteScriptAsync(
                        "window.scrollTo(0, document.documentElement.scrollHeight || document.body.scrollHeight);")
                    .ConfigureAwait(true);
        }
        catch
        {
            // ignore
        }
    }
}
