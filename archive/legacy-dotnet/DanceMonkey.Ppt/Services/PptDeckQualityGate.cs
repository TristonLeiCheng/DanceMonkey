using System.Text;
using DanceMonkey.Ppt.Models;

namespace DanceMonkey.Ppt.Services;

/// <summary>
/// 对 LLM 生成的 <see cref="PptDeck"/> 做质量闸门：
/// 1) 生成用户可见的 warnings（不致命）；
/// 2) 对严重问题给出“是否需要返工修复”的判定与原因。
/// </summary>
internal static class PptDeckQualityGate
{
    internal sealed record Result(
        bool ShouldRepair,
        IReadOnlyList<string> Warnings,
        IReadOnlyList<string> RepairReasons);

    public static Result Evaluate(PptDeck deck, PptGenerationRequest request)
    {
        ArgumentNullException.ThrowIfNull(deck);
        ArgumentNullException.ThrowIfNull(request);

        var warnings = new List<string>();
        var reasons = new List<string>();

        var slides = deck.EnumerateSlides().ToList();
        if (slides.Count == 0)
            return new Result(true, new[] { "Deck 没有任何内容页。" }, new[] { "missing_slides" });

        // 标题（高级感更依赖短标题与可扫读）
        foreach (var s in slides)
        {
            if (!string.IsNullOrWhiteSpace(s.Title) && s.Title!.Trim().Length > 18)
            {
                warnings.Add($"页面标题偏长（>18字）：{Shorten(s.Title, 26)}");
            }
        }

        // keyMessage：缺失视为严重问题（决定“像不像 PPT”）
        var missingKey = slides.Count(s => string.IsNullOrWhiteSpace(s.KeyMessage));
        if (missingKey > 0)
        {
            reasons.Add("missing_keyMessage");
            warnings.Add($"有 {missingKey} 页缺少 keyMessage（核心结论句）。");
        }

        // keyMessage 与 title 重复（高级感会变“标题=主题句”，信息密度低）
        var repeatedKey = slides.Count(s =>
            !string.IsNullOrWhiteSpace(s.KeyMessage) &&
            !string.IsNullOrWhiteSpace(s.Title) &&
            IsNearDuplicate(s.KeyMessage!, s.Title!));
        if (repeatedKey > 0)
        {
            warnings.Add($"有 {repeatedKey} 页 keyMessage 与标题过于接近，建议改为结论句。");
        }

        // bullets 数量与长度
        foreach (var s in slides)
        {
            var bCount = s.Bullets.Count;
            if (bCount == 0 && s.LayoutHint is PptLayoutHint.Bullets or PptLayoutHint.TwoColumn)
            {
                reasons.Add("missing_bullets");
                warnings.Add($"页面缺少 bullets：{Shorten(s.Title, 20)}");
            }
            if (bCount > 6)
                warnings.Add($"bullets 过多（>{6}）：{Shorten(s.Title, 20)}（{bCount} 条）");

            foreach (var b in s.Bullets)
            {
                if (b != null && b.Trim().Length > 80)
                    warnings.Add($"bullet 过长（>80字）：{Shorten(b, 40)}");
            }
            foreach (var b in s.RightBullets)
            {
                if (b != null && b.Trim().Length > 80)
                    warnings.Add($"右栏 bullet 过长（>80字）：{Shorten(b, 40)}");
            }
        }

        // twoColumn：左右都要有内容，否则降级或修复
        var badTwoCol = slides.Count(s => s.LayoutHint == PptLayoutHint.TwoColumn && (s.Bullets.Count < 2 || s.RightBullets.Count < 2));
        if (badTwoCol > 0)
        {
            warnings.Add($"有 {badTwoCol} 页 twoColumn 版式左右栏内容不足（建议每栏 2-4 条）。");
        }

        // quote：需要正文与来源（subtitle）
        var badQuote = slides.Count(s => s.LayoutHint == PptLayoutHint.Quote && (s.Bullets.Count == 0 || string.IsNullOrWhiteSpace(s.Subtitle)));
        if (badQuote > 0)
        {
            warnings.Add($"有 {badQuote} 页 quote 版式缺少引述正文或来源（subtitle）。");
        }

        // 版式节奏：连续 3 页相同版式会疲劳（不致命，提示即可）
        var run = LongestSameLayoutRun(slides);
        if (run >= 3)
        {
            warnings.Add($"存在连续 {run} 页相同版式，建议混合 twoColumn/quote/图文页提升节奏。");
        }

        // 页数偏离：偏离过大会影响“高级感”（要么信息过载要么灌水）
        if (request.TargetSlides is int target and > 0)
        {
            // 估算总页：封面+结尾由渲染器自动补
            var estimatedTotal = slides.Count + 2 + (deck.Sections.Count > 1 ? deck.Sections.Count : 0);
            var diff = Math.Abs(estimatedTotal - target);
            if (diff >= Math.Max(3, target / 3))
                warnings.Add($"页数与目标偏差较大：约 {estimatedTotal} 页（目标 {target}）。");
        }

        // 是否需要“自动返工修复”：只对会明显破坏体验的硬问题触发
        var shouldRepair = reasons.Count > 0;
        return new Result(shouldRepair, warnings.Distinct().ToArray(), reasons.Distinct().ToArray());
    }

