using System.Text.RegularExpressions;

namespace DanceMonkey.Agent.Core.Runtime;

public enum SkillActivationMode
{
    Auto,
    Manual,
    Always
}

/// <summary>单个 Skill 定义。</summary>
public sealed record SkillDefinition(
    string Name,
    string Content,
    string SourcePath,
    string? Summary,
    string? Description = null,
    IReadOnlyList<string>? AllowedTools = null,
    IReadOnlyList<string>? Triggers = null,
    SkillActivationMode Activation = SkillActivationMode.Auto,
    IReadOnlyDictionary<string, string>? Metadata = null)
{
    public IReadOnlyList<string> AllowedTools { get; init; } = AllowedTools ?? Array.Empty<string>();
    public IReadOnlyList<string> Triggers { get; init; } = Triggers ?? Array.Empty<string>();
    public IReadOnlyDictionary<string, string> Metadata { get; init; } = Metadata ?? new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    public string EffectiveDescription => FirstNonBlank(Description, Summary) ?? "";

    private static string? FirstNonBlank(params string?[] values) =>
        values.FirstOrDefault(v => !string.IsNullOrWhiteSpace(v))?.Trim();
}

/// <summary>运行时可用 Skill 集合。</summary>
public sealed class SkillCatalog
{
    private static readonly HttpClient Http = new();
    private static readonly Regex FrontMatterFence = new(@"^\s*---\s*$", RegexOptions.Compiled);
    private static readonly Regex ListItem = new(@"^\s*-\s*(.+?)\s*$", RegexOptions.Compiled);
    private readonly Dictionary<string, SkillDefinition> _skills = new(StringComparer.OrdinalIgnoreCase);

    public IReadOnlyCollection<SkillDefinition> All => _skills.Values;

    public int Count => _skills.Count;

    public bool TryGet(string name, out SkillDefinition skill) => _skills.TryGetValue(name, out skill!);

    public SkillCatalog Add(SkillDefinition skill)
    {
        if (string.IsNullOrWhiteSpace(skill.Name) || string.IsNullOrWhiteSpace(skill.Content))
            return this;
        _skills[skill.Name] = skill;
        return this;
    }

    public static SkillCatalog LoadFromDirectories(IEnumerable<string> roots)
    {
        var catalog = new SkillCatalog();
        foreach (var root in roots.Where(Directory.Exists))
        {
            foreach (var skillPath in EnumerateSkillFilesSafe(root))
            {
                try
                {
                    var skill = LoadFromFile(skillPath);
                    if (skill != null)
                        catalog.Add(skill);
                }
                catch
                {
                    // 忽略坏文件，避免阻断主流程
                }
            }
        }
        return catalog;
    }

    public static SkillDefinition? LoadFromFile(string skillPath)
    {
        var content = File.ReadAllText(skillPath);
        if (string.IsNullOrWhiteSpace(content))
            return null;

        var dir = Path.GetDirectoryName(skillPath) ?? "";
        var fallbackName = Path.GetFileName(dir);
        if (string.IsNullOrWhiteSpace(fallbackName))
            fallbackName = Path.GetFileNameWithoutExtension(skillPath);

        return Parse(content, skillPath, fallbackName);
    }

    public static SkillDefinition Parse(string markdown, string sourcePath, string fallbackName)
    {
        var (metadata, body) = SplitFrontMatter(markdown);
        var name = FirstMetadataValue(metadata, "name", "title");
        if (string.IsNullOrWhiteSpace(name))
            name = fallbackName;
        name = SanitizeSkillName(name!);

        var description = FirstMetadataValue(metadata, "description", "summary");
        var summary = ExtractSummary(body);
        var allowedTools = ParseList(FirstMetadataValue(metadata, "allowed-tools", "allowed_tools", "tools"))
            .Select(NormalizeToolName)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        var triggers = ParseList(FirstMetadataValue(metadata, "triggers", "trigger", "keywords"));
        var activation = ParseActivation(FirstMetadataValue(metadata, "activation-mode", "activation_mode", "activation", "auto-activate", "auto_activate"));

        return new SkillDefinition(
            name.Trim(),
            body.Trim(),
            sourcePath,
            summary,
            description,
            allowedTools,
            triggers,
            activation,
            metadata);
    }

