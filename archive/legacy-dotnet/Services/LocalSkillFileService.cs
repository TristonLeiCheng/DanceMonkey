using System.IO;
using System.Text;
using DanceMonkey.Agent.Core.Runtime;

namespace DesktopAssistant.Services;

/// <summary>管理沙箱下 <c>.dancemonkey/skills/&lt;name&gt;/SKILL.md</c> 的增删改查。</summary>
public static class LocalSkillFileService
{
    public sealed class SkillItem
    {
        public string Name { get; init; } = "";
        public string DirectoryPath { get; init; } = "";
        public string SkillFilePath { get; init; } = "";
        public string? Summary { get; init; }
        public string? Description { get; init; }
        public string AllowedToolsText { get; init; } = "";
        public string TriggersText { get; init; } = "";
        public SkillActivationMode Activation { get; init; } = SkillActivationMode.Auto;
        public string DisplaySummary => !string.IsNullOrWhiteSpace(Description) ? Description! : Summary ?? "";
        public string MetadataLine
        {
            get
            {
                var parts = new List<string> { $"activation: {Activation}" };
                if (!string.IsNullOrWhiteSpace(AllowedToolsText))
                    parts.Add($"tools: {AllowedToolsText}");
                if (!string.IsNullOrWhiteSpace(TriggersText))
                    parts.Add($"triggers: {TriggersText}");
                return string.Join(" · ", parts);
            }
        }
    }

    public static string GetManagedSkillsRoot(string? sandboxConfigPath)
    {
        var s = new SandboxFileService(sandboxConfigPath);
        var root = Path.Combine(s.SandboxRoot, ".dancemonkey", "skills");
        Directory.CreateDirectory(root);
        return root;
    }

    public static string GetSandboxRoot(string? sandboxConfigPath)
    {
        var s = new SandboxFileService(sandboxConfigPath);
        return s.SandboxRoot;
    }

    public static IReadOnlyList<SkillItem> ListSkills(string? sandboxConfigPath)
    {
        var root = GetManagedSkillsRoot(sandboxConfigPath);
        var list = new List<SkillItem>();
        if (!Directory.Exists(root))
            return list;

        foreach (var dir in Directory.EnumerateDirectories(root))
        {
            var skillFile = Path.Combine(dir, "SKILL.md");
            if (!File.Exists(skillFile)) continue;
            var folderName = Path.GetFileName(dir);
            try
            {
                var skill = SkillCatalog.LoadFromFile(skillFile);
                if (skill == null) continue;

                list.Add(new SkillItem
                {
                    Name = skill.Name,
                    DirectoryPath = dir,
                    SkillFilePath = skillFile,
                    Summary = skill.Summary,
                    Description = skill.Description,
                    AllowedToolsText = string.Join(", ", skill.AllowedTools),
                    TriggersText = string.Join(", ", skill.Triggers),
                    Activation = skill.Activation,
                });
            }
            catch
            {
                list.Add(new SkillItem
                {
                    Name = folderName,
                    DirectoryPath = dir,
                    SkillFilePath = skillFile,
                    Summary = "SKILL.md 解析失败，可打开后修正。"
                });
            }
        }

        return list.OrderBy(x => x.Name, StringComparer.OrdinalIgnoreCase).ToList();
    }

    public static void SaveNewSkill(string? sandboxConfigPath, string rawName, string markdown, string? description = null)
    {
        var name = SkillCatalog.SanitizeSkillName((rawName ?? "").Trim());
        if (string.IsNullOrWhiteSpace(name))
            throw new ArgumentException("技能名称无效。");

        var content = (markdown ?? "").Trim();
        if (string.IsNullOrWhiteSpace(content))
            content = BuildSkillTemplate(name, description);
        else if (!HasFrontMatter(content))
            content = BuildSkillMarkdown(name, description, content);

        var root = GetManagedSkillsRoot(sandboxConfigPath);
        var dir = Path.Combine(root, name);
        if (Directory.Exists(dir))
            throw new IOException($"已存在同名技能目录：{name}");

        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, "SKILL.md");
        AtomicWriteAllText(path, content.Trim() + Environment.NewLine);
    }

    public static SkillDefinition ImportSkill(string? sandboxConfigPath, string source)
    {
        if (string.IsNullOrWhiteSpace(source))
            throw new ArgumentException("导入来源不能为空。");

        var sandboxRoot = GetSandboxRoot(sandboxConfigPath);
        return IsHttpUrl(source)
            ? SkillCatalog.ImportFromUrl(source, sandboxRoot, maxBytes: 512 * 1024, timeout: TimeSpan.FromSeconds(10))
            : SkillCatalog.ImportLocal(source, sandboxRoot);
    }

    public static void OverwriteSkillFile(string path, string markdown)
    {
        if (string.IsNullOrWhiteSpace(path))
            throw new ArgumentException("文件路径无效。");
        if (!path.EndsWith("SKILL.md", StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("仅允许写入 SKILL.md。");
        AtomicWriteAllText(path, (markdown ?? "").Trim() + Environment.NewLine);
    }

    public static void DeleteSkill(string directoryPath)
    {
        if (string.IsNullOrWhiteSpace(directoryPath) || !Directory.Exists(directoryPath))
            return;
        Directory.Delete(directoryPath, recursive: true);
    }

    public static string BuildSkillTemplate(string? rawName, string? description = null)
    {
        var name = SkillCatalog.SanitizeSkillName(rawName ?? "new-skill");
        var desc = string.IsNullOrWhiteSpace(description)
            ? "Describe when this skill should be used."
            : description.Trim();

        return BuildSkillMarkdown(name, desc, """
# Skill overview

Explain the goal, expected inputs, and output quality bar for this skill.

## Workflow

1. Confirm the task matches this skill's description.
2. Inspect relevant files or context before changing anything.
3. Apply the workflow's domain-specific rules.
4. Validate the result before replying.

## Rules

- Keep changes focused on the user's request.
- Reuse existing project conventions.
- Explain blockers plainly if required context is missing.
""");
    }

    public static void AtomicWriteAllText(string path, string content)
    {
        var dir = Path.GetDirectoryName(path);
        if (string.IsNullOrWhiteSpace(dir))
            throw new InvalidOperationException("目标目录无效。");
        Directory.CreateDirectory(dir);
        var tmp = path + ".tmp";
        File.WriteAllText(tmp, content, new UTF8Encoding(false));
        if (File.Exists(path))
            File.Replace(tmp, path, null, ignoreMetadataErrors: true);
        else
            File.Move(tmp, path);
    }

    private static string BuildSkillMarkdown(string name, string? description, string body)
    {
        var desc = string.IsNullOrWhiteSpace(description)
            ? "Describe when this skill should be used."
            : description.Trim();

        return $"""
---
name: {name}
description: {EscapeYaml(desc)}
allowed-tools: read_file, write_file, edit_file, list_dir, grep, run_shell
activation: auto
---

{body.Trim()}
""";
    }

    private static bool HasFrontMatter(string markdown)
    {
        using var reader = new StringReader(markdown);
        return string.Equals(reader.ReadLine()?.Trim(), "---", StringComparison.Ordinal);
    }

    private static bool IsHttpUrl(string value) =>
        Uri.TryCreate(value, UriKind.Absolute, out var uri) &&
        (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps);

    private static string EscapeYaml(string value)
    {
        var v = (value ?? "").Replace("\"", "\\\"");
        return $"\"{v}\"";
    }
}
