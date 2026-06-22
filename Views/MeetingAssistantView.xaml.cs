using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using DesktopAssistant.Services;
using Microsoft.Web.WebView2.Core;

namespace DesktopAssistant.Views;

public partial class MeetingAssistantView : UserControl
{
    private static readonly JsonSerializerOptions WebJsonOptions = new()
    {
        PropertyNameCaseInsensitive = true
    };

    private readonly MeetingHubService _hub = new();
    private bool _webReady;
    private bool _messageHooked;

    public MeetingAssistantView()
    {
        InitializeComponent();
        Loaded += async (_, _) =>
        {
            _hub.Initialize();
            await EnsureWebAsync();
        };
    }

    public void Reload()
    {
        _hub.Initialize();
        _ = PushStateAsync();
    }

    private async Task EnsureWebAsync()
    {
        if (_webReady) return;
        await HubWeb.EnsureCoreWebView2Async(null);
        if (HubWeb.CoreWebView2 == null) return;
        if (!_messageHooked)
        {
            HubWeb.CoreWebView2.WebMessageReceived += HubWeb_OnWebMessageReceived;
            HubWeb.NavigationCompleted += async (_, _) =>
            {
                _webReady = true;
                await PushStateAsync();
            };
            _messageHooked = true;
        }
        var htmlPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "Assets", "meeting-hub.html");
        HubWeb.Source = new Uri(htmlPath);
    }

    private async void HubWeb_OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            var message = JsonSerializer.Deserialize<HubWebMessage>(e.WebMessageAsJson, WebJsonOptions);
            if (message?.Type == null) return;
            await _hub.HandleAsync(message);
            if (message.Type == "libEmail")
                (Application.Current.MainWindow as MainWindow)?.ShowAndSwitch(AppPage.Email);
            await PushStateAsync();
        }
        catch (Exception ex)
        {
            await HubWeb.ExecuteScriptAsync(
                $"window.MeetingHub && window.MeetingHub.showError({JsonSerializer.Serialize(ex.Message)});");
        }
    }

    private async Task PushStateAsync()
    {
        if (!_webReady || HubWeb.CoreWebView2 == null) return;
        var json = JsonSerializer.Serialize(_hub.BuildWebState(), WebJsonOptions);
        await HubWeb.ExecuteScriptAsync($"window.MeetingHub && window.MeetingHub.receiveState({json});");
    }
}
