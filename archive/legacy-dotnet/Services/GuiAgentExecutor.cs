using System.Net;
using System.Text;
using System.Text.Json;
using System.Windows;
using System.Windows.Threading;
using DanceMonkey.Agent.Core.Models;
using DanceMonkey.Agent.Core.Runtime;
using DesktopAssistant.Models;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace DesktopAssistant.Services;

/// <summary>GUI Agent 单轮执行结果。</summary>
public sealed class GuiAgentTurnResult
{
    public bool Success { get; init; }
    public string? FinalAssistantText { get; init; }
    public string? Error { get; init; }
    public AgentSession Session { get; init; } = null!;
    public IReadOnlyList<GuiAgentSink.ToolEventRecord> ToolEvents { get; init; } = Array.Empty<GuiAgentSink.ToolEventRecord>();
}

/// <summary>GUI / GlobalChat 共用的 Agent 单轮执行与 WebView 流式 UI 辅助。</summary>
public static class GuiAgentExecutor
{
    public static async Task<GuiAgentTurnResult> RunTurnAsync(
        AppConfig cfg,
        AgentSession? session,
        AgentMode mode,
        string question,
        GuiAgentSink sink,
        CancellationToken ct,
        Window? owner = null,
        string? sessionsDirectory = null,
        IReadOnlyList<AgentImagePart>? images = null)
    {
        var runtime = GuiAgentFactory.Build(cfg, session, mode, owner);
        session = runtime.Session;

        var result = await runtime.Runner.RunTurnAsync(session, question, sink, ct, images).ConfigureAwait(false);

        var saveDir = sessionsDirectory ?? AgentSessionStore.GuiAiChatSessionsDirectory;
        AgentSessionStore.TryAutosave(
            session,
            saveDir,
            runtime.FileSystem.PrimaryRoot,
            out _);

        return new GuiAgentTurnResult
        {
            Success = result.Success,
            FinalAssistantText = result.FinalAssistantText,
            Error = result.Error,
            Session = session,
            ToolEvents = sink.ToolEvents,
        };
    }

    public static async Task AppendAgentStreamingBubbleAsync(WebView2 chatWeb)
    {
        var thinking = WebUtility.HtmlEncode("思考中…");
        var label = WebUtility.HtmlEncode("助手");
        const string jsTemplate = """
(function(){
  var d=document.createElement('div');
  d.className='msg assistant streaming';
  d.innerHTML='<div class="msg-avatar">AI</div>'+
              '<div class="msg-body">'+
                '<div class="msg-header"><span class="label">__LABEL__</span></div>'+
                '<div id="tool-timeline" class="tool-timeline"></div>'+
                '<div class="md" id="streaming-bubble"><span class="typing"><i></i><i></i><i></i></span> <span class="typing-text">__THINKING__</span></div>'+
              '</div>';
  document.body.appendChild(d);
  window.scrollTo(0,document.documentElement.scrollHeight);
})();
""";
        var js = jsTemplate
            .Replace("__LABEL__", label, StringComparison.Ordinal)
            .Replace("__THINKING__", thinking, StringComparison.Ordinal);
        if (chatWeb.CoreWebView2 != null)
            await chatWeb.CoreWebView2.ExecuteScriptAsync(js).ConfigureAwait(false);
    }

    public static async Task UpdateStreamingBubbleAsync(WebView2 chatWeb, string htmlBody)
    {
        var jsonStr = JsonSerializer.Serialize(htmlBody);
        var js = "var el=document.getElementById('streaming-bubble');if(el){el.innerHTML=" + jsonStr + ";window.scrollTo(0,document.documentElement.scrollHeight);}";
        if (chatWeb.CoreWebView2 != null)
            await chatWeb.CoreWebView2.ExecuteScriptAsync(js).ConfigureAwait(false);
    }

    public static GuiAgentSink CreateSink(
        Dispatcher dispatcher,
        WebView2? web,
        StringBuilder fullText)
    {
        return new GuiAgentSink(
            dispatcher,
            web,
            chunk =>
            {
                fullText.Append(chunk);
                var htmlBody = MarkdownHtml.ToHtmlBody(fullText.ToString());
                dispatcher.InvokeAsync(() =>
                {
                    if (web != null)
                        _ = UpdateStreamingBubbleAsync(web, htmlBody);
                });
            });
    }

    /// <summary>将工具事件转为聊天 turn 文本行。</summary>
    public static IEnumerable<string> FormatToolEventLines(IEnumerable<GuiAgentSink.ToolEventRecord> events)
    {
        foreach (var ev in events)
        {
            var icon = ev.Success ? "✓" : "✗";
            var line = $"{icon} {ev.Summary}";
            if (!string.IsNullOrWhiteSpace(ev.Detail))
                line += " — " + ev.Detail;
            yield return line;
        }
    }
}