    public static string BuildRepairPrompt(PptGenerationRequest request, string originalJson, Result gate)
    {
        var sb = new StringBuilder();
        sb.AppendLine("你刚才输出的 PPT 大纲 JSON 需要修复。\n");
        sb.AppendLine("修复要求：");
        sb.AppendLine("1) 只能在原始内容基础上改写结构与表达，不得编造不存在的关键事实、数字、引语。");
        sb.AppendLine("2) 仍然只输出一个 JSON 对象，字段名与 schema 保持一致；不要解释、不要 Markdown 围栏。");
        sb.AppendLine("3) 必须满足高级商务风格：标题短、结论先行、bullets 克制。\n");

        if (gate.RepairReasons.Count > 0)
            sb.AppendLine("需要重点修复的问题：" + string.Join(", ", gate.RepairReasons) + "\n");

        if (request.TargetSlides is int t and > 0)
            sb.AppendLine($"页数目标：含封面/结尾约 {t} 页（尽量贴近）。\n");

        sb.AppendLine("原始 JSON 如下（请在此基础上修复后输出新 JSON）：");
        sb.AppendLine(originalJson.Trim());
        return sb.ToString();
    }

    private static int LongestSameLayoutRun(IReadOnlyList<PptSlide> slides)
    {
        if (slides.Count == 0) return 0;
        var best = 1;
        var run = 1;
        var last = slides[0].LayoutHint;
        for (var i = 1; i < slides.Count; i++)
        {
            var cur = slides[i].LayoutHint;
            if (cur == last)
                run++;
            else
            {
                best = Math.Max(best, run);
                run = 1;
                last = cur;
            }
        }
        return Math.Max(best, run);
    }

    private static bool IsNearDuplicate(string a, string b)
    {
        a = Normalize(a);
        b = Normalize(b);
        if (a.Length == 0 || b.Length == 0) return false;
        if (a == b) return true;
        // 简单包含/前缀判断足够：避免引入昂贵的相似度算法
        if (a.Contains(b, StringComparison.Ordinal) || b.Contains(a, StringComparison.Ordinal)) return true;
        return CommonPrefixLen(a, b) >= Math.Min(8, Math.Min(a.Length, b.Length));
    }

    private static int CommonPrefixLen(string a, string b)
    {
        var n = Math.Min(a.Length, b.Length);
        var i = 0;
        while (i < n && a[i] == b[i]) i++;
        return i;
    }

    private static string Normalize(string s)
    {
        // 去掉空白与常见标点，降低“标题=keyMessage”的误判难度
        var chars = s
            .Where(c => !char.IsWhiteSpace(c))
            .Where(c => c is not '，' and not ',' and not '。' and not '.' and not '：' and not ':' and not '、' and not '；' and not ';' and not '（' and not '(' and not '）' and not ')' and not '【' and not '】' and not '[' and not ']')
            .ToArray();
        return new string(chars).Trim();
    }

    private static string Shorten(string? s, int max)
    {
        if (string.IsNullOrWhiteSpace(s)) return "(无标题)";
        s = s.Trim();
        return s.Length <= max ? s : s[..max] + "...";
    }
}

