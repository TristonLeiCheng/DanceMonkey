using System.Windows;
using System.Windows.Controls;
using DesktopAssistant.Models;
using DesktopAssistant.Services;

namespace DesktopAssistant.Views;

public partial class CodexProxyView : UserControl
{
    private bool _loaded;
    private bool _busy;

    public CodexProxyView()
    {
        InitializeComponent();
        PopulateModelCombo();
        App.CodexProxy.StateChanged += CodexProxy_OnStateChanged;
    }

    private void PopulateModelCombo()
    {
        ModelCombo.Items.Clear();
        foreach (var model in CodexIntegrationService.PresetCodexModels)
            ModelCombo.Items.Add(new ComboBoxItem { Content = model, Tag = model });
    }

    private void CodexProxyView_OnLoaded(object sender, RoutedEventArgs e)
    {
        EnsureConfigLoaded();
        RefreshStatus();
    }

    public async Task StartProxyFromShortcutAsync()
    {
        EnsureConfigLoaded();

        if (App.CodexProxy.IsRunning)
        {
            RefreshStatus();
            AppendLog("中转站已在运行。");
            return;
        }

        await StartProxyAsync(showMessage: false);
    }

    private async void StartBtn_OnClick(object sender, RoutedEventArgs e)
    {
        await StartProxyAsync(showMessage: true);
    }

    private void StopBtn_OnClick(object sender, RoutedEventArgs e)
    {
        App.CodexProxy.Stop();
        AppendLog("中转站已停止。");
        RefreshStatus();
    }

    private void CopyBaseUrlBtn_OnClick(object sender, RoutedEventArgs e)
    {
        var baseUrl = CurrentBaseUrl();
        Clipboard.SetText(baseUrl);
        AppendLog("已复制 Codex Base URL: " + baseUrl);
    }

    private void ApplyCodexConfigBtn_OnClick(object sender, RoutedEventArgs e)
    {
        var config = SaveConfigFromInputs();
        if (config == null)
            return;

        var result = CodexIntegrationService.WriteCodexConfig(config);
        LogCodexSetup(result);
        if (result.Success)
        {
            MessageBox.Show(
                string.Join(Environment.NewLine, result.Messages),
                "Codex 配置已写入",
                MessageBoxButton.OK,
                MessageBoxImage.Information);
        }
        else
        {
            MessageBox.Show(
                result.Error ?? "写入失败",
                "Codex 配置",
                MessageBoxButton.OK,
                MessageBoxImage.Warning);
        }

        RefreshStatus(config);
    }

    private void ApplyNoProxyBtn_OnClick(object sender, RoutedEventArgs e)
    {
        var result = CodexIntegrationService.ApplyNoProxyManual();
        LogCodexSetup(result);
        if (result.Success)
        {
            MessageBox.Show(
                string.Join(Environment.NewLine, result.Messages),
                "NO_PROXY 已设置",
                MessageBoxButton.OK,
                MessageBoxImage.Information);
        }
        else
        {
            MessageBox.Show(
                result.Error ?? "设置失败",
                "NO_PROXY",
                MessageBoxButton.OK,
                MessageBoxImage.Warning);
        }

        RefreshStatus();
    }

    private void RestoreCodexConfigBtn_OnClick(object sender, RoutedEventArgs e)
    {
        var confirm = MessageBox.Show(
            "将移除 config.toml 中由 DanceMonkey 注入的 DM Proxy 配置块。\n不会自动恢复之前被注释的旧配置。\n\n是否继续？",
            "恢复 Codex 默认",
            MessageBoxButton.YesNo,
            MessageBoxImage.Question);
        if (confirm != MessageBoxResult.Yes)
            return;

        var result = CodexIntegrationService.RestoreCodexConfigDefault();
        LogCodexSetup(result);
        if (result.Success)
        {
            MessageBox.Show(
                string.Join(Environment.NewLine, result.Messages),
                "已恢复 Codex 默认",
                MessageBoxButton.OK,
                MessageBoxImage.Information);
        }
        else
        {
            MessageBox.Show(
                result.Error ?? "恢复失败",
                "恢复 Codex 默认",
                MessageBoxButton.OK,
                MessageBoxImage.Warning);
        }

        RefreshStatus();
    }

    private async Task StartProxyAsync(bool showMessage)
    {
        if (_busy)
            return;

        EnsureConfigLoaded();
        var config = SaveConfigFromInputs();
        if (config == null)
            return;

        _busy = true;
        SetButtonsEnabled();
        try
        {
            AppendLog("正在启动 Codex API 中转站...");
            await App.CodexProxy.StartAsync(config);
            AppendLog("已启动: " + App.CodexProxy.ResponsesUrl);
            LogCodexSetup(App.CodexProxy.LastCodexSetup);
            RefreshStatus();
        }
        catch (Exception ex)
        {
            AppendLog("启动失败: " + ex.Message);
            if (showMessage)
            {
                MessageBox.Show(
                    ex.Message,
                    "Codex API 中转站启动失败",
                    MessageBoxButton.OK,
                    MessageBoxImage.Error);
            }
        }
        finally
        {
            _busy = false;
            SetButtonsEnabled();
        }
    }

