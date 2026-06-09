using System.Collections.ObjectModel;
using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using DesktopAssistant.Models;
using Markdig;

namespace DesktopAssistant.Services;

public sealed class NoteFileInfo
{
    public required string FullPath { get; init; }
    public required string FileName { get; init; }
    public DateTime LastWriteUtc { get; init; }
}

/// <summary>全文搜索匹配结果，含文件路径与摘要片段。</summary>
public sealed record NoteSearchMatch(string FilePath, string FileName, string Snippet);

/// <summary>双链选择器条目：一条笔记的完整路径、相对路径（不含扩展名）、Stem 及推荐链接文本。</summary>
/// <param name="FullPath">笔记的磁盘绝对路径。</param>
/// <param name="RelativePath">相对笔记库根目录的路径，用 / 分隔，不含 .md 扩展名。</param>
/// <param name="Stem">文件名（不含扩展名）。</param>
/// <param name="SuggestedLinkText">推荐插入的双链文本：同名有歧义时为相对路径，否则为 Stem。</param>
public sealed record NotePickerItem(string FullPath, string RelativePath, string Stem, string SuggestedLinkText);

public sealed class NoteService
{
    public sealed class ContinuousScreenshotSession
    {
        public required string MarkdownPath { get; init; }
        public required string Stamp { get; init; }
        public int Count { get; set; }
    }

    public static string DefaultNotesRoot()
    {
        var docs = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
        return Path.Combine(docs, "NoteVault");
    }

    public static string ResolveRoot(string? configured)
    {
        var root = string.IsNullOrWhiteSpace(configured) ? DefaultNotesRoot() : configured.Trim();
        Directory.CreateDirectory(root);
        return root;
    }

    public string RootPath { get; }
    private readonly Dictionary<string, NoteCategory> _folderCategoryOverrides;
    private string InitMarkerPath => Path.Combine(RootPath, ".dm-notes-initialized");
    private string FolderColorOverridesPath => Path.Combine(RootPath, ".dm-folder-colors.json");

    /// <summary>新建笔记占位文件名（无标题时），首行一级标题填写后会自动改名。</summary>
    public const string DefaultNewNoteBaseName = "未命名";

    /// <summary>新建笔记默认正文：首行一级标题为待填「文件名行」，其下为正文。</summary>
    public const string DefaultNewNoteMarkdown = "# \n\n";

    /// <summary>与 <c>某.md</c> 同级的子笔记目录后缀；物理路径为 <c>…/某.subnotes/</c>，树中作为该 .md 的子节点展示。</summary>
    public const string SubnotesDirectorySuffix = ".subnotes";

