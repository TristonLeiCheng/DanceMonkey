using DanceMonkey.Agent.Core.Models;
using DanceMonkey.Agent.Core.Runtime;
using Spectre.Console;
using System.Security.Cryptography;
using System.Text;

namespace DanceMonkey.Cli;

/// <summary>
/// Claude-Code 风格的交互式 REPL。
/// </summary>
internal static class InteractiveRepl
{
    public static async Task<int> RunAsync(CliAgentFactory.Runtime rt, IAnsiConsole console, CancellationToken appCt)
    {
        PrintBanner(console, rt);

        while (!appCt.IsCancellationRequested)
        {
            // 读一行用户输入。支持 \ 结尾续行。
            var input = ReadUserLine(console);
            if (input == null) break; // Ctrl+D / EOF
            if (string.IsNullOrWhiteSpace(input)) continue;

            // 斜杠命令
            if (input.StartsWith('/'))
            {
                if (HandleSlashCommand(input.Trim(), rt, console, out var shouldExit))
                {
                    if (shouldExit) return 0;
                    continue;
                }
            }

            // 一轮 Agent 调用
            using var turnCts = CancellationTokenSource.CreateLinkedTokenSource(appCt);
            using var ctrlcHandler = new CtrlCInterrupt(turnCts);

            var sink = new SpectreAgentSink(console);
            try
            {
                var result = await rt.Runner.RunTurnAsync(rt.Session, input, sink, turnCts.Token);
                console.WriteLine();
                if (!result.Success && !string.IsNullOrWhiteSpace(result.Error))
                {
                    console.MarkupLine($"[red]✖ {Markup.Escape(result.Error!)}[/]");
                    if (string.Equals(result.Error, AgentRunner.IncompleteToolCallsError, StringComparison.Ordinal))
                        console.WriteLine(ContinuationPromptHelper.BuildTemplate(input));
                }
            }
            catch (OperationCanceledException)
            {
                console.WriteLine();
                console.MarkupLine("[yellow]⏹ 已中断本轮任务（Ctrl+C）[/]");
            }
            catch (Exception ex)
            {
                console.WriteLine();
                console.MarkupLine($"[red]✖ 异常: {Markup.Escape(ex.Message)}[/]");
            }
            finally
            {
                if (rt.AutosaveEnabled)
                    WarnAutosaveIfFailed(console, rt.Session, rt.FileSystem.PrimaryRoot);
            }
        }
        return 0;
    }

    private static void ListSessions(IAnsiConsole console)
    {
        var items = CliSessionStore.ListSavedSessions();
        if (items.Count == 0)
        {
            console.MarkupLine($"[grey]目录 {Markup.Escape(CliSessionStore.SessionsDirectory)} 下暂无会话文件。[/]");
            return;
        }

        console.MarkupLine($"[grey]{Markup.Escape(CliSessionStore.SessionsDirectory)}[/]");
        foreach (var x in items)
        {
            var title = string.IsNullOrWhiteSpace(x.Title) ? "—" : x.Title;
            console.MarkupLine(
                $"  [cyan]{Markup.Escape(x.FileStem)}[/]  " +
                $"{x.SavedAtUtc:yyyy-MM-dd HH:mm}  " +
                $"id=[grey]{Markup.Escape(x.SessionId)}[/]  " +
                $"{Markup.Escape(title)}");
        }
    }

