using System.CommandLine;
using DanceMonkey.Agent.Core.Models;
using DanceMonkey.Agent.Core.Proxy;
using DanceMonkey.Agent.Core.Runtime;
using Spectre.Console;

namespace DanceMonkey.Cli;

internal static class Program
{
    public static async Task<int> Main(string[] args)
    {
        try
        {
            Console.OutputEncoding = System.Text.Encoding.UTF8;
            Console.InputEncoding = System.Text.Encoding.UTF8;
        }
        catch { /* ignore */ }

        if (OperatingSystem.IsWindows())
            ConsoleHostSupport.TryEnableCjkFont();

        var console = AnsiConsole.Console;

        var promptArg = new Argument<string[]>("prompt", description: "一次性执行的用户输入（可留空进入 REPL）")
        {
            Arity = ArgumentArity.ZeroOrMore,
        };
        var printOpt = new Option<bool>(
            aliases: new[] { "-p", "--print" },
            description: "非交互模式：直接执行并退出，适合脚本 / 管道");
        var cwdOpt = new Option<string?>(
            aliases: new[] { "-C", "--cwd" },
            description: "工作目录（默认当前终端 CWD）");
        var modelOpt = new Option<string?>(
            aliases: new[] { "-m", "--model" },
            description: "覆盖配置里的模型名（也覆盖已加载会话中的模型）");
        var modeOpt = new Option<string?>(
            aliases: new[] { "--mode" },
            description: "权限模式：plan / ask / auto（默认 ask）");
        var maxTokensOpt = new Option<int?>(
            aliases: new[] { "--max-tokens" },
            description: "单轮 LLM 输出上限（覆盖配置 cliMaxTokens，推荐 8192-32768）");
        var yesOpt = new Option<bool>(
            aliases: new[] { "-y", "--yes" },
            description: "一律放行所有审批（等价于 --mode auto）");
        var sandboxOpt = new Option<bool>(
            aliases: new[] { "--sandbox" },
            description: "把工作目录限制到配置里的沙箱路径（%AppData%\\DanceMonkey\\Sandbox）");
        var configOpt = new Option<bool>(
            aliases: new[] { "--show-config" },
            description: "打印配置文件路径并退出");
        var sessionOpt = new Option<string?>(
            aliases: new[] { "-s", "--session" },
            description: "启动时加载已保存会话（文件名、id、autosave 或 .json 绝对路径）");
        var skillOpt = new Option<string[]>(
            aliases: new[] { "--skill" },
            description: "启动时附加启用指定 skill；可重复传入")
        {
            Arity = ArgumentArity.ZeroOrMore,
        };
        var onlySkillOpt = new Option<string[]>(
            aliases: new[] { "--only-skill" },
            description: "启动时仅启用指定 skill；可重复传入")
        {
            Arity = ArgumentArity.ZeroOrMore,
        };
        var noAutosaveOpt = new Option<bool>(
            aliases: new[] { "--no-autosave" },
            getDefaultValue: () => false,
            description: "禁用会话自动保存（REPL 每轮后、无头模式结束后）");
        var formatOpt = new Option<string>(
            aliases: new[] { "-f", "--format" },
            getDefaultValue: () => "text",
            description: "无头模式输出格式：text（默认）或 json");

        var proxyHostOpt = new Option<string>(
            aliases: new[] { "--host" },
            getDefaultValue: () => "127.0.0.1",
            description: "Host to bind for the Codex-compatible proxy.");
        var proxyPortOpt = new Option<int>(
            aliases: new[] { "--port" },
            getDefaultValue: () => 8000,
            description: "Port to bind for the Codex-compatible proxy.");
        var proxyEndpointOpt = new Option<string?>(
            aliases: new[] { "--endpoint", "--chat-endpoint" },
            description: "Upstream Chat Completions endpoint or API root. Defaults to DanceMonkey config.");
        var proxyApiKeyOpt = new Option<string?>(
            aliases: new[] { "--api-key" },
            description: "Upstream API key. Defaults to DanceMonkey config; if empty, inbound Bearer is used.");
        var proxyModelOpt = new Option<string?>(
            aliases: new[] { "--model" },
            description: "Default model when a Responses request does not specify model.");
        var proxyTimeoutOpt = new Option<int>(
            aliases: new[] { "--timeout-seconds" },
            getDefaultValue: () => 300,
            description: "Upstream timeout in seconds.");

        var proxyCmd = new Command("proxy", "Start a local Codex-compatible /v1/responses proxy.")
        {
            proxyHostOpt,
            proxyPortOpt,
            proxyEndpointOpt,
            proxyApiKeyOpt,
            proxyModelOpt,
            proxyTimeoutOpt,
        };

        var root = new RootCommand("DanceMonkey CLI —— Claude-Code 风格的命令行 Agent")
        {
            promptArg,
            printOpt,
            cwdOpt,
            modelOpt,
            modeOpt,
            maxTokensOpt,
            yesOpt,
            sandboxOpt,
            configOpt,
            sessionOpt,
            skillOpt,
            onlySkillOpt,
            noAutosaveOpt,
            formatOpt,
        };

        root.AddCommand(proxyCmd);

        proxyCmd.SetHandler(async ctx =>
        {
            var cfg = CliConfig.Load();
            var host = ctx.ParseResult.GetValueForOption(proxyHostOpt) ?? "127.0.0.1";
            var port = Math.Clamp(ctx.ParseResult.GetValueForOption(proxyPortOpt), 1, 65535);

            var endpoint = ctx.ParseResult.GetValueForOption(proxyEndpointOpt);
            if (string.IsNullOrWhiteSpace(endpoint))
                endpoint = cfg.ApiEndpoint;

            var apiKey = ctx.ParseResult.GetValueForOption(proxyApiKeyOpt);
            if (string.IsNullOrWhiteSpace(apiKey))
                apiKey = cfg.ApiKey;

            var model = ctx.ParseResult.GetValueForOption(proxyModelOpt);
            model = cfg.ResolveModel(model);

            var timeoutSeconds = Math.Clamp(ctx.ParseResult.GetValueForOption(proxyTimeoutOpt), 1, 3600);

            if (string.IsNullOrWhiteSpace(apiKey))
                console.MarkupLine("[yellow]No upstream API key configured; inbound Authorization: Bearer ... will be used.[/]");

            using var server = new CodexResponsesProxyServer(new CodexProxyOptions
            {
                Host = host,
                Port = port,
                ChatCompletionsEndpoint = endpoint ?? "",
                ApiKey = apiKey ?? "",
                DefaultModel = model ?? "gpt-4o-mini",
                UpstreamTimeout = TimeSpan.FromSeconds(timeoutSeconds),
                Log = message => console.MarkupLine($"[grey]{Markup.Escape(message)}[/]"),
            });

            console.MarkupLine("[green]Codex proxy ready.[/]");
            console.MarkupLine($"[grey]Set Codex/OpenAI base URL to [bold]{Markup.Escape(server.LocalBaseUrl + "/v1")}[/][/]");
            console.MarkupLine("[grey]Press Ctrl+C to stop.[/]");

            using var cts = new CancellationTokenSource();
            using var hook = new CtrlCInterrupt(cts);
            try
            {
                await server.RunAsync(cts.Token).ConfigureAwait(false);
                ctx.ExitCode = 0;
            }
            catch (OperationCanceledException)
            {
                ctx.ExitCode = 0;
            }
            catch (Exception ex)
            {
                console.MarkupLine($"[red]Proxy failed: {Markup.Escape(ex.Message)}[/]");
                ctx.ExitCode = 1;
            }
        });

        root.SetHandler(async ctx =>
        {
            if (ctx.ParseResult.GetValueForOption(configOpt))
            {
                var path = CliConfig.ResolveConfigPath();
                console.MarkupLine($"[grey]config: [bold]{Markup.Escape(path)}[/][/]");
                console.MarkupLine(File.Exists(path) ? "[green]存在[/]" : "[yellow]尚未创建（请先在 DanceMonkey 设置里保存一次）[/]");
                console.MarkupLine($"[grey]环境变量可覆盖: {CliEnvironment.EnvApiKey}, {CliEnvironment.EnvEndpoint}, {CliEnvironment.EnvModel}, {CliEnvironment.EnvNotesRoot}[/]");
                ctx.ExitCode = 0;
                return;
            }

            var cfg = CliConfig.Load();
            if (string.IsNullOrWhiteSpace(cfg.ApiKey))
            {
                console.MarkupLine("[red]✖ 没有找到 API Key。[/]");
                console.MarkupLine($"[grey]请在 DanceMonkey 设置里配置，或设置环境变量 {CliEnvironment.EnvApiKey}。[/]");
                console.MarkupLine($"[grey]配置文件: {Markup.Escape(CliConfig.ResolveConfigPath())}[/]");
                ctx.ExitCode = 78;
                return;
            }

            var cwdArg = ctx.ParseResult.GetValueForOption(cwdOpt);
            string workingDir;
            if (ctx.ParseResult.GetValueForOption(sandboxOpt))
            {
                workingDir = cfg.ResolveSandboxRoot();
            }
            else if (!string.IsNullOrWhiteSpace(cwdArg))
            {
                workingDir = Path.GetFullPath(cwdArg!);
                if (!Directory.Exists(workingDir))
                {
                    console.MarkupLine($"[red]✖ 工作目录不存在: {Markup.Escape(workingDir)}[/]");
                    ctx.ExitCode = 1;
                    return;
                }
            }
            else
            {
                workingDir = Environment.CurrentDirectory;
            }

            var yes = ctx.ParseResult.GetValueForOption(yesOpt);
            var modeStr = ctx.ParseResult.GetValueForOption(modeOpt);
            var modelOverride = ctx.ParseResult.GetValueForOption(modelOpt);
            var resolvedModelOverride = string.IsNullOrWhiteSpace(modelOverride) ? null : cfg.ResolveModel(modelOverride);
            var maxTokensOverride = ctx.ParseResult.GetValueForOption(maxTokensOpt);
            var hasModeFlag = yes || !string.IsNullOrWhiteSpace(modeStr);

            AgentMode mode = AgentMode.Ask;
            if (yes)
                mode = AgentMode.Auto;
            else if (!string.IsNullOrWhiteSpace(modeStr) &&
                     Enum.TryParse(modeStr, ignoreCase: true, out AgentMode parsed))
                mode = parsed;
            else if (!string.IsNullOrWhiteSpace(modeStr))
            {
                console.MarkupLine($"[red]✖ 未知模式: {Markup.Escape(modeStr!)}. 可用 plan / ask / auto[/]");
                ctx.ExitCode = 1;
                return;
            }

            var noAutosave = ctx.ParseResult.GetValueForOption(noAutosaveOpt);
            var skillNames = ParseSkillOptionValues(ctx.ParseResult.GetValueForOption(skillOpt));
            var onlySkillNames = ParseSkillOptionValues(ctx.ParseResult.GetValueForOption(onlySkillOpt));
            var fmtRaw = ctx.ParseResult.GetValueForOption(formatOpt) ?? "text";
            var format = fmtRaw.Equals("json", StringComparison.OrdinalIgnoreCase)
                ? CliOutputFormat.Json
                : CliOutputFormat.Text;

            if (skillNames.Count > 0 && onlySkillNames.Count > 0)
            {
                console.MarkupLine("[red]✖ --skill 与 --only-skill 不能同时使用。[/]");
                ctx.ExitCode = 1;
                return;
            }

            var rt = CliAgentFactory.Build(
                workingDir,
                mode,
                autoApproveAll: yes,
                console,
                modelOverride: resolvedModelOverride,
                maxTokensOverride: maxTokensOverride,
                autosaveEnabled: !noAutosave);

            var sessionArg = ctx.ParseResult.GetValueForOption(sessionOpt);
            if (!string.IsNullOrWhiteSpace(sessionArg))
            {
                try
                {
                    var path = CliSessionStore.ResolveSessionPath(sessionArg);
                    var loaded = CliSessionStore.LoadFromFile(path);
                    var merge = CliSessionMerge.ApplyAfterStartupLoad(loaded, workingDir, mode, hasModeFlag, resolvedModelOverride);
                    rt.Session = loaded;
                    if (merge.ChangedFields.Count > 0)
                        console.MarkupLine($"[grey]会话合并覆盖: {Markup.Escape(string.Join("; ", merge.ChangedFields))}[/]");
                }
                catch (Exception ex)
                {
                    console.MarkupLine($"[red]✖ 无法加载会话: {Markup.Escape(ex.Message)}[/]");
                    ctx.ExitCode = 1;
                    return;
                }
            }

            if (!TryApplyStartupSkillSelection(rt, console, skillNames, onlySkillNames))
            {
                ctx.ExitCode = 1;
                return;
            }

            var positional = string.Join(' ', ctx.ParseResult.GetValueForArgument(promptArg) ?? Array.Empty<string>()).Trim();
            string? piped = null;
            if (Console.IsInputRedirected)
            {
                piped = await Console.In.ReadToEndAsync();
                piped = piped?.Trim();
            }

            var printMode = ctx.ParseResult.GetValueForOption(printOpt) ||
                            !string.IsNullOrEmpty(piped) ||
                            !string.IsNullOrEmpty(positional);

            if (printMode)
            {
                var combined = CombinePrompts(positional, piped);
                if (string.IsNullOrWhiteSpace(combined))
                {
                    if (format == CliOutputFormat.Json)
                    {
                        await Console.Out.WriteLineAsync(
                            """{"success":false,"exitCode":1,"error":"没有 prompt 输入"}""").ConfigureAwait(false);
                    }
                    else
                    {
                        console.MarkupLine("[yellow]没有 prompt 输入，退出。[/]");
                    }
                    ctx.ExitCode = 1;
                    return;
                }

                using var cts = new CancellationTokenSource();
                using var hook = new CtrlCInterrupt(cts);
                ctx.ExitCode = await HeadlessRunner.RunAsync(rt, combined, console, cts.Token, format, Console.Out)
                    .ConfigureAwait(false);

                if (!noAutosave)
                {
                    if (!CliSessionStore.TryAutosave(rt.Session, rt.FileSystem.PrimaryRoot, out var autosaveErr))
                        console.MarkupLine($"[yellow]⚠ 自动保存失败: {Markup.Escape(autosaveErr ?? "未知错误")}[/]");
                }
                return;
            }

            if (format == CliOutputFormat.Json)
                console.MarkupLine("[yellow]提示: --format json 仅对无头模式（-p / 管道 / 位置参数）有效；REPL 仍为文本输出。[/]");

            using var appCts = new CancellationTokenSource();
            ctx.ExitCode = await InteractiveRepl.RunAsync(rt, console, appCts.Token).ConfigureAwait(false);
        });

        return await root.InvokeAsync(args);
    }