    private static readonly HashSet<string> ReservedWindowsDeviceNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "CON", "PRN", "AUX", "NUL",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"
    };

    /// <summary>顶层目录骨架（首次运行时自动创建）。</summary>
    private static readonly string[] StructureFolders =
    [
        "Inbox", "Inbox/Captures", "Inbox/Screenshots", "Inbox/Clipboard", "Inbox/Imports",
        "Journal", "Journal/Daily", "Journal/Weekly", "Journal/Stickies",
        "Projects",
        "Areas", "Areas/Work", "Areas/Work/Meetings", "Areas/Work/Reports", "Areas/Work/Processes",
        "Areas/Personal", "Areas/Personal/Health", "Areas/Personal/Finance", "Areas/Personal/Goals",
        "Areas/Learning", "Areas/Learning/Courses", "Areas/Learning/Skills",
        "Resources", "Resources/Reading", "Resources/Articles", "Resources/Cheatsheets", "Resources/Bookmarks",
        "AI", "AI/Conversations", "AI/Prompts", "AI/Generated",
        "Attachments", "Attachments/Images", "Attachments/Files",
        "Archive",
        "Templates"
    ];

    /// <summary>默认模板文件（仅当 Templates/ 为空时写入）。</summary>
    private static readonly (string FileName, string Content)[] DefaultTemplates =
    [
        ("meeting.md", """
---
tags: [会议]
---

# 会议记录 - {{date}}

## 参会人员

- 

## 议题

1. 

## 讨论内容



## 行动项

- [ ] 
- [ ] 

## 下次会议时间


"""),
        ("weekly-report.md", """
---
tags: [周报]
---

# 周报 - {{date}}

## 本周完成

- 

## 进行中

- 

## 下周计划

- 

## 遇到的问题 / 需要的支持

- 

## 总结


"""),
        ("reading-note.md", """
---
tags: [读书笔记]
---

# 📖 读书笔记

**书名**：
**作者**：
**开始日期**：{{date}}

## 核心观点



## 精彩摘录

> 

## 个人感悟



## 行动清单

- [ ] 
"""),
        ("project-plan.md", """
---
tags: [项目]
---

# 项目计划

## 项目概述

**项目名称**：
**负责人**：
**开始日期**：{{date}}
**目标日期**：

## 目标



## 里程碑

| 阶段 | 任务 | 负责人 | 截止日期 | 状态 |
|------|------|--------|----------|------|
|      |      |        |          | 🟡   |

## 风险 & 依赖

- 

## 资源需求

- 
"""),
        ("todo-list.md", """
---
tags: [待办]
---

# 📋 待办清单 - {{date}}

## 🔴 紧急重要

- [ ] 

## 🟠 重要不紧急

- [ ] 

## 🟡 紧急不重要

- [ ] 

## 🟢 不紧急不重要

- [ ] 

## 已完成 ✅

- [x] 
"""),
        ("daily.md", """
---
tags: [日记]
---

# {{date}}

## 今日计划

- [ ] 

## 日志



## 反思


""")
    ];

    public NoteService(string? configuredRoot)
    {
        RootPath = ResolveRoot(configuredRoot);
        _folderCategoryOverrides = LoadFolderCategoryOverrides();
        EnsureStructure();
    }

    /// <summary>仅首次初始化（空库）创建默认目录骨架与模板；后续不再自动补建。</summary>
    private void EnsureStructure()
    {
        if (File.Exists(InitMarkerPath))
            return;

        var hasAnyUserContent = Directory.EnumerateFileSystemEntries(RootPath)
            .Any(p => !string.Equals(Path.GetFileName(p), Path.GetFileName(InitMarkerPath), StringComparison.OrdinalIgnoreCase) &&
                      !string.Equals(Path.GetFileName(p), Path.GetFileName(FolderColorOverridesPath), StringComparison.OrdinalIgnoreCase));

        // 仅空目录首次启动时创建默认结构；后续用户删改都尊重，不自动补建。
        if (!hasAnyUserContent)
        {
            foreach (var rel in StructureFolders)
                Directory.CreateDirectory(Path.Combine(RootPath, rel));

            var templatesDir = Path.Combine(RootPath, "Templates");
            if (!Directory.EnumerateFiles(templatesDir, "*.md").Any())
            {
                foreach (var (fileName, content) in DefaultTemplates)
                    File.WriteAllText(Path.Combine(templatesDir, fileName), content, Utf8NoBom);
            }
        }

        File.WriteAllText(InitMarkerPath, DateTime.Now.ToString("O"), Utf8NoBom);
    }

    private Dictionary<string, NoteCategory> LoadFolderCategoryOverrides()
    {
        try
        {
            if (!File.Exists(FolderColorOverridesPath))
                return new Dictionary<string, NoteCategory>(StringComparer.OrdinalIgnoreCase);
            var json = File.ReadAllText(FolderColorOverridesPath, Encoding.UTF8);
            var raw = JsonSerializer.Deserialize<Dictionary<string, string>>(json) ??
                      new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            var map = new Dictionary<string, NoteCategory>(StringComparer.OrdinalIgnoreCase);
            foreach (var kv in raw)
            {
                if (string.IsNullOrWhiteSpace(kv.Key))
                    continue;
                if (!Enum.TryParse<NoteCategory>(kv.Value, ignoreCase: true, out var cat))
                    continue;
                map[NormalizeRelativeFolderKey(kv.Key)] = cat;
            }
            return map;
        }
        catch
        {
            return new Dictionary<string, NoteCategory>(StringComparer.OrdinalIgnoreCase);
        }
    }

    private void SaveFolderCategoryOverrides()
    {
        try
        {
            var raw = _folderCategoryOverrides
                .OrderBy(kv => kv.Key, StringComparer.OrdinalIgnoreCase)
                .ToDictionary(kv => kv.Key, kv => kv.Value.ToString());
            var json = JsonSerializer.Serialize(raw, new JsonSerializerOptions { WriteIndented = true });
            File.WriteAllText(FolderColorOverridesPath, json, Utf8NoBom);
        }
        catch
        {
            // 颜色偏好保存失败不影响主流程
        }
    }

    private static string NormalizeRelativeFolderKey(string relativePath)
    {
        var key = relativePath.Replace('\\', '/').Trim();
        if (string.IsNullOrEmpty(key) || key == ".")
            return "";
        return key.Trim('/');
    }

    private string ToRelativeFolderKey(string fullPath)
    {
        var rel = Path.GetRelativePath(RootPath, fullPath);
        return NormalizeRelativeFolderKey(rel);
    }

    private NoteCategory ResolveCategoryWithOverride(string relativePath, NoteCategory fallback)
    {
        var key = NormalizeRelativeFolderKey(relativePath);
        if (_folderCategoryOverrides.TryGetValue(key, out var custom))
            return custom;
        return fallback;
    }

    public void SetFolderColorCategory(string folderFullPath, NoteCategory category)
    {
        if (!Directory.Exists(folderFullPath))
            throw new DirectoryNotFoundException("目标文件夹不存在。");
        if (!IsUnderRoot(folderFullPath))
            throw new InvalidOperationException("路径不在笔记根目录内。");
        var key = ToRelativeFolderKey(folderFullPath);
        _folderCategoryOverrides[key] = category;
        SaveFolderCategoryOverrides();
    }

    public void ClearFolderColorCategory(string folderFullPath)
    {
        if (!IsUnderRoot(folderFullPath))
            throw new InvalidOperationException("路径不在笔记根目录内。");
        var key = ToRelativeFolderKey(folderFullPath);
        if (_folderCategoryOverrides.Remove(key))
            SaveFolderCategoryOverrides();
    }

    private void RemoveFolderOverrideForSubtree(string folderFullPath)
    {
        var key = ToRelativeFolderKey(folderFullPath);
        var prefix = string.IsNullOrEmpty(key) ? "" : key + "/";
        var removed = _folderCategoryOverrides.Keys
            .Where(k => string.Equals(k, key, StringComparison.OrdinalIgnoreCase) ||
                        (!string.IsNullOrEmpty(prefix) && k.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)))
            .ToList();
        if (removed.Count == 0) return;
        foreach (var k in removed)
            _folderCategoryOverrides.Remove(k);
        SaveFolderCategoryOverrides();
    }

    private void MoveFolderOverrideSubtree(string fromFolderFullPath, string toFolderFullPath)
    {
        var fromKey = ToRelativeFolderKey(fromFolderFullPath);
        var toKey = ToRelativeFolderKey(toFolderFullPath);
        var fromPrefix = string.IsNullOrEmpty(fromKey) ? "" : fromKey + "/";
        var updates = new List<(string OldKey, string NewKey, NoteCategory Category)>();

        foreach (var kv in _folderCategoryOverrides)
        {
            if (string.Equals(kv.Key, fromKey, StringComparison.OrdinalIgnoreCase))
            {
                updates.Add((kv.Key, toKey, kv.Value));
                continue;
            }
            if (!string.IsNullOrEmpty(fromPrefix) &&
                kv.Key.StartsWith(fromPrefix, StringComparison.OrdinalIgnoreCase))
            {
                var suffix = kv.Key[fromPrefix.Length..];
                var newKey = string.IsNullOrEmpty(toKey) ? suffix : $"{toKey}/{suffix}";
                updates.Add((kv.Key, newKey, kv.Value));
            }
        }

        if (updates.Count == 0) return;
        foreach (var u in updates)
            _folderCategoryOverrides.Remove(u.OldKey);
        foreach (var u in updates)
            _folderCategoryOverrides[NormalizeRelativeFolderKey(u.NewKey)] = u.Category;
        SaveFolderCategoryOverrides();
    }

    /// <summary>列出 Templates/ 下所有 .md 模板（名称 = 不含扩展名）。</summary>
    public IReadOnlyList<(string Name, string FullPath)> ListTemplates()
    {
        var dir = Path.Combine(RootPath, "Templates");
        if (!Directory.Exists(dir))
            return Array.Empty<(string, string)>();
        return Directory.EnumerateFiles(dir, "*.md")
            .OrderBy(f => f, StringComparer.OrdinalIgnoreCase)
            .Select(f => (Path.GetFileNameWithoutExtension(f), f))
            .ToList();
    }

    /// <summary>读取模板内容并替换 {{date}} 占位符。</summary>
    public string LoadTemplateContent(string templateFullPath)
    {
        var raw = File.ReadAllText(templateFullPath, Encoding.UTF8);
        return raw.Replace("{{date}}", DateTime.Now.ToString("yyyy-MM-dd"));
    }

    public bool IsUnderRoot(string fullPath)
    {
        var root = Path.GetFullPath(RootPath.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
        var p = Path.GetFullPath(fullPath);
        return p.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) ||
               p.Equals(root, StringComparison.OrdinalIgnoreCase);
    }

    // ── 双链（BiDirectional Link）支持 ───────────────────────────────────────

    private static readonly Regex WikiLinkTargetRegex = new(
        @"\[\[([^\]\|]+?)(?:\|[^\]]+?)?\]\]",
        RegexOptions.Compiled);

    /// <summary>从 Markdown 正文提取所有 <c>[[目标]]</c> / <c>[[目标|显示名]]</c> 中的目标文本（去重，保序）。</summary>
    public static IReadOnlyList<string> ExtractWikiLinkTargets(string markdown)
    {
        if (string.IsNullOrEmpty(markdown)) return Array.Empty<string>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var result = new List<string>();
        foreach (Match m in WikiLinkTargetRegex.Matches(markdown))
        {
            var target = m.Groups[1].Value.Trim();
            if (!string.IsNullOrEmpty(target) && seen.Add(target))
                result.Add(target);
        }
        return result;
    }

    /// <summary>
    /// 在笔记库中解析 wikilink 目标，返回匹配的 .md 全路径。
    /// 支持两种语法：
    ///   - 纯文件名：<c>[[笔记名]]</c>  优先级：同目录精确匹配 → 全库精确匹配（字母序）
    ///   - 相对路径：<c>[[目录/笔记名]]</c>  相对于笔记库根目录的路径（/ 或 \ 均可），精确匹配
    /// </summary>
    public string? ResolveWikiLinkTarget(string targetName, string? currentNotePath = null)
    {
        if (string.IsNullOrWhiteSpace(targetName)) return null;

        var normalized = targetName.Trim().Replace('\\', '/');

        // ── 路径形式：目标含 '/'，视为相对于根目录的路径 ──────────────────────────
        if (normalized.Contains('/'))
        {
            // 允许末尾带或不带 .md
            var withMd = normalized.EndsWith(".md", StringComparison.OrdinalIgnoreCase)
                ? normalized : normalized + ".md";
            var candidate = Path.GetFullPath(Path.Combine(RootPath, withMd.Replace('/', Path.DirectorySeparatorChar)));
            if (File.Exists(candidate)) return candidate;

            // 回退：路径段中的最后一段当 stem，在全库中按路径精确匹配（不区分大小写）
            var all2 = ListAllMarkdownRecursive();
            return all2.FirstOrDefault(f =>
            {
                var rel = GetRelativePathFromRoot(f.FullPath).Replace('\\', '/');
                var relNoExt = rel.EndsWith(".md", StringComparison.OrdinalIgnoreCase)
                    ? rel[..^3] : rel;
                return string.Equals(relNoExt, normalized, StringComparison.OrdinalIgnoreCase);
            })?.FullPath;
        }

        // ── 纯文件名形式 ────────────────────────────────────────────────────────
        var all = ListAllMarkdownRecursive();

        // 同目录优先
        if (!string.IsNullOrEmpty(currentNotePath))
        {
            var dir = Path.GetDirectoryName(currentNotePath) ?? "";
            var sameDir = all.FirstOrDefault(f =>
                string.Equals(Path.GetDirectoryName(f.FullPath), dir, StringComparison.OrdinalIgnoreCase) &&
                string.Equals(Path.GetFileNameWithoutExtension(f.FullPath), normalized, StringComparison.OrdinalIgnoreCase));
            if (sameDir != null) return sameDir.FullPath;
        }

        // 全库匹配（字母序第一）
        return all
            .Where(f => string.Equals(Path.GetFileNameWithoutExtension(f.FullPath), normalized, StringComparison.OrdinalIgnoreCase))
            .OrderBy(f => f.FullPath, StringComparer.OrdinalIgnoreCase)
            .FirstOrDefault()?.FullPath;
    }

    /// <summary>返回笔记相对于笔记库根目录的相对路径（含扩展名），使用系统路径分隔符。</summary>
    public string GetRelativePathFromRoot(string fullPath)
    {
        var root = Path.GetFullPath(RootPath.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar))
                   + Path.DirectorySeparatorChar;
        var full = Path.GetFullPath(fullPath);
        return full.StartsWith(root, StringComparison.OrdinalIgnoreCase)
            ? full[root.Length..]
            : full;
    }

    /// <summary>
    /// 列出全库所有 .md 笔记，供双链选择器使用。
    /// 返回元组：FullPath、相对根目录的显示路径（用 / 分隔，不含扩展名）、文件名 Stem。
    /// </summary>
    public IReadOnlyList<NotePickerItem> ListAllNotesForPicker()
    {
        var all = ListAllMarkdownRecursive();
        // 统计 stem 出现次数，用于判断是否需要加路径前缀
        var stemCount = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        foreach (var f in all)
        {
            var stem = Path.GetFileNameWithoutExtension(f.FullPath);
            stemCount[stem] = stemCount.GetValueOrDefault(stem, 0) + 1;
        }

        return all.Select(f =>
        {
            var stem = Path.GetFileNameWithoutExtension(f.FullPath);
            var rel = GetRelativePathFromRoot(f.FullPath).Replace('\\', '/');
            var relNoExt = rel.EndsWith(".md", StringComparison.OrdinalIgnoreCase) ? rel[..^3] : rel;
            // 若同名有多个，生成带路径的链接文本；否则只用 stem
            var linkText = stemCount[stem] > 1 ? relNoExt : stem;
            return new NotePickerItem(f.FullPath, relNoExt, stem, linkText);
        }).OrderBy(x => x.RelativePath, StringComparer.OrdinalIgnoreCase).ToList();
    }

    /// <summary>扫描全库，返回所有通过 <c>[[wikilink]]</c> 指向 <paramref name="fullPath"/> 的笔记列表。
    /// 同时匹配纯文件名形式（<c>[[笔记名]]</c>）和路径形式（<c>[[目录/笔记名]]</c>）。</summary>
    public IReadOnlyList<NoteFileInfo> GetBacklinksForNote(string fullPath)
    {
        if (!File.Exists(fullPath)) return Array.Empty<NoteFileInfo>();
        var targetStem = Path.GetFileNameWithoutExtension(fullPath);
        var relNoExt = GetRelativePathFromRoot(fullPath).Replace('\\', '/');
        if (relNoExt.EndsWith(".md", StringComparison.OrdinalIgnoreCase))
            relNoExt = relNoExt[..^3];
        var result = new List<NoteFileInfo>();

        foreach (var f in ListAllMarkdownRecursive())
        {
            if (string.Equals(f.FullPath, fullPath, StringComparison.OrdinalIgnoreCase))
                continue;
            try
            {
                var md = File.ReadAllText(f.FullPath, Encoding.UTF8);
                var targets = ExtractWikiLinkTargets(md);
                foreach (var t in targets)
                {
                    var tNorm = t.Trim().Replace('\\', '/');
                    // 纯文件名匹配
                    if (!tNorm.Contains('/') &&
                        string.Equals(tNorm, targetStem, StringComparison.OrdinalIgnoreCase))
                    {
                        result.Add(f);
                        break;
                    }
                    // 路径形式匹配（相对根目录路径，不含扩展名）
                    if (tNorm.Contains('/'))
                    {
                        var tNoExt = tNorm.EndsWith(".md", StringComparison.OrdinalIgnoreCase) ? tNorm[..^3] : tNorm;
                        if (string.Equals(tNoExt, relNoExt, StringComparison.OrdinalIgnoreCase))
                        {
                            result.Add(f);
                            break;
                        }
                    }
                }
            }
            catch
            {
                // 无法读取时跳过
            }
        }
        return result;
    }

    /// <summary>返回与 Markdown 文件绑定的子笔记目录绝对路径（目录不一定已存在）。</summary>
    public static string GetSubnotesDirectoryForMarkdown(string markdownFileFullPath)
    {
        var dir = Path.GetDirectoryName(markdownFileFullPath) ?? "";
        var stem = Path.GetFileNameWithoutExtension(markdownFileFullPath);
        return Path.GetFullPath(Path.Combine(dir, stem + SubnotesDirectorySuffix));
    }

    private static bool ShouldHideBundledSubnotesFolder(string directoryName, List<string> mdFilePathsInParent)
    {
        if (!directoryName.EndsWith(SubnotesDirectorySuffix, StringComparison.OrdinalIgnoreCase))
            return false;
        var stem = directoryName[..^SubnotesDirectorySuffix.Length];
        if (string.IsNullOrEmpty(stem))
            return false;
        return mdFilePathsInParent.Any(md =>
            string.Equals(Path.GetFileNameWithoutExtension(md), stem, StringComparison.OrdinalIgnoreCase));
    }

    private static void CopyDirectoryRecursive(string sourceDir, string destDir)
    {
        Directory.CreateDirectory(destDir);
        foreach (var file in Directory.EnumerateFiles(sourceDir))
        {
            var name = Path.GetFileName(file);
            File.Copy(file, Path.Combine(destDir, name), overwrite: false);
        }

        foreach (var sub in Directory.EnumerateDirectories(sourceDir))
        {
            var name = Path.GetFileName(sub);
            CopyDirectoryRecursive(sub, Path.Combine(destDir, name));
        }
    }

    /// <summary>复制 .md 及其 <c>.subnotes</c> 子目录（若有），返回新 .md 路径。</summary>
    public string DuplicateMarkdownWithSubnotesFolder(string markdownSourcePath)
    {
        if (!File.Exists(markdownSourcePath))
            throw new FileNotFoundException(markdownSourcePath);
        if (!markdownSourcePath.EndsWith(".md", StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("仅支持 Markdown 文件。", nameof(markdownSourcePath));

        var dir = Path.GetDirectoryName(markdownSourcePath)!;
        var baseName = Path.GetFileNameWithoutExtension(markdownSourcePath);
        var ext = Path.GetExtension(markdownSourcePath);
        var copyName = $"{baseName} - 副本{ext}";
        var dest = Path.Combine(dir, copyName);
        var i = 2;
        while (File.Exists(dest))
        {
            copyName = $"{baseName} - 副本 ({i}){ext}";
            dest = Path.Combine(dir, copyName);
            i++;
        }

        File.Copy(markdownSourcePath, dest);
        var srcSub = GetSubnotesDirectoryForMarkdown(markdownSourcePath);
        var dstSub = GetSubnotesDirectoryForMarkdown(dest);
        if (Directory.Exists(srcSub))
            CopyDirectoryRecursive(srcSub, dstSub);
        return dest;
    }

    public IReadOnlyList<NoteFileInfo> ListMarkdown()
    {
        if (!Directory.Exists(RootPath))
            return Array.Empty<NoteFileInfo>();

        return Directory.EnumerateFiles(RootPath, "*.md", SearchOption.TopDirectoryOnly)
            .Select(p => new FileInfo(p))
            .OrderByDescending(f => f.LastWriteTimeUtc)
            .Select(f => new NoteFileInfo
            {
                FullPath = f.FullName,
                FileName = f.Name,
                LastWriteUtc = f.LastWriteTimeUtc
            })
            .ToList();
    }

    /// <summary>递归列出全部 .md 文件（用于搜索）。</summary>
    public IReadOnlyList<NoteFileInfo> ListAllMarkdownRecursive()
    {
        if (!Directory.Exists(RootPath))
            return Array.Empty<NoteFileInfo>();

        return Directory.EnumerateFiles(RootPath, "*.md", SearchOption.AllDirectories)
            .Select(p => new FileInfo(p))
            .OrderByDescending(f => f.LastWriteTimeUtc)
            .Select(f => new NoteFileInfo
            {
                FullPath = f.FullName,
                FileName = f.Name,
                LastWriteUtc = f.LastWriteTimeUtc
            })
            .ToList();
    }

    /// <summary>
    /// 全文搜索：在所有 .md 文件内容中查找 <paramref name="query"/>，
    /// 返回匹配文件列表及匹配周围的文本摘要片段。
    /// 支持 CancellationToken，适合在后台线程调用。
    /// </summary>
    public List<NoteSearchMatch> SearchWithSnippets(string query, CancellationToken ct = default)
    {
        var q = query.Trim();
        if (string.IsNullOrWhiteSpace(q)) return new List<NoteSearchMatch>();

        var results = new List<NoteSearchMatch>();

        foreach (var f in ListAllMarkdownRecursive())
        {
            ct.ThrowIfCancellationRequested();
            try
            {
                var content = File.ReadAllText(f.FullPath, Encoding.UTF8);
                var idx = content.IndexOf(q, StringComparison.OrdinalIgnoreCase);
                if (idx < 0) continue;

                // 提取匹配点前后 ~70 字符作为摘要
                const int ContextRadius = 70;
                var start = Math.Max(0, idx - ContextRadius);
                var end = Math.Min(content.Length, idx + q.Length + ContextRadius);
                var raw = content[start..end];

                // 折叠连续空白，避免换行符破坏摘要阅读
                var snippet = Regex.Replace(raw, @"[\r\n]+", " ").Trim();
                snippet = Regex.Replace(snippet, @"\s{2,}", " ");
                if (start > 0) snippet = "…" + snippet;
                if (end < content.Length) snippet += "…";

                results.Add(new NoteSearchMatch(f.FullPath, f.FileName, snippet));
            }
            catch
            {
                // 无法读取时跳过
            }
        }

        return results;
    }

    /// <summary>构建完整目录树（根节点为笔记库根目录）。</summary>
    public NoteTreeNode BuildTree()
    {
        var rootName = Path.GetFileName(RootPath.TrimEnd('\\', '/'));
        if (string.IsNullOrEmpty(rootName))
            rootName = "笔记库";

        var root = new NoteTreeNode
        {
            Name = rootName,
            FullPath = Path.GetFullPath(RootPath),
            IsFolder = true,
            Category = ResolveCategoryWithOverride("", NoteCategory.General)
        };
        FillChildren(root);
        return root;
    }

    /// <summary>根据相对路径推断目录的语义分类（用于左侧树彩色文件夹）。</summary>
    private static NoteCategory ClassifyCategory(string relativePath)
    {
        if (string.IsNullOrEmpty(relativePath) || relativePath == ".")
            return NoteCategory.General;

        // 取顶级目录名（不区分大小写）
        var sep = new[] { '\\', '/' };
        var top = relativePath.Split(sep, 2, StringSplitOptions.RemoveEmptyEntries)[0];
        return top.ToLowerInvariant() switch
        {
            "inbox" => NoteCategory.Inbox,
            "journal" => NoteCategory.Journal,
            "projects" => NoteCategory.Projects,
            "areas" => NoteCategory.Areas,
            "resources" => NoteCategory.Resources,
            "ai" => NoteCategory.Ai,
            "attachments" => NoteCategory.Attachments,
            "archive" => NoteCategory.Archive,
            "templates" => NoteCategory.Templates,
            _ => NoteCategory.General
        };
    }

    /// <summary>根据文件相对路径与文件名推断笔记子类型（用于角标）。</summary>
    private static NoteKind ClassifyKind(string relativePath, string fileName)
    {
        var rel = relativePath.Replace('\\', '/').ToLowerInvariant();
        var name = fileName.ToLowerInvariant();

        if (rel.StartsWith("templates/", StringComparison.Ordinal))
            return NoteKind.Template;
        if (rel.StartsWith("ai/conversations/", StringComparison.Ordinal) ||
            name.StartsWith("chat-", StringComparison.Ordinal))
            return NoteKind.AiConversation;
        if (rel.StartsWith("ai/generated/", StringComparison.Ordinal))
            return NoteKind.AiGenerated;
        if (rel.StartsWith("journal/daily/", StringComparison.Ordinal))
            return NoteKind.Daily;
        if (rel.StartsWith("journal/stickies/", StringComparison.Ordinal) ||
            name.StartsWith("sticky-", StringComparison.Ordinal))
            return NoteKind.Sticky;
        if (rel.StartsWith("inbox/captures/", StringComparison.Ordinal))
        {
            if (name.StartsWith("quick-", StringComparison.Ordinal))
                return NoteKind.Quick;
            if (name.StartsWith("capture-", StringComparison.Ordinal))
                return NoteKind.Screenshot;
        }
        if (rel.StartsWith("inbox/screenshots/", StringComparison.Ordinal))
            return NoteKind.Screenshot;

        return NoteKind.General;
    }

    /// <summary>按文件名/路径关键字过滤后构建树（仅包含匹配的 .md 及其父文件夹）。</summary>
    public NoteTreeNode BuildFilteredTree(string? searchQuery, bool searchContent = false)
    {
        var full = BuildTree();
        if (string.IsNullOrWhiteSpace(searchQuery))
            return full;

        var q = searchQuery.Trim();

        bool MatchFile(NoteFileInfo f)
        {
            // 始终按路径/文件名匹配
            if (f.FullPath.Contains(q, StringComparison.OrdinalIgnoreCase) ||
                f.FileName.Contains(q, StringComparison.OrdinalIgnoreCase))
                return true;

            // 全文搜索模式：读取文件内容匹配
            if (searchContent)
            {
                try
                {
                    var content = File.ReadAllText(f.FullPath, Encoding.UTF8);
                    if (content.Contains(q, StringComparison.OrdinalIgnoreCase))
                        return true;
                }
                catch
                {
                    // 无法读取时跳过
                }
            }

            return false;
        }

        var allMd = ListAllMarkdownRecursive().Where(MatchFile).Select(f => f.FullPath).ToHashSet(StringComparer.OrdinalIgnoreCase);
        return FilterTree(full, allMd) ?? new NoteTreeNode { Name = full.Name, FullPath = full.FullPath, IsFolder = true };
    }

    private static NoteTreeNode? FilterTree(NoteTreeNode node, HashSet<string> keepFiles)
    {
        if (!node.IsFolder)
            return keepFiles.Contains(node.FullPath) ? node : null;

        var copy = new NoteTreeNode
        {
            Name = node.Name,
            FullPath = node.FullPath,
            IsFolder = true,
            Category = node.Category
        };
        foreach (var ch in node.Children)
        {
            var sub = FilterTree(ch, keepFiles);
            if (sub != null)
                copy.Children.Add(sub);
        }

        return copy.Children.Count > 0 ? copy : null;
    }

    private void FillChildren(NoteTreeNode parent) => FillTreeFromDisk(parent, parent.FullPath);

    /// <summary>从磁盘目录填充树：<c>某.md</c> 的 <c>某.subnotes</c> 不单独成节点，而作为该 .md 的子级递归挂载。</summary>
    private void FillTreeFromDisk(NoteTreeNode parent, string physicalDir)
    {
        try
        {
            if (!Directory.Exists(physicalDir))
                return;

            var mdPaths = Directory.EnumerateFiles(physicalDir, "*.md")
                .OrderBy(f => f, StringComparer.OrdinalIgnoreCase)
                .ToList();

            foreach (var dir in Directory.EnumerateDirectories(physicalDir).OrderBy(d => d, StringComparer.OrdinalIgnoreCase))
            {
                var name = Path.GetFileName(dir);
                if (name.StartsWith('.') && name is not "." and not "..")
                    continue;
                if (ShouldHideBundledSubnotesFolder(name, mdPaths))
                    continue;

                var rel = Path.GetRelativePath(RootPath, dir);
                var n = new NoteTreeNode
                {
                    Name = name,
                    FullPath = Path.GetFullPath(dir),
                    IsFolder = true,
                    Category = ResolveCategoryWithOverride(rel, ClassifyCategory(rel))
                };
                parent.Children.Add(n);
                FillTreeFromDisk(n, n.FullPath);
            }

            foreach (var file in mdPaths)
            {
                var rel = Path.GetRelativePath(RootPath, file);
                var fname = Path.GetFileName(file);
                var node = new NoteTreeNode
                {
                    Name = fname,
                    FullPath = Path.GetFullPath(file),
                    IsFolder = false,
                    Category = ClassifyCategory(rel),
                    Kind = ClassifyKind(rel, fname)
                };
                parent.Children.Add(node);
                var subDir = GetSubnotesDirectoryForMarkdown(file);
                if (Directory.Exists(subDir))
                    FillTreeFromDisk(node, subDir);
            }
        }
        catch (UnauthorizedAccessException)
        {
            // 忽略无权限子目录
        }
    }

    public string CreateTodayNote()
    {
        var dailyDir = Path.Combine(RootPath, "Journal", "Daily");
        Directory.CreateDirectory(dailyDir);
        var name = $"{DateTime.Now:yyyy-MM-dd}.md";
        var path = Path.Combine(dailyDir, name);
        if (!File.Exists(path))
        {
            var header = $"# {DateTime.Now:yyyy-MM-dd}\n\n";
            File.WriteAllText(path, header, Utf8NoBom);
        }

        return path;
    }

    /// <summary>创建新笔记。可选 <paramref name="templateContent"/> 来指定初始内容（#18 笔记模板）。</summary>
    public string CreateNewNote(string baseName, string? relativeFolder = null, string? templateContent = null)
    {
        var safe = string.Join("_", baseName.Split(Path.GetInvalidFileNameChars(), StringSplitOptions.RemoveEmptyEntries))
            .Trim();
        if (string.IsNullOrEmpty(safe))
            safe = DefaultNewNoteBaseName;
        if (!safe.EndsWith(".md", StringComparison.OrdinalIgnoreCase))
            safe += ".md";

        var dir = string.IsNullOrWhiteSpace(relativeFolder)
            ? RootPath
            : Path.GetFullPath(Path.Combine(RootPath, relativeFolder.Trim().TrimStart('\\', '/')));
        if (!IsUnderRoot(dir))
            throw new InvalidOperationException("目标目录不在笔记根目录内。");
        Directory.CreateDirectory(dir);

        var path = Path.Combine(dir, safe);
        var n = 1;
        while (File.Exists(path))
        {
            var stem = Path.GetFileNameWithoutExtension(safe);
            path = Path.Combine(dir, $"{stem}_{n}.md");
            n++;
        }

        var content = string.IsNullOrEmpty(templateContent) ? DefaultNewNoteMarkdown : templateContent;
        File.WriteAllText(path, content, Utf8NoBom);
        return path;
    }

    /// <summary>从正文取首行一级 ATX 标题（<c># </c>，不含 <c>##</c>）的标题文本。</summary>
    public static bool TryGetFirstLineH1Title(string markdown, out string title)
    {
        title = "";
        if (string.IsNullOrEmpty(markdown))
            return false;

        var idx = markdown.IndexOfAny(['\r', '\n']);
        var first = (idx < 0 ? markdown : markdown[..idx]).TrimStart('\ufeff').TrimEnd('\r', '\n', ' ');
        if (first.Length == 0)
            return false;

        // 仅一级 ATX：# 后不得再紧跟 #（排除 ## 二级及以上）
        var m = Regex.Match(first, @"^\s*#(?!\#)\s*(.*)$", RegexOptions.CultureInvariant);
        if (!m.Success)
            return false;
        title = m.Groups[1].Value.Trim();
        return title.Length > 0;
    }

    /// <summary>将一级标题中的文字清洗为安全的 .md 主文件名（不含扩展名）。</summary>
    public static string SanitizeMarkdownNoteFileStem(string? rawTitle)
    {
        if (string.IsNullOrWhiteSpace(rawTitle))
            return "";
        var t = rawTitle.Trim();
        foreach (var c in Path.GetInvalidFileNameChars())
            t = t.Replace(c, '_');
        t = t.Trim(' ', '.');
        if (t.Length > 120)
            t = t[..120].Trim(' ', '.');
        if (t.Length == 0)
            return "";

        var dot = t.IndexOf('.');
        var stemPart = dot >= 0 ? t[..dot] : t;
        if (ReservedWindowsDeviceNames.Contains(stemPart))
            t += "_";

        return t;
    }

    /// <summary>
    /// 若 <paramref name="headingTitle"/> 清洗后的主文件名与当前文件不同，则在同目录重命名为唯一可用名；
    /// 否则返回原路径。
    /// </summary>
    public string TryRenameMarkdownFileFromHeadingTitle(string fullPath, string headingTitle)
    {
        if (!IsUnderRoot(fullPath) || !File.Exists(fullPath))
            return fullPath;

        var stem = SanitizeMarkdownNoteFileStem(headingTitle);
        if (string.IsNullOrEmpty(stem))
            return fullPath;

        var dir = Path.GetDirectoryName(fullPath)!;
        var currentName = Path.GetFileName(fullPath);
        var currentStem = Path.GetFileNameWithoutExtension(currentName);
        if (string.Equals(stem, currentStem, StringComparison.OrdinalIgnoreCase))
            return fullPath;

        static bool SamePath(string a, string b) =>
            string.Equals(Path.GetFullPath(a), Path.GetFullPath(b), StringComparison.OrdinalIgnoreCase);

        string PickUniqueName()
        {
            var plain = stem + ".md";
            var plainFull = Path.Combine(dir, plain);
            if (!File.Exists(plainFull) || SamePath(fullPath, plainFull))
                return plain;

            for (var n = 1; ; n++)
            {
                var name = $"{stem}_{n}.md";
                var p = Path.Combine(dir, name);
                if (!File.Exists(p) || SamePath(fullPath, p))
                    return name;
            }
        }

        var newName = PickUniqueName();
        if (string.Equals(newName, currentName, StringComparison.OrdinalIgnoreCase))
            return fullPath;

        return Rename(fullPath, newName);
    }

    public void CreateFolder(string? relativeParent, string folderName)
    {
        folderName = folderName.Trim();
        foreach (var c in Path.GetInvalidFileNameChars())
        {
            if (folderName.Contains(c))
                throw new ArgumentException("文件夹名包含非法字符。");
        }

        if (string.IsNullOrWhiteSpace(folderName))
            throw new ArgumentException("请输入文件夹名。");

        var parent = string.IsNullOrWhiteSpace(relativeParent)
            ? RootPath
            : Path.GetFullPath(Path.Combine(RootPath, relativeParent.Trim().TrimStart('\\', '/')));
        if (!IsUnderRoot(parent))
            throw new InvalidOperationException("目标目录不在笔记根目录内。");

        var path = Path.Combine(parent, folderName);
        if (!IsUnderRoot(path))
            throw new InvalidOperationException("路径无效。");
        Directory.CreateDirectory(path);
    }

    /// <summary>将截图复制到 Inbox/Screenshots 并生成带引用的 .md。</summary>
    public string SaveScreenshotAsNote(string pngSourcePath)
    {
        if (!File.Exists(pngSourcePath))
            throw new FileNotFoundException(pngSourcePath);

        var shotsDir = Path.Combine(RootPath, "Inbox", "Screenshots");
        Directory.CreateDirectory(shotsDir);

        var stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss");
        var imgName = $"screenshot-{stamp}.png";
        var destImg = Path.Combine(shotsDir, imgName);
        File.Copy(pngSourcePath, destImg, overwrite: false);

        var capturesDir = Path.Combine(RootPath, "Inbox", "Captures");
        Directory.CreateDirectory(capturesDir);
        var mdName = $"capture-{stamp}.md";
        var mdPath = Path.Combine(capturesDir, mdName);
        // 用相对路径引用截图（从 Captures/ 到 Screenshots/）
        var relImg = $"../Screenshots/{imgName}";
        var md = $"# 截图 {DateTime.Now:yyyy-MM-dd HH:mm}\n\n![截图]({relImg})\n";
        File.WriteAllText(mdPath, md, Utf8NoBom);
        return mdPath;
    }

    /// <summary>开始一次连续截图会话：多张截图汇总到同一个 Markdown 文件。</summary>
    public ContinuousScreenshotSession StartContinuousScreenshotSession()
    {
        var capturesDir = Path.Combine(RootPath, "Inbox", "Captures");
        Directory.CreateDirectory(capturesDir);
        var stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss");
        var mdPath = Path.Combine(capturesDir, $"capture-series-{stamp}.md");
        var header = $"# 连续截图 {DateTime.Now:yyyy-MM-dd HH:mm}\n\n";
        File.WriteAllText(mdPath, header, Utf8NoBom);
        return new ContinuousScreenshotSession
        {
            MarkdownPath = mdPath,
            Stamp = stamp,
            Count = 0
        };
    }

    /// <summary>将截图追加到连续截图会话中，返回追加后的序号（1-based）。</summary>
    public int AppendScreenshotToContinuousSession(ContinuousScreenshotSession session, string pngSourcePath)
    {
        if (!File.Exists(pngSourcePath))
            throw new FileNotFoundException(pngSourcePath);

        if (!File.Exists(session.MarkdownPath))
            throw new FileNotFoundException(session.MarkdownPath);

        var shotsDir = Path.Combine(RootPath, "Inbox", "Screenshots");
        Directory.CreateDirectory(shotsDir);

        var nextIndex = session.Count + 1;
        var imgName = $"series-{session.Stamp}-{nextIndex:000}.png";
        var destImg = Path.Combine(shotsDir, imgName);
        File.Copy(pngSourcePath, destImg, overwrite: false);

        var relImg = $"../Screenshots/{imgName}";
        var section = $"## 截图 {nextIndex}\n\n![截图 {nextIndex}]({relImg})\n\n";
        File.AppendAllText(session.MarkdownPath, section, Utf8NoBom);
        session.Count = nextIndex;
        return nextIndex;
    }

    /// <summary>AI 对话导出：AI/Conversations/chat-时间戳.md。若提供截图路径，复制到 Attachments/Images。</summary>
    public string SaveGlobalChatTranscript(string markdownBody, string? screenshotSourcePath = null)
    {
        var convDir = Path.Combine(RootPath, "AI", "Conversations");
        Directory.CreateDirectory(convDir);
        var stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss");
        var name = $"chat-{stamp}.md";
        var path = Path.Combine(convDir, name);

        var header = new StringBuilder();
        header.Append($"# AI 对话 {DateTime.Now:yyyy-MM-dd HH:mm:ss}\n\n");

        if (!string.IsNullOrWhiteSpace(screenshotSourcePath) && File.Exists(screenshotSourcePath))
        {
            var imagesDir = Path.Combine(RootPath, "Attachments", "Images");
            Directory.CreateDirectory(imagesDir);
            var imgName = $"chat-{stamp}.png";
            var destImg = Path.Combine(imagesDir, imgName);
            File.Copy(screenshotSourcePath, destImg, overwrite: false);
            var relImg = $"../../Attachments/Images/{imgName}";
            header.Append($"![截图]({relImg})\n\n---\n\n");
        }

        var text = header.ToString() + markdownBody.TrimEnd() + "\n";
        File.WriteAllText(path, text, Utf8NoBom);
        return path;
    }

    /// <summary>快速笔录：保存到 Inbox/Captures/quick-时间戳.md</summary>
    public string SaveQuickCapture(string markdownBody)
    {
        var dir = Path.Combine(RootPath, "Inbox", "Captures");
        Directory.CreateDirectory(dir);
        var name = $"quick-{DateTime.Now:yyyyMMdd-HHmmss}.md";
        var path = Path.Combine(dir, name);
        var text = $"# 快速笔录 {DateTime.Now:yyyy-MM-dd HH:mm}\n\n{markdownBody.TrimEnd()}\n";
        File.WriteAllText(path, text, Utf8NoBom);
        return path;
    }

    /// <summary>新建桌面便签文件（Journal/Stickies 目录）。</summary>
    public string CreateStickyNoteFile()
    {
        var dir = Path.Combine(RootPath, "Journal", "Stickies");
        Directory.CreateDirectory(dir);
        var stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss");
        var path = Path.Combine(dir, $"sticky-{stamp}.md");
        var day = DateTime.Now.ToString("yyyy-MM-dd");
        File.WriteAllText(path, $"# {day}\n\n", Utf8NoBom);
        return path;
    }

    /// <summary>
    /// 将便签保存到「每日笔记」目录：若笔记根本身名为 Daily Note 则直接保存在根下；
    /// 否则保存在 <c>笔记根/Daily Note/</c>（兼容仍指向旧版 DanceMonkeyNotes 的配置）。
    /// 文件名为 <c>yyyy-MM-dd.md</c>；若已存在则依次 <c>yyyy-MM-dd-1.md</c>、<c>-2</c> …
    /// 正文首行为 <c># yyyy-MM-dd</c>（会去掉原内容顶部单行 # 标题以免重复）。
    /// </summary>
    public string SaveStickyToDailyNote(string markdownBody)
    {
        var dailyDir = ResolveDailyNoteSaveDirectory();
        Directory.CreateDirectory(dailyDir);
        var day = DateTime.Now.ToString("yyyy-MM-dd");
        var path = AllocateDailyNoteFilePath(dailyDir, day);
        var body = BuildDailyNoteMarkdown(markdownBody, day);
        File.WriteAllText(path, body, Utf8NoBom);
        return path;
    }

    private static string AllocateDailyNoteFilePath(string dailyDir, string day)
    {
        var primary = Path.Combine(dailyDir, $"{day}.md");
        if (!File.Exists(primary))
            return primary;
        for (var n = 1; ; n++)
        {
            var p = Path.Combine(dailyDir, $"{day}-{n}.md");
            if (!File.Exists(p))
                return p;
        }
    }

    private static string BuildDailyNoteMarkdown(string markdownBody, string day)
    {
        var t = markdownBody.TrimEnd();
        var lines = t.Split(new[] { "\r\n", "\r", "\n" }, StringSplitOptions.None);
        var start = 0;
        if (lines.Length > 0 && lines[0].TrimStart().StartsWith("# ", StringComparison.Ordinal))
            start = 1;
        var rest = string.Join(Environment.NewLine, lines.Skip(start)).TrimStart();
        return string.IsNullOrEmpty(rest) ? $"# {day}\n\n" : $"# {day}\n\n{rest}\n";
    }

    /// <summary>每日归档目录：Journal/Daily。</summary>
    private string ResolveDailyNoteSaveDirectory()
    {
        return Path.GetFullPath(Path.Combine(RootPath, "Journal", "Daily"));
    }

    public void Save(string fullPath, string content)
    {
        if (!IsUnderRoot(fullPath))
            throw new InvalidOperationException("路径不在笔记根目录内");
        Directory.CreateDirectory(Path.GetDirectoryName(fullPath)!);

        // ── #15 版本历史：保存前将旧版本备份到 .history/ ──
        BackupToHistory(fullPath);

        File.WriteAllText(fullPath, content, Utf8NoBom);
    }

    /// <summary>将文件当前内容备份到同级 .history/ 隐藏目录（文件级版本历史）。</summary>
    private static void BackupToHistory(string fullPath)
    {
        try
        {
            if (!File.Exists(fullPath)) return;
            var dir = Path.GetDirectoryName(fullPath)!;
            var historyDir = Path.Combine(dir, ".history");
            Directory.CreateDirectory(historyDir);
            // 标记为隐藏目录
            try { new DirectoryInfo(historyDir).Attributes |= FileAttributes.Hidden; } catch { }

            var stem = Path.GetFileNameWithoutExtension(fullPath);
            var ext = Path.GetExtension(fullPath);
            var stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss-fff");
            var backupName = $"{stem}.{stamp}{ext}";
            var backupPath = Path.Combine(historyDir, backupName);
            File.Copy(fullPath, backupPath, overwrite: false);

            // 清理：每个文件最多保留 50 个历史版本
            CleanupHistory(historyDir, stem, ext, maxVersions: 50);
        }
        catch
        {
            // 备份失败不应阻止正常保存
        }
    }

    private static void CleanupHistory(string historyDir, string stem, string ext, int maxVersions)
    {
        try
        {
            var pattern = $"{stem}.*{ext}";
            var files = Directory.EnumerateFiles(historyDir, pattern)
                .OrderByDescending(f => f, StringComparer.OrdinalIgnoreCase)
                .Skip(maxVersions)
                .ToList();
            foreach (var f in files)
            {
                try { File.Delete(f); } catch { }
            }
        }
        catch { }
    }

    /// <summary>获取指定文件的版本历史列表（最新在前）。</summary>
    public IReadOnlyList<(string Path, DateTime Timestamp)> GetVersionHistory(string fullPath)
    {
        var dir = Path.GetDirectoryName(fullPath)!;
        var historyDir = Path.Combine(dir, ".history");
        if (!Directory.Exists(historyDir))
            return Array.Empty<(string, DateTime)>();

        var stem = Path.GetFileNameWithoutExtension(fullPath);
        var ext = Path.GetExtension(fullPath);
        var pattern = $"{stem}.*{ext}";

        return Directory.EnumerateFiles(historyDir, pattern)
            .Select(f => new FileInfo(f))
            .OrderByDescending(f => f.LastWriteTimeUtc)
            .Select(f => (f.FullName, f.LastWriteTimeUtc))
            .ToList();
    }

    public string Read(string fullPath)
    {
        return File.ReadAllText(fullPath, Encoding.UTF8);
    }

    public void Delete(string fullPath)
    {
        if (!IsUnderRoot(fullPath))
            throw new InvalidOperationException("路径不在笔记根目录内");
        if (Directory.Exists(fullPath))
        {
            RemoveFolderOverrideForSubtree(fullPath);
            Directory.Delete(fullPath, recursive: true);
        }
        else if (File.Exists(fullPath))
        {
            if (fullPath.EndsWith(".md", StringComparison.OrdinalIgnoreCase))
            {
                var sub = GetSubnotesDirectoryForMarkdown(fullPath);
                File.Delete(fullPath);
                if (Directory.Exists(sub))
                {
                    RemoveFolderOverrideForSubtree(sub);
                    Directory.Delete(sub, recursive: true);
                }
            }
            else
                File.Delete(fullPath);
        }
    }

    /// <summary>移动文件/文件夹到目标文件夹下。</summary>
    public string MoveToFolder(string sourcePath, string targetFolderPath)
    {
        if (!IsUnderRoot(sourcePath))
            throw new InvalidOperationException("源路径不在笔记根目录内");
        if (!IsUnderRoot(targetFolderPath))
            throw new InvalidOperationException("目标路径不在笔记根目录内");
        if (!Directory.Exists(targetFolderPath))
            throw new DirectoryNotFoundException($"目标文件夹不存在：{targetFolderPath}");

        var name = Path.GetFileName(sourcePath);
        var dest = Path.GetFullPath(Path.Combine(targetFolderPath, name));
        if (!IsUnderRoot(dest))
            throw new InvalidOperationException("目标路径无效。");

        if (string.Equals(Path.GetFullPath(sourcePath), dest, StringComparison.OrdinalIgnoreCase))
            return dest; // 同位置不需要移动

        // 避免覆盖已有同名项
        if (File.Exists(dest) || Directory.Exists(dest))
            throw new InvalidOperationException($"目标位置已存在同名项：{name}");

        if (File.Exists(sourcePath))
        {
            if (sourcePath.EndsWith(".md", StringComparison.OrdinalIgnoreCase))
            {
                var oldSub = GetSubnotesDirectoryForMarkdown(sourcePath);
                File.Move(sourcePath, dest);
                if (Directory.Exists(oldSub))
                {
                    var newSub = GetSubnotesDirectoryForMarkdown(dest);
                    if (!Directory.Exists(newSub))
                    {
                        try
                        {
                            Directory.Move(oldSub, newSub);
                        }
                        catch
                        {
                            // 子目录未随动时保留在原父目录，避免移动主文件失败
                        }
                    }
                }
            }
            else
                File.Move(sourcePath, dest);
        }
        else if (Directory.Exists(sourcePath))
        {
            Directory.Move(sourcePath, dest);
            MoveFolderOverrideSubtree(sourcePath, dest);
        }
        else
            throw new FileNotFoundException(sourcePath);

        return dest;
    }

    /// <summary>复制文件完整路径到剪贴板用字符串。</summary>
    public static string GetCopyPath(string fullPath) => Path.GetFullPath(fullPath);

    public string Rename(string fullPath, string newName)
    {
        if (!IsUnderRoot(fullPath))
            throw new InvalidOperationException("路径不在笔记根目录内");
        newName = newName.Trim();
        foreach (var c in Path.GetInvalidFileNameChars())
        {
            if (newName.Contains(c))
                throw new ArgumentException("名称包含非法字符。");
        }

        var parent = Path.GetDirectoryName(fullPath)!;
        if (File.Exists(fullPath) && !newName.EndsWith(".md", StringComparison.OrdinalIgnoreCase))
            newName += ".md";

        var target = Path.GetFullPath(Path.Combine(parent, newName));
        if (!IsUnderRoot(target))
            throw new InvalidOperationException("目标路径无效。");
        if (File.Exists(fullPath))
        {
            if (fullPath.EndsWith(".md", StringComparison.OrdinalIgnoreCase))
            {
                var oldSub = GetSubnotesDirectoryForMarkdown(fullPath);
                File.Move(fullPath, target);
                if (Directory.Exists(oldSub))
                {
                    var newSub = GetSubnotesDirectoryForMarkdown(target);
                    if (!Directory.Exists(newSub))
                    {
                        try
                        {
                            Directory.Move(oldSub, newSub);
                        }
                        catch
                        {
                            // 重命名主文件已成功；子目录冲突或占用时跳过
                        }
                    }
                }
            }
            else
                File.Move(fullPath, target);
        }
        else if (Directory.Exists(fullPath))
        {
            Directory.Move(fullPath, target);
            MoveFolderOverrideSubtree(fullPath, target);
        }
        else
            throw new FileNotFoundException(fullPath);

        return target;
    }

    /// <summary>将整个笔记根目录导出为 zip（保留相对路径）。</summary>
    public void ExportToZip(string zipFilePath)
    {
        if (File.Exists(zipFilePath))
            File.Delete(zipFilePath);

        using var zip = ZipFile.Open(zipFilePath, ZipArchiveMode.Create);
        var root = Path.GetFullPath(RootPath);
        foreach (var file in Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories))
        {
            if (file.EndsWith(".tmp", StringComparison.OrdinalIgnoreCase))
                continue;
            // 跳过 .history 备份目录
            var rel = Path.GetRelativePath(root, file);
            if (rel.Contains(".history", StringComparison.OrdinalIgnoreCase))
                continue;
            zip.CreateEntryFromFile(file, rel.Replace('\\', '/'), CompressionLevel.Optimal);
        }
    }

    /// <summary>#11 导出单个笔记为自包含 HTML 文件。</summary>
    public void ExportNoteToHtml(string mdFullPath, string htmlOutputPath)
    {
        var md = Read(mdFullPath);
        var pipeline = new MarkdownPipelineBuilder().UseAdvancedExtensions().Build();
        var processed = MarkdownHtml.StripFrontmatter(md);
        processed = MarkdownHtml.PreprocessWikiLinks(processed);
        var bodyHtml = Markdig.Markdown.ToHtml(processed, pipeline);
        var noteDir = Path.GetDirectoryName(mdFullPath);
        if (!string.IsNullOrEmpty(noteDir))
            bodyHtml = InlineImagesAsBase64(bodyHtml, noteDir);

        var title = Path.GetFileNameWithoutExtension(mdFullPath);
        var encodedTitle = System.Net.WebUtility.HtmlEncode(title);
        var fullDoc = $$"""
<!DOCTYPE html>
<html><head><meta charset="utf-8"/><title>{{encodedTitle}}</title>
<style>
body{font-family:Segoe UI,system-ui,sans-serif;max-width:800px;margin:0 auto;padding:32px 24px;line-height:1.6;color:#1a1d26;font-size:14px;}
h1{font-size:1.5em;border-bottom:1px solid #eee;padding-bottom:8px;} h2{font-size:1.25em;} h3{font-size:1.1em;}
code{font-family:Consolas,monospace;background:#f0f1f6;padding:0.15em 0.4em;border-radius:4px;font-size:0.92em;}
pre{background:#f0f1f6;padding:14px;border-radius:8px;overflow:auto;font-size:13px;}
pre code{background:transparent;padding:0;}
blockquote{border-left:4px solid #e8eaf0;margin:0.5em 0;padding-left:14px;color:#4b5563;}
table{border-collapse:collapse;margin:0.5em 0;} th,td{border:1px solid #e8eaf0;padding:6px 10px;}
a{color:#4F6EF7;} img{max-width:100%;height:auto;}
ul.contains-task-list{list-style:none;padding-left:0;}
li.task-list-item{margin:0.35em 0;} li.task-list-item input{margin-right:0.5em;}
</style></head><body>
{{bodyHtml}}
</body></html>
""";
        File.WriteAllText(htmlOutputPath, fullDoc, Utf8NoBom);
    }

    /// <summary>将 HTML 中的本地相对图片转为 base64 data URI（自包含）。</summary>
    private static string InlineImagesAsBase64(string html, string baseDir)
    {
        return System.Text.RegularExpressions.Regex.Replace(html,
            @"<img\s[^>]*\bsrc\s*=\s*([""'])([^""']+)\1",
            m =>
            {
                var quote = m.Groups[1].Value;
                var src = m.Groups[2].Value.Trim();
                if (string.IsNullOrEmpty(src) ||
                    src.StartsWith("data:", StringComparison.OrdinalIgnoreCase) ||
                    src.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
                    src.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
                    return m.Value;
                try
                {
                    var rel = src.Replace('/', Path.DirectorySeparatorChar);
                    var full = Path.GetFullPath(Path.Combine(baseDir, rel));
                    if (!File.Exists(full)) return m.Value;
                    var ext = Path.GetExtension(full).TrimStart('.').ToLowerInvariant();
                    var mime = ext switch
                    {
                        "jpg" or "jpeg" => "image/jpeg",
                        "png" => "image/png",
                        "gif" => "image/gif",
                        "svg" => "image/svg+xml",
                        "webp" => "image/webp",
                        _ => "application/octet-stream"
                    };
                    var b64 = Convert.ToBase64String(File.ReadAllBytes(full));
                    var dataUrl = $"data:{mime};base64,{b64}";
                    return m.Value.Replace($"{quote}{src}{quote}", $"{quote}{dataUrl}{quote}");
                }
                catch { return m.Value; }
            },
            System.Text.RegularExpressions.RegexOptions.IgnoreCase);
    }

    /// <summary>将 zip 解压到「Imported-时间戳」子目录，避免覆盖现有结构。</summary>
    public string ImportZip(string zipFilePath)
    {
        if (!File.Exists(zipFilePath))
            throw new FileNotFoundException(zipFilePath);

        var folder = Path.Combine(RootPath, $"Imported-{DateTime.Now:yyyyMMdd-HHmmss}");
        Directory.CreateDirectory(folder);
        ZipFile.ExtractToDirectory(zipFilePath, folder);
        return folder;
    }

    private static readonly UTF8Encoding Utf8NoBom = new(encoderShouldEmitUTF8Identifier: false);
}