    private static void PrintBanner(IAnsiConsole console, CliAgentFactory.Runtime rt)
    {
        console.WriteLine();
        console.Write(new FigletText("DanceMonkey").Color(Color.MediumPurple));
        console.MarkupLine($"[grey]交互式 Agent  ·  模型 [bold]{Markup.Escape(rt.Session.Model ?? "default")}[/]  ·  模式 [bold]{rt.Session.Mode}[/][/]");
        console.MarkupLine($"[grey]cwd（终端工作区）: {Markup.Escape(rt.FileSystem.PrimaryRoot)}[/]");
        console.MarkupLine($"[grey]笔记库（notes/ 前缀）: {Markup.Escape(rt.FileSystem.NotesRoot)}[/]");
        console.MarkupLine($"[grey]Zen Task（Journal）: {Markup.Escape(rt.DancePaths.JournalDirectory)}[/]");
        console.MarkupLine($"[grey]Skills: {rt.Skills.Count}（输入 /skills 查看）[/]");
        console.MarkupLine($"[grey]会话目录: {Markup.Escape(CliSessionStore.SessionsDirectory)}[/]");
        console.MarkupLine($"[grey]输入 [bold]/help[/] 查看命令，[bold]/exit[/] 退出。空行跳过。行尾加 [bold]\\[/] 可续行。[/]");
        console.WriteLine();
    }

    /// <summary>读一行用户输入，支持行尾 <c>\</c> 续行和 Ctrl+D 结束。</summary>
    private static string? ReadUserLine(IAnsiConsole console)
    {
        console.Markup("[bold cyan]›[/] ");
        var line = Console.ReadLine();
        if (line == null) return null;

        // 续行：行尾反斜杠。
        var buffer = new System.Text.StringBuilder();
        while (line.EndsWith('\\'))
        {
            buffer.Append(line.AsSpan(0, line.Length - 1)).Append('\n');
            console.Markup("[bold cyan]…[/] ");
            var next = Console.ReadLine();
            if (next == null) break;
            line = next;
        }
        buffer.Append(line);
        return buffer.ToString();
    }

