using System.Diagnostics;
using System.IO;
using System.Net;
using System.Text;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media.Imaging;
using DanceMonkey.Agent.Core.Models;
using DanceMonkey.Agent.Core.Runtime;
using DesktopAssistant.Models;
using DesktopAssistant.Services;
using Microsoft.Web.WebView2.Core;
using Microsoft.Win32;

namespace DesktopAssistant.Views;

public partial class AiChatView : UserControl
{
    private const int MaxImages = 8;
    private const int MaxTextAttachmentChars = 120_000;
    private const long MaxTextFileBytes = 512 * 1024;
    private const int TranslateMaxTokens = 8192;

    private bool _isBusy;
    private bool _isSttBusy;
    private bool _webInited;
    private bool _navigationScrollHooked;
    private CancellationTokenSource? _streamCts;
    private bool _uiReady;

    private bool _agentModeEnabled;
    private AgentMode _agentPermissionMode = AgentMode.Ask;
    private AgentSession? _agentSession;
    private bool _agentPermComboProgrammatic;
    private bool _agentWorkflowProgrammatic;
    private bool _modelSelectorProgrammatic;
    private IntegratedMode _integratedMode = IntegratedMode.Chat;

    private readonly List<ChatTurn> _turns = new();
    private readonly List<PendingImage> _pendingImages = new();
    private readonly List<PendingText> _pendingTexts = new();

    private sealed class PendingImage
    {
        public byte[] Data { get; init; } = Array.Empty<byte>();
        public string Mime { get; init; } = "image/png";
        public string Label { get; init; } = "";
    }

    private sealed class PendingText
    {
        public string Name { get; init; } = "";
        public string Content { get; init; } = "";
    }

    private sealed record ChatTurn(ChatTurnKind Kind, string Text, string? ApiText = null);

    private enum ChatTurnKind
    {
        User,
        Assistant,
        Tool,
        Error
    }

    private enum IntegratedMode
    {
        Chat,
        Translate,
        Email
    }

    public AiChatView()
    {
        InitializeComponent();

        // Placeholder 可见性：输入框为空时显示
        InputBox.TextChanged += (_, _) =>
        {
            InputPlaceholder.Visibility = string.IsNullOrEmpty(InputBox.Text)
                ? Visibility.Visible : Visibility.Collapsed;
        };
        InputBox.GotFocus += (_, _) => { /* 保持现有行为 */ };

        Loaded += async (_, _) =>
        {
            ReloadPromptSnippets();
            ReloadAgentWorkflows();
            ReloadModelSelector();
            ApplyAgentModeUi();
            try
            {
                await RefreshChatViewAsync().ConfigureAwait(true);
            }
            catch
            {
                // WebView2 未就绪时忽略
            }
        };

        _uiReady = true;
    }

    public void ApplyHandoffIfPending()
    {
        if (!AgentHandoff.TryConsume(out var prompt, out var enableAgent, out var suggestedMode))
            return;

        if (enableAgent)
        {
            _agentModeEnabled = true;
            if (suggestedMode.HasValue)
                _agentPermissionMode = suggestedMode.Value;
            ApplyAgentModeUi();
            SyncAgentPermComboSelection();
            if (_agentSession == null)
                TryRestoreAgentAutosave(showFeedback: false);
        }

        InputBox.Text = prompt;
        if (!_isBusy)
            _ = SendAsync();
    }

    public void ShowChatMode()
    {
        SetIntegratedMode(IntegratedMode.Chat);
    }

    public void ShowTranslateMode()
    {
        SetIntegratedMode(IntegratedMode.Translate);
    }

    public void ShowEmailMode()
    {
        SetIntegratedMode(IntegratedMode.Email);
    }

    /// <summary>会议中心一键会后邮件：消费交接内容并预填邮件主题与要点。</summary>
    public void ApplyEmailHandoffIfPending()
    {
        if (!MeetingEmailHandoff.TryConsume(out var subject, out var points))
            return;
        SetIntegratedMode(IntegratedMode.Email);
        EmailSubjectText.Text = subject;
        EmailPointsText.Text = points;
    }

    private void ChatModeChatBtn_OnClick(object sender, RoutedEventArgs e)
    {
        ShowChatMode();
    }

    private void ChatModeTranslateBtn_OnClick(object sender, RoutedEventArgs e)
    {
        ShowTranslateMode();
    }

    private void ChatModeEmailBtn_OnClick(object sender, RoutedEventArgs e)
    {
        ShowEmailMode();
    }

    private void SetIntegratedMode(IntegratedMode mode)
    {
        _integratedMode = mode;
        ApplyIntegratedModeUi();
    }

    private void ApplyIntegratedModeUi()
    {
        if (!_uiReady)
            return;

        var isChat = _integratedMode == IntegratedMode.Chat;
        ChatContentPanel.Visibility = isChat ? Visibility.Visible : Visibility.Collapsed;
        ChatComposerPanel.Visibility = isChat ? Visibility.Visible : Visibility.Collapsed;
        AttachmentChipsHost.Visibility = isChat && (_pendingImages.Count > 0 || _pendingTexts.Count > 0)
            ? Visibility.Visible
            : Visibility.Collapsed;
        TranslateContentPanel.Visibility = _integratedMode == IntegratedMode.Translate ? Visibility.Visible : Visibility.Collapsed;
        EmailContentPanel.Visibility = _integratedMode == IntegratedMode.Email ? Visibility.Visible : Visibility.Collapsed;

        ChatModeChatBtn.Tag = _integratedMode == IntegratedMode.Chat ? "Active" : null;
        ChatModeTranslateBtn.Tag = _integratedMode == IntegratedMode.Translate ? "Active" : null;
        ChatModeEmailBtn.Tag = _integratedMode == IntegratedMode.Email ? "Active" : null;
    }

    private static string? GetComboTag(ComboBox combo)
    {
        return combo.SelectedItem is ComboBoxItem item ? item.Tag?.ToString() : null;
    }

    private static string GetComboContent(ComboBox combo, string fallback)
    {
        return combo.SelectedItem switch
        {
            ComboBoxItem item when item.Content is string text && !string.IsNullOrWhiteSpace(text) => text,
            string text when !string.IsNullOrWhiteSpace(text) => text,
            _ => fallback
        };
    }

    private static void SelectComboByTag(ComboBox combo, string tag)
    {
        foreach (ComboBoxItem item in combo.Items)
        {
            if (string.Equals(item.Tag?.ToString(), tag, StringComparison.OrdinalIgnoreCase))
            {
                combo.SelectedItem = item;
                return;
            }
        }
    }

