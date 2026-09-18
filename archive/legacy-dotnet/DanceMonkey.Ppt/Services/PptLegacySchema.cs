using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using DanceMonkey.Ppt.Internal;
using DanceMonkey.Ppt.Models;

namespace DanceMonkey.Ppt.Services;

/// <summary>
/// 旧版 PPT 大纲 JSON 的固定 prompt 与解析逻辑（原 <c>PptGenerationService</c> 中与「仅大纲」相关的部分）。
/// 供 <see cref="PptLegacyOutlineGenerator"/> 与桌面端 <c>PptGenerationService</c> 委托复用。
/// </summary>
public static class PptLegacySchema
{
    public const string SystemPrompt = """
        你是演示文稿结构设计助手。用户会提供一篇 Markdown 笔记。请将其整理为适合口头演示的幻灯片大纲。
        只输出**一个 JSON 对象**，不要 Markdown 围栏、不要注释、不要解释。
        JSON 结构必须严格如下（字段名区分大小写）：
        {
          "deckTitle": "整场演示的标题（中文，简短）",
          "slides": [
            { "title": "单页标题", "bullets": ["要点1", "要点2"] }
          ]
        }
        要求：
        - slides 数组 4～18 页为宜，按笔记逻辑分节；内容过少时可少于 4 页。
        - 每页 bullets 2～6 条，每条不超过 100 字，使用简洁中文。
        - 不要编造笔记中不存在的关键事实或数据；记不清的内容不要写。
        - 第一页对应 deckTitle 的总体脉络，后续页展开各章节。
        """;

    public static string BuildUserPrompt(string noteMarkdown) =>
        "以下为用户笔记（Markdown）。请生成符合系统说明的 JSON：\n\n" + noteMarkdown.Trim();

    /// <summary>在固定系统提示后附加沙箱 <c>.dancemonkey/skills/*/SKILL.md</c>。</summary>
    public static string BuildLlmSystemPrompt(string? sandboxConfigPath)
    {
        var sb = new StringBuilder(SystemPrompt);
        var items = PptSandboxSkills.ListSkills(sandboxConfigPath);
        if (items.Count == 0)
            return sb.ToString();

        const int maxExtraTotal = 12000;
        var extra = new StringBuilder();
        extra.AppendLine();
        extra.AppendLine("以下为你在「技能管理」中配置的技能（与 Agent 共用同一目录）。生成幻灯片 JSON 大纲时须遵守其中关于行业/风格/合规的说明；");
        extra.AppendLine("若与上方 JSON 结构或「不得编造」冲突，以 JSON 与事实约束为准。技能内容：");
        extra.AppendLine();

        var used = 0;
        foreach (var it in items)
        {
            string text;
            try
            {
                text = File.ReadAllText(it.SkillFilePath, Encoding.UTF8).Trim();
            }
            catch
            {
                continue;
            }
            if (string.IsNullOrEmpty(text)) continue;

            var header = $"### {it.Name}\n";
            var need = header.Length + text.Length + 2;
            if (used + need > maxExtraTotal)
            {
                var room = maxExtraTotal - used - header.Length - 4;
                if (room < 200) break;
                text = text[..room] + "…\n\n";
                extra.Append(header).AppendLine(text);
                extra.AppendLine("…（技能内容因长度已截断，可精简各 SKILL.md 或拆分多技能。）");
                break;
            }

            extra.Append(header).AppendLine(text).AppendLine();
            used += need;
        }

        sb.Append(extra);
        return sb.ToString();
    }

    public static bool TryParseOutline(string raw, out PptOutline? outline, out string? error)
    {
        outline = null;
        error = null;
        var json = ExtractJsonObject(raw);
        if (string.IsNullOrWhiteSpace(json))
        {
            error = "无法从模型回复中识别 JSON。";
            return false;
        }

        try
        {
            var opts = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
            var o = JsonSerializer.Deserialize<PptOutline>(json, opts);
            if (o == null || o.Slides == null || o.Slides.Count == 0)
            {
                error = "JSON 中缺少有效的 slides 数组。";
                return false;
            }

            outline = o;
            return true;
        }
        catch (Exception ex)
        {
            error = $"JSON 解析失败：{ex.Message}";
            return false;
        }
    }

    private static string ExtractJsonObject(string raw)
    {
        var t = raw.Trim();
        var fence = Regex.Match(t, @"```(?:json)?\s*([\s\S]*?)```", RegexOptions.IgnoreCase);
        if (fence.Success)
            t = fence.Groups[1].Value.Trim();

        var start = t.IndexOf('{');
        var end = t.LastIndexOf('}');
        if (start < 0 || end <= start)
            return "";
        return t.Substring(start, end - start + 1);
    }
}
