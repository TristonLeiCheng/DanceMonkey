using DanceMonkey.Agent.Core.Proxy;
using DesktopAssistant.Models;

namespace DesktopAssistant.Services;

public sealed class CodexProxyDesktopService : IDisposable
{
    private readonly object _gate = new();
    private CodexResponsesProxyServer? _server;
    private CancellationTokenSource? _cts;
    private Task? _runTask;

    public event EventHandler? StateChanged;

    public bool IsRunning
    {
        get
        {
            lock (_gate)
                return _server != null && _cts is { IsCancellationRequested: false } && _runTask is { IsCompleted: false };
        }
    }

    public string LocalBaseUrl
    {
        get
        {
            lock (_gate)
                return _server?.LocalBaseUrl ?? "";
        }
    }

    public string ResponsesUrl
    {
        get
        {
            lock (_gate)
                return _server?.ResponsesUrl ?? "";
        }
    }

    public string ChatEndpoint
    {
        get
        {
            lock (_gate)
                return _server?.ChatEndpoint ?? "";
        }
    }

    public string StatusMessage { get; private set; } = "未启动";
    public string? LastError { get; private set; }

    public async Task StartAsync(AppConfig config)
    {
        if (IsRunning)
            return;

        Stop();

        var host = string.IsNullOrWhiteSpace(config.CodexProxyHost)
            ? "127.0.0.1"
            : config.CodexProxyHost.Trim();
        var port = config.CodexProxyPort is >= 1 and <= 65535 ? config.CodexProxyPort : 8000;
        var model = string.IsNullOrWhiteSpace(config.Model) ? "gpt-4o-mini" : config.Model.Trim();
        var timeoutSeconds = config.CodexProxyTimeoutSeconds is >= 1 and <= 3600
            ? config.CodexProxyTimeoutSeconds
            : 300;

        var server = new CodexResponsesProxyServer(new CodexProxyOptions
        {
            Host = host,
            Port = port,
            ChatCompletionsEndpoint = config.ApiEndpoint ?? "",
            ApiKey = config.ApiKey ?? "",
            DefaultModel = model,
            UpstreamTimeout = TimeSpan.FromSeconds(timeoutSeconds),
            Log = message =>
            {
                StatusMessage = message;
                StateChanged?.Invoke(this, EventArgs.Empty);
            }
        });

        var cts = new CancellationTokenSource();
        Task runTask;
        lock (_gate)
        {
            _server = server;
            _cts = cts;
            LastError = null;
            StatusMessage = "正在启动...";
            runTask = server.RunAsync(cts.Token);
            _runTask = runTask;
        }

        _ = runTask.ContinueWith(t =>
        {
            lock (_gate)
            {
                if (!ReferenceEquals(_server, server))
                    return;

                if (t.IsFaulted)
                {
                    LastError = t.Exception?.GetBaseException().Message;
                    StatusMessage = "启动失败";
                }
                else if (t.IsCanceled || cts.IsCancellationRequested)
                {
                    StatusMessage = "已停止";
                }
                else
                {
                    StatusMessage = "已停止";
                }

                server.Dispose();
                cts.Dispose();
                _server = null;
                _cts = null;
                _runTask = null;
            }

            StateChanged?.Invoke(this, EventArgs.Empty);
        }, TaskScheduler.Default);

        await Task.Delay(200).ConfigureAwait(false);
        if (runTask.IsFaulted)
        {
            var error = runTask.Exception?.GetBaseException().Message ?? "启动失败";
            Stop();
            throw new InvalidOperationException(error);
        }

        StatusMessage = $"运行中：{server.ResponsesUrl}";
        StateChanged?.Invoke(this, EventArgs.Empty);
    }

    public void Stop()
    {
        CodexResponsesProxyServer? server;
        CancellationTokenSource? cts;
        lock (_gate)
        {
            server = _server;
            cts = _cts;
            _server = null;
            _cts = null;
            _runTask = null;
            StatusMessage = "已停止";
        }

        try { cts?.Cancel(); } catch (ObjectDisposedException) { }
        server?.Stop();
        server?.Dispose();
        cts?.Dispose();
        StateChanged?.Invoke(this, EventArgs.Empty);
    }

    public static string BuildBaseUrl(AppConfig config)
    {
        var host = string.IsNullOrWhiteSpace(config.CodexProxyHost)
            ? "127.0.0.1"
            : config.CodexProxyHost.Trim();
        var port = config.CodexProxyPort is >= 1 and <= 65535 ? config.CodexProxyPort : 8000;
        return $"http://{host}:{port}/v1";
    }

    public void Dispose() => Stop();
}