    public static List<string> BuildSearchRoots(string workingDirectory)
    {
        var roots = new List<string>
        {
            Path.Combine(workingDirectory, ".dancemonkey", "skills"),
            Path.Combine(workingDirectory, ".github", "skills"),
            Path.Combine(workingDirectory, ".agents", "skills"),
            Path.Combine(workingDirectory, ".claude", "skills"),
            Path.Combine(workingDirectory, ".cursor", "skills"),
        };
        var userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        if (!string.IsNullOrWhiteSpace(userProfile))
        {
            roots.Add(Path.Combine(userProfile, ".dancemonkey", "skills"));
            roots.Add(Path.Combine(userProfile, ".claude", "skills"));
            roots.Add(Path.Combine(userProfile, ".cursor", "skills"));
            roots.Add(Path.Combine(userProfile, ".cursor", "skills-cursor"));
        }
        return roots
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    /// <summary>导入本地 skill 文件或目录到项目技能目录。</summary>
    public static SkillDefinition ImportLocal(string sourcePath, string workingDirectory)
    {
        if (string.IsNullOrWhiteSpace(sourcePath))
            throw new ArgumentException("sourcePath 不能为空。", nameof(sourcePath));

        var sourceFull = Path.IsPathRooted(sourcePath)
            ? Path.GetFullPath(sourcePath)
            : Path.GetFullPath(Path.Combine(workingDirectory, sourcePath));
        string skillName;
        string markdown;

        if (Directory.Exists(sourceFull))
        {
            var skillFile = Path.Combine(sourceFull, "SKILL.md");
            if (!File.Exists(skillFile))
                throw new FileNotFoundException("目录内未找到 SKILL.md。", skillFile);
            skillName = Path.GetFileName(sourceFull);
            markdown = File.ReadAllText(skillFile);
        }
        else if (File.Exists(sourceFull))
        {
            markdown = File.ReadAllText(sourceFull);
            var fileName = Path.GetFileName(sourceFull);
            if (fileName.Equals("SKILL.md", StringComparison.OrdinalIgnoreCase))
            {
                var parent = Path.GetDirectoryName(sourceFull) ?? "";
                skillName = string.IsNullOrWhiteSpace(parent) ? "imported-skill" : Path.GetFileName(parent);
            }
            else
            {
                skillName = Path.GetFileNameWithoutExtension(sourceFull);
            }
        }
        else
        {
            throw new FileNotFoundException("源路径不存在。", sourceFull);
        }

        var parsed = Parse(markdown, sourceFull, skillName);
        skillName = SanitizeSkillName(parsed.Name);
        if (string.IsNullOrWhiteSpace(parsed.Content))
            throw new InvalidDataException("SKILL.md 内容为空。");

        var targetDir = Path.Combine(workingDirectory, ".dancemonkey", "skills", skillName);
        Directory.CreateDirectory(targetDir);
        var targetPath = Path.Combine(targetDir, "SKILL.md");
        File.WriteAllText(targetPath, markdown.Trim() + Environment.NewLine);

        return Parse(markdown, targetPath, skillName);
    }

    /// <summary>从 URL 下载 markdown 并导入到项目技能目录。</summary>
    public static SkillDefinition ImportFromUrl(
        string url,
        string workingDirectory,
        int maxBytes = 512 * 1024,
        TimeSpan? timeout = null,
        IReadOnlySet<string>? allowedHosts = null)
    {
        if (string.IsNullOrWhiteSpace(url))
            throw new ArgumentException("url 不能为空。", nameof(url));
        if (!Uri.TryCreate(url.Trim(), UriKind.Absolute, out var uri) ||
            (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
            throw new ArgumentException("仅支持 http/https URL。", nameof(url));
        if (allowedHosts is { Count: > 0 } && !allowedHosts.Contains(uri.Host))
            throw new InvalidOperationException($"URL 域名不在允许列表中: {uri.Host}");
        if (maxBytes <= 0)
            throw new ArgumentOutOfRangeException(nameof(maxBytes), "maxBytes 必须大于 0。");

        string markdown;
        try
        {
            using var cts = new CancellationTokenSource(timeout ?? TimeSpan.FromSeconds(10));
            using var resp = Http.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead, cts.Token).GetAwaiter().GetResult();
            if (!resp.IsSuccessStatusCode)
                throw new InvalidOperationException($"HTTP {(int)resp.StatusCode}");
            if (resp.Content.Headers.ContentLength is long len && len > maxBytes)
                throw new InvalidDataException($"下载内容过大（{len} bytes），上限 {maxBytes} bytes。");
            using var stream = resp.Content.ReadAsStreamAsync(cts.Token).GetAwaiter().GetResult();
            using var reader = new StreamReader(stream);
            using var writer = new StringWriter();
            var buffer = new char[4096];
            var totalBytes = 0;
            while (true)
            {
                var n = reader.Read(buffer, 0, buffer.Length);
                if (n <= 0) break;
                var chunk = new string(buffer, 0, n);
                totalBytes += System.Text.Encoding.UTF8.GetByteCount(chunk);
                if (totalBytes > maxBytes)
                    throw new InvalidDataException($"下载内容过大（超过 {maxBytes} bytes）。");
                writer.Write(chunk);
            }
            markdown = writer.ToString();
        }
        catch (Exception ex)
        {
            throw new InvalidOperationException($"下载失败: {ex.Message}", ex);
        }

        if (string.IsNullOrWhiteSpace(markdown))
            throw new InvalidDataException("下载内容为空。");

        var guessedName = GuessSkillNameFromUrl(uri);
        var parsed = Parse(markdown, uri.ToString(), guessedName);
        var skillName = SanitizeSkillName(parsed.Name);
        var targetDir = Path.Combine(workingDirectory, ".dancemonkey", "skills", skillName);
        Directory.CreateDirectory(targetDir);
        var targetPath = Path.Combine(targetDir, "SKILL.md");
        File.WriteAllText(targetPath, markdown.Trim() + Environment.NewLine);

        return Parse(markdown, targetPath, skillName);
    }

    public static bool MatchesPrompt(SkillDefinition skill, string? userInput)
    {
        if (string.IsNullOrWhiteSpace(userInput))
            return skill.Activation == SkillActivationMode.Always;

        if (skill.Activation == SkillActivationMode.Always)
            return true;
        if (skill.Activation == SkillActivationMode.Manual)
            return false;

        var input = userInput.Trim();
        if (ContainsToken(input, skill.Name) || ContainsToken(input, "@" + skill.Name))
            return true;

        if (skill.Triggers.Any(t => ContainsToken(input, t)))
            return true;

        var score = 0;
        foreach (var keyword in ExtractKeywords(skill.Name).Concat(skill.EffectiveDescription.SplitKeywords()).Distinct(StringComparer.OrdinalIgnoreCase))
        {
            if (ContainsToken(input, keyword))
                score += keyword.Length >= 6 ? 2 : 1;
            if (score >= 2)
                return true;
        }

        return false;
    }

    public static string SanitizeSkillName(string raw)
    {
        var name = (raw ?? "").Trim();
        if (string.IsNullOrWhiteSpace(name)) return "imported-skill";
        var invalid = Path.GetInvalidFileNameChars();
        var chars = name.Select(c => invalid.Contains(c) ? '-' : c).ToArray();
        return new string(chars).Trim();
    }

    private static (Dictionary<string, string> Metadata, string Body) SplitFrontMatter(string markdown)
    {
        using var reader = new StringReader(markdown ?? "");
        var first = reader.ReadLine();
        if (first == null || !FrontMatterFence.IsMatch(first))
            return (new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase), markdown ?? "");

        var metadata = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        string? currentKey = null;
        var body = new List<string>();
        var inMatter = true;

        while (reader.ReadLine() is { } line)
        {
            if (inMatter)
            {
                if (FrontMatterFence.IsMatch(line))
                {
                    inMatter = false;
                    continue;
                }

                var item = ListItem.Match(line);
                if (item.Success && currentKey != null)
                {
                    metadata[currentKey] = AppendCsv(metadata.TryGetValue(currentKey, out var existing) ? existing : "", item.Groups[1].Value);
                    continue;
                }

                var colon = line.IndexOf(':');
                if (colon <= 0)
                    continue;

                currentKey = line[..colon].Trim();
                var value = line[(colon + 1)..].Trim();
                metadata[currentKey] = TrimYamlScalar(value);
            }
            else
            {
                body.Add(line);
            }
        }

        if (inMatter)
            return (new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase), markdown ?? "");

        return (metadata, string.Join(Environment.NewLine, body));
    }