    private void LoadConfig()
    {
        var cfg = App.Config.Load();
        HostBox.Text = string.IsNullOrWhiteSpace(cfg.CodexProxyHost) ? "127.0.0.1" : cfg.CodexProxyHost;
        PortBox.Text = (cfg.CodexProxyPort is >= 1 and <= 65535 ? cfg.CodexProxyPort : 8000).ToString();
        EndpointBox.Text = cfg.ApiEndpoint ?? "";
        ApiKeyBox.Password = cfg.ApiKey ?? "";
        TimeoutBox.Text = (cfg.CodexProxyTimeoutSeconds > 0 ? cfg.CodexProxyTimeoutSeconds : 300).ToString();
        CodexAutoConfigureCheck.IsChecked = cfg.CodexAutoConfigure;
        SelectModel(ResolveModelFromConfig(cfg));
        SelectReasoningEffort(string.IsNullOrWhiteSpace(cfg.CodexModelReasoningEffort)
            ? CodexIntegrationService.DefaultReasoningEffort
            : cfg.CodexModelReasoningEffort);
        SelectReasoningSummary(cfg.CodexModelReasoningSummary);
        ContextWindowBox.Text = (cfg.CodexModelContextWindow > 0 ? cfg.CodexModelContextWindow : 1_000_000).ToString();
        CompactLimitBox.Text = (cfg.CodexModelAutoCompactTokenLimit > 0 ? cfg.CodexModelAutoCompactTokenLimit : 900_000).ToString();
        CodexConfigPathText.Text = CodexIntegrationService.ConfigTomlPath;
        RefreshStatus();
    }

    private static string ResolveModelFromConfig(AppConfig cfg) =>
        CodexIntegrationService.ResolveCodexModel(cfg);

    private void SelectModel(string? value)
    {
        var model = string.IsNullOrWhiteSpace(value)
            ? CodexIntegrationService.DefaultCodexModel
            : value.Trim();

        var matched = false;
        foreach (var item in ModelCombo.Items.OfType<ComboBoxItem>())
        {
            var tag = item.Tag?.ToString() ?? item.Content?.ToString() ?? "";
            if (tag.Equals(model, StringComparison.OrdinalIgnoreCase))
            {
                ModelCombo.SelectedItem = item;
                matched = true;
                break;
            }
        }

        if (!matched)
        {
            ModelCombo.SelectedItem = null;
            ModelCombo.Text = model;
        }
    }

    private static string GetModelInput(ComboBox combo)
    {
        if (combo.SelectedItem is ComboBoxItem item)
        {
            var fromTag = item.Tag?.ToString();
            if (!string.IsNullOrWhiteSpace(fromTag))
                return fromTag.Trim();

            return item.Content?.ToString()?.Trim() ?? "";
        }

        return combo.Text.Trim();
    }

    private void SelectReasoningEffort(string? value)
    {
        var normalized = string.IsNullOrWhiteSpace(value) ? "" : value.Trim().ToLowerInvariant();
        foreach (var item in ReasoningEffortCombo.Items.OfType<ComboBoxItem>())
        {
            var tag = item.Tag?.ToString() ?? "";
            item.IsSelected = tag.Equals(normalized, StringComparison.OrdinalIgnoreCase);
        }
    }

    private void SelectReasoningSummary(string? value)
    {
        var normalized = string.IsNullOrWhiteSpace(value) ? "" : value.Trim().ToLowerInvariant();
        foreach (var item in ReasoningSummaryCombo.Items.OfType<ComboBoxItem>())
        {
            var tag = item.Tag?.ToString() ?? "";
            item.IsSelected = tag.Equals(normalized, StringComparison.OrdinalIgnoreCase);
        }
    }

    private static string? GetSelectedComboTag(ComboBox combo)
    {
        if (combo.SelectedItem is ComboBoxItem item)
            return item.Tag?.ToString();

        return null;
    }

    private void EnsureConfigLoaded()
    {
        if (_loaded)
            return;

        LoadConfig();
        _loaded = true;
    }

