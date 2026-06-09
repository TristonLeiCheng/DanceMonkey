using DanceMonkey.Agent.Core.Abstractions;
using DanceMonkey.Agent.Core.Models;
using Spectre.Console;

namespace DanceMonkey.Cli;

/// <summary>
/// 终端审批提示：把 <see cref="ApprovalRequest"/> 变成一个选单。
/// 非交互模式（<c>--yes</c> 或 Auto 模式）不会走到这里。
/// </summary>
internal sealed class SpectreApprovalPrompt : IApprovalPrompt
{
    private readonly IAnsiConsole _console;

    public SpectreApprovalPrompt(IAnsiConsole console)
    {
        _console = console;
    }

    public Task<ApprovalDecision> AskAsync(ApprovalRequest request, AgentSession session, CancellationToken ct)
    {
        _console.WriteLine();

        var riskColor = request.Risk switch
        {
            ToolRiskLevel.ReadOnly => "grey",
            ToolRiskLevel.Write => "yellow",
            ToolRiskLevel.Shell => "orange1",
            ToolRiskLevel.Dangerous => "red",
            _ => "white",
        };

        var panel = new Panel(new Markup(
            $"[bold]工具:[/] {Escape(request.Tool)}\n" +
            $"[bold]风险:[/] [{riskColor}]{request.Risk}[/]\n" +
            $"[bold]操作:[/] {Escape(request.Summary)}" +
            (string.IsNullOrWhiteSpace(request.Details) ? "" : $"\n\n{Escape(request.Details!)}")))
        {
            Header = new PanelHeader("[bold yellow]需要审批[/]"),
            Border = BoxBorder.Rounded,
            BorderStyle = new Style(Color.Yellow),
        };
        _console.Write(panel);

        var choice = _console.Prompt(
            new SelectionPrompt<string>()
                .Title("如何处理？")
                .HighlightStyle(new Style(Color.Cyan1))
                .AddChoices(
                    "允许一次",
                    string.IsNullOrEmpty(request.Scope) ? "允许（本次会话内始终放行此类操作）" : $"允许并本次会话始终放行（{request.Scope}）",
                    "拒绝"
                ));

        ApprovalDecision decision = choice.StartsWith("允许一次") ? ApprovalDecision.AllowOnce
            : choice.StartsWith("拒绝") ? ApprovalDecision.Reject
            : ApprovalDecision.AllowSessionScope;

        return Task.FromResult(decision);
    }

    private static string Escape(string s) => Markup.Escape(s ?? "");
}