    private static string? FirstMetadataValue(IReadOnlyDictionary<string, string> metadata, params string[] keys)
    {
        foreach (var key in keys)
        {
            if (metadata.TryGetValue(key, out var value) && !string.IsNullOrWhiteSpace(value))
                return value.Trim();
        }
        return null;
    }

    private static IReadOnlyList<string> ParseList(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
            return Array.Empty<string>();

        var trimmed = value.Trim();
        if (trimmed.StartsWith("[") && trimmed.EndsWith("]"))
            trimmed = trimmed[1..^1];

        return trimmed
            .Split(new[] { ',', '，', ';', '；', '\n', '\r' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(TrimYamlScalar)
            .Where(v => !string.IsNullOrWhiteSpace(v))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    private static SkillActivationMode ParseActivation(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
            return SkillActivationMode.Auto;

        var v = value.Trim().Trim('"', '\'').ToLowerInvariant();
        if (v is "always" or "true" or "yes" or "on")
            return SkillActivationMode.Always;
        if (v is "manual" or "false" or "no" or "off" or "never")
            return SkillActivationMode.Manual;
        return SkillActivationMode.Auto;
    }

    private static string GuessSkillNameFromUrl(Uri uri)
    {
        var last = uri.Segments.LastOrDefault()?.Trim('/').Trim();
        if (string.IsNullOrWhiteSpace(last))
            return "imported-skill";
        if (last.Equals("SKILL.md", StringComparison.OrdinalIgnoreCase) ||
            last.EndsWith(".md", StringComparison.OrdinalIgnoreCase))
        {
            if (uri.Segments.Length >= 2)
            {
                var parent = uri.Segments[^2].Trim('/').Trim();
                if (!string.IsNullOrWhiteSpace(parent))
                    return parent;
            }
            return Path.GetFileNameWithoutExtension(last);
        }
        return Path.GetFileNameWithoutExtension(last);
    }

    private static IEnumerable<string> EnumerateSkillFilesSafe(string root)
    {
        try
        {
            return Directory.EnumerateFiles(root, "SKILL.md", SearchOption.AllDirectories);
        }
        catch
        {
            return Array.Empty<string>();
        }
    }

    private static string? ExtractSummary(string markdown)
    {
        foreach (var line in markdown.Split('\n'))
        {
            var t = line.Trim();
            if (string.IsNullOrWhiteSpace(t)) continue;
            if (t.StartsWith("#")) continue;
            return t.Length <= 120 ? t : t[..120] + "…";
        }
        return null;
    }

    private static string AppendCsv(string existing, string value) =>
        string.IsNullOrWhiteSpace(existing) ? TrimYamlScalar(value) : $"{existing},{TrimYamlScalar(value)}";

    private static string TrimYamlScalar(string value)
    {
        var v = (value ?? "").Trim();
        if (v.Length >= 2 && ((v[0] == '"' && v[^1] == '"') || (v[0] == '\'' && v[^1] == '\'')))
            return v[1..^1].Trim();
        return v;
    }

    private static string NormalizeToolName(string tool)
    {
        var t = TrimYamlScalar(tool);
        var name = t;
        var paren = name.IndexOf('(');
        if (paren > 0)
            name = name[..paren];

        return name.Trim().ToLowerInvariant() switch
        {
            "read" => "read_file",
            "write" => "write_file",
            "edit" => "edit_file",
            "bash" => "run_shell",
            "ls" => "list_dir",
            "list" => "list_dir",
            "glob" => "list_dir",
            _ => t
        };
    }

    private static bool ContainsToken(string input, string token)
    {
        if (string.IsNullOrWhiteSpace(input) || string.IsNullOrWhiteSpace(token))
            return false;
        return input.IndexOf(token.Trim(), StringComparison.OrdinalIgnoreCase) >= 0;
    }

    private static IEnumerable<string> ExtractKeywords(string value) => value.SplitKeywords();
}

internal static class SkillCatalogStringExtensions
{
    public static IEnumerable<string> SplitKeywords(this string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
            yield break;

        foreach (var token in Regex.Split(value, @"[\s,，。；;:：/\\|()\[\]{}<>""'`]+"))
        {
            var t = token.Trim('-', '_', '.', '。', '，', '；', ':', '：');
            if (t.Length == 0)
                continue;
            if (IsAscii(t) && t.Length < 4)
                continue;
            if (!IsAscii(t) && t.Length < 2)
                continue;
            if (IsStopWord(t))
                continue;
            yield return t;
        }
    }

    private static bool IsAscii(string value) => value.All(c => c < 128);

    private static bool IsStopWord(string value)
    {
        var v = value.ToLowerInvariant();
        return v is "this" or "that" or "when" or "with" or "from" or "into" or "using" or "about" or "skill" or "agent"
            or "使用" or "用于" or "需要" or "根据" or "这个" or "一个" or "技能";
    }
}
