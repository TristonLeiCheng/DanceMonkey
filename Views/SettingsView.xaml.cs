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

    private readonly ObservableCollection<QuickLinkItem> _quickLinks = new();
    private readonly ObservableCollection<PromptSnippetItem> _promptSnippets = new();
    private readonly ObservableCollection<ModelProfileItem> _modelProfiles = new();
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

        // 健康提醒
        TodoReminderCheck.IsChecked = config.TodoReminderEnabled;
        TodoReminderIntervalBox.Text = config.TodoReminderMinutes.ToString();
        HealthReminderCheck.IsChecked = config.HealthReminderEnabled;
        WaterIntervalBox.Text = config.WaterReminderMinutes.ToString();
        MovementIntervalBox.Text = config.MovementReminderMinutes.ToString();
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
            _quickLinks.Add(new QuickLinkItem { Name = l.Name, Path = l.Path });

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

        // 健康提醒
        config.TodoReminderEnabled = TodoReminderCheck.IsChecked == true;
        if (int.TryParse(TodoReminderIntervalBox.Text.Trim(), out var todoMinutes) && todoMinutes >= 5 && todoMinutes <= 240)
            config.TodoReminderMinutes = todoMinutes;
        config.HealthReminderEnabled = HealthReminderCheck.IsChecked == true;
        if (int.TryParse(WaterIntervalBox.Text.Trim(), out var water) && water >= 5 && water <= 240)
            config.WaterReminderMinutes = water;
        if (int.TryParse(MovementIntervalBox.Text.Trim(), out var move) && move >= 10 && move <= 240)
            config.MovementReminderMinutes = move;

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

        config.QuickLinks = _quickLinks.Select(l => new QuickLinkItem { Name = l.Name, Path = l.Path }).ToList();
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
        if (string.IsNullOrWhiteSpace(manifestSource))
        {
            MessageBox.Show("请先配置在线升级清单 URL。", L("Msg.Hint"), MessageBoxButton.OK,
                MessageBoxImage.Warning);
            return;
        }

        var originalContent = UpdateBtn.Content;
        UpdateBtn.IsEnabled = false;
        UpdateBtn.Content = "Updating...";
        UpdateStatusText.Text = "正在检查最新版本...";

        try
        {
            var check = await _appUpdateService.CheckForUpdateAsync(manifestSource);
            if (!check.IsUpdateAvailable || check.Manifest == null)
            {
                UpdateStatusText.Text = $"已是最新版本（v{check.CurrentVersionText}）。";
                return;
            }

            var progress = new Progress<string>(message => UpdateStatusText.Text = message);
            var launchInfo = await _appUpdateService.DownloadAndStageUpdateAsync(check.Manifest, progress);
            UpdateStatusText.Text = $"已准备升级到 v{check.LatestVersionText}，正在退出并更新...";

            MessageBox.Show(
                $"已准备升级到 v{check.LatestVersionText}。\n程序将退出、替换为最新版本，并在完成后自动重新启动。",
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
