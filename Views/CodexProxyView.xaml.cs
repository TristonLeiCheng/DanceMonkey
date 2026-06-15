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
        App.CodexProxy.StateChanged += CodexProxy_OnStateChanged;
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
        ModelBox.Text = string.IsNullOrWhiteSpace(cfg.Model) ? "gpt-4o-mini" : cfg.Model;
        TimeoutBox.Text = (cfg.CodexProxyTimeoutSeconds > 0 ? cfg.CodexProxyTimeoutSeconds : 300).ToString();
        CodexAutoConfigureCheck.IsChecked = cfg.CodexAutoConfigure;
        CodexModelBox.Text = string.IsNullOrWhiteSpace(cfg.CodexModel)
            ? CodexIntegrationService.ResolveCodexModel(cfg)
            : cfg.CodexModel;
        SelectReasoningEffort(cfg.CodexModelReasoningEffort);
        CodexConfigPathText.Text = CodexIntegrationService.ConfigTomlPath;
        RefreshStatus();
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

    private static string? GetSelectedReasoningEffort(ComboBox combo)
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
        cfg.Model = string.IsNullOrWhiteSpace(ModelBox.Text) ? "gpt-4o-mini" : ModelBox.Text.Trim();
        cfg.CodexAutoConfigure = CodexAutoConfigureCheck.IsChecked == true;
        cfg.CodexModel = CodexModelBox.Text.Trim();
        cfg.CodexModelReasoningEffort = GetSelectedReasoningEffort(ReasoningEffortCombo) ?? "";

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
        var codexApiKey = string.IsNullOrWhiteSpace(ApiKeyBox.Password)
            ? "<your-upstream-api-key>"
            : CodexIntegrationService.PlaceholderApiKey;
        EnvBox.Text =
            $"OPENAI_BASE_URL={baseUrl}{Environment.NewLine}" +
            $"OPENAI_API_KEY={codexApiKey}{Environment.NewLine}" +
            $"NO_PROXY={CodexIntegrationService.MergeProxyBypass(null)}";
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
