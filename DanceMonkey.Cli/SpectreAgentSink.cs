using System.Text;
using System.Text.RegularExpressions;
using DanceMonkey.Agent.Core.Abstractions;
using DanceMonkey.Agent.Core.Models;
using Spectre.Console;

namespace DanceMonkey.Cli;

/// <summary>
/// 把 AgentRunner 的事件渲染到终端。
/// 助手回复按行缓冲，将常见 Markdown 转为 Spectre Markup；围栏代码块以灰色面板显示。
/// 工具调用走彩色面板、错误红色强调。
/// </summary>
internal sealed class SpectreAgentSink : IAgentSink
{
    private const int MaxUnflushedBeforeRawDump = 4096;

    private readonly IAnsiConsole _console;
    private bool _inAssistantStream;
    private readonly StringBuilder _pending = new();
    private bool _inFence;
    private int _fenceOpenLen;
    private readonly StringBuilder _fenceCode = new();

    public SpectreAgentSink(IAnsiConsole console)
    {
        _console = console;
    }

    public void OnAssistantChunk(string chunk)
    {
        if (!_inAssistantStream)
        {
            _inAssistantStream = true;
            _console.Markup("[cyan]⏺[/] ");
        }

        if (string.IsNullOrEmpty(chunk)) return;

        _pending.Append(chunk.Replace("\r\n", "\n", StringComparison.Ordinal).Replace("\r", "\n", StringComparison.Ordinal));
        if (_inFence) DrainFence();
        else DrainLines();

        if (!_inFence && _pending.Length > MaxUnflushedBeforeRawDump)
            DumpPendingAsRaw("仍无换行，已原样输出后续片段以避免终端长时间无反馈。");
    }

    public void OnAssistantCompleted(string full)
    {
        _ = full;
        if (_inAssistantStream)
        {
            if (_inFence)
            {
                if (_pending.Length > 0)
                {
                    _fenceCode.Append(_pending);
                    _pending.Clear();
                }
                WriteCodeFencePanel();
                _inFence = false;
                _fenceCode.Clear();
            }
            else
            {
                if (_pending.Length > 0)
                {
                    var tail = _pending.ToString();
                    _pending.Clear();
                    try
                    {
                        _console.MarkupLine(CliMarkdownToSpectre.LineToMarkup(tail));
                    }
                    catch
                    {
                        _console.WriteLine(Spectre.Console.Markup.Escape(tail));
                    }
                }
            }

            _console.WriteLine();
        }
        _inAssistantStream = false;
    }

    public void OnToolStart(ToolRequest request, string summary)
    {
        TryFlushOrphanStreamState();
        _console.MarkupLine($"[cyan]●[/] [bold]{Esc(request.Tool)}[/] [grey]{Esc(summary)}[/]");
    }

    public void OnToolEnd(ToolRequest request, ToolResult result)
    {
        var text = result.Display ?? result.Output ?? "";
        if (string.IsNullOrWhiteSpace(text))
        {
            var tag = result.Success ? "[green]ok[/]" : result.Rejected ? "[yellow]rejected[/]" : "[red]fail[/]";
            _console.MarkupLine($"  ⎿  {tag}");
            return;
        }

        var lines = text.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n');
        const int maxLines = 20;
        var shown = lines.Take(maxLines);
        foreach (var line in shown)
        {
            _console.MarkupLine($"  [grey]⎿[/]  {Esc(line)}");
        }
        if (lines.Length > maxLines)
            _console.MarkupLine($"  [grey]⎿  … ({lines.Length - maxLines} more lines)[/]");

        if (!result.Success && !result.Rejected)
            _console.MarkupLine("  [red]⎿  failed[/]");
    }

    public void OnStatus(string text)
    {
        TryFlushOrphanStreamState();
        _console.MarkupLine($"[grey]∙ {Esc(text)}[/]");
    }

    public void OnWarning(string text)
    {
        TryFlushOrphanStreamState();
        _console.MarkupLine($"[yellow]⚠ {Esc(text)}[/]");
    }

    public void OnError(string text)
    {
        FlushPendingOnInterrupt();
        _console.MarkupLine($"[red]✖ {Esc(text)}[/]");
    }

