using DanceMonkey.Agent.Core.Abstractions;
using DanceMonkey.Agent.Core.Models;
using DanceMonkey.Agent.Core.Ppt;
using DanceMonkey.Agent.Core.Runtime;
using DanceMonkey.Agent.Core.Tools;
using Spectre.Console;

namespace DanceMonkey.Cli;

/// <summary>
/// CLI 端的 Agent 运行时组装。WPF 客户端已不提供内置 Agent 终端，Agent 通过 dancemonkey CLI 使用。
/// </summary>
internal sealed class CliAgentFactory
{
    public sealed class Runtime
    {
        public required AgentRunner Runner { get; init; }
        public required DualRootFileSystem FileSystem { get; init; }
        public required ToolRegistry Tools { get; init; }
        public required SkillCatalog Skills { get; set; }
        public required IReadOnlyList<string> SkillRoots { get; init; }
        /// <summary>当前会话（可被 <c>/load</c>、<c>--session</c> 替换）。</summary>
        public AgentSession Session { get; set; } = null!;
        public required ProcessShellRunner Shell { get; init; }
        public required CliConfig Config { get; init; }
        public required CliDancePaths DancePaths { get; init; }

        /// <summary>REPL 是否在每轮后自动写入 <see cref="CliSessionStore.AutosavePath"/>。</summary>
        public bool AutosaveEnabled { get; init; } = true;

        public void ReloadSkills()
        {
            Skills = SkillCatalog.LoadFromDirectories(SkillRoots);
            Runner.Skills = Skills;
        }
    }

    /// <summary>
    /// 组装一个可用的 CLI 运行时。
    /// </summary>
    /// <param name="workingDirectory">Agent 可见的工作目录（默认当前终端 CWD）。</param>
    /// <param name="mode">权限模式。</param>
    /// <param name="autoApproveAll">若为真，所有审批一律放行（等价于 Auto 模式或 <c>--yes</c>）。</param>
    /// <param name="console">用于审批与事件输出的控制台。</param>
    /// <param name="autosaveEnabled">是否在 REPL 每轮后自动保存会话。</param>
    public static Runtime Build(
        string workingDirectory,
        AgentMode mode,
        bool autoApproveAll,
        IAnsiConsole console,
        string? modelOverride = null,
        int? maxTokensOverride = null,
        bool autosaveEnabled = true)
    {
        var cfg = CliConfig.Load();
        var dancePaths = CliPathHelper.ResolveDancePaths(cfg);
        var fs = new DualRootFileSystem(workingDirectory, dancePaths.NotesRootAbsolute);
        PptScaffoldInstaller.EnsureInstalled(workingDirectory);
        var shell = new ProcessShellRunner();

        var model = cfg.ResolveModel(modelOverride);

        var llm = new OpenAiCompatibleLlmClient(cfg.ApiEndpoint, cfg.ApiKey, model!);
        var pptBridge = new OpenAiCompatiblePptLlmBridge(llm, model);

        var tools = new ToolRegistry()
            .Register(new ReadFileTool(fs))
            .Register(new WriteFileTool(fs))
            .Register(new EditFileTool(fs))
            .Register(new ListDirTool(fs))
            .Register(new GrepTool(fs))
            .Register(new RunShellTool(shell, fs))
            .Register(new PptGenerateTool(pptBridge, fs, cfg.SandboxPath));

        IApprovalPrompt prompt = autoApproveAll
            ? new AutoApproveAllPrompt()
            : new SpectreApprovalPrompt(console);
        var approval = new ModeAwareApprovalService(prompt);
        var skillRoots = SkillCatalog.BuildSearchRoots(workingDirectory);
        var skills = SkillCatalog.LoadFromDirectories(skillRoots);

        var runner = new AgentRunner(llm, tools, approval, fs)
        {
            ProjectMemory = CombineProjectMemories(workingDirectory, dancePaths),
            Skills = skills,
        };
        var maxTokens = maxTokensOverride ?? cfg.CliMaxTokens;
        runner.MaxTokens = Math.Clamp(maxTokens, 1024, 32768);

        var session = new AgentSession
        {
            Mode = mode,
            Model = model,
            WorkingDirectory = workingDirectory,
        };

        return new Runtime
        {
            Runner = runner,
            FileSystem = fs,
            Tools = tools,
            Skills = skills,
            SkillRoots = skillRoots,
            Session = session,
            Shell = shell,
            Config = cfg,
            DancePaths = dancePaths,
            AutosaveEnabled = autosaveEnabled,
        };
    }

    /// <summary>合并 CWD 与笔记根下的项目记忆，并注入笔记/Zen Task 路径说明。</summary>
    private static string? CombineProjectMemories(string cwd, CliDancePaths dancePaths)
    {
        var parts = new List<string>();
        var cwdMem = LoadProjectMemory(cwd);
        if (!string.IsNullOrWhiteSpace(cwdMem))
            parts.Add(cwdMem.Trim());

        var cwdFull = Path.GetFullPath(cwd);
        if (!dancePaths.NotesRootAbsolute.Equals(cwdFull, StringComparison.OrdinalIgnoreCase))
        {
            var noteMem = LoadProjectMemory(dancePaths.NotesRootAbsolute);
            if (!string.IsNullOrWhiteSpace(noteMem))
                parts.Add("### 笔记库根目录下的项目记忆（DANCEMONKEY / CLAUDE）\n" + noteMem.Trim());
        }

        parts.Add(CliPathHelper.BuildAutoLoadedContextMarkdown(dancePaths).Trim());
        return string.Join("\n\n", parts.Where(p => !string.IsNullOrWhiteSpace(p)));
    }

    private static string? LoadProjectMemory(string root)
    {
        string[] candidates = { "DANCEMONKEY.md", "AGENT.md", "CLAUDE.md" };
        foreach (var name in candidates)
        {
            var path = Path.Combine(root, name);
            if (!File.Exists(path)) continue;
            try { return File.ReadAllText(path); }
            catch { /* ignore */ }
        }
        return null;
    }

}

/// <summary>一律放行（用于 <c>--yes</c> / 非交互模式）。</summary>
internal sealed class AutoApproveAllPrompt : IApprovalPrompt
{
    public Task<ApprovalDecision> AskAsync(ApprovalRequest request, AgentSession session, CancellationToken ct)
        => Task.FromResult(ApprovalDecision.AllowSessionScope);
}
