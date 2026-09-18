namespace DanceMonkey.Ppt.Internal;

/// <summary>枚举沙箱下技能目录中的 <c>SKILL.md</c>（与 <c>LocalSkillFileService</c> 行为对齐）。</summary>
internal static class PptSandboxSkills
{
    public sealed record SkillItem(string Name, string SkillFilePath);

    public static IReadOnlyList<SkillItem> ListSkills(string? sandboxConfigPath)
    {
        var root = PptSandboxPaths.GetSkillsRootDirectory(sandboxConfigPath);
        var list = new List<SkillItem>();
        if (!Directory.Exists(root))
            return list;

        foreach (var dir in Directory.EnumerateDirectories(root))
        {
            var skillFile = Path.Combine(dir, "SKILL.md");
            if (!File.Exists(skillFile)) continue;
            var name = Path.GetFileName(dir);
            list.Add(new SkillItem(name, skillFile));
        }

        return list.OrderBy(x => x.Name, StringComparer.OrdinalIgnoreCase).ToList();
    }
}
