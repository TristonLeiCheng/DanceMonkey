using System.Windows.Threading;
using DanceMonkey.Agent.Core.Abstractions;
using DanceMonkey.Agent.Core.Models;
using Microsoft.Web.WebView2.Wpf;

namespace DesktopAssistant.Services;

/// <summary>
/// GUI Agent 事件接收器：流式文本 + 工具调用时间线（WebView2 实时更新）。
/// </summary>
public sealed class GuiAgentSink : IAgentSink
{
    private readonly Dispatcher _dispatcher;
    private readonly WebView2? _web;
    private readonly Action<string>? _onChunk;
    private int _toolLineId;

    public GuiAgentSink(
        Dispatcher dispatcher,
        WebView2? web,
        Action<string>? onChunk = null)
    {
        _dispatcher = dispatcher;
        _web = web;
        _onChunk = onChunk;
    }

    /// <summary>本轮工具调用摘要（成功/失败），供刷新历史视图。</summary>
    public List<ToolEventRecord> ToolEvents { get; } = new();

    public sealed record ToolEventRecord(string Summary, bool Success, string? Detail);

    public void OnAssistantChunk(string chunk) => _onChunk?.Invoke(chunk);

    public void OnAssistantCompleted(string fullText) { }

    public void OnToolStart(ToolRequest request, string summary)
    {
        _toolLineId++;
        var id = _toolLineId;
        AgentAuditLog.ToolStart(request.Tool, summary);
        ToolEvents.Add(new ToolEventRecord(summary, false, null));
        _dispatcher.InvokeAsync(() => AppendToolLineAsync(id, summary, running: true));
    }

    public void OnToolEnd(ToolRequest request, ToolResult result)
    {
        AgentAuditLog.ToolEnd(request.Tool, result.Success, result.Display ?? result.Output);
        if (ToolEvents.Count > 0)
        {
            var last = ToolEvents[^1];
            ToolEvents[^1] = last with
            {
                Success = result.Success,
                Detail = Truncate(result.Display ?? result.Output, 200),
            };
        }

        var id = _toolLineId;
        var icon = result.Success ? "✓" : "✗";
        var text = $"{icon} {request.Tool}: {Truncate(result.Display ?? result.Output, 120)}";
        _dispatcher.InvokeAsync(() => UpdateToolLineAsync(id, result.Success, text));
    }

    public void OnStatus(string message) { }

    public void OnWarning(string message)
    {
        _dispatcher.InvokeAsync(() => AppendToolLineAsync(++_toolLineId, $"⚠ {message}", running: false, warn: true));
    }

    public void OnError(string message)
    {
        _dispatcher.InvokeAsync(() => AppendToolLineAsync(++_toolLineId, $"✗ {message}", running: false, warn: true));
    }

    private async void AppendToolLineAsync(int id, string text, bool running, bool warn = false)
    {
        if (_web?.CoreWebView2 == null) return;
        var cls = running ? "running" : warn ? "warn" : "ok";
        var json = System.Text.Json.JsonSerializer.Serialize(text);
        var js = "(function(){" +
                 "var tl=document.getElementById('tool-timeline');" +
                 "if(!tl) return;" +
                 "var line=document.createElement('div');" +
                 "line.className='tool-line " + cls + "';" +
                 "line.id='tool-line-" + id + "';" +
                 "line.textContent=" + json + ";" +
                 "tl.appendChild(line);" +
                 "window.scrollTo(0,document.documentElement.scrollHeight);" +
                 "})();";
        try { await _web.CoreWebView2.ExecuteScriptAsync(js).ConfigureAwait(false); }
        catch { /* WebView 可能已销毁 */ }
    }

    private async void UpdateToolLineAsync(int id, bool success, string text)
    {
        if (_web?.CoreWebView2 == null) return;
        var cls = success ? "ok" : "fail";
        var json = System.Text.Json.JsonSerializer.Serialize(text);
        var js = "(function(){" +
                 "var line=document.getElementById('tool-line-" + id + "');" +
                 "if(!line) return;" +
                 "line.className='tool-line " + cls + "';" +
                 "line.textContent=" + json + ";" +
                 "window.scrollTo(0,document.documentElement.scrollHeight);" +
                 "})();";
        try { await _web.CoreWebView2.ExecuteScriptAsync(js).ConfigureAwait(false); }
        catch { /* ignore */ }
    }

    private static string Truncate(string? s, int max)
    {
        if (string.IsNullOrEmpty(s)) return "";
        s = s.Replace('\r', ' ').Replace('\n', ' ').Trim();
        return s.Length <= max ? s : s[..max] + "…";
    }
}
