using System.Collections.ObjectModel;
using System.Windows;
using System.Windows.Controls;
using DesktopAssistant.Models;
using DesktopAssistant.Services;
using Forms = System.Windows.Forms;

namespace DesktopAssistant.Views;

public partial class SettingsView : UserControl
{
    public event EventHandler? SettingsSaved;
    public event Action? OpenScheduledRemindersRequested;

    private readonly ObservableCollection<QuickLinkItem> _quickLinks = new();
    private readonly ObservableCollection<FolderSyncProfile> _folderSyncProfiles = new();
    private readonly ObservableCollection<FolderSyncPreviewItem> _folderSyncPreviewItems = new();
    private readonly ObservableCollection<PromptSnippetItem> _promptSnippets = new();
    private readonly ObservableCollection<ModelProfileItem> _modelProfiles = new();
    private readonly FolderSyncService _folderSyncService = new();
    private readonly AppUpdateService _appUpdateService = new();
    private bool _initialized;

    public SettingsView()
    {
        InitializeComponent();
        Provider.Items.Add("OpenAI");
        Provider.Items.Add("Anthropic Claude");
        Provider.Items.Add("自定义");

        MeetingLanguageCombo.Items.Add("中文 (zh)");
        MeetingLanguageCombo.Items.Add("English (en)");
        MeetingLanguageCombo.Items.Add("日本語 (ja)");
        MeetingLanguageCombo.Items.Add("Deutsch (de)");
        MeetingLanguageCombo.Items.Add("Français (fr)");
        MeetingLanguageCombo.SelectedIndex = 0;

        MeetingAudioSourceCombo.Items.Add("麦克风 (mic)");
        MeetingAudioSourceCombo.Items.Add("系统回放 (loopback)");
        MeetingAudioSourceCombo.SelectedIndex = 0;

        LanguageCombo.Items.Add("中文 (zh-CN)");
        LanguageCombo.Items.Add("English (en-US)");
        LanguageCombo.SelectedIndex = 0;
        ProxyModeCombo.SelectedIndex = 0;

        ModelCombo.ItemsSource = _modelProfiles;
        ModelCombo.DisplayMemberPath = nameof(ModelProfileItem.DisplayName);
        ModelProfilesList.ItemsSource = _modelProfiles;
        QuickLinksList.ItemsSource = _quickLinks;
        FolderSyncProfilesList.ItemsSource = _folderSyncProfiles;
        FolderSyncPreviewList.ItemsSource = _folderSyncPreviewItems;
        PromptSnippetsList.ItemsSource = _promptSnippets;
        Loaded += SettingsView_OnLoaded;
    }

    private void SettingsView_OnLoaded(object sender, RoutedEventArgs e)
    {
        if (_initialized)
            return;

        ClipboardHistoryList.ItemsSource = DesktopAssistant.App.ClipboardHistory.Items;
        LoadFromDisk();
        _initialized = true;
    }

    public void LoadFromDisk()
    {
        var config = DesktopAssistant.App.Config.Load();

        var providerUi = config.Provider.ToLowerInvariant() switch
        {
            "claude" => "Anthropic Claude",
            "custom" => "自定义",
            _ => "OpenAI"
        };
        Provider.SelectedItem = providerUi;
        Endpoint.Text = config.ApiEndpoint ?? "";
        ApiKeyBox.Password = config.ApiKey ?? "";
        ReloadModelProfiles(config);
        FloatingIconCheck.IsChecked = config.FloatingIconEnabled;
        StartWithWindowsCheck.IsChecked = StartupService.IsEnabled();
        ClipboardHistoryCheck.IsChecked = config.ClipboardHistoryEnabled;
        TaskbarResourceMonitorCheck.IsChecked = config.TaskbarResourceMonitorEnabled;
        TaskbarResourceIntervalBox.Text = config.TaskbarResourceMonitorIntervalSeconds is >= 1 and <= 10
            ? config.TaskbarResourceMonitorIntervalSeconds.ToString()
            : "2";
        NotesRootPathBox.Text = config.NotesRootPath ?? "";
        NotesRestoreStickiesCheck.IsChecked = config.NotesRestoreStickiesOnStartup;

        GlobalChatHotkeyBox.Text = string.IsNullOrWhiteSpace(config.GlobalChatHotkey) ? "Ctrl+Shift+Q" : config.GlobalChatHotkey;
        QuickScreenshotHotkeyBox.Text = string.IsNullOrWhiteSpace(config.QuickScreenshotHotkey) ? "Ctrl+Shift+S" : config.QuickScreenshotHotkey;
        RegionScreenshotHotkeyBox.Text = string.IsNullOrWhiteSpace(config.RegionScreenshotHotkey) ? "Ctrl+Shift+R" : config.RegionScreenshotHotkey;
        GlobalChatPromptBox.Text = config.GlobalChatSystemPrompt ?? "";

        // 强制代理
        ProxyForceEnabledCheck.IsChecked = config.ProxyForceEnabled;
        ProxyModeCombo.SelectedIndex = string.Equals(config.ProxyForceMode, "pac", StringComparison.OrdinalIgnoreCase) ? 1 : 0;
        ProxyPacUrlBox.Text = config.ProxyPacUrl ?? "";
        ProxyPacShanghaiBox.Text = config.ProxyPacUrlShanghai ?? "";
        ProxyPacBeijingBox.Text = config.ProxyPacUrlBeijing ?? "";
        ProxyServerBox.Text = config.ProxyServer ?? "";
        ProxyPortBox.Text = config.ProxyPort is > 0 and <= 65535 ? config.ProxyPort.ToString() : "8080";
        ProxyBypassBox.Text = config.ProxyBypass ?? "";
        ProxyRefreshMinutesBox.Text = config.ProxyRefreshMinutes >= 1 ? config.ProxyRefreshMinutes.ToString() : "3";
        UpdateProxyUiByMode();

        // 会议助手
        MeetingLanguageCombo.SelectedIndex = config.MeetingLanguage switch
        {
            "en" => 1, "ja" => 2, "de" => 3, "fr" => 4, _ => 0
        };
        MeetingAudioSourceCombo.SelectedIndex = config.MeetingAudioSource == "loopback" ? 1 : 0;
        MeetingSegmentSecondsBox.Text = config.MeetingSegmentSeconds.ToString();
        MeetingAutoSummaryCheck.IsChecked = config.MeetingAutoSummary;
        MeetingSavePathBox.Text = config.MeetingSavePath ?? "";

        // 本地 STT
        LocalSttExePathBox.Text = config.LocalSttWhisperExePath ?? "";
        LocalSttModelPathBox.Text = config.LocalSttModelPath ?? "";
        LocalSttLanguageBox.Text = string.IsNullOrWhiteSpace(config.LocalSttLanguage) ? "zh" : config.LocalSttLanguage;
        LocalSttThreadsBox.Text = config.LocalSttThreads > 0 ? config.LocalSttThreads.ToString() : "4";
        LocalSttTimeoutBox.Text = config.LocalSttTimeoutSeconds >= 30 ? config.LocalSttTimeoutSeconds.ToString() : "240";
        LocalSttAutoPunctuationCheck.IsChecked = config.LocalSttAutoPunctuation;

        // 文件管理沙箱
        SandboxPathBox.Text = config.SandboxPath ?? "";

        // 提醒
        TodoReminderCheck.IsChecked = config.TodoReminderEnabled;
        TodoReminderIntervalBox.Text = config.TodoReminderMinutes.ToString();
        if (UpdateGitHubRepoBox != null)
            UpdateGitHubRepoBox.Text = string.IsNullOrWhiteSpace(config.UpdateGitHubRepo)
                ? "TristonLeiCheng/DanceMonkey"
                : config.UpdateGitHubRepo;
        if (UpdateAssetKeywordBox != null)
            UpdateAssetKeywordBox.Text = string.IsNullOrWhiteSpace(config.UpdateAssetKeyword)
                ? "win-x64"
                : config.UpdateAssetKeyword;
        if (UpdateManifestUrlBox != null)
            UpdateManifestUrlBox.Text = config.UpdateManifestUrl ?? "";
        if (CurrentVersionText != null)
            CurrentVersionText.Text = $"版本 {AppVersionService.GetCurrentVersionText()} · .NET 8 WPF";
        if (UpdateStatusText != null)
            UpdateStatusText.Text = "";

        // 语言
        LanguageCombo.SelectedIndex = config.Language == "en-US" ? 1 : 0;

        _quickLinks.Clear();
        foreach (var l in config.QuickLinks)
            _quickLinks.Add(new QuickLinkItem
            {
                Name = l.Name,
                Path = l.Path,
                Category = l.Category,
                Description = l.Description,
                Group = l.Group,
                ClickCount = l.ClickCount,
                LastClicked = l.LastClicked,
                Pinned = l.Pinned
            });

        _folderSyncProfiles.Clear();
        foreach (var profile in config.FolderSyncProfiles ?? new List<FolderSyncProfile>())
            _folderSyncProfiles.Add(profile.Clone());

        _promptSnippets.Clear();
        foreach (var s in config.PromptSnippets)
            _promptSnippets.Add(new PromptSnippetItem { Title = s.Title, SystemPrompt = s.SystemPrompt });

        SkillManagerPanel.ReloadForSandboxChange();
        UpdateEndpointPlaceholder();
    }