    /// <summary>
    /// 处理斜杠命令。返回 true 表示已处理；通过 <paramref name="shouldExit"/> 指示是否退出。
    /// </summary>
    private static bool HandleSlashCommand(string cmd, CliAgentFactory.Runtime rt, IAnsiConsole console, out bool shouldExit)
    {
        shouldExit = false;
        var parts = cmd.Split(' ', 2, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var head = parts[0].ToLowerInvariant();
        var arg = parts.Length > 1 ? parts[1] : "";

        switch (head)
        {
            case "/help":
            case "/?":
                ShowHelp(console);
                return true;

            case "/exit":
            case "/quit":
                shouldExit = true;
                console.MarkupLine("[grey]bye.[/]");
                return true;

            case "/clear":
                rt.Session.Messages.Clear();
                rt.Session.AllowedScopes.Clear();
                rt.Session.ApproxTokens = 0;
                console.MarkupLine("[grey]∙ 会话已清空[/]");
                if (rt.AutosaveEnabled)
                    WarnAutosaveIfFailed(console, rt.Session, rt.FileSystem.PrimaryRoot);
                return true;

            case "/sessions":
                ListSessions(console);
                return true;

            case "/save":
            {
                var stem = string.IsNullOrWhiteSpace(arg) ? CliSessionStore.SanitizeFileStem(rt.Session.Id) : CliSessionStore.SanitizeFileStem(arg);
                var path = Path.Combine(CliSessionStore.SessionsDirectory, stem + ".json");
                try
                {
                    CliSessionStore.SaveToFile(rt.Session, path, rt.FileSystem.PrimaryRoot);
                    console.MarkupLine($"[grey]已保存: {Markup.Escape(path)}[/]");
                }
                catch (Exception ex)
                {
                    console.MarkupLine($"[red]✖ {Markup.Escape(ex.Message)}[/]");
                }
                return true;
            }

            case "/load":
            case "/resume":
            {
                if (string.IsNullOrWhiteSpace(arg))
                {
                    console.MarkupLine("[yellow]用法: /load <文件名、id 或 autosave>[/]");
                    return true;
                }
                try
                {
                    var path = CliSessionStore.ResolveSessionPath(arg.Trim());
                    var loaded = CliSessionStore.LoadFromFile(path);
                    var merge = CliSessionMerge.ApplyAfterStartupLoad(
                        loaded,
                        rt.FileSystem.PrimaryRoot,
                        rt.Session.Mode,
                        cliSpecifiesMode: false,
                        modelOverride: null);
                    rt.Session = loaded;
                    console.MarkupLine($"[grey]已加载会话 [bold]{Markup.Escape(loaded.Id)}[/]，消息 {loaded.Messages.Count} 条。目录: {Markup.Escape(loaded.WorkingDirectory)}[/]");
                    if (merge.ChangedFields.Count > 0)
                        console.MarkupLine($"[grey]会话合并覆盖: {Markup.Escape(string.Join("; ", merge.ChangedFields))}[/]");
                }
                catch (Exception ex)
                {
                    console.MarkupLine($"[red]✖ {Markup.Escape(ex.Message)}[/]");
                }
                return true;
            }

            case "/new":
            {
                var m = rt.Session.Mode;
                var md = rt.Session.Model;
                var wd = rt.FileSystem.PrimaryRoot;
                rt.Session = new AgentSession
                {
                    Mode = m,
                    Model = md,
                    WorkingDirectory = wd,
                };
                console.MarkupLine($"[grey]新建会话: [bold]{Markup.Escape(rt.Session.Id)}[/][/]");
                if (rt.AutosaveEnabled)
                    WarnAutosaveIfFailed(console, rt.Session, rt.FileSystem.PrimaryRoot);
                return true;
            }

            case "/model":
                if (string.IsNullOrEmpty(arg))
                    console.MarkupLine($"[grey]当前模型: {Markup.Escape(rt.Session.Model ?? "default")}[/]");
                else
                {
                    rt.Session.Model = CliConfig.Load().ResolveModel(arg);
                    console.MarkupLine($"[grey]模型已切换: {Markup.Escape(arg)}[/]");
                }
                return true;

            case "/mode":
                if (string.IsNullOrEmpty(arg))
                {
                    console.MarkupLine($"[grey]当前模式: {rt.Session.Mode}. 可用: plan / ask / auto[/]");
                }
                else if (Enum.TryParse<AgentMode>(arg, ignoreCase: true, out var m))
                {
                    rt.Session.Mode = m;
                    console.MarkupLine($"[grey]模式已切换: {m}[/]");
                }
                else
                {
                    console.MarkupLine($"[yellow]未知模式: {Markup.Escape(arg)}. 可用: plan / ask / auto[/]");
                }
                return true;

            case "/cwd":
            case "/pwd":
                console.MarkupLine($"[grey]终端工作区: {Markup.Escape(rt.FileSystem.PrimaryRoot)}[/]");
                console.MarkupLine($"[grey]笔记库根: {Markup.Escape(rt.FileSystem.NotesRoot)}[/]");
                return true;

            case "/notes":
                NotesTasksListCommands.ListNotes(rt.DancePaths, console);
                return true;

            case "/tasks":
                NotesTasksListCommands.ListTasks(rt.DancePaths, console);
                return true;

            case "/tools":
                console.MarkupLine("[bold]可用工具:[/]");
                foreach (var t in rt.Tools.All.OrderBy(x => x.Name))
                {
                    var desc = t.Description.Split('\n').FirstOrDefault()?.Trim() ?? "";
                    console.MarkupLine($"  [cyan]{Markup.Escape(t.Name)}[/] [grey]{Markup.Escape(desc)}[/]");
                }
                return true;

            case "/skills":
                ShowSkills(console, rt);
                return true;

            case "/skill":
                HandleSkillCommand(console, rt, arg);
                return true;

            case "/cost":
            case "/tokens":
                console.MarkupLine($"[grey]近似 tokens: {rt.Session.ApproxTokens}[/]");
                return true;

            case "/tree":
                try
                {
                    var tree = rt.FileSystem.RenderTree(3);
                    console.WriteLine(tree);
                }
                catch (Exception ex)
                {
                    console.MarkupLine($"[red]✖ {Markup.Escape(ex.Message)}[/]");
                }
                return true;

            default:
                console.MarkupLine($"[yellow]未知命令: {Markup.Escape(head)}. 输入 /help 看支持列表。[/]");
                return true;
        }
    }

    private static void ShowHelp(IAnsiConsole console)
    {
        // 不用 Table：Spectre Markup 把字符 | 当语法（如链接），plan|ask|auto、| /resume 会抛异常。
        console.WriteLine();
        console.MarkupLine("[bold]斜杠命令[/]");
        HelpLine(console, "/help", "显示本帮助");
        HelpLine(console, "/exit、/quit", "退出 REPL");
        HelpLine(console, "/clear", "清空当前会话历史");
        HelpLine(console, "/model <name>", "查看或切换模型");
        HelpLine(console, "/mode plan·ask·auto", "查看或切换权限模式");
        HelpLine(console, "/cwd", "显示终端工作区与笔记库根路径");
        HelpLine(console, "/notes", "列出笔记库下全部 .md（按修改时间，最多 800 条）");
        HelpLine(console, "/tasks", "列出 Zen Task 项目与任务（Journal/*.json）");
        HelpLine(console, "/tools", "列出可用工具");
        HelpLine(console, "/skills", "列出已加载 skill 与启用状态");
        HelpLine(console, "/skill on|off|only|clear|disable-all <name>", "启用/关闭/仅启用/清空选择/全部禁用技能");
        HelpLine(console, "/skill import <path|url>", "导入本地 skill 或远程 markdown 到项目技能库");
        HelpLine(console, "/skill reload", "重新扫描 skill 目录");
        HelpLine(console, "/skill doctor", "显示 skill 来源、搜索根与启用状态");
        HelpLine(console, "/tree", "打印工作目录树");
        HelpLine(console, "/cost、/tokens", "近似 token 消耗");
        HelpLine(console, "/sessions", "列出已保存的会话文件");
        HelpLine(console, "/save [名]", "保存当前会话（默认用会话 id 作文件名）");
        HelpLine(console, "/load、/resume <名>", "从文件加载会话（可写 autosave）");
        HelpLine(console, "/new", "新建空会话（保留当前模型/模式）");
        console.WriteLine();
        console.MarkupLine("[grey]行尾 \\ 可续行；Ctrl+C 中断当前任务。[/]");
        console.WriteLine();
    }

    private static void HelpLine(IAnsiConsole console, string cmd, string desc)
    {
        console.MarkupLine($"  [cyan]{Markup.Escape(cmd)}[/]  {Markup.Escape(desc)}");
    }

    private static void ShowSkills(IAnsiConsole console, CliAgentFactory.Runtime rt)
    {
        if (rt.Skills.Count == 0)
        {
            console.MarkupLine("[grey]当前未发现任何 skill（可放在 .dancemonkey/skills/*/SKILL.md）。[/]");
            return;
        }

        var allDisabled = rt.Session.EnabledSkills.Contains(AgentRunner.DisabledAllSkillsMarker);
        var autoMode = rt.Session.EnabledSkills.Count == 0;

        console.MarkupLine("[bold]Skills:[/]");
        foreach (var s in rt.Skills.All.OrderBy(x => x.Name, StringComparer.OrdinalIgnoreCase))
        {
            var enabled = !allDisabled && rt.Session.EnabledSkills.Contains(s.Name);
            var flag = enabled ? "[green]●[/]" : autoMode && s.Activation != SkillActivationMode.Manual ? "[yellow]◇[/]" : "[grey]○[/]";
            var state = enabled ? "enabled" : autoMode && s.Activation != SkillActivationMode.Manual ? "auto" : "disabled";
            var summary = string.IsNullOrWhiteSpace(s.EffectiveDescription) ? "" : $" [grey]{Markup.Escape(s.EffectiveDescription)}[/]";
            console.MarkupLine($"  {flag} [cyan]{Markup.Escape(s.Name)}[/] [grey]{state}[/]{summary}");
        }
    }

    private static void HandleSkillCommand(IAnsiConsole console, CliAgentFactory.Runtime rt, string arg)
    {
        var parts = arg.Split(' ', 2, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (parts.Length == 0)
        {
            console.MarkupLine("[yellow]用法: /skill on|off|only|clear|disable-all|import|reload|doctor <name>[/]");
            return;
        }

        if (parts[0].Equals("clear", StringComparison.OrdinalIgnoreCase))
        {
            rt.Session.EnabledSkills.Clear();
            console.MarkupLine("[grey]已清空 skill 选择，下轮会按 description/triggers 自动匹配 skill。[/]");
            return;
        }

        if (parts[0].Equals("disable-all", StringComparison.OrdinalIgnoreCase))
        {
            rt.Session.EnabledSkills.Clear();
            rt.Session.EnabledSkills.Add(AgentRunner.DisabledAllSkillsMarker);
            console.MarkupLine("[grey]已禁用所有 skill（直到再次 on/only 或 clear 恢复默认选择）。[/]");
            return;
        }

        if (parts[0].Equals("reload", StringComparison.OrdinalIgnoreCase))
        {
            rt.ReloadSkills();
            console.MarkupLine($"[grey]已重载 skills：{rt.Skills.Count}[/]");
            return;
        }

        if (parts[0].Equals("doctor", StringComparison.OrdinalIgnoreCase))
        {
            ShowSkillDoctor(console, rt);
            return;
        }

        if (parts.Length < 2)
        {
            console.MarkupLine("[yellow]缺少 skill 名称。[/]");
            return;
        }

        if (parts[0].Equals("import", StringComparison.OrdinalIgnoreCase))
        {
            try
            {
                var source = parts[1];
                var imported = IsHttpUrl(source)
                    ? SkillCatalog.ImportFromUrl(source, rt.FileSystem.PrimaryRoot, maxBytes: 512 * 1024, timeout: TimeSpan.FromSeconds(10))
                    : SkillCatalog.ImportLocal(source, rt.FileSystem.PrimaryRoot);
                rt.ReloadSkills();
                rt.Session.EnabledSkills.Add(imported.Name);
                console.MarkupLine($"[green]已导入 skill:[/] [cyan]{Markup.Escape(imported.Name)}[/]");
                console.MarkupLine($"[grey]{Markup.Escape(imported.SourcePath)}[/]");
                if (IsHttpUrl(source))
                    console.MarkupLine($"[grey]sha256: {Markup.Escape(Sha256Hex(imported.Content))}[/]");
            }
            catch (Exception ex)
            {
                console.MarkupLine($"[red]✖ 导入失败: {Markup.Escape(ex.Message)}[/]");
            }
            return;
        }

        var name = parts[1];
        if (!rt.Skills.TryGet(name, out var skill))
        {
            console.MarkupLine($"[yellow]未找到 skill: {Markup.Escape(name)}（输入 /skills 查看）[/]");
            return;
        }

        if (parts[0].Equals("on", StringComparison.OrdinalIgnoreCase))
        {
            rt.Session.EnabledSkills.Remove(AgentRunner.DisabledAllSkillsMarker);
            rt.Session.EnabledSkills.Add(skill.Name);
            console.MarkupLine($"[grey]已启用 skill: {Markup.Escape(skill.Name)}[/]");
            return;
        }

        if (parts[0].Equals("off", StringComparison.OrdinalIgnoreCase))
        {
            rt.Session.EnabledSkills.Remove(skill.Name);
            console.MarkupLine($"[grey]已关闭 skill: {Markup.Escape(skill.Name)}[/]");
            return;
        }

        if (parts[0].Equals("only", StringComparison.OrdinalIgnoreCase))
        {
            rt.Session.EnabledSkills.Clear();
            rt.Session.EnabledSkills.Remove(AgentRunner.DisabledAllSkillsMarker);
            rt.Session.EnabledSkills.Add(skill.Name);
            console.MarkupLine($"[grey]仅启用 skill: {Markup.Escape(skill.Name)}[/]");
            return;
        }

        console.MarkupLine("[yellow]用法: /skill on|off|only|clear|disable-all|import|reload|doctor <name>[/]");
    }

    private static bool IsHttpUrl(string value) =>
        Uri.TryCreate(value, UriKind.Absolute, out var uri) &&
        (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps);

    private static void WarnAutosaveIfFailed(IAnsiConsole console, AgentSession session, string primaryRoot)
    {
        if (CliSessionStore.TryAutosave(session, primaryRoot, out var err)) return;
        console.MarkupLine($"[yellow]⚠ 自动保存失败: {Markup.Escape(err ?? "未知错误")}[/]");
    }

    private static void ShowSkillDoctor(IAnsiConsole console, CliAgentFactory.Runtime rt)
    {
        console.MarkupLine("[bold]Skill Doctor[/]");
        console.MarkupLine("[grey]搜索根（按顺序，后者可覆盖前者同名 skill）:[/]");
        foreach (var root in rt.SkillRoots)
        {
            var exists = Directory.Exists(root);
            console.MarkupLine($"  {(exists ? "[green]●[/]" : "[grey]○[/]")} {Markup.Escape(root)}");
        }

        if (rt.Skills.Count == 0)
        {
            console.MarkupLine("[yellow]当前未加载到任何 skill。[/]");
            return;
        }

        console.MarkupLine("[grey]已加载 skills:[/]");
        foreach (var s in rt.Skills.All.OrderBy(x => x.Name, StringComparer.OrdinalIgnoreCase))
        {
            var allDisabled = rt.Session.EnabledSkills.Contains(AgentRunner.DisabledAllSkillsMarker);
            var autoMode = rt.Session.EnabledSkills.Count == 0;
            var enabled = !allDisabled && rt.Session.EnabledSkills.Contains(s.Name);
            var state = enabled ? "[green]enabled[/]" : autoMode && s.Activation != SkillActivationMode.Manual ? "[yellow]auto[/]" : "[grey]disabled[/]";
            console.MarkupLine($"  [cyan]{Markup.Escape(s.Name)}[/] {state}");
            if (!string.IsNullOrWhiteSpace(s.EffectiveDescription))
                console.MarkupLine($"    [grey]description: {Markup.Escape(s.EffectiveDescription)}[/]");
            if (s.AllowedTools.Count > 0)
                console.MarkupLine($"    [grey]allowed-tools: {Markup.Escape(string.Join(", ", s.AllowedTools))}[/]");
            if (s.Triggers.Count > 0)
                console.MarkupLine($"    [grey]triggers: {Markup.Escape(string.Join(", ", s.Triggers))}[/]");
            console.MarkupLine($"    [grey]source: {Markup.Escape(s.SourcePath)}[/]");
        }
    }

    private static string Sha256Hex(string text)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(text ?? ""));
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }
}

/// <summary>
/// 挂载 Ctrl+C 钩子：第一次 Ctrl+C 取消当前任务，第二次 Ctrl+C 让进程退出。
/// </summary>
internal sealed class CtrlCInterrupt : IDisposable
{
    private readonly CancellationTokenSource _cts;
    private readonly ConsoleCancelEventHandler _handler;
    private int _hits;

    public CtrlCInterrupt(CancellationTokenSource cts)
    {
        _cts = cts;
        _handler = Handler;
        Console.CancelKeyPress += _handler;
    }

    private void Handler(object? sender, ConsoleCancelEventArgs e)
    {
        var n = Interlocked.Increment(ref _hits);
        if (n == 1)
        {
            e.Cancel = true;
            try { _cts.Cancel(); } catch { }
        }
        // 第二次：不拦截，让进程正常退出
    }

    public void Dispose()
    {
        Console.CancelKeyPress -= _handler;
    }
}