    /// <summary>工具/状态等插入前，若因异常尚未结束流式，则把缓冲区写出。</summary>
    private void TryFlushOrphanStreamState() => FlushPendingOnInterrupt();

    /// <summary>中断或错误时：尽量输出已缓冲的助手文本（含未闭合围栏）。</summary>
    private void FlushPendingOnInterrupt()
    {
        if (!_inAssistantStream) return;

        if (_inFence)
        {
            if (_pending.Length > 0)
            {
                _fenceCode.Append(_pending);
                _pending.Clear();
            }
            WriteCodeFencePanel();
            _inFence = false;
            _fenceCode.Clear();
        }
        else if (_pending.Length > 0)
        {
            var tail = _pending.ToString();
            _pending.Clear();
            try
            {
                _console.MarkupLine(CliMarkdownToSpectre.LineToMarkup(tail));
            }
            catch
            {
                _console.WriteLine(Spectre.Console.Markup.Escape(tail));
            }
        }

        _console.WriteLine();
        _inAssistantStream = false;
    }

    private void DrainLines()
    {
        while (true)
        {
            var idx = _pending.ToString().IndexOf('\n', StringComparison.Ordinal);
            if (idx < 0) return;

            var line = _pending.ToString(0, idx);
            _pending.Remove(0, idx + 1);

            if (TryStartFence(line))
            {
                _inFence = true;
                DrainFence();
            }
            else
            {
                try
                {
                    _console.MarkupLine(CliMarkdownToSpectre.LineToMarkup(line));
                }
                catch
                {
                    _console.WriteLine(Spectre.Console.Markup.Escape(line));
                }
            }
        }
    }

    // 围栏：开头为 ```{lang} 或 ```；结束行为至少等长、仅 backtick 的行
    private static readonly Regex FenceOpen = new(
        @"^(\s*)(`{3,})\s*(\S*)\s*$",
        RegexOptions.Compiled);

    private void DrainFence()
    {
        while (true)
        {
            if (!_inFence) return;
            var idx = _pending.ToString().IndexOf('\n', StringComparison.Ordinal);
            if (idx < 0) return;

            var line = _pending.ToString(0, idx);
            _pending.Remove(0, idx + 1);

            if (IsClosingFenceLine(line))
            {
                WriteCodeFencePanel();
                _inFence = false;
                _fenceCode.Clear();
                return;
            }

            if (_fenceCode.Length > 0) _fenceCode.Append('\n');
            _fenceCode.Append(line);
        }
    }

    private static bool IsFenceOpen(string line, out int tickLen)
    {
        tickLen = 0;
        var m = FenceOpen.Match(line);
        if (!m.Success) return false;
        tickLen = m.Groups[2].Value.Length;
        return true;
    }

    private static bool IsClosingFenceString(string line, int needLen)
    {
        var t = line.Trim();
        if (t.Length < needLen) return false;
        for (var i = 0; i < t.Length; i++)
        {
            if (t[i] != '`') return false;
        }
        return t.Length >= needLen;
    }

    private bool TryStartFence(string line)
    {
        if (!IsFenceOpen(line, out var n)) return false;
        _fenceOpenLen = n;
        return true;
    }

    private bool IsClosingFenceLine(string line) => IsClosingFenceString(line, _fenceOpenLen);

    private void WriteCodeFencePanel()
    {
        var body = _fenceCode.ToString();
        var panel = new Panel(Spectre.Console.Markup.Escape(body))
        {
            Border = BoxBorder.Heavy,
            BorderStyle = new Style(Color.Grey),
        };
        _console.Write(panel);
        _console.WriteLine();
    }

    private void DumpPendingAsRaw(string note)
    {
        if (_pending.Length == 0) return;
        _console.WriteLine();
        if (!string.IsNullOrEmpty(note))
        {
            _console.MarkupLine($"[grey]（{Spectre.Console.Markup.Escape(note)}）[/]");
        }
        _console.Write(_pending.ToString());
        _pending.Clear();
    }

    private static string Esc(string s) => Spectre.Console.Markup.Escape(s ?? "");
}