    public void ShowSkillsSettings()
    {
        SettingsTabs.SelectedItem = SkillsTab;
        SkillManagerPanel.ReloadForSandboxChange();
    }

    public void ReloadSkillManagerForSandboxChange() => SkillManagerPanel.ReloadForSandboxChange();

    public void PrefillFolderSyncProfile(string masterPath, string? name = null)
    {
        SettingsTabs.SelectedItem = FolderSyncTab;
        FolderSyncProfilesList.SelectedItem = null;
        SyncNameBox.Text = string.IsNullOrWhiteSpace(name) ? "文件夹同步" : name.Trim() + " 同步";
        SyncMasterPathBox.Text = masterPath;
        SyncSlavePathBox.Text = "";
        SyncEnabledCheck.IsChecked = true;
        SyncAutoEnabledCheck.IsChecked = false;
        SyncAutoIntervalBox.Text = "30";
        SyncTrashRetentionBox.Text = "30";
        SyncDeleteExtraCheck.IsChecked = false;
        SyncExcludeBox.Text = "*.tmp;~$*;.DS_Store;Thumbs.db";
        SelectSyncMode(FolderSyncModes.MasterToSlave);
        SelectSyncConflictPolicy(FolderSyncConflictPolicies.KeepConflictCopy);
        ClearSyncPreviewDetails();
        ClearSyncLogPreview();
        FolderSyncStatusText.Text = "已从快速访问预填主文件夹，请选择部门共享盘/局域网盘作为从文件夹后添加任务。";
    }

    private void ReloadModelProfiles(AppConfig config)
    {
        config.EnsureModelProfiles();
        _modelProfiles.Clear();
        foreach (var profile in config.ModelProfiles)
        {
            _modelProfiles.Add(new ModelProfileItem
            {
                Name = profile.Name,
                Model = profile.Model
            });
        }

        SelectModelInCombo(config.Model);
    }

    private string GetSelectedModelText()
    {
        if (ModelCombo.SelectedItem is ModelProfileItem selected && !string.IsNullOrWhiteSpace(selected.Model))
            return selected.Model.Trim();
        return ModelCombo.Text.Trim();
    }

    private void SelectModelInCombo(string? model)
    {
        var target = string.IsNullOrWhiteSpace(model) ? "gpt-3.5-turbo" : model.Trim();
        var profile = _modelProfiles.FirstOrDefault(m => string.Equals(m.Model, target, StringComparison.OrdinalIgnoreCase));
        if (profile != null)
        {
            ModelCombo.SelectedItem = profile;
            ModelProfilesList.SelectedItem = profile;
        }
        else
        {
            ModelCombo.SelectedItem = null;
            ModelCombo.Text = target;
        }
    }

    private ModelProfileItem EnsureModelProfileExists(string model)
    {
        var value = model.Trim();
        var existing = _modelProfiles.FirstOrDefault(m => string.Equals(m.Model, value, StringComparison.OrdinalIgnoreCase));
        if (existing != null)
            return existing;

        var created = new ModelProfileItem { Name = value, Model = value };
        _modelProfiles.Add(created);
        return created;
    }

