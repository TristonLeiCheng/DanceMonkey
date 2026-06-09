using System.Text.Json;
using System.Text.Json.Serialization;
using DanceMonkey.Agent.Core.Runtime;
using Spectre.Console;

namespace DanceMonkey.Cli;

/// <summary>
/// 无头/单次执行模式：跑一轮 Agent，输出到终端或 JSON。
/// </summary>
internal static class HeadlessRunner
{
    private static readonly JsonSerializerOptions JsonOutOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = false,
    };

    public static async Task<int> RunAsync(
        CliAgentFactory.Runtime rt,
        string prompt,
        IAnsiConsole console,
        CancellationToken ct,
        CliOutputFormat format,
        TextWriter stdout)
    {
        if (format == CliOutputFormat.Json)
        {
            var sink = new CliJsonRecordingSink();
            try
            {
                var result = await rt.Runner.RunTurnAsync(rt.Session, prompt, sink, ct).ConfigureAwait(false);
                var exit = result.Success ? 0 : 1;
                var tools = sink.Tools.Where(t => t.Completed).ToList();

                var payload = new HeadlessJsonOutput
                {
                    Success = result.Success,
                    ExitCode = exit,
                    Error = result.Success ? null : result.Error,
                    Session = new JsonSessionInfo
                    {
                        Id = rt.Session.Id,
                        ApproxTokens = rt.Session.ApproxTokens,
                        MessageCount = rt.Session.Messages.Count,
                    },
                    Result = new JsonRunResult
                    {
                        FinalAssistantText = result.FinalAssistantText ?? sink.AssistantFull,
                        ApproxTokens = result.ApproxTokens,
                        StepsUsed = result.StepsUsed,
                    },
                    Tools = tools,
                };

                await stdout.WriteLineAsync(JsonSerializer.Serialize(payload, JsonOutOpts)).ConfigureAwait(false);
                return exit;
            }
            catch (OperationCanceledException)
            {
                await WriteJsonErrorAsync(stdout, 130, "已取消", rt).ConfigureAwait(false);
                return 130;
            }
            catch (Exception ex)
            {
                await WriteJsonErrorAsync(stdout, 2, ex.Message, rt).ConfigureAwait(false);
                return 2;
            }
        }

        var textSink = new SpectreAgentSink(console);
        try
        {
            var result = await rt.Runner.RunTurnAsync(rt.Session, prompt, textSink, ct).ConfigureAwait(false);
            console.WriteLine();
            if (!result.Success)
            {
                if (!string.IsNullOrWhiteSpace(result.Error))
                    console.MarkupLine($"[red]✖ {Markup.Escape(result.Error!)}[/]");
                if (string.Equals(result.Error, AgentRunner.IncompleteToolCallsError, StringComparison.Ordinal))
                    console.WriteLine(ContinuationPromptHelper.BuildTemplate(prompt));
                return 1;
            }
            return 0;
        }
        catch (OperationCanceledException)
        {
            console.MarkupLine("[yellow]⏹ 已中断[/]");
            return 130;
        }
        catch (Exception ex)
        {
            console.MarkupLine($"[red]✖ 异常: {Markup.Escape(ex.Message)}[/]");
            return 2;
        }
    }

    private static async Task WriteJsonErrorAsync(TextWriter stdout, int exitCode, string message, CliAgentFactory.Runtime rt)
    {
        var payload = new HeadlessJsonOutput
        {
            Success = false,
            ExitCode = exitCode,
            Error = message,
            Session = new JsonSessionInfo
            {
                Id = rt.Session.Id,
                ApproxTokens = rt.Session.ApproxTokens,
                MessageCount = rt.Session.Messages.Count,
            },
        };
        await stdout.WriteLineAsync(JsonSerializer.Serialize(payload, JsonOutOpts)).ConfigureAwait(false);
    }
}

internal enum CliOutputFormat
{
    Text,
    Json,
}
