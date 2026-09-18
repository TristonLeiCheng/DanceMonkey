using System.Text;

namespace DesktopAssistant.Models;

/// <summary>
/// 极简 YAML frontmatter 解析与序列化（仅支持本应用 Inspector 写出的格式）。
/// 支持 <c>summary</c>（多行 <c>|</c> 字面块）、<c>notes</c>（同上）、<c>tags</c>（数组或逗号串）。
/// 其他键在解析时会原样保留到 <see cref="ExtraLines"/>，再写出时回填。
/// </summary>
public sealed class NoteFrontmatter
{
    public string Summary { get; set; } = "";
    public string Notes { get; set; } = "";
    public List<string> Tags { get; set; } = new();

    /// <summary>原始 frontmatter 中无法识别的行（保持顺序，序列化时原样回填）。</summary>
    public List<string> ExtraLines { get; } = new();

    /// <summary>解析 markdown 开头的 <c>---</c> frontmatter 块。<paramref name="body"/> 输出剥离 frontmatter 后的正文。</summary>
    public static NoteFrontmatter Parse(string markdown, out string body)
    {
        var fm = new NoteFrontmatter();
        body = markdown ?? "";
        if (string.IsNullOrEmpty(markdown))
            return fm;

        // 必须以 "---\n" 或 "---\r\n" 开头
        if (!markdown.StartsWith("---", StringComparison.Ordinal))
            return fm;
        var firstNl = markdown.IndexOf('\n');
        if (firstNl < 0)
            return fm;

        // 找到结束的 "\n---" 行（必须是行首）
        var searchFrom = firstNl + 1;
        int endIdx = -1;
        while (searchFrom < markdown.Length)
        {
            var candidate = markdown.IndexOf("---", searchFrom, StringComparison.Ordinal);
            if (candidate < 0) break;
            // 必须是行首（前一个字符为换行）
            if (candidate == 0 || markdown[candidate - 1] == '\n')
            {
                endIdx = candidate;
                break;
            }
            searchFrom = candidate + 1;
        }
        if (endIdx < 0)
            return fm;

        var fmContent = markdown.Substring(firstNl + 1, endIdx - (firstNl + 1));
        var afterEnd = endIdx + 3; // 跳过 "---"
        // 跳过结束行后的换行
        if (afterEnd < markdown.Length && markdown[afterEnd] == '\r') afterEnd++;
        if (afterEnd < markdown.Length && markdown[afterEnd] == '\n') afterEnd++;
        body = afterEnd <= markdown.Length ? markdown.Substring(afterEnd) : "";

        ParseFrontmatterContent(fm, fmContent);
        return fm;
    }

    private static void ParseFrontmatterContent(NoteFrontmatter fm, string fmContent)
    {
        var lines = fmContent.Split(new[] { "\r\n", "\r", "\n" }, StringSplitOptions.None);
        string? curKey = null;
        var sb = new StringBuilder();
        var inMultiline = false;

        void Flush()
        {
            if (curKey != null)
            {
                AssignKey(fm, curKey, sb.ToString().TrimEnd('\r', '\n'));
                sb.Clear();
                curKey = null;
            }
            inMultiline = false;
        }

        foreach (var rawLine in lines)
        {
            if (inMultiline)
            {
                // 多行块：以 2 空格或制表符缩进的行属于当前键
                if (rawLine.StartsWith("  ", StringComparison.Ordinal) || rawLine.StartsWith("\t", StringComparison.Ordinal))
                {
                    var indented = rawLine.StartsWith("\t", StringComparison.Ordinal)
                        ? rawLine.Substring(1)
                        : rawLine.Substring(2);
                    sb.AppendLine(indented);
                    continue;
                }
                Flush();
            }

            var line = rawLine.TrimEnd();
            if (string.IsNullOrWhiteSpace(line)) continue;

            var colon = line.IndexOf(':');
            if (colon < 0)
            {
                fm.ExtraLines.Add(rawLine);
                continue;
            }

            var key = line.Substring(0, colon).Trim().ToLowerInvariant();
            var val = line.Substring(colon + 1).Trim();

            if (val == "|" || val == "|-" || val == ">")
            {
                curKey = key;
                inMultiline = true;
                continue;
            }

            if (IsKnownKey(key))
                AssignKey(fm, key, val);
            else
                fm.ExtraLines.Add(rawLine);
        }

        Flush();
    }