    private AppConfig? SaveConfigFromInputs()
    {
        var cfg = App.Config.Load();

        var host = string.IsNullOrWhiteSpace(HostBox.Text) ? "127.0.0.1" : HostBox.Text.Trim();
        if (!int.TryParse(PortBox.Text.Trim(), out var port) || port is < 1 or > 65535)
        {
            MessageBox.Show("请输入 1-65535 之间的监听端口。", "Codex API 中转站", MessageBoxButton.OK, MessageBoxImage.Warning);
            return null;
        }

        if (!int.TryParse(TimeoutBox.Text.Trim(), out var timeoutSeconds) || timeoutSeconds is < 1 or > 3600)
        {
            MessageBox.Show("请输入 1-3600 之间的超时时间。", "Codex API 中转站", MessageBoxButton.OK, MessageBoxImage.Warning);
            return null;
        }

        cfg.CodexProxyHost = host;
        cfg.CodexProxyPort = port;
        cfg.CodexProxyTimeoutSeconds = timeoutSeconds;
        cfg.ApiEndpoint = EndpointBox.Text.Trim();
        cfg.ApiKey = ApiKeyBox.Password.Trim();
        cfg.Model = GetModelInput(ModelCombo);
        if (string.IsNullOrWhiteSpace(cfg.Model))
            cfg.Model = CodexIntegrationService.DefaultCodexModel;
        cfg.CodexModel = "";
        cfg.CodexAutoConfigure = CodexAutoConfigureCheck.IsChecked == true;
        cfg.CodexModelReasoningEffort = GetSelectedComboTag(ReasoningEffortCombo) ?? "";
        cfg.CodexModelReasoningSummary = GetSelectedComboTag(ReasoningSummaryCombo) ?? "";

        if (!int.TryParse(ContextWindowBox.Text.Trim(), out var contextWindow) || contextWindow < 1)
        {
            MessageBox.Show("请输入有效的上下文窗口（正整数）。", "Codex 配置", MessageBoxButton.OK, MessageBoxImage.Warning);
            return null;
        }

        if (!int.TryParse(CompactLimitBox.Text.Trim(), out var compactLimit) || compactLimit < 1)
        {
            MessageBox.Show("请输入有效的自动压缩阈值（正整数）。", "Codex 配置", MessageBoxButton.OK, MessageBoxImage.Warning);
            return null;
        }

        cfg.CodexModelContextWindow = contextWindow;
        cfg.CodexModelAutoCompactTokenLimit = compactLimit;

        if (!App.Config.Save(cfg))
        {
            MessageBox.Show("保存配置失败，请检查配置文件权限。", "Codex API 中转站", MessageBoxButton.OK, MessageBoxImage.Error);
            return null;
        }

        RefreshStatus(cfg);
        return cfg;
    }

    private void RefreshStatus(AppConfig? config = null)
    {
        config ??= App.Config.Load();
        var running = App.CodexProxy.IsRunning;
        var baseUrl = running ? App.CodexProxy.LocalBaseUrl + "/v1" : CodexProxyDesktopService.BuildBaseUrl(config);
        var responsesUrl = running ? App.CodexProxy.ResponsesUrl : baseUrl.TrimEnd('/') + "/responses";
        var upstream = running ? App.CodexProxy.ChatEndpoint : (string.IsNullOrWhiteSpace(config.ApiEndpoint) ? "默认 OpenAI Chat Completions" : config.ApiEndpoint);

        StatusText.Text = running ? "运行中" : "未启动";
        StatusDetailText.Text = App.CodexProxy.LastError ?? (running ? App.CodexProxy.StatusMessage : "点击启动后，Codex 可连接到本地 /v1/responses。");
        StatusBadge.Background = (System.Windows.Media.Brush)(TryFindResource(running ? "BrushAccentMuted" : "BrushSurfaceMuted")
                                                             ?? System.Windows.Media.Brushes.Transparent);

        BaseUrlText.Text = baseUrl;
        ResponsesUrlText.Text = responsesUrl;
        UpstreamText.Text = upstream;
        var codexModel = CodexIntegrationService.ResolveCodexModel(config);
        EnvBox.Text =
            $"NO_PROXY={CodexIntegrationService.NoProxyValue}{Environment.NewLine}" +
            $"model_provider={CodexIntegrationService.ProviderId}{Environment.NewLine}" +
            $"base_url={baseUrl}{Environment.NewLine}" +
            $"model={codexModel}";
        CodexConfigPathText.Text = CodexIntegrationService.ConfigTomlPath;
        SetButtonsEnabled();
    }

    private string CurrentBaseUrl()
    {
        if (App.CodexProxy.IsRunning)
            return App.CodexProxy.LocalBaseUrl + "/v1";

        if (!int.TryParse(PortBox.Text.Trim(), out var port) || port is < 1 or > 65535)
            port = 8000;
        var host = string.IsNullOrWhiteSpace(HostBox.Text) ? "127.0.0.1" : HostBox.Text.Trim();
        return $"http://{host}:{port}/v1";
    }

    private void SetButtonsEnabled()
    {
        var running = App.CodexProxy.IsRunning;
        StartBtn.IsEnabled = !_busy && !running;
        StopBtn.IsEnabled = !_busy && running;
        CopyBaseUrlBtn.IsEnabled = !_busy;
    }

    private void AppendLog(string message)
    {
        LogBox.AppendText($"[{DateTime.Now:HH:mm:ss}] {message}{Environment.NewLine}");
        LogBox.ScrollToEnd();
    }

    private void LogCodexSetup(CodexIntegrationService.ApplyResult? result)
    {
        if (result == null)
            return;

        if (!result.Success)
        {
            AppendLog("Codex 自动配置失败: " + result.Error);
            return;
        }

        foreach (var message in result.Messages)
            AppendLog("Codex: " + message);
    }

    private void CodexProxy_OnStateChanged(object? sender, EventArgs e)
    {
        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.Invoke(() => RefreshStatus());
            return;
        }

        RefreshStatus();
    }
}