    private static string LangNameZh(string? code) => code switch
    {
        null or "" => "",
        "auto" => "自动识别后译向目标语",
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

    private void TranslateSwapLangBtn_OnClick(object sender, RoutedEventArgs e)
    {
        var src = GetComboTag(TranslateSourceLangCombo);
        var tgt = GetComboTag(TranslateTargetLangCombo);
        if (src is null || tgt is null)
            return;

        if (src == "auto")
        {
            SelectComboByTag(TranslateSourceLangCombo, tgt);
            SelectComboByTag(TranslateTargetLangCombo, "zh");
            return;
        }

        SelectComboByTag(TranslateSourceLangCombo, tgt);
        SelectComboByTag(TranslateTargetLangCombo, src);
    }

    private void TranslatePasteBtn_OnClick(object sender, RoutedEventArgs e)
    {
        try
        {
            if (Clipboard.ContainsText())
            {
                TranslateSourceText.Text = Clipboard.GetText();
                return;
            }

            MessageBox.Show("剪贴板中没有文本。", "提示", MessageBoxButton.OK, MessageBoxImage.Information);
        }
        catch (Exception ex)
        {
            MessageBox.Show($"读取剪贴板失败：{ex.Message}", "提示", MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }

    private void TranslateClearBtn_OnClick(object sender, RoutedEventArgs e)
    {
        TranslateSourceText.Text = "";
    }

    private async void TranslateRunBtn_OnClick(object sender, RoutedEventArgs e)
    {
        var text = TranslateSourceText.Text.Trim();
        if (string.IsNullOrEmpty(text))
        {
            MessageBox.Show("请输入要翻译的原文。", "提示", MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        var cfg = App.Config.Load();
        if (string.IsNullOrWhiteSpace(cfg.ApiKey))
        {
            MessageBox.Show("请先在「设置」中配置 API 密钥与接口地址。", "提示", MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        var src = GetComboTag(TranslateSourceLangCombo) ?? "auto";
        var tgt = GetComboTag(TranslateTargetLangCombo) ?? "en";
        if (src != "auto" && src == tgt)
        {
            MessageBox.Show("源语言与目标语言相同，请调整其中一项。", "提示", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }

        TranslateRunBtn.IsEnabled = false;
        TranslateRunBtn.Content = "翻译中...";
        TranslateResultText.Text = "";
        try
        {
            var client = new OpenAiApiClient(cfg);
            var result = await client.CallAsync(
                text,
                BuildTranslateSystemPrompt(src, tgt),
                maxTokens: TranslateMaxTokens,
                temperature: 0.3);

            if (result.Success)
                TranslateResultText.Text = result.Result ?? "";
            else
                MessageBox.Show(result.Error ?? "未知错误", "翻译失败", MessageBoxButton.OK, MessageBoxImage.Error);
        }
        finally
        {
            TranslateRunBtn.IsEnabled = true;
            TranslateRunBtn.Content = "翻译";
        }
    }

    private void TranslateCopyResultBtn_OnClick(object sender, RoutedEventArgs e)
    {
        CopyTextOrWarn(TranslateResultText.Text, "暂无译文可复制。");
    }

    private async void EmailGenerateBtn_OnClick(object sender, RoutedEventArgs e)
    {
        var subject = EmailSubjectText.Text.Trim();
        var points = EmailPointsText.Text.Trim();
        if (string.IsNullOrEmpty(subject) || string.IsNullOrEmpty(points))
        {
            MessageBox.Show("请填写邮件主题和关键要点。", "提示", MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        var cfg = App.Config.Load();
        if (string.IsNullOrWhiteSpace(cfg.ApiKey))
        {
            MessageBox.Show("请先在设置中配置 API 密钥。", "提示", MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        EmailGenerateBtn.IsEnabled = false;
        EmailGenerateBtn.Content = "生成中...";
        try
        {
            var emailType = GetComboContent(EmailTypeCombo, "商务邮件");
            var tone = GetComboContent(EmailToneCombo, "专业");
            var systemPrompt =
                $"你是一个专业的邮件撰写助手。请根据用户提供的信息，撰写一封{emailType}，语气要{tone}。邮件应该结构清晰、表达准确、符合商务礼仪。";

            var prompt = $"""
请帮我撰写一封邮件：

邮件主题：{subject}

需要包含的要点：
{points}

请直接输出完整的邮件内容，包括称呼、正文和结尾。
""";

            var client = new OpenAiApiClient(cfg);
            var result = await client.CallAsync(prompt, systemPrompt);
            if (result.Success)
                EmailResultText.Text = result.Result ?? "";
            else
                MessageBox.Show($"生成失败：{result.Error}", "错误", MessageBoxButton.OK, MessageBoxImage.Error);
        }
        finally
        {
            EmailGenerateBtn.IsEnabled = true;
            EmailGenerateBtn.Content = "生成邮件";
        }
    }

    private void EmailCopyBtn_OnClick(object sender, RoutedEventArgs e)
    {
        CopyTextOrWarn(EmailResultText.Text, "没有可复制的邮件内容。");
    }

    private static void CopyTextOrWarn(string text, string emptyMessage)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            MessageBox.Show(emptyMessage, "提示", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }

        Clipboard.SetText(text);
        MessageBox.Show("已复制到剪贴板。", "成功", MessageBoxButton.OK, MessageBoxImage.Information);
    }

    private void AgentModeBtn_OnClick(object sender, RoutedEventArgs e)
    {
        _agentModeEnabled = !_agentModeEnabled;
        ApplyAgentModeUi();
        SyncAgentPermComboSelection();
        UpdateModelChip();

        if (_agentModeEnabled && _agentSession == null)
            TryRestoreAgentAutosave(showFeedback: false);
    }

    private void AgentPermCombo_OnSelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!_uiReady || _agentPermComboProgrammatic)
            return;
        if (AgentPermCombo?.SelectedItem is not ComboBoxItem item)
            return;

        var tag = item.Tag?.ToString() ?? "Ask";
        _agentPermissionMode = tag switch
        {
            "Plan" => AgentMode.Plan,
            "Auto" => AgentMode.Auto,
            _ => AgentMode.Ask,
        };
        if (_agentSession != null)
            _agentSession.Mode = _agentPermissionMode;
        UpdateModelChip();
    }

    private void AgentWorkflowCombo_OnSelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!_uiReady || _agentWorkflowProgrammatic)
            return;
        if (AgentWorkflowCombo?.SelectedItem is not ComboBoxItem item || item.Tag is not string id)
            return;

        var preset = AgentWorkflowPreset.Find(id);
        if (preset == null)
            return;

        if (!_agentModeEnabled)
        {
            _agentModeEnabled = true;
            ApplyAgentModeUi();
            SyncAgentPermComboSelection();
        }

        if (preset.SuggestedMode.HasValue)
        {
            _agentPermissionMode = preset.SuggestedMode.Value;
            SyncAgentPermComboSelection();
        }

        InputBox.Text = preset.Prompt;
        UpdateModelChip();
        if (preset.AutoSend && !_isBusy)
            _ = SendAsync();
    }

    public void ReloadModelSelector()
    {
        if (ModelSelectorCombo == null)
            return;

        var cfg = App.Config.Load();
        cfg.EnsureModelProfiles();

        _modelSelectorProgrammatic = true;
        try
        {
            ModelSelectorCombo.Items.Clear();
            foreach (var profile in cfg.ModelProfiles)
            {
                ModelSelectorCombo.Items.Add(new ComboBoxItem
                {
                    Content = profile.DisplayName,
                    Tag = profile.Model
                });
            }

            var selectedIndex = -1;
            for (var i = 0; i < ModelSelectorCombo.Items.Count; i++)
            {
                if (ModelSelectorCombo.Items[i] is ComboBoxItem item &&
                    string.Equals(item.Tag?.ToString(), cfg.Model, StringComparison.OrdinalIgnoreCase))
                {
                    selectedIndex = i;
                    break;
                }
            }

            if (selectedIndex >= 0)
                ModelSelectorCombo.SelectedIndex = selectedIndex;
            else if (!string.IsNullOrWhiteSpace(cfg.Model))
                ModelSelectorCombo.Items.Add(new ComboBoxItem { Content = cfg.Model.Trim(), Tag = cfg.Model.Trim(), IsSelected = true });
        }
        finally
        {
            _modelSelectorProgrammatic = false;
        }

        UpdateModelChip();
    }

    private void ModelSelectorCombo_OnSelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!_uiReady || _modelSelectorProgrammatic)
            return;
        if (ModelSelectorCombo.SelectedItem is not ComboBoxItem item)
            return;

        var model = item.Tag?.ToString()?.Trim();
        if (string.IsNullOrWhiteSpace(model))
            return;

        var cfg = App.Config.Load();
        cfg.Model = model;
        cfg.EnsureModelProfiles();
        App.Config.Save(cfg);
        UpdateModelChip();
    }

    private void ReloadAgentWorkflows()
    {
        if (AgentWorkflowCombo == null)
            return;

        _agentWorkflowProgrammatic = true;
        try
        {
            AgentWorkflowCombo.Items.Clear();
            AgentWorkflowCombo.Items.Add(new ComboBoxItem { Content = "工作流…", Tag = null });
            foreach (var p in AgentWorkflowPreset.All)
                AgentWorkflowCombo.Items.Add(new ComboBoxItem { Content = p.Title, Tag = p.Id });
            AgentWorkflowCombo.SelectedIndex = 0;
        }
        finally
        {
            _agentWorkflowProgrammatic = false;
        }
    }

    private void ApplyAgentModeUi()
    {
        if (!_uiReady)
            return;
        if (AgentModeBtnText == null)
            return;

        AgentModeBtnText.Text = _agentModeEnabled ? "Agent: On" : "Agent: Off";
        AgentModeBtn.Tag = _agentModeEnabled ? "On" : "Off";
        if (AgentPermCombo != null)
            AgentPermCombo.Visibility = _agentModeEnabled ? Visibility.Visible : Visibility.Collapsed;
        if (AgentWorkflowCombo != null)
            AgentWorkflowCombo.Visibility = _agentModeEnabled ? Visibility.Visible : Visibility.Collapsed;
    }

    private void SyncAgentPermComboSelection()
    {
        if (AgentPermCombo == null)
            return;

        _agentPermComboProgrammatic = true;
        try
        {
            var idx = _agentPermissionMode switch
            {
                AgentMode.Plan => 0,
                AgentMode.Auto => 2,
                _ => 1,
            };
            if (idx >= 0 && idx < AgentPermCombo.Items.Count)
                AgentPermCombo.SelectedIndex = idx;
        }
        finally
        {
            _agentPermComboProgrammatic = false;
        }
    }

    private void TryRestoreAgentAutosave(bool showFeedback)
    {
        if (_agentSession != null)
            return;

        if (!AgentSessionStore.TryLoadAutosave(AgentSessionStore.GuiAiChatSessionsDirectory, out var session) ||
            session == null)
        {
            if (showFeedback)
            {
                MessageBox.Show("未找到可恢复的 Agent 会话。", "Agent", MessageBoxButton.OK,
                    MessageBoxImage.Information);
            }

            return;
        }

        _agentSession = session;
        _agentPermissionMode = session.Mode;
        SyncAgentPermComboSelection();
        AgentAuditLog.Session($"AiChat autosave restored ({session.Messages.Count} msgs)");

        if (showFeedback)
        {
            MessageBox.Show($"已恢复 Agent 会话（{session.Messages.Count} 条消息）。", "Agent",
                MessageBoxButton.OK, MessageBoxImage.Information);
        }
    }

    private void UpdateModelChip()
    {
        if (ModelChipText == null)
            return;

        var cfg = App.Config.Load();
        if (string.IsNullOrWhiteSpace(cfg.ApiKey))
        {
            ModelChipText.Text = "未配置 API";
            return;
        }

        var model = string.IsNullOrWhiteSpace(cfg.Model) ? "gpt-3.5-turbo" : cfg.Model.Trim();
        if (_agentModeEnabled)
        {
            var perm = _agentPermissionMode switch
            {
                AgentMode.Plan => "Plan",
                AgentMode.Auto => "Auto",
                _ => "Ask",
            };
            ModelChipText.Text = $"Agent · {perm} · {model}";
        }
        else
        {
            ModelChipText.Text = model;
        }
    }

    private void PromptChipBtn_OnClick(object sender, RoutedEventArgs e)
    {
        PromptPopup.IsOpen = !PromptPopup.IsOpen;
    }

    private void SaveToNotesBtn_OnClick(object sender, RoutedEventArgs e)
    {
        ExportBtn_OnClick(sender, e);
    }

    private void RestoreAgentSessionMenu_OnClick(object sender, RoutedEventArgs e)
    {
        TryRestoreAgentAutosave(showFeedback: true);
    }

    private void NewAgentSessionMenu_OnClick(object sender, RoutedEventArgs e)
    {
        _agentSession = null;
        AgentSessionStore.DeleteAutosave(AgentSessionStore.GuiAiChatSessionsDirectory);
        AgentAuditLog.Session("AiChat new agent session");
        MessageBox.Show("已新建 Agent 会话（下次发送将重新开始）。", "Agent", MessageBoxButton.OK,
            MessageBoxImage.Information);
    }

    private void OpenAgentAuditLogMenu_OnClick(object sender, RoutedEventArgs e)
    {
        try
        {
            var path = AgentAuditLog.LogPath;
            if (!File.Exists(path))
                File.WriteAllText(path, "", Encoding.UTF8);
            Process.Start(new ProcessStartInfo
            {
                FileName = path,
                UseShellExecute = true,
            });
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, "Agent 审计日志", MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }

    private void SystemPromptBox_OnTextChanged(object sender, TextChangedEventArgs e)
    {
    }

    private void PromptDoneBtn_OnClick(object sender, RoutedEventArgs e)
    {
        PromptPopup.IsOpen = false;
    }

    private void SetRegenerateButtonVisibility(Visibility visibility)
    {
        if (FindName("RegenerateBtn") is Button regenerateButton)
            regenerateButton.Visibility = visibility;
    }

    private void MoreActionsBtn_OnClick(object sender, RoutedEventArgs e)
    {
        MoreActionsMenu.PlacementTarget = MoreActionsBtn;
        MoreActionsMenu.Placement = System.Windows.Controls.Primitives.PlacementMode.Bottom;
        MoreActionsMenu.IsOpen = true;
    }

    private async void RegenerateBtn_OnClick(object sender, RoutedEventArgs e)
    {
        if (_isBusy) return;

        // 移除最后一条 Assistant/Error 回复，保留用户消息，重新发送
        var lastIdx = _turns.FindLastIndex(t => t.Kind == ChatTurnKind.Assistant || t.Kind == ChatTurnKind.Error);
        if (lastIdx < 0) return;
        _turns.RemoveAt(lastIdx);

        // 找到对应的用户消息
        var lastUserIdx = _turns.FindLastIndex(t => t.Kind == ChatTurnKind.User);
        if (lastUserIdx < 0) return;

        var userTurn = _turns[lastUserIdx];
        _turns.RemoveAt(lastUserIdx);

        // 恢复到输入框并重发（不含附件，因为附件已随上次发送清除）
        InputBox.Text = userTurn.Text.Split('\n')[0].Trim(); // 取第一行作为显示文本
        await RefreshChatViewAsync().ConfigureAwait(true);
        await SendAsync().ConfigureAwait(true);
    }

    /// <summary>设置保存后刷新 Prompt 片段下拉。</summary>
    public void ReloadPromptSnippets()
    {
        PromptSnippetCombo.Items.Clear();
        PromptSnippetCombo.Items.Add(new ComboBoxItem
        {
            Content = LocalizationManager.Get("AiChat.SelectSnippet"),
            Tag = (PromptSnippetItem?)null
        });
        foreach (var s in App.Config.Load().PromptSnippets)
        {
            if (string.IsNullOrWhiteSpace(s.Title) && string.IsNullOrWhiteSpace(s.SystemPrompt))
                continue;
            var label = string.IsNullOrWhiteSpace(s.Title)
                ? s.SystemPrompt.Trim()[..Math.Min(24, s.SystemPrompt.Trim().Length)] + "…"
                : s.Title.Trim();
            PromptSnippetCombo.Items.Add(new ComboBoxItem { Content = label, Tag = s });
        }
        PromptSnippetCombo.SelectedIndex = 0;
    }

    private void ApplySnippetBtn_OnClick(object sender, RoutedEventArgs e)
    {
        if (PromptSnippetCombo.SelectedItem is not ComboBoxItem item || item.Tag is not PromptSnippetItem snippet)
        {
            MessageBox.Show(LocalizationManager.Get("AiChat.SelectSnippetHint"),
                LocalizationManager.Get("AiChat.Hint"), MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }
        var text = snippet.SystemPrompt?.Trim() ?? "";
        if (string.IsNullOrEmpty(text))
        {
            MessageBox.Show(LocalizationManager.Get("AiChat.SnippetEmpty"),
                LocalizationManager.Get("AiChat.Hint"), MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }
        SystemPromptBox.Text = text;
    }

    private void InputBox_OnPreviewKeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.V && Keyboard.Modifiers == ModifierKeys.Control)
        {
            if (TryAddClipboardImage())
                e.Handled = true;
            return;
        }

        if (e.Key == Key.Enter && Keyboard.Modifiers == ModifierKeys.None)
        {
            e.Handled = true;
            if (!_isBusy)
                _ = SendAsync();
        }
    }

    private bool TryAddClipboardImage()
    {
        if (!Clipboard.ContainsImage())
            return false;

        var src = Clipboard.GetImage();
        if (src == null)
            return false;

        if (_pendingImages.Count >= MaxImages)
        {
            MessageBox.Show($"最多添加 {MaxImages} 张图片。", "AI 对话", MessageBoxButton.OK, MessageBoxImage.Information);
            return true;
        }

        try
        {
            var enc = new PngBitmapEncoder();
            enc.Frames.Add(BitmapFrame.Create(src));
            using var ms = new MemoryStream();
            enc.Save(ms);
            var png = ms.ToArray();
            var label = $"粘贴图 {_pendingImages.Count + 1}";
            _pendingImages.Add(new PendingImage { Data = png, Mime = "image/png", Label = label });
            RefreshAttachmentUi();
            return true;
        }
        catch
        {
            return false;
        }
    }

    private void RefreshAttachmentUi()
    {
        AttachmentChipsHost.Children.Clear();
        var any = _pendingImages.Count > 0 || _pendingTexts.Count > 0;
        AttachmentChipsHost.Visibility = any && _integratedMode == IntegratedMode.Chat
            ? Visibility.Visible
            : Visibility.Collapsed;
        if (!any)
            return;

        foreach (var img in _pendingImages)
        {
            var captured = img;
            AttachmentChipsHost.Children.Add(MakeChip(captured.Label, () =>
            {
                _pendingImages.Remove(captured);
                RefreshAttachmentUi();
            }));
        }

        foreach (var t in _pendingTexts)
        {
            var captured = t;
            AttachmentChipsHost.Children.Add(MakeChip($"📄 {t.Name}", () =>
            {
                _pendingTexts.Remove(captured);
                RefreshAttachmentUi();
            }));
        }
    }

    private Border MakeChip(string text, Action remove)
    {
        var border = new Border
        {
            Background = (System.Windows.Media.Brush)FindResource("BrushSurfaceMuted"),
            BorderBrush = (System.Windows.Media.Brush)FindResource("BrushBorderSubtle"),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(6),
            Padding = new Thickness(8, 4, 6, 4),
            Margin = new Thickness(0, 0, 8, 6)
        };
        var sp = new StackPanel { Orientation = Orientation.Horizontal };
        sp.Children.Add(new TextBlock
        {
            Text = text,
            FontSize = 12,
            VerticalAlignment = VerticalAlignment.Center,
            MaxWidth = 220,
            TextTrimming = TextTrimming.CharacterEllipsis
        });
        var x = new Button
        {
            Content = "✕",
            Padding = new Thickness(6, 0, 0, 0),
            Margin = new Thickness(4, 0, 0, 0),
            Background = System.Windows.Media.Brushes.Transparent,
            BorderThickness = new Thickness(0),
            Cursor = Cursors.Hand,
            Foreground = (System.Windows.Media.Brush)FindResource("BrushTextMuted"),
            FontSize = 11,
            VerticalAlignment = VerticalAlignment.Center
        };
        x.Click += (_, _) => remove();
        sp.Children.Add(x);
        border.Child = sp;
        return border;
    }

    private async void SendBtn_OnClick(object sender, RoutedEventArgs e)
    {
        if (!_isBusy)
            await SendAsync().ConfigureAwait(true);
    }

    private async void SttBtn_OnClick(object sender, RoutedEventArgs e)
    {
        if (_isBusy || _isSttBusy)
            return;

        var dlg = new OpenFileDialog
        {
            Filter =
                "音频文件|*.wav;*.mp3;*.m4a;*.flac;*.ogg;*.aac;*.wma|所有文件|*.*",
            Multiselect = false,
            Title = "选择要转写的音频"
        };
        if (dlg.ShowDialog() != true)
            return;

        var cfg = App.Config.Load();
        var options = BuildLocalSttOptionsFromConfig(cfg);
        if (!LocalSpeechToTextService.ValidateOptions(options, out var validationError))
        {
            MessageBox.Show(
                $"{validationError}\n\n请先在“设置 → 本地语音转文字（离线）”中配置 whisper.cpp 与模型路径。",
                "语音转文字", MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        _isSttBusy = true;

        try
        {
            var result = await LocalSpeechToTextService.TranscribeFileAsync(dlg.FileName, options).ConfigureAwait(true);
            if (!result.Success)
            {
                MessageBox.Show(result.Error, "语音转文字", MessageBoxButton.OK, MessageBoxImage.Warning);
                return;
            }

            if (!string.IsNullOrWhiteSpace(InputBox.Text))
                InputBox.Text += "\n\n";
            InputBox.Text += result.Text.Trim();
            InputBox.CaretIndex = InputBox.Text.Length;
            InputBox.Focus();

            MessageBox.Show(
                $"转写完成（{result.Elapsed.TotalSeconds:F1}s）。",
                "语音转文字", MessageBoxButton.OK, MessageBoxImage.Information);
        }
        catch (Exception ex)
        {
            MessageBox.Show($"转写失败：{ex.Message}", "语音转文字", MessageBoxButton.OK, MessageBoxImage.Error);
        }
        finally
        {
            _isSttBusy = false;
        }
    }

    private void StopBtn_OnClick(object sender, RoutedEventArgs e)
    {
        _streamCts?.Cancel();
    }

    private async void ClearBtn_OnClick(object sender, RoutedEventArgs e)
    {
        _turns.Clear();
        _pendingImages.Clear();
        _pendingTexts.Clear();
        _agentSession = null;
        AgentSessionStore.DeleteAutosave(AgentSessionStore.GuiAiChatSessionsDirectory);
        RefreshAttachmentUi();
        InputBox.Text = "";
        SetRegenerateButtonVisibility(Visibility.Collapsed);
        await RefreshChatViewAsync().ConfigureAwait(true);
    }

    private void AddFilesBtn_OnClick(object sender, RoutedEventArgs e)
    {
        var dlg = new OpenFileDialog
        {
            Filter =
                "图片|*.png;*.jpg;*.jpeg;*.gif;*.webp|文本|*.txt;*.md;*.csv;*.json;*.log;*.cs;*.xml;*.html;*.htm|所有文件|*.*",
            Multiselect = true
        };

        if (dlg.ShowDialog() != true)
            return;

        foreach (var path in dlg.FileNames)
        {
            if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
                continue;

            var ext = Path.GetExtension(path).ToLowerInvariant();
            var mime = GuessImageMime(ext);
            if (mime.Length > 0)
            {
                if (_pendingImages.Count >= MaxImages)
                {
                    MessageBox.Show($"已达到图片上限（{MaxImages} 张）。", "AI 对话", MessageBoxButton.OK,
                        MessageBoxImage.Information);
                    break;
                }

                try
                {
                    var len = new FileInfo(path).Length;
                    if (len > 15 * 1024 * 1024)
                    {
                        MessageBox.Show($"图片过大，已跳过：{Path.GetFileName(path)}", "AI 对话", MessageBoxButton.OK,
                            MessageBoxImage.Warning);
                        continue;
                    }

                    var bytes = File.ReadAllBytes(path);
                    _pendingImages.Add(new PendingImage
                    {
                        Data = bytes,
                        Mime = mime,
                        Label = Path.GetFileName(path)
                    });
                }
                catch (Exception ex)
                {
                    MessageBox.Show($"无法读取图片：{ex.Message}", "AI 对话", MessageBoxButton.OK, MessageBoxImage.Warning);
                }

                continue;
            }

            if (IsProbablyTextExtension(ext))
            {
                try
                {
                    var len = new FileInfo(path).Length;
                    if (len > MaxTextFileBytes)
                    {
                        MessageBox.Show($"文本文件过大（>{MaxTextFileBytes / 1024} KB），已跳过：{Path.GetFileName(path)}",
                            "AI 对话", MessageBoxButton.OK, MessageBoxImage.Warning);
                        continue;
                    }

                    var raw = File.ReadAllBytes(path);
                    var text = Encoding.UTF8.GetString(raw);
                    if (text.Length > MaxTextAttachmentChars)
                        text = text[..MaxTextAttachmentChars] + "\n…（已截断）";

                    _pendingTexts.Add(new PendingText { Name = Path.GetFileName(path), Content = text });
                }
                catch (Exception ex)
                {
                    MessageBox.Show($"无法读取文本：{ex.Message}", "AI 对话", MessageBoxButton.OK, MessageBoxImage.Warning);
                }
            }
            else if (ext == ".pdf")
            {
                MessageBox.Show("暂不支持直接上传 PDF，请将内容复制为文本或使用截图。", "AI 对话", MessageBoxButton.OK,
                    MessageBoxImage.Information);
            }
            else
            {
                MessageBox.Show($"不支持的文件类型：{ext}", "AI 对话", MessageBoxButton.OK, MessageBoxImage.Information);
            }
        }

        RefreshAttachmentUi();
    }

    private async void SummarizeClipBtn_OnClick(object sender, RoutedEventArgs e)
    {
        string? clip = null;
        try
        {
            if (Clipboard.ContainsText())
                clip = Clipboard.GetText();
        }
        catch { }

        if (string.IsNullOrWhiteSpace(clip))
        {
            MessageBox.Show(LocalizationManager.Get("AiChat.ClipEmpty"),
                LocalizationManager.Get("AiChat.Hint"), MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        InputBox.Text = "请摘要以下内容：\n\n" + clip.Trim();
        if (string.IsNullOrWhiteSpace(SystemPromptBox.Text))
            SystemPromptBox.Text = "你是精炼的中文助理，请将用户给出的长文本整理为要点摘要，使用 Markdown 小标题与列表，保留关键数字与日期。";

        if (!_isBusy)
            await SendAsync().ConfigureAwait(true);
    }

    private void ExportBtn_OnClick(object sender, RoutedEventArgs e)
    {
        if (_turns.Count == 0)
        {
            MessageBox.Show(LocalizationManager.Get("AiChat.NothingToExport"),
                LocalizationManager.Get("AiChat.Hint"), MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }

        var sb = new StringBuilder();
        foreach (var t in _turns)
        {
            switch (t.Kind)
            {
                case ChatTurnKind.User:
                    sb.AppendLine("## 🧑 用户\n");
                    sb.AppendLine(t.Text.Trim());
                    sb.AppendLine();
                    break;
                case ChatTurnKind.Assistant:
                    sb.AppendLine("## 🤖 助手\n");
                    sb.AppendLine(t.Text.Trim());
                    sb.AppendLine();
                    break;
                case ChatTurnKind.Tool:
                    sb.AppendLine("## 🔧 工具\n");
                    sb.AppendLine(t.Text.Trim());
                    sb.AppendLine();
                    break;
                case ChatTurnKind.Error:
                    sb.AppendLine($"> ⚠ {t.Text.Trim()}\n");
                    break;
            }
        }

        try
        {
            var cfg = App.Config.Load();
            var notes = new NoteService(cfg.NotesRootPath);
            var path = notes.SaveGlobalChatTranscript(sb.ToString());
            MessageBox.Show($"{LocalizationManager.Get("AiChat.ExportedTo")}\n{path}",
                LocalizationManager.Get("AiChat.ExportNotes"), MessageBoxButton.OK, MessageBoxImage.Information);
        }
        catch (Exception ex)
        {
            MessageBox.Show($"导出失败：{ex.Message}", "AI 对话", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private static string GuessImageMime(string ext) =>
        ext switch
        {
            ".png" => "image/png",
            ".jpg" or ".jpeg" => "image/jpeg",
            ".gif" => "image/gif",
            ".webp" => "image/webp",
            _ => ""
        };

    private static bool IsProbablyTextExtension(string ext) =>
        ext is ".txt" or ".md" or ".csv" or ".json" or ".log" or ".cs" or ".xml" or ".html" or ".htm" or ".yml"
            or ".yaml" or ".ts" or ".tsx" or ".js" or ".css" or ".ps1" or ".bat" or ".cmd";

    private static SpeechToTextOptions BuildLocalSttOptionsFromConfig(AppConfig cfg)
    {
        return new SpeechToTextOptions
        {
            WhisperExePath = cfg.LocalSttWhisperExePath?.Trim() ?? "",
            ModelPath = cfg.LocalSttModelPath?.Trim() ?? "",
            Language = string.IsNullOrWhiteSpace(cfg.LocalSttLanguage) ? "zh" : cfg.LocalSttLanguage.Trim(),
            Threads = cfg.LocalSttThreads <= 0 ? 4 : cfg.LocalSttThreads,
            AutoPunctuation = cfg.LocalSttAutoPunctuation,
            TimeoutSeconds = cfg.LocalSttTimeoutSeconds < 30 ? 240 : cfg.LocalSttTimeoutSeconds
        };
    }

    private static string BuildFileContextBlock(IReadOnlyList<PendingText> texts)
    {
        if (texts.Count == 0)
            return "";

        var sb = new StringBuilder();
        foreach (var t in texts)
        {
            sb.AppendLine($"【附件: {t.Name}】");
            sb.AppendLine(t.Content.TrimEnd());
            sb.AppendLine();
        }

        return sb.ToString().TrimEnd();
    }

    private string BuildDisplayUserMessage(string question)
    {
        var parts = new List<string>();
        if (!string.IsNullOrWhiteSpace(question))
            parts.Add(question.Trim());
        var imgN = _pendingImages.Count;
        var txN = _pendingTexts.Count;
        if (imgN > 0 || txN > 0)
        {
            var hint = new StringBuilder();
            if (imgN > 0)
                hint.Append($"图片×{imgN}");
            if (txN > 0)
            {
                if (hint.Length > 0)
                    hint.Append("，");
                hint.Append($"文本附件×{txN}");
            }

            parts.Add($"（{hint}）");
        }

        return string.Join("\n", parts.Where(s => s.Length > 0));
    }

    /// <summary>构建多轮 messages 数组（含系统提示词、历史对话、当前用户消息）。</summary>
    private object[] BuildMessagesArray(string systemPrompt, string currentUserText)
    {
        var msgs = new List<object> { new { role = "system", content = systemPrompt } };

        // 追加历史对话（跳过 Error 类型）
        foreach (var t in _turns)
        {
            if (t.Kind == ChatTurnKind.User)
                msgs.Add(new { role = "user", content = t.ApiText ?? t.Text });
            else if (t.Kind == ChatTurnKind.Assistant)
                msgs.Add(new { role = "assistant", content = t.Text });
        }

        return msgs.ToArray();
    }

    private static List<AgentImagePart>? BuildAgentImages(IReadOnlyList<(byte[] Data, string Mime)> images)
    {
        if (images.Count == 0)
            return null;

        return images
            .Select(i => new AgentImagePart { Data = i.Data, MimeType = i.Mime })
            .ToList();
    }

    private async Task SendToAgentCoreAsync(
        string apiUserText,
        IReadOnlyList<(byte[] Data, string Mime)> snapImages,
        AppConfig cfg)
    {
        var displayUser = BuildDisplayUserMessage(InputBox.Text.Trim());
        if (string.IsNullOrWhiteSpace(displayUser))
            displayUser = apiUserText.Trim();

        _turns.Add(new ChatTurn(ChatTurnKind.User, displayUser, apiUserText));
        InputBox.Text = "";
        _pendingImages.Clear();
        _pendingTexts.Clear();
        RefreshAttachmentUi();
        await RefreshChatViewAsync().ConfigureAwait(true);

        _isBusy = true;
        SendBtn.IsEnabled = false;
        SendBtn.Visibility = Visibility.Collapsed;
        StopBtn.Visibility = Visibility.Visible;

        await EnsureWebAsync().ConfigureAwait(true);
        await GuiAgentExecutor.AppendAgentStreamingBubbleAsync(ChatWeb).ConfigureAwait(true);

        _streamCts = new CancellationTokenSource();
        var ct = _streamCts.Token;
        var fullText = new StringBuilder();
        var owner = Window.GetWindow(this);
        var guiSink = GuiAgentExecutor.CreateSink(Dispatcher, ChatWeb, fullText);
        var agentImages = BuildAgentImages(snapImages);

        try
        {
            var turn = await GuiAgentExecutor.RunTurnAsync(
                cfg,
                _agentSession,
                _agentPermissionMode,
                apiUserText,
                guiSink,
                ct,
                owner,
                AgentSessionStore.GuiAiChatSessionsDirectory,
                agentImages).ConfigureAwait(true);
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
            SendBtn.IsEnabled = true;
            SendBtn.Visibility = Visibility.Visible;
            StopBtn.Visibility = Visibility.Collapsed;
            SetRegenerateButtonVisibility(_turns.Any(t => t.Kind == ChatTurnKind.Assistant)
                ? Visibility.Visible
                : Visibility.Collapsed);
            _streamCts?.Dispose();
            _streamCts = null;
            InputBox.Focus();
        }

        await RefreshChatViewAsync().ConfigureAwait(true);
    }

    private async Task SendAsync()
    {
        var question = InputBox.Text.Trim();
        if (string.IsNullOrEmpty(question) && _pendingImages.Count == 0 && _pendingTexts.Count == 0)
            return;

        var cfg = App.Config.Load();
        if (string.IsNullOrWhiteSpace(cfg.ApiKey))
        {
            _turns.Add(new ChatTurn(ChatTurnKind.Error, "请先在设置中配置 API 密钥。"));
            await RefreshChatViewAsync().ConfigureAwait(true);
            return;
        }

        var snapImages = _pendingImages.Select(p => (p.Data, p.Mime)).ToList();
        var snapTexts = _pendingTexts.Select(p => new PendingText { Name = p.Name, Content = p.Content }).ToList();

        var fileBlock = BuildFileContextBlock(snapTexts);
        var apiUserText = string.IsNullOrEmpty(fileBlock)
            ? question
            : fileBlock + "\n\n【用户问题】\n" + question;

        if (string.IsNullOrWhiteSpace(apiUserText) && snapImages.Count == 0)
            return;

        if (_agentModeEnabled)
        {
            await SendToAgentCoreAsync(apiUserText, snapImages, cfg).ConfigureAwait(true);
            return;
        }

        var displayUser = BuildDisplayUserMessage(question);
        _turns.Add(new ChatTurn(ChatTurnKind.User, displayUser, apiUserText));
        InputBox.Text = "";
        _pendingImages.Clear();
        _pendingTexts.Clear();
        RefreshAttachmentUi();
        await RefreshChatViewAsync().ConfigureAwait(true);

        _isBusy = true;
        SendBtn.IsEnabled = false;
        SendBtn.Visibility = Visibility.Collapsed;
        StopBtn.Visibility = Visibility.Visible;

        var systemPrompt = SystemPromptBox.Text.Trim();
        if (string.IsNullOrEmpty(systemPrompt))
        {
            systemPrompt = string.IsNullOrWhiteSpace(cfg.GlobalChatSystemPrompt)
                ? "你是一个简洁高效的 AI 助手。请用清晰的语言回答；需要时使用 Markdown（标题、列表、加粗）。若用户附带图片或文件，请结合这些内容作答。"
                : cfg.GlobalChatSystemPrompt;
        }

        systemPrompt += "\n\n用户可能发送截图或文档片段，请充分利用其中的文字与图像信息。";

        _streamCts = new CancellationTokenSource();
        var ct = _streamCts.Token;

        try
        {
            var client = new OpenAiApiClient(cfg);

            if (snapImages.Count > 0)
            {
                // 有图片时走非流式 multimodal（多数 API 对 vision stream 支持有限）
                var result = await client.CallMultimodalAsync(apiUserText, snapImages, systemPrompt, maxTokens: 4096,
                    cancellationToken: ct).ConfigureAwait(true);

                if (result.Success && !string.IsNullOrEmpty(result.Result))
                    _turns.Add(new ChatTurn(ChatTurnKind.Assistant, result.Result));
                else
                    _turns.Add(new ChatTurn(ChatTurnKind.Error, result.Error ?? "未返回内容。"));
            }
            else
            {
                // 纯文本走流式多轮
                var messages = BuildMessagesArray(systemPrompt, apiUserText);

                // 先添加一个占位助手气泡用于流式追加
                await EnsureWebAsync().ConfigureAwait(true);
                await AppendStreamingBubbleAsync().ConfigureAwait(true);

                var fullText = new StringBuilder();
                var result = await client.CallStreamWithMessagesAsync(
                    messages,
                    maxTokens: 4096,
                    temperature: 0.7,
                    onChunk: chunk =>
                    {
                        fullText.Append(chunk);
                        var htmlBody = MarkdownHtml.ToHtmlBody(fullText.ToString());
                        Dispatcher.InvokeAsync(() => UpdateStreamingBubbleAsync(htmlBody));
                    },
                    cancellationToken: ct).ConfigureAwait(true);

                if (result.Success && !string.IsNullOrEmpty(result.Result))
                    _turns.Add(new ChatTurn(ChatTurnKind.Assistant, result.Result));
                else if (ct.IsCancellationRequested)
                {
                    // 用户取消，但保留已生成的文本
                    var partial = fullText.ToString();
                    if (!string.IsNullOrEmpty(partial))
                        _turns.Add(new ChatTurn(ChatTurnKind.Assistant, partial));
                    else
                        _turns.Add(new ChatTurn(ChatTurnKind.Error, "已停止生成。"));
                }
                else
                    _turns.Add(new ChatTurn(ChatTurnKind.Error, result.Error ?? "未返回内容。"));
            }
        }
        catch (OperationCanceledException)
        {
            // 已在上面处理
        }
        catch (Exception ex)
        {
            _turns.Add(new ChatTurn(ChatTurnKind.Error, ex.Message));
        }
        finally
        {
            _isBusy = false;
            SendBtn.IsEnabled = true;
            SendBtn.Visibility = Visibility.Visible;
            StopBtn.Visibility = Visibility.Collapsed;
            // 有 AI 回复后显示"重新生成"按钮
            SetRegenerateButtonVisibility(_turns.Any(t => t.Kind == ChatTurnKind.Assistant)
                ? Visibility.Visible
                : Visibility.Collapsed);
            _streamCts?.Dispose();
            _streamCts = null;
            InputBox.Focus();
        }

        // 图片模式（非流式）需要整页刷新；流式模式 streaming bubble 已在页面中，只需追加最终高亮
        if (snapImages.Count > 0)
        {
            await RefreshChatViewAsync().ConfigureAwait(true);
        }
        else
        {
            // 流式完成：用 JS 替换 streaming-bubble 为带高亮的最终内容，避免 NavigateToString 闪白
            var lastAssistant = _turns.LastOrDefault(t => t.Kind == ChatTurnKind.Assistant);
            var lastError = _turns.LastOrDefault(t => t.Kind == ChatTurnKind.Error);
            if (lastAssistant != null)
            {
                var finalHtml = MarkdownHtml.ToHtmlBody(lastAssistant.Text);
                var jsonFinal = System.Text.Json.JsonSerializer.Serialize(finalHtml);
                                const string JsTemplate = """
(function(){
    var el=document.getElementById('streaming-bubble');
    if(el){el.id='';el.innerHTML=__FINAL_HTML__;}
    var parent=el?el.closest('.msg.assistant'):null;
    if(parent){
        var h=parent.querySelector('.msg-header');
        if(h){
            var btn=document.createElement('button');
            btn.className='copy-btn';
            btn.textContent='复制';
            btn.onclick=function(){
                var md=parent.querySelector('.md');
                navigator.clipboard.writeText(md?md.innerText:parent.innerText).then(function(){
                    btn.textContent='已复制';
                    btn.classList.add('copied');
                    setTimeout(function(){
                        btn.textContent='复制';
                        btn.classList.remove('copied');
                    },2000);
                });
            };
            h.appendChild(btn);
        }
    }
    if(typeof hljs!=='undefined') hljs.highlightAll();
    document.querySelectorAll('pre:not(:has(.pre-copy-btn))').forEach(function(pre){
        var b=document.createElement('button');
        b.className='pre-copy-btn';
        b.textContent='复制';
        b.onclick=function(){
            var c=pre.querySelector('code');
            navigator.clipboard.writeText(c?c.innerText:pre.innerText).then(function(){
                b.textContent='已复制';
                b.classList.add('copied');
                setTimeout(function(){
                    b.textContent='复制';
                    b.classList.remove('copied');
                },2000);
            });
        };
        pre.appendChild(b);
    });
    window.scrollTo(0,document.documentElement.scrollHeight);
})();
""";
                                var js = JsTemplate.Replace("__FINAL_HTML__", jsonFinal, StringComparison.Ordinal);
                if (ChatWeb.CoreWebView2 != null)
                    await ChatWeb.CoreWebView2.ExecuteScriptAsync(js).ConfigureAwait(true);
            }
            else if (lastError != null)
            {
                // 错误信息：整页刷新（非流式错误情况不常见）
                await RefreshChatViewAsync().ConfigureAwait(true);
            }
        }
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

    /// <summary>在 WebView2 中追加一个空的助手流式气泡。</summary>
    private async Task AppendStreamingBubbleAsync()
    {
        var js = """
(function(){
  var d=document.createElement('div');
  d.className='msg assistant';
  d.innerHTML='<div class="msg-header"><span class="label">助手</span></div><div class="md" id="streaming-bubble">⏳</div>';
  document.body.appendChild(d);
  window.scrollTo(0,document.documentElement.scrollHeight);
})();
""";
        if (ChatWeb.CoreWebView2 != null)
            await ChatWeb.CoreWebView2.ExecuteScriptAsync(js).ConfigureAwait(true);
    }

    /// <summary>更新流式气泡内容（增量 Markdown→HTML）。使用 JSON 序列化保证 JS 注入安全。</summary>
    private async Task UpdateStreamingBubbleAsync(string htmlBody)
    {
        var jsonStr = System.Text.Json.JsonSerializer.Serialize(htmlBody);
        var js = $"var el=document.getElementById('streaming-bubble');if(el){{el.innerHTML={jsonStr};window.scrollTo(0,document.documentElement.scrollHeight);}}";
        if (ChatWeb.CoreWebView2 != null)
            await ChatWeb.CoreWebView2.ExecuteScriptAsync(js).ConfigureAwait(true);
    }

    private async Task RefreshChatViewAsync()
    {
        await EnsureWebAsync().ConfigureAwait(true);

        var inner = new StringBuilder();
        if (_turns.Count == 0)
        {
            inner.Append("<div class=\"empty-shell\"><section class=\"hero\">");
            inner.Append("<p class=\"hero-kicker\">Where should we start?</p>");
            inner.Append("<p class=\"hero-sub\">");
            inner.Append(WebUtility.HtmlEncode(LocalizationManager.Get("AiChat.EmptyHint")));
            inner.Append("</p>");
            inner.Append("<div class=\"chip-row\">" +
                         "<span class=\"chip\">Create image</span>" +
                         "<span class=\"chip\">Create music</span>" +
                         "<span class=\"chip\">Boost my day</span>" +
                         "<span class=\"chip\">Write anything</span>" +
                         "<span class=\"chip\">Help me learn</span>" +
                         "</div>");
            inner.Append("</section></div>");
        }
        else
        {
            inner.Append("<div class=\"chat-shell\">");
            foreach (var t in _turns)
            {
                switch (t.Kind)
                {
                    case ChatTurnKind.User:
                        inner.Append("<div class=\"msg user\"><div class=\"bubble\">");
                        inner.Append(WebUtility.HtmlEncode(t.Text).Replace("\n", "<br/>", StringComparison.Ordinal));
                        inner.Append("</div></div>");
                        break;
                    case ChatTurnKind.Assistant:
                        inner.Append("<div class=\"msg assistant\"><div class=\"msg-header\"><span class=\"label\">助手</span></div><div class=\"md\">");
                        inner.Append(MarkdownHtml.ToHtmlBody(t.Text));
                        inner.Append("</div></div>");
                        break;
                    case ChatTurnKind.Tool:
                        inner.Append("<div class=\"msg tool\"><div class=\"msg-header\"><span class=\"label\">工具</span></div><div class=\"md\">");
                        inner.Append(WebUtility.HtmlEncode(t.Text).Replace("\n", "<br/>", StringComparison.Ordinal));
                        inner.Append("</div></div>");
                        break;
                    case ChatTurnKind.Error:
                        inner.Append("<div class=\"msg err\"><div class=\"msg-header\"><span class=\"label\">⚠ 提示</span></div><div>");
                        inner.Append(WebUtility.HtmlEncode(t.Text));
                        inner.Append("</div></div>");
                        break;
                }
            }
            inner.Append("</div>");
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