    private void AddModelProfile_OnClick(object sender, RoutedEventArgs e)
    {
        var model = ModelProfileValueBox.Text.Trim();
        if (string.IsNullOrWhiteSpace(model))
        {
            MessageBox.Show("请填写模型 ID。", L("Msg.Hint"), MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        var name = ModelProfileNameBox.Text.Trim();
        if (string.IsNullOrWhiteSpace(name))
            name = model;

        var existing = _modelProfiles.FirstOrDefault(m =>
            string.Equals(m.Model, model, StringComparison.OrdinalIgnoreCase) ||
            string.Equals(m.Name, name, StringComparison.OrdinalIgnoreCase));

        if (existing != null)
        {
            existing.Name = name;
            existing.Model = model;
            ModelProfilesList.Items.Refresh();
            ModelCombo.Items.Refresh();
            ModelProfilesList.SelectedItem = existing;
            ModelCombo.SelectedItem = existing;
        }
        else
        {
            var created = new ModelProfileItem { Name = name, Model = model };
            _modelProfiles.Add(created);
            ModelProfilesList.SelectedItem = created;
            ModelCombo.SelectedItem = created;
        }

        ModelProfileNameBox.Text = "";
        ModelProfileValueBox.Text = "";
    }

    private void UseSelectedModelProfile_OnClick(object sender, RoutedEventArgs e)
    {
        if (ModelProfilesList.SelectedItem is not ModelProfileItem item)
            return;
        ModelCombo.SelectedItem = item;
    }

    private void RemoveModelProfile_OnClick(object sender, RoutedEventArgs e)
    {
        if (ModelProfilesList.SelectedItem is not ModelProfileItem item)
            return;

        _modelProfiles.Remove(item);
        if (ReferenceEquals(ModelCombo.SelectedItem, item))
        {
            var next = _modelProfiles.FirstOrDefault();
            if (next != null)
                ModelCombo.SelectedItem = next;
            else
                ModelCombo.Text = item.Model;
        }
    }

    private void Provider_OnSelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        UpdateEndpointPlaceholder();
    }

    private void UpdateEndpointPlaceholder()
    {
        var p = Provider.SelectedItem?.ToString();
        Endpoint.ToolTip = p switch
        {
            "Anthropic Claude" => "https://api.anthropic.com/v1/messages",
            "自定义" =>
                "可填网关根路径（如 https://chat.int.bayer.com/api/v2/ ），程序会自动补全为 …/chat/completions；或粘贴完整 OpenAI 兼容地址。",
            _ => "https://api.openai.com/v1/chat/completions"
        };
    }

    private void SaveBtn_OnClick(object sender, RoutedEventArgs e)
    {
        var apiKey = ApiKeyBox.Password.Trim();

        var providerKey = Provider.SelectedItem?.ToString() switch
        {
            "Anthropic Claude" => "claude",
            "自定义" => "custom",
            _ => "openai"
        };

        var modelText = GetSelectedModelText();
        if (string.IsNullOrEmpty(modelText))
            modelText = "gpt-3.5-turbo";
        EnsureModelProfileExists(modelText);

        var config = DesktopAssistant.App.Config.Load();
        config.Provider = providerKey;
        config.ApiEndpoint = Endpoint.Text.Trim();
        config.ApiKey = apiKey;
        config.Model = modelText;
        config.ModelProfiles = _modelProfiles
            .Where(m => !string.IsNullOrWhiteSpace(m.Model))
            .Select(m => new ModelProfileItem
            {
                Name = string.IsNullOrWhiteSpace(m.Name) ? m.Model.Trim() : m.Name.Trim(),
                Model = m.Model.Trim()
            })
            .ToList();
        config.FloatingIconEnabled = FloatingIconCheck.IsChecked == true;
        config.StartWithWindows = StartWithWindowsCheck.IsChecked == true;
        config.ClipboardHistoryEnabled = ClipboardHistoryCheck.IsChecked == true;
        config.TaskbarResourceMonitorEnabled = TaskbarResourceMonitorCheck.IsChecked == true;
        config.TaskbarResourceMonitorIntervalSeconds =
            int.TryParse(TaskbarResourceIntervalBox.Text.Trim(), out var monitorSec)
                ? Math.Clamp(monitorSec, 1, 10)
                : 2;
        config.NotesRootPath = string.IsNullOrWhiteSpace(NotesRootPathBox.Text)
            ? null
            : NotesRootPathBox.Text.Trim();
        config.NotesRestoreStickiesOnStartup = NotesRestoreStickiesCheck.IsChecked == true;

        config.GlobalChatHotkey = string.IsNullOrWhiteSpace(GlobalChatHotkeyBox.Text)
            ? "Ctrl+Shift+Q"
            : GlobalChatHotkeyBox.Text.Trim();
        config.QuickScreenshotHotkey = string.IsNullOrWhiteSpace(QuickScreenshotHotkeyBox.Text)
            ? "Ctrl+Shift+S"
            : QuickScreenshotHotkeyBox.Text.Trim();
        config.RegionScreenshotHotkey = string.IsNullOrWhiteSpace(RegionScreenshotHotkeyBox.Text)
            ? "Ctrl+Shift+R"
            : RegionScreenshotHotkeyBox.Text.Trim();
        config.GlobalChatSystemPrompt = string.IsNullOrWhiteSpace(GlobalChatPromptBox.Text)
            ? null
            : GlobalChatPromptBox.Text.Trim();

        // 强制代理
        config.ProxyForceEnabled = ProxyForceEnabledCheck.IsChecked == true;
        config.ProxyForceMode = ProxyModeCombo.SelectedIndex == 1 ? "pac" : "manual";
        config.ProxyPacUrl = ProxyPacUrlBox.Text.Trim();
        config.ProxyPacUrlShanghai = ProxyPacShanghaiBox.Text.Trim();
        config.ProxyPacUrlBeijing = ProxyPacBeijingBox.Text.Trim();
        config.ProxyServer = ProxyServerBox.Text.Trim();
        config.ProxyBypass = ProxyBypassBox.Text.Trim();
        config.ProxyPort = int.TryParse(ProxyPortBox.Text.Trim(), out var proxyPort)
            ? Math.Clamp(proxyPort, 1, 65535)
            : 8080;
        config.ProxyRefreshMinutes = int.TryParse(ProxyRefreshMinutesBox.Text.Trim(), out var proxyRefresh)
            ? Math.Clamp(proxyRefresh, 1, 60)
            : 3;
        config.UpdateGitHubRepo = string.IsNullOrWhiteSpace(UpdateGitHubRepoBox.Text)
            ? "TristonLeiCheng/DanceMonkey"
            : UpdateGitHubRepoBox.Text.Trim();
        config.UpdateAssetKeyword = string.IsNullOrWhiteSpace(UpdateAssetKeywordBox.Text)
            ? "win-x64"
            : UpdateAssetKeywordBox.Text.Trim();
        config.UpdateManifestUrl = string.IsNullOrWhiteSpace(UpdateManifestUrlBox.Text)
            ? null
            : UpdateManifestUrlBox.Text.Trim();

        if (config.ProxyForceEnabled)
        {
            if (config.ProxyForceMode == "pac")
            {
                if (!Uri.TryCreate(config.ProxyPacUrl, UriKind.Absolute, out var pacUri) ||
                    (pacUri.Scheme != Uri.UriSchemeHttp && pacUri.Scheme != Uri.UriSchemeHttps))
                {
                    MessageBox.Show("PAC 地址无效，请填写完整 http/https 地址。", L("Msg.Hint"),
                        MessageBoxButton.OK, MessageBoxImage.Warning);
                    return;
                }
            }
            else if (string.IsNullOrWhiteSpace(config.ProxyServer))
            {
                MessageBox.Show("手动代理地址不能为空。", L("Msg.Hint"),
                    MessageBoxButton.OK, MessageBoxImage.Warning);
                return;
            }
        }

        if (!string.IsNullOrWhiteSpace(config.ProxyPacUrlShanghai) &&
            !TryValidateHttpOrHttpsUrl(config.ProxyPacUrlShanghai))
        {
            MessageBox.Show("上海 PAC 地址无效，请填写完整 http/https 地址。", L("Msg.Hint"),
                MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }
        if (!string.IsNullOrWhiteSpace(config.ProxyPacUrlBeijing) &&
            !TryValidateHttpOrHttpsUrl(config.ProxyPacUrlBeijing))
        {
            MessageBox.Show("北京 PAC 地址无效，请填写完整 http/https 地址。", L("Msg.Hint"),
                MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        // 会议助手
        config.MeetingLanguage = MeetingLanguageCombo.SelectedIndex switch
        {
            1 => "en", 2 => "ja", 3 => "de", 4 => "fr", _ => "zh"
        };
        config.MeetingAudioSource = MeetingAudioSourceCombo.SelectedIndex == 1 ? "loopback" : "mic";
        if (int.TryParse(MeetingSegmentSecondsBox.Text.Trim(), out var seg) && seg >= 2 && seg <= 30)
            config.MeetingSegmentSeconds = seg;
        config.MeetingAutoSummary = MeetingAutoSummaryCheck.IsChecked == true;
        config.MeetingSavePath = string.IsNullOrWhiteSpace(MeetingSavePathBox.Text)
            ? null
            : MeetingSavePathBox.Text.Trim();

        // 本地 STT
        config.LocalSttWhisperExePath = string.IsNullOrWhiteSpace(LocalSttExePathBox.Text)
            ? null
            : LocalSttExePathBox.Text.Trim();
        config.LocalSttModelPath = string.IsNullOrWhiteSpace(LocalSttModelPathBox.Text)
            ? null
            : LocalSttModelPathBox.Text.Trim();
        config.LocalSttLanguage = string.IsNullOrWhiteSpace(LocalSttLanguageBox.Text)
            ? "zh"
            : LocalSttLanguageBox.Text.Trim();
        config.LocalSttThreads = int.TryParse(LocalSttThreadsBox.Text.Trim(), out var localThreads)
            ? Math.Clamp(localThreads, 1, 32)
            : 4;
        config.LocalSttTimeoutSeconds = int.TryParse(LocalSttTimeoutBox.Text.Trim(), out var localTimeout)
            ? Math.Clamp(localTimeout, 30, 3600)
            : 240;
        config.LocalSttAutoPunctuation = LocalSttAutoPunctuationCheck.IsChecked == true;

        config.SandboxPath = string.IsNullOrWhiteSpace(SandboxPathBox.Text)
            ? null
            : SandboxPathBox.Text.Trim();

        // 待办提醒
        config.TodoReminderEnabled = TodoReminderCheck.IsChecked == true;
        if (int.TryParse(TodoReminderIntervalBox.Text.Trim(), out var todoMinutes) && todoMinutes >= 5 && todoMinutes <= 240)
            config.TodoReminderMinutes = todoMinutes;

        config.Language = LanguageCombo.SelectedIndex == 1 ? "en-US" : "zh-CN";

        if (!TryParseHotkey(config.GlobalChatHotkey))
        {
            MessageBox.Show(L("Msg.HotkeyInvalid"), L("Msg.Hint"),
                MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }
        if (!TryParseHotkey(config.QuickScreenshotHotkey) || !TryParseHotkey(config.RegionScreenshotHotkey))
        {
            MessageBox.Show(L("Msg.HotkeyInvalid"), L("Msg.Hint"),
                MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        config.QuickLinks = _quickLinks.Select(l => new QuickLinkItem
        {
            Name = l.Name,
            Path = l.Path,
            Category = l.Category,
            Description = l.Description,
            Group = l.Group,
            ClickCount = l.ClickCount,
            LastClicked = l.LastClicked,
            Pinned = l.Pinned
        }).ToList();
        config.FolderSyncProfiles = _folderSyncProfiles.Select(p => p.Clone()).ToList();
        config.PromptSnippets = _promptSnippets
            .Select(s => new PromptSnippetItem { Title = s.Title, SystemPrompt = s.SystemPrompt }).ToList();

        if (DesktopAssistant.App.Config.Save(config))
        {
            try
            {
                StartupService.SetEnabled(config.StartWithWindows);
            }
            catch (Exception ex)
            {
                MessageBox.Show(L("Msg.StartupWriteFailed", ex.Message), L("Msg.Hint"), MessageBoxButton.OK,
                    MessageBoxImage.Warning);
            }

            LocalizationManager.SwitchLanguage(config.Language);
            MessageBox.Show(L("Msg.SaveSuccess"), L("Msg.Success"), MessageBoxButton.OK, MessageBoxImage.Information);
            SettingsSaved?.Invoke(this, EventArgs.Empty);
        }
        else
            MessageBox.Show(L("Msg.SaveFailed"), L("Msg.Error"), MessageBoxButton.OK, MessageBoxImage.Error);
    }

    private void ClearClipboardHistory_OnClick(object sender, RoutedEventArgs e)
    {
        DesktopAssistant.App.ClipboardHistory.Clear();
    }

    private void OpenScheduledReminders_OnClick(object sender, RoutedEventArgs e) =>
        OpenScheduledRemindersRequested?.Invoke();

    private void ClipboardHistoryList_OnMouseDoubleClick(object sender, System.Windows.Input.MouseButtonEventArgs e)
    {
        if (ClipboardHistoryList.SelectedItem is string s)
            ClipboardHistoryService.CopyToClipboard(s);
    }

    private void BrowseNotesRoot_OnClick(object sender, RoutedEventArgs e)
    {
        using var dlg = new Forms.FolderBrowserDialog { Description = L("Settings.SelectNotesRoot") };
        if (dlg.ShowDialog() == Forms.DialogResult.OK)
            NotesRootPathBox.Text = dlg.SelectedPath;
    }

    private void AddQuickLink_OnClick(object sender, RoutedEventArgs e)
    {
        var name = QuickLinkNameBox.Text.Trim();
        var path = QuickLinkPathBox.Text.Trim();
        if (string.IsNullOrEmpty(name) || string.IsNullOrEmpty(path))
        {
            MessageBox.Show(L("Msg.FillNameAndPath"), L("Msg.Hint"), MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        var category = (QuickLinkCategoryCombo.SelectedItem as ComboBoxItem)?.Tag as string ?? "local";
        if (category is "local" or "network" && !System.IO.Directory.Exists(path))
        {
            MessageBox.Show($"文件夹不存在或当前账号无权访问：{path}", L("Msg.Hint"),
                MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        _quickLinks.Add(new QuickLinkItem { Name = name, Path = path, Category = category });
        QuickLinkNameBox.Text = "";
        QuickLinkPathBox.Text = "";
    }

    private void RemoveQuickLink_OnClick(object sender, RoutedEventArgs e)
    {
        if (QuickLinksList.SelectedItem is QuickLinkItem item)
            _quickLinks.Remove(item);
    }

    private void AddPromptSnippet_OnClick(object sender, RoutedEventArgs e)
    {
        var title = PromptSnippetTitleBox.Text.Trim();
        var body = PromptSnippetBodyBox.Text.Trim();
        if (string.IsNullOrEmpty(body))
        {
            MessageBox.Show(L("Msg.FillPromptContent"), L("Msg.Hint"), MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        if (string.IsNullOrEmpty(title))
            title = body.Length > 20 ? body[..20] + "…" : body;

        _promptSnippets.Add(new PromptSnippetItem { Title = title, SystemPrompt = body });
        PromptSnippetTitleBox.Text = "";
        PromptSnippetBodyBox.Text = "";
    }

    private void RemovePromptSnippet_OnClick(object sender, RoutedEventArgs e)
    {
        if (PromptSnippetsList.SelectedItem is PromptSnippetItem item)
            _promptSnippets.Remove(item);
    }

    private void OpenQuickLink_OnClick(object sender, RoutedEventArgs e)
    {
        if (QuickLinksList.SelectedItem is not QuickLinkItem item || string.IsNullOrWhiteSpace(item.Path))
            return;
        if (!System.IO.Directory.Exists(item.Path))
        {
            MessageBox.Show(L("Msg.PathNotExist"), L("Msg.Hint"), MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        QuickAccessPaths.OpenInExplorer(item.Path);
    }

    private void FolderSyncProfilesList_OnSelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (FolderSyncProfilesList.SelectedItem is not FolderSyncProfile profile)
            return;

        SyncNameBox.Text = profile.Name;
        SyncMasterPathBox.Text = profile.MasterPath;
        SyncSlavePathBox.Text = profile.SlavePath;
        SyncEnabledCheck.IsChecked = profile.Enabled;
        SyncAutoEnabledCheck.IsChecked = profile.AutoSyncEnabled;
        SyncAutoIntervalBox.Text = Math.Clamp(profile.AutoSyncIntervalMinutes, 5, 1440).ToString();
        SyncTrashRetentionBox.Text = Math.Clamp(profile.TrashRetentionDays, 1, 3650).ToString();
        SyncDeleteExtraCheck.IsChecked = profile.DeleteExtraFiles;
        SyncExcludeBox.Text = string.IsNullOrWhiteSpace(profile.ExcludePatterns)
            ? "*.tmp;~$*;.DS_Store;Thumbs.db"
            : profile.ExcludePatterns;
        SelectSyncMode(profile.Mode);
        SelectSyncConflictPolicy(profile.ConflictPolicy);
        ClearSyncPreviewDetails();
        LoadRecentSyncLog(profile, showMissing: false);
        FolderSyncStatusText.Text = BuildSyncProfileStatus(profile);
    }

    private void BrowseSyncMaster_OnClick(object sender, RoutedEventArgs e)
    {
        if (TryBrowseFolder("选择主文件夹（本地电脑常用文件夹）", out var path))
            SyncMasterPathBox.Text = path;
    }

    private void BrowseSyncSlave_OnClick(object sender, RoutedEventArgs e)
    {
        if (TryBrowseFolder("选择从文件夹（部门共享盘/局域网盘）", out var path))
            SyncSlavePathBox.Text = path;
    }

    private void AddOrUpdateSyncProfile_OnClick(object sender, RoutedEventArgs e)
    {
        if (!TryBuildSyncProfileFromUi(out var profile))
            return;

        if (FolderSyncProfilesList.SelectedItem is FolderSyncProfile selected)
        {
            selected.Name = profile.Name;
            selected.MasterPath = profile.MasterPath;
            selected.SlavePath = profile.SlavePath;
            selected.Mode = profile.Mode;
            selected.Enabled = profile.Enabled;
            selected.AutoSyncEnabled = profile.AutoSyncEnabled;
            selected.AutoSyncIntervalMinutes = profile.AutoSyncIntervalMinutes;
            selected.DeleteExtraFiles = profile.DeleteExtraFiles;
            selected.TrashRetentionDays = profile.TrashRetentionDays;
            selected.ConflictPolicy = profile.ConflictPolicy;
            selected.ExcludePatterns = profile.ExcludePatterns;
            FolderSyncProfilesList.Items.Refresh();
            FolderSyncStatusText.Text = BuildSyncProfileStatus(selected);
        }
        else
        {
            _folderSyncProfiles.Add(profile);
            FolderSyncProfilesList.SelectedItem = profile;
        }
    }

    private void RemoveSyncProfile_OnClick(object sender, RoutedEventArgs e)
    {
        if (FolderSyncProfilesList.SelectedItem is FolderSyncProfile profile)
        {
            _folderSyncProfiles.Remove(profile);
            ClearSyncProfileEditor();
        }
    }

    private void PreviewSyncProfile_OnClick(object sender, RoutedEventArgs e)
    {
        if (FolderSyncProfilesList.SelectedItem is not FolderSyncProfile profile)
        {
            MessageBox.Show("请先选择一个同步任务。", L("Msg.Hint"), MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        try
        {
            var preview = _folderSyncService.Preview(profile);
            ShowSyncPreviewDetails(preview);
            FolderSyncStatusText.Text = BuildSyncPreviewStatus(preview);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or InvalidOperationException)
        {
            ClearSyncPreviewDetails();
            FolderSyncStatusText.Text = ex.Message;
            MessageBox.Show(ex.Message, L("Msg.Error"), MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private async void RunSyncProfile_OnClick(object sender, RoutedEventArgs e)
    {
        if (FolderSyncProfilesList.SelectedItem is not FolderSyncProfile profile)
        {
            MessageBox.Show("请先选择一个同步任务。", L("Msg.Hint"), MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        if (!profile.Enabled)
        {
            MessageBox.Show("该同步任务未启用。", L("Msg.Hint"), MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        FolderSyncProgressWindow? progressWindow = null;
        try
        {
            var preview = _folderSyncService.Preview(profile);
            ShowSyncPreviewDetails(preview);
            var confirm = MessageBox.Show(
                $"将执行同步：{preview.Summary}\n\n冲突策略：{profile.ConflictPolicyDisplayName}\n\n是否继续？",
                AppBranding.DisplayName,
                MessageBoxButton.YesNo,
                MessageBoxImage.Question);
            if (confirm != MessageBoxResult.Yes)
                return;

            progressWindow = new FolderSyncProgressWindow(profile.Name, preview)
            {
                Owner = Window.GetWindow(this)
            };
            var progress = new Progress<FolderSyncProgress>(progressWindow.UpdateProgress);
            progressWindow.Show();

            var result = await Task.Run(() => _folderSyncService.Run(profile, progress, progressWindow.CancellationToken));
            progressWindow.MarkCompleted(result);
            profile.LastRunAt = DateTime.Now;
            profile.LastStatus = result.ErrorCount == 0 ? result.Summary : result.Summary + $"；{result.ErrorCount} 个错误";
            FolderSyncProfilesList.Items.Refresh();
            FolderSyncStatusText.Text = result.Errors.Count == 0
                ? profile.LastStatus
                : profile.LastStatus + Environment.NewLine + string.Join(Environment.NewLine, result.Errors.Take(5));
            SaveFolderSyncProfilesToConfig();
            LoadRecentSyncLog(profile, showMissing: false);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or InvalidOperationException)
        {
            progressWindow?.MarkFailed(ex.Message);
            ClearSyncPreviewDetails();
            profile.LastRunAt = DateTime.Now;
            profile.LastStatus = "失败：" + ex.Message;
            FolderSyncProfilesList.Items.Refresh();
            FolderSyncStatusText.Text = profile.LastStatus;
            MessageBox.Show(ex.Message, L("Msg.Error"), MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void ShowSyncPreviewDetails(FolderSyncPreview preview)
    {
        _folderSyncPreviewItems.Clear();
        foreach (var item in preview.Items.Take(500))
            _folderSyncPreviewItems.Add(item);

        FolderSyncPreviewList.Visibility = preview.Items.Count == 0
            ? Visibility.Collapsed
            : Visibility.Visible;
    }

    private string BuildSyncPreviewStatus(FolderSyncPreview preview)
    {
        var lines = new List<string> { preview.Summary };
        if (preview.Items.Count > _folderSyncPreviewItems.Count)
            lines.Add($"预览明细较多，仅显示前 {_folderSyncPreviewItems.Count} 项。");
        lines.AddRange(preview.Messages.Take(5));
        return string.Join(Environment.NewLine, lines);
    }

    private void ClearSyncPreviewDetails()
    {
        _folderSyncPreviewItems.Clear();
        FolderSyncPreviewList.Visibility = Visibility.Collapsed;
    }

    private void LoadRecentSyncLog(FolderSyncProfile profile, bool showMissing)
    {
        string text;
        try
        {
            text = _folderSyncService.ReadRecentLog(profile);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            ClearSyncLogPreview();
            FolderSyncStatusText.Text = "读取同步日志失败：" + ex.Message;
            return;
        }

        if (string.IsNullOrWhiteSpace(text))
        {
            ClearSyncLogPreview();
            if (showMissing)
                MessageBox.Show("该任务还没有同步日志。", L("Msg.Hint"), MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }

        FolderSyncLogBox.Text = text;
        FolderSyncLogBox.Visibility = Visibility.Visible;
    }

    private void ClearSyncLogPreview()
    {
        FolderSyncLogBox.Text = "";
        FolderSyncLogBox.Visibility = Visibility.Collapsed;
    }

    private bool TryBuildSyncProfileFromUi(out FolderSyncProfile profile)
    {
        profile = new FolderSyncProfile();
        var masterPath = SyncMasterPathBox.Text.Trim();
        var slavePath = SyncSlavePathBox.Text.Trim();
        var name = SyncNameBox.Text.Trim();

        if (string.IsNullOrWhiteSpace(masterPath) || string.IsNullOrWhiteSpace(slavePath))
        {
            MessageBox.Show("请填写主文件夹和从文件夹。", L("Msg.Hint"), MessageBoxButton.OK, MessageBoxImage.Warning);
            return false;
        }

        if (!System.IO.Directory.Exists(masterPath))
        {
            MessageBox.Show($"主文件夹不存在或无权访问：{masterPath}", L("Msg.Hint"),
                MessageBoxButton.OK, MessageBoxImage.Warning);
            return false;
        }

        if (string.IsNullOrWhiteSpace(name))
            name = $"{System.IO.Path.GetFileName(masterPath.TrimEnd('\\'))} → {System.IO.Path.GetFileName(slavePath.TrimEnd('\\'))}";

        profile = new FolderSyncProfile
        {
            Id = FolderSyncProfilesList.SelectedItem is FolderSyncProfile selected ? selected.Id : Guid.NewGuid().ToString("N"),
            Name = name,
            MasterPath = masterPath,
            SlavePath = slavePath,
            Mode = GetSelectedSyncMode(),
            Enabled = SyncEnabledCheck.IsChecked == true,
            AutoSyncEnabled = SyncAutoEnabledCheck.IsChecked == true,
            AutoSyncIntervalMinutes = int.TryParse(SyncAutoIntervalBox.Text.Trim(), out var interval)
                ? Math.Clamp(interval, 5, 1440)
                : 30,
            DeleteExtraFiles = SyncDeleteExtraCheck.IsChecked == true,
            TrashRetentionDays = int.TryParse(SyncTrashRetentionBox.Text.Trim(), out var trashRetention)
                ? Math.Clamp(trashRetention, 1, 3650)
                : 30,
            ConflictPolicy = GetSelectedSyncConflictPolicy(),
            ExcludePatterns = string.IsNullOrWhiteSpace(SyncExcludeBox.Text)
                ? "*.tmp;~$*;.DS_Store;Thumbs.db"
                : SyncExcludeBox.Text.Trim()
        };
        return true;
    }

    private string GetSelectedSyncMode() =>
        (SyncModeCombo.SelectedItem as ComboBoxItem)?.Tag as string ?? FolderSyncModes.MasterToSlave;

    private string GetSelectedSyncConflictPolicy() =>
        (SyncConflictPolicyCombo.SelectedItem as ComboBoxItem)?.Tag as string ?? FolderSyncConflictPolicies.KeepConflictCopy;

    private void SelectSyncMode(string? mode)
    {
        foreach (ComboBoxItem item in SyncModeCombo.Items)
        {
            if (string.Equals(item.Tag as string, mode, StringComparison.OrdinalIgnoreCase))
            {
                item.IsSelected = true;
                return;
            }
        }
        SyncModeCombo.SelectedIndex = 0;
    }

    private void SelectSyncConflictPolicy(string? policy)
    {
        foreach (ComboBoxItem item in SyncConflictPolicyCombo.Items)
        {
            if (string.Equals(item.Tag as string, policy, StringComparison.OrdinalIgnoreCase))
            {
                item.IsSelected = true;
                return;
            }
        }
        SyncConflictPolicyCombo.SelectedIndex = 0;
    }

    private static bool TryBrowseFolder(string description, out string path)
    {
        using var dlg = new Forms.FolderBrowserDialog
        {
            Description = description,
            ShowNewFolderButton = true
        };

        if (dlg.ShowDialog() == Forms.DialogResult.OK)
        {
            path = dlg.SelectedPath;
            return true;
        }

        path = "";
        return false;
    }

    private void ClearSyncProfileEditor()
    {
        SyncNameBox.Text = "";
        SyncMasterPathBox.Text = "";
        SyncSlavePathBox.Text = "";
        SyncEnabledCheck.IsChecked = true;
        SyncAutoEnabledCheck.IsChecked = false;
        SyncAutoIntervalBox.Text = "30";
        SyncTrashRetentionBox.Text = "30";
        SyncDeleteExtraCheck.IsChecked = false;
        SyncExcludeBox.Text = "*.tmp;~$*;.DS_Store;Thumbs.db";
        SyncModeCombo.SelectedIndex = 0;
        SelectSyncConflictPolicy(FolderSyncConflictPolicies.KeepConflictCopy);
        ClearSyncPreviewDetails();
        ClearSyncLogPreview();
        FolderSyncStatusText.Text = "";
    }

    private static string BuildSyncProfileStatus(FolderSyncProfile profile)
    {
        var lastRun = profile.LastRunAt.HasValue
            ? $"上次同步：{profile.LastRunAt:yyyy-MM-dd HH:mm}。"
            : "尚未同步。";
        return string.IsNullOrWhiteSpace(profile.LastStatus)
            ? lastRun
            : lastRun + " " + profile.LastStatus;
    }

    private void SaveFolderSyncProfilesToConfig()
    {
        var config = DesktopAssistant.App.Config.Load();
        config.FolderSyncProfiles = _folderSyncProfiles.Select(p => p.Clone()).ToList();
        DesktopAssistant.App.Config.Save(config);
    }

    private void OpenSyncLog_OnClick(object sender, RoutedEventArgs e)
    {
        if (FolderSyncProfilesList.SelectedItem is not FolderSyncProfile profile)
        {
            MessageBox.Show("请先选择一个同步任务。", L("Msg.Hint"), MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        var path = _folderSyncService.GetLogPath(profile);
        if (!System.IO.File.Exists(path))
        {
            MessageBox.Show("该任务还没有同步日志。", L("Msg.Hint"), MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }

        QuickAccessPaths.OpenInExplorer(path);
    }

    private void RefreshSyncLog_OnClick(object sender, RoutedEventArgs e)
    {
        if (FolderSyncProfilesList.SelectedItem is not FolderSyncProfile profile)
        {
            MessageBox.Show("请先选择一个同步任务。", L("Msg.Hint"), MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        LoadRecentSyncLog(profile, showMissing: true);
    }

    private async void TestBtn_OnClick(object sender, RoutedEventArgs e)
    {
        var cfg = DesktopAssistant.App.Config.Load();
        cfg.Provider = Provider.SelectedItem?.ToString() switch
        {
            "Anthropic Claude" => "claude",
            "自定义" => "custom",
            _ => "openai"
        };
        cfg.ApiEndpoint = Endpoint.Text.Trim();
        cfg.ApiKey = ApiKeyBox.Password.Trim();
        cfg.Model = string.IsNullOrWhiteSpace(GetSelectedModelText()) ? "gpt-3.5-turbo" : GetSelectedModelText();

        if (string.IsNullOrWhiteSpace(cfg.ApiKey))
        {
            MessageBox.Show(L("Msg.SaveApiFirst"), L("Msg.Hint"), MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        TestBtn.IsEnabled = false;
        TestBtn.Content = L("Settings.Testing");

        try
        {
            var client = new OpenAiApiClient(cfg);
            var result = await client.TestConnectionAsync();

            if (result.Success)
                MessageBox.Show(result.Message, L("Msg.Success"), MessageBoxButton.OK, MessageBoxImage.Information);
            else
                MessageBox.Show(result.Error ?? "Unknown error", L("Msg.Error"), MessageBoxButton.OK, MessageBoxImage.Error);
        }
        finally
        {
            TestBtn.IsEnabled = true;
            TestBtn.Content = L("Settings.TestConnection");
        }
    }

    private void BrowseLocalSttExe_OnClick(object sender, RoutedEventArgs e)
    {
        using var dlg = new Forms.OpenFileDialog
        {
            Filter = "可执行文件 (*.exe)|*.exe|所有文件 (*.*)|*.*",
            Title = "选择 whisper.cpp 可执行文件"
        };
        if (dlg.ShowDialog() == Forms.DialogResult.OK)
            LocalSttExePathBox.Text = dlg.FileName;
    }

    private void BrowseLocalSttModel_OnClick(object sender, RoutedEventArgs e)
    {
        using var dlg = new Forms.OpenFileDialog
        {
            Filter = "模型文件 (*.bin;*.gguf)|*.bin;*.gguf|所有文件 (*.*)|*.*",
            Title = "选择语音模型文件"
        };
        if (dlg.ShowDialog() == Forms.DialogResult.OK)
            LocalSttModelPathBox.Text = dlg.FileName;
    }

    private void ValidateLocalStt_OnClick(object sender, RoutedEventArgs e)
    {
        var options = BuildLocalSttOptionsFromUi();
        if (LocalSpeechToTextService.ValidateOptions(options, out var error))
        {
            MessageBox.Show("本地 STT 配置可用。", L("Msg.Success"), MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }

        MessageBox.Show(error, L("Msg.Hint"), MessageBoxButton.OK, MessageBoxImage.Warning);
    }

    private async void UpdateBtn_OnClick(object sender, RoutedEventArgs e)
    {
        var manifestSource = UpdateManifestUrlBox.Text.Trim();
        var repository = string.IsNullOrWhiteSpace(UpdateGitHubRepoBox.Text)
            ? "TristonLeiCheng/DanceMonkey"
            : UpdateGitHubRepoBox.Text.Trim();
        var assetKeyword = string.IsNullOrWhiteSpace(UpdateAssetKeywordBox.Text)
            ? "win-x64"
            : UpdateAssetKeywordBox.Text.Trim();

        var originalContent = UpdateBtn.Content;
        UpdateBtn.IsEnabled = false;
        UpdateBtn.Content = "Updating...";
        UpdateStatusText.Text = string.IsNullOrWhiteSpace(manifestSource)
            ? "正在检查 GitHub 最新 Release..."
            : "正在检查最新版本...";

        try
        {
            var check = string.IsNullOrWhiteSpace(manifestSource)
                ? await _appUpdateService.CheckForUpdateFromGitHubAsync(repository, assetKeyword)
                : await _appUpdateService.CheckForUpdateAsync(manifestSource);

            if (!check.IsUpdateAvailable || check.Manifest == null)
            {
                UpdateStatusText.Text = $"已是最新版本（v{check.CurrentVersionText}）。";
                return;
            }

            var progress = new Progress<string>(message => UpdateStatusText.Text = message);
            var launchInfo = await _appUpdateService.DownloadAndStageUpdateAsync(check.Manifest, progress);

            var migrating = !AppInstallPathService.PathsEqual(
                launchInfo.InstallDirectory,
                launchInfo.PreviousInstallDirectory);
            var migrateHint = migrating
                ? $"\n\n将迁移到固定目录：\n{launchInfo.InstallDirectory}"
                : "";

            UpdateStatusText.Text = $"已准备升级到 v{check.LatestVersionText}，正在退出并更新...";

            MessageBox.Show(
                $"已准备升级到 v{check.LatestVersionText}。\n程序将退出、替换为最新版本，并在完成后自动重新启动。{migrateHint}",
                "开始升级",
                MessageBoxButton.OK,
                MessageBoxImage.Information);

            _appUpdateService.LaunchUpdaterAndRestart(launchInfo);
            Application.Current.Shutdown();
        }
        catch (Exception ex)
        {
            UpdateStatusText.Text = ex.Message;
            MessageBox.Show(ex.Message, L("Msg.Error"), MessageBoxButton.OK, MessageBoxImage.Error);
        }
        finally
        {
            if (IsLoaded)
            {
                UpdateBtn.IsEnabled = true;
                UpdateBtn.Content = originalContent;
            }
        }
    }

    private SpeechToTextOptions BuildLocalSttOptionsFromUi()
    {
        return new SpeechToTextOptions
        {
            WhisperExePath = LocalSttExePathBox.Text.Trim(),
            ModelPath = LocalSttModelPathBox.Text.Trim(),
            Language = string.IsNullOrWhiteSpace(LocalSttLanguageBox.Text) ? "zh" : LocalSttLanguageBox.Text.Trim(),
            Threads = int.TryParse(LocalSttThreadsBox.Text.Trim(), out var t) ? t : 4,
            AutoPunctuation = LocalSttAutoPunctuationCheck.IsChecked == true,
            TimeoutSeconds = int.TryParse(LocalSttTimeoutBox.Text.Trim(), out var s) ? s : 240
        };
    }

    private static bool TryParseHotkey(string hotkey)
    {
        if (string.IsNullOrWhiteSpace(hotkey))
            return false;

        var modifiers = 0;
        var hasKey = false;
        var parts = hotkey.Split('+', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        foreach (var part in parts)
        {
            var upper = part.ToUpperInvariant();
            switch (upper)
            {
                case "CTRL":
                case "CONTROL":
                case "SHIFT":
                case "ALT":
                case "WIN":
                case "WINDOWS":
                    modifiers++;
                    break;
                default:
                    if (upper.Length == 1 && char.IsLetterOrDigit(upper[0]))
                        hasKey = true;
                    else if (Enum.TryParse<System.Windows.Input.Key>(part, true, out _))
                        hasKey = true;
                    break;
            }
        }

        return modifiers > 0 && hasKey;
    }

    private void ProxyModeCombo_OnSelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        UpdateProxyUiByMode();
    }

    private void UpdateProxyUiByMode()
    {
        var pacMode = ProxyModeCombo.SelectedIndex == 1;
        if (ProxyPacUrlBox != null)
            ProxyPacUrlBox.IsEnabled = pacMode;
        if (ProxyServerBox != null)
            ProxyServerBox.IsEnabled = !pacMode;
        if (ProxyPortBox != null)
            ProxyPortBox.IsEnabled = !pacMode;
        if (ProxyBypassBox != null)
            ProxyBypassBox.IsEnabled = !pacMode;
    }

    private static bool TryValidateHttpOrHttpsUrl(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri))
            return false;
        return uri.Scheme is "http" or "https";
    }

    private static string L(string key) => LocalizationManager.Get(key);
    private static string L(string key, params object[] args) => LocalizationManager.Get(key, args);
}
