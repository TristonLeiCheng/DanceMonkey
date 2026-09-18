namespace DanceMonkey.Cli;

/// <summary>
/// DanceMonkey 笔记与 Zen Task 在磁盘上的位置（与 WPF 端一致）。
/// </summary>
internal sealed record CliDancePaths(
    string NotesRootAbsolute,
    string JournalDirectory,
    string TaskModuleJsonPath,
    string ProjectsJsonPath);

internal static class CliPathHelper
{
    /// <summary>与 WPF 端 NoteService.ResolveRoot 相同逻辑。</summary>
    public static string ResolveNotesRoot(CliConfig cfg)
    {
        var root = string.IsNullOrWhiteSpace(cfg.NotesRootPath)
            ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "NoteVault")
            : cfg.NotesRootPath.Trim();
        Directory.CreateDirectory(root);
        return Path.GetFullPath(root);
    }

    public static CliDancePaths ResolveDancePaths(CliConfig cfg)
    {
        var notes = ResolveNotesRoot(cfg);
        var journal = Path.Combine(notes, "Journal");
        Directory.CreateDirectory(journal);
        return new CliDancePaths(
            notes,
            journal,
            Path.Combine(journal, "task-module.json"),
            Path.Combine(journal, "zentask-projects.json"));
    }

    public static string BuildAutoLoadedContextMarkdown(CliDancePaths p)
    {
        return $"""
## DanceMonkey 数据路径（CLI 已自动加载）

- **笔记根目录**（绝对路径）：`{p.NotesRootAbsolute}`
- **Zen Task · 任务列表**（JSON）：`{p.TaskModuleJsonPath}`
- **Zen Task · 项目列表**（JSON）：`{p.ProjectsJsonPath}`

**工具路径约定**：访问笔记库内文件时，请使用前缀 **`notes/`**（映射到上述笔记根目录）。
例如读取今日日记：`notes/Journal/Daily/{DateTime.Now:yyyy-MM-dd}.md`；读取任务数据：`notes/Journal/task-module.json`。
当前终端目录中的代码/仓库仍用**无前缀**相对路径（见上方「工作目录」树）。

""";
    }
}