    private static bool IsKnownKey(string key) => key is "summary" or "notes" or "tags";

    private static void AssignKey(NoteFrontmatter fm, string key, string value)
    {
        switch (key)
        {
            case "summary":
                fm.Summary = StripQuotes(value);
                break;
            case "notes":
                fm.Notes = StripQuotes(value);
                break;
            case "tags":
                fm.Tags = ParseTags(value);
                break;
        }
    }

    private static string StripQuotes(string v)
    {
        v = v?.Trim() ?? "";
        if (v.Length >= 2 &&
            ((v[0] == '"' && v[^1] == '"') || (v[0] == '\'' && v[^1] == '\'')))
        {
            return v.Substring(1, v.Length - 2);
        }
        return v;
    }

    private static List<string> ParseTags(string v)
    {
        v = v.Trim();
        if (v.StartsWith("[", StringComparison.Ordinal) && v.EndsWith("]", StringComparison.Ordinal))
            v = v.Substring(1, v.Length - 2);
        return v.Split(',', StringSplitOptions.RemoveEmptyEntries)
                .Select(t => StripQuotes(t.Trim()))
                .Where(t => !string.IsNullOrWhiteSpace(t))
                .ToList();
    }

    /// <summary>把当前元数据 + 正文重新拼为完整 markdown。</summary>
    public string SerializeWithBody(string body)
    {
        var hasContent = !string.IsNullOrWhiteSpace(Summary) ||
                         !string.IsNullOrWhiteSpace(Notes) ||
                         Tags.Count > 0 ||
                         ExtraLines.Count > 0;

        body ??= "";
        var bodyTrim = body.TrimStart('\r', '\n');

        if (!hasContent)
            return bodyTrim;

        var sb = new StringBuilder();
        sb.Append("---\n");
        AppendStringField(sb, "summary", Summary);
        AppendStringField(sb, "notes", Notes);
        if (Tags.Count > 0)
        {
            sb.Append("tags: [");
            sb.Append(string.Join(", ", Tags.Select(EscapeTag)));
            sb.Append("]\n");
        }
        foreach (var extra in ExtraLines)
            sb.Append(extra).Append('\n');
        sb.Append("---\n\n");
        sb.Append(bodyTrim);
        return sb.ToString();
    }

    private static void AppendStringField(StringBuilder sb, string key, string value)
    {
        if (string.IsNullOrWhiteSpace(value))
            return;

        if (value.Contains('\n'))
        {
            sb.Append(key).Append(": |\n");
            foreach (var line in value.Split('\n'))
                sb.Append("  ").Append(line.TrimEnd('\r')).Append('\n');
        }
        else
        {
            sb.Append(key).Append(": ").Append(EscapeIfNeeded(value)).Append('\n');
        }
    }

    private static string EscapeIfNeeded(string s)
    {
        // 包含 YAML 特殊起始字符或冒号空格时加引号
        if (NeedsQuoting(s))
            return "\"" + s.Replace("\"", "\\\"") + "\"";
        return s;
    }

    private static bool NeedsQuoting(string s)
    {
        if (s.Length == 0) return false;
        var first = s[0];
        if (first == '-' || first == '#' || first == '[' || first == '{' ||
            first == '?' || first == '!' || first == '&' || first == '*' ||
            first == '|' || first == '>' || first == '%' || first == '@' || first == '`')
            return true;
        if (s.Contains(": ", StringComparison.Ordinal)) return true;
        return false;
    }

    private static string EscapeTag(string t)
    {
        if (t.Any(c => char.IsWhiteSpace(c) || c == ',' || c == '[' || c == ']' || c == ':'))
            return "\"" + t.Replace("\"", "\\\"") + "\"";
        return t;
    }
}
