using System.Windows;
using DanceMonkey.Agent.Core.Models;
using DanceMonkey.Agent.Core.Ppt;
using DanceMonkey.Agent.Core.Runtime;
using DanceMonkey.Agent.Core.Tools;
using DesktopAssistant.Models;
using DesktopAssistant.Services.AgentTools;

namespace DesktopAssistant.Services;

/// <summary>
/// GUI Agent 运行时组装（对齐 CLI 的 <c>CliAgentFactory</c>，Phase 1：完整工具 + 双根 FS + Skills + 审批）。
/// </summary>
public static class GuiAgentFactory
{
    public sealed class Runtime
    {
        public required AgentRunner Runner { get; init; }
        public required DualRootFileSystem FileSystem { get; init; }
        public required ToolRegistry Tools { get; init; }
        public required SkillCatalog Skills { get; init; }
        public AgentSession Session { get; set; } = null!;
    }

    public static Runtime Build(AppConfig cfg, AgentSession? existingSession, AgentMode mode, Window? owner = null)
    {
        var sandboxRoot = ResolveSandboxRoot(cfg.SandboxPath);
        var notesRoot = NoteService.ResolveRoot(cfg.NotesRootPath);
        EnsurePptScaffold(sandboxRoot);
        var fs = new DualRootFileSystem(sandboxRoot, notesRoot);
        var shell = new ProcessShellRunner();

        var model = string.IsNullOrWhiteSpace(cfg.Model) ? "gpt-4o-mini" : cfg.Model.Trim();
        var llm = new OpenAiCompatibleLlmClient(cfg.ApiEndpoint, cfg.ApiKey, model);
        var pptBridge = new OpenAiCompatiblePptLlmBridge(llm, model);

        var tools = new ToolRegistry()
            .Register(new ReadFileTool(fs))
            .Register(new WriteFileTool(fs))
            .Register(new EditFileTool(fs))
            .Register(new ListDirTool(fs))
            .Register(new GrepTool(fs))
            .Register(new RunShellTool(shell, fs))
            .Register(new SearchNotesTool(notesRoot))
            .Register(new CreateNoteTool(notesRoot))
            .Register(new AppendToNoteTool(notesRoot))
            .Register(new ListTasksTool(notesRoot))
            .Register(new AddTaskTool(notesRoot))
            .Register(new ListRecentScreenshotsTool(notesRoot))
            .Register(new PptGenerateTool(pptBridge, fs, cfg.SandboxPath))
            .Register(new ProcessDiagnoseTool());

        Window? ResolveOwner() => owner ?? Application.Current?.MainWindow as Window;
        var approval = new ModeAwareApprovalService(new WpfApprovalPrompt(ResolveOwner));

        var skillRoots = SkillCatalog.BuildSearchRoots(sandboxRoot);
        var skills = SkillCatalog.LoadFromDirectories(skillRoots);

        var session = existingSession ?? new AgentSession
        {
            WorkingDirectory = fs.WorkingDirectory,
            Model = model,
            Mode = mode,
        };
        session.Mode = mode;
        session.Model = model;
        session.WorkingDirectory = fs.WorkingDirectory;

        var runner = new AgentRunner(llm, tools, approval, fs)
        {
            ProjectMemory = BuildProjectMemory(sandboxRoot, notesRoot),
            Skills = skills,
            UserName = string.IsNullOrWhiteSpace(cfg.PreferredUserName) ? null : cfg.PreferredUserName.Trim(),
            Streaming = true,
            Temperature = 0.3,
            MaxTokens = 4096,
            MaxToolSteps = 8,
        };

        return new Runtime
        {
            Runner = runner,
            FileSystem = fs,
            Tools = tools,
            Skills = skills,
            Session = session,
        };
    }

    public static string ResolveSandboxRoot(string? configuredSandboxPath)
    {
        var p = (configuredSandboxPath ?? "").Trim();
        if (!string.IsNullOrWhiteSpace(p))
            return Path.GetFullPath(p);

        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "DanceMonkey",
            "Sandbox");
    }

    private static string? BuildProjectMemory(string sandboxRoot, string notesRoot)
    {
        var parts = new List<string>();
        var sandboxMem = LoadProjectMemory(sandboxRoot);
        if (!string.IsNullOrWhiteSpace(sandboxMem))
            parts.Add(sandboxMem.Trim());

        var sandboxFull = Path.GetFullPath(sandboxRoot);
        if (!notesRoot.Equals(sandboxFull, StringComparison.OrdinalIgnoreCase))
        {
            var noteMem = LoadProjectMemory(notesRoot);
            if (!string.IsNullOrWhiteSpace(noteMem))
                parts.Add("### 笔记库根目录下的项目记忆（DANCEMONKEY / CLAUDE）\n" + noteMem.Trim());
        }

        parts.Add(BuildNotesContextMarkdown(sandboxRoot, notesRoot).Trim());
        return string.Join("\n\n", parts.Where(p => !string.IsNullOrWhiteSpace(p)));
    }

    private static string BuildNotesContextMarkdown(string sandboxRoot, string notesRoot)
    {
        var journal = Path.Combine(notesRoot, "Journal");
        return $"""
## DanceMonkey 数据路径（GUI Agent 已自动加载）

- **沙箱 / 工作区**（无前缀相对路径）：`{sandboxRoot}`
- **笔记根目录**（绝对路径）：`{notesRoot}`
- **Zen Task · 任务列表**：`{Path.Combine(journal, "task-module.json")}`
- **Zen Task · 项目列表**：`{Path.Combine(journal, "zentask-projects.json")}`

**工具路径约定**：访问笔记库内文件时，请使用前缀 **`notes/`**。
例如：`notes/Inbox/foo.md`、`notes/Journal/task-module.json`。
沙箱内文件使用**无前缀**相对路径。

**专用工具**：`search_notes`、`create_note`、`append_to_note`、`list_tasks`、`add_task`、`list_recent_screenshots`、`ppt_generate`。

""";
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

    private static void EnsurePptScaffold(string workingDirectory)
    {
        if (string.IsNullOrWhiteSpace(workingDirectory))
            return;

        try
        {
            var src = Path.Combine(AppContext.BaseDirectory, "ppt_scaffold");
            if (!Directory.Exists(src))
                return;

            var dest = Path.Combine(workingDirectory, ".dancemonkey", "ppt_scaffold");
            Directory.CreateDirectory(dest);

            foreach (var file in Directory.EnumerateFiles(src, "*", SearchOption.AllDirectories))
            {
                var rel = Path.GetRelativePath(src, file);
                var target = Path.Combine(dest, rel);
                var targetDir = Path.GetDirectoryName(target);
                if (!string.IsNullOrEmpty(targetDir))
                    Directory.CreateDirectory(targetDir);

                File.Copy(file, target, overwrite: true);
            }
        }
        catch
        {
            // 尽力而为，不阻塞 Agent 启动
        }
    }
}