    private static string CombinePrompts(string positional, string? piped)
    {
        if (string.IsNullOrEmpty(piped)) return positional;
        if (string.IsNullOrEmpty(positional)) return piped!;
        return positional + "\n\n--- stdin ---\n" + piped;
    }

    private static IReadOnlyList<string> ParseSkillOptionValues(string[]? values)
    {
        if (values == null || values.Length == 0)
            return Array.Empty<string>();

        return values
            .SelectMany(v => (v ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            .Where(v => !string.IsNullOrWhiteSpace(v))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    private static bool TryApplyStartupSkillSelection(
        CliAgentFactory.Runtime rt,
        IAnsiConsole console,
        IReadOnlyList<string> skillNames,
        IReadOnlyList<string> onlySkillNames)
    {
        var requested = onlySkillNames.Count > 0 ? onlySkillNames : skillNames;
        if (requested.Count == 0)
            return true;

        if (rt.Skills.Count == 0)
        {
            console.MarkupLine("[red]✖ 当前未加载到任何 skill，无法应用 --skill/--only-skill。可先用 /skill doctor 检查搜索根。[/]");
            return false;
        }

        var missing = requested
            .Where(name => !rt.Skills.TryGet(name, out _))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        if (missing.Length > 0)
        {
            console.MarkupLine($"[red]✖ 未找到 skill:[/] {Markup.Escape(string.Join(", ", missing))}");
            console.MarkupLine($"[grey]已加载: {Markup.Escape(string.Join(", ", rt.Skills.All.OrderBy(s => s.Name, StringComparer.OrdinalIgnoreCase).Select(s => s.Name)))}[/]");
            return false;
        }

        if (onlySkillNames.Count > 0)
        {
            rt.Session.EnabledSkills.Clear();
            foreach (var name in onlySkillNames)
                rt.Session.EnabledSkills.Add(name);
            return true;
        }

        if (rt.Session.EnabledSkills.Contains(AgentRunner.DisabledAllSkillsMarker))
            rt.Session.EnabledSkills.Remove(AgentRunner.DisabledAllSkillsMarker);

        foreach (var name in skillNames)
            rt.Session.EnabledSkills.Add(name);

        return true;
    }
}
