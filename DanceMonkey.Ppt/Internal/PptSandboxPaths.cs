namespace DanceMonkey.Ppt.Internal;

/// <summary>与桌面端 <c>SandboxFileService</c> 默认规则对齐的沙箱路径解析（不依赖 WPF 程序集）。</summary>
internal static class PptSandboxPaths
{
    public static string GetSandboxRoot(string? sandboxConfigPath)
    {
        if (string.IsNullOrWhiteSpace(sandboxConfigPath))
        {
            var appData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            sandboxConfigPath = Path.Combine(appData, "DanceMonkey", "Sandbox");
        }

        return Path.GetFullPath(sandboxConfigPath);
    }

    /// <summary><c>{sandbox}/.dancemonkey/skills</c>，与「技能管理」目录一致。</summary>
    public static string GetSkillsRootDirectory(string? sandboxConfigPath) =>
        Path.Combine(GetSandboxRoot(sandboxConfigPath), ".dancemonkey", "skills");
}
