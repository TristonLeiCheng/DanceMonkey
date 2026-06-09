using System.Text;
using DanceMonkey.Ppt.Internal;
using DanceMonkey.Ppt.Models;

namespace DanceMonkey.Ppt.Services;

/// <summary>
/// P2 新版提示词构建器。
/// <para>负责：构建系统提示（含 JSON schema 与「高端大气」视觉规范） + 拼接用户消息。</para>
/// <para>JSON schema：deckTitle/subtitle/sections[].slides[].layoutHint/bullets/speakerNotes/media。</para>
/// <para>同时声明：当模型只能产出旧字段（deckTitle + slides[].title/bullets）时，<see cref="PptDeckJsonParser"/> 仍可解析。</para>
/// </summary>
internal static class PptDeckPromptBuilder
{
    /// <summary>新版系统提示。允许的版式：title/section/bullets/twoColumn/quote/ending。</summary>
    public const string SystemPrompt = """
        你是「演示文稿结构 + 风格设计」助手。用户会提供一篇笔记/文档原文或主题。
        请把原文整理为「适合口头演示」的中文 PPT 大纲。

        只输出**一个 JSON 对象**，不要 Markdown 围栏、不要注释、不要解释。
        JSON 结构（字段名区分大小写；不存在的字段省略，不要写 null）：
        {
          "deckTitle": "整场演示的标题（简短中文）",
          "subtitle": "封面副标题或一句话提要（可选）",
          "sections": [
            {
              "title": "章节标题",
              "summary": "章节一句话简介（可选，作为章节分隔页副标题）",
              "slides": [
                {
                  "title": "页标题",
                  "layoutHint": "bullets",
                  // 可选版式：
                  //   bullets    — 标题 + 要点列表（默认）
                  //   twoColumn  — 左右两栏对比/并列（两组 bullets 时优先使用）
                  //   quote      — 大字引述 + 出处（适合名言/数据亮点/金句）
                  //   section    — 章节分隔页（由系统自动插入，无需手动声明）
                  //   ending     — 结尾页（由系统自动插入，无需手动声明）
                  "keyMessage": "本页最核心的一句话结论（≤30字，观众记不住 bullets 时能带走的唯一信息）",
                  "bullets": ["要点1", "要点2"],  // bullets/twoColumn 版式使用
                  "rightBullets": ["右栏要点1"],   // twoColumn 版式右栏；左栏用 bullets
                  "visualSuggestion": "若建议配图/图表，在此用一句话说明内容与类型，例如「柱状图：三年收入对比」",
                  "speakerNotes": "演讲备注（可选，写入 pptx notes slide）"
                }
              ]
            }
          ]
        }

        结构与质量要求：
        1. **叙事弧（Coherence）**：全场须有完整故事线——背景/现状 → 问题/机会 → 方案/证据 → 结论/行动。
           章节顺序应体现这一递进关系，不可随意排列。
        2. **章节优先**：把内容按逻辑分 2~5 个章节（短笔记可只 1 个章节）。每章节 2~6 页内容页。
        3. **每页核心信息**：每张内容页须填写 `keyMessage`（≤30字的核心结论），让观众在快速翻页时也能把握要点。
        4. **每页 bullets 2~5 条**，每条不超过 80 字；语言简洁、口语友好。
        5. **版式选择策略**：
           - 有两组对立/并列内容 → 用 `twoColumn`（左右各填 bullets / rightBullets）
           - 有高影响力名言、数据亮点或金句 → 用 `quote`（把引语放进 bullets[0]，出处放 subtitle）
           - 其余内容 → 默认 `bullets`
        6. **数据可视化**：当页面包含数字对比、趋势、占比时，在 `visualSuggestion` 中建议合适的图表类型
           （柱状图 / 折线图 / 饼图 / 散点图 / 热力图）及其核心数据维度，供演讲者手动补充。
        7. **不要编造**笔记/文档中不存在的关键事实、数字、引语。记不清的内容不要写。
        8. 第一页（封面）与结尾页由系统自动补，无需在 sections 中显式声明。
        9. **演讲备注**应是 2~4 句口语化提示，展开页面 bullet 背后的逻辑，而不是重复 bullet。
        10. 标题与 bullets 风格高端商务：克制、不堆砌形容词、不用感叹号。
        11. 若用户在追加指令中给出受众/目的/语气/避讳，请遵守，优先级高于以上规则。

        反模式（必须避免）：
        - ✗ 每页 bullets 超过 6 条（信息过载）
        - ✗ 标题超过 18 个字（无法快速扫读）
        - ✗ 连续 3 页以上使用相同版式（视觉疲劳）
        - ✗ 在 bullets 中重复标题信息（浪费空间）
        - ✗ keyMessage 与标题几乎相同（失去意义）
        """;

    /// <summary>追加在系统提示之后的「演示文稿风格契约」，与具体主题脱钩，但要求层级清晰、留白、不密。</summary>
    public const string StyleContract = """
        视觉与表达规范（不直接绘制，由渲染器执行；这里只影响文字内容选择）：
        - 先选择一种叙事模板并贯彻全场，不要像“笔记摘要堆叠”。可选模板（择一）：
          A) 背景/现状 → 问题/机会 → 方案/策略 → 证据/收益 → 风险/落地 → 行动/收束
          B) 目标 → 现状差距 → 关键洞察 → 方案路径 → 里程碑 → 需要的支持/决策
          C) 定义问题 → 原因拆解 → 方案对比 → 推荐方案 → 推进计划 → 下一步
        - 标题简洁，避免长句；尽量在 14 字以内。
        - 标题尽量用“名词短语/结论句”，避免教程腔：不要使用“如何…/浅谈…/全面解析…”等表达。
        - 全场术语必须一致：同一概念只用一种叫法（产品名、指标名、模块名），不要来回切换同义词。
        - bullets 之间避免重复语义；每条信息密度均衡。
        - bullets 句式偏“动词 + 对象 + 结果/原因”的短句，避免堆砌形容词（如“全面提升/显著增强”）。
        - twoColumn 版式：bullets 为左栏内容，rightBullets 为右栏内容，各 2~4 条；两栏应形成对比或并列关系。
        - quote 版式：bullets[0] 填引述正文（≤60字），subtitle 填引述出处或数据来源。
        - keyMessage 要以「结论句」而非「主题句」写作，例如「X 比 Y 快 3 倍」而非「X 与 Y 的速度对比」。
        - visualSuggestion 只在确实有数字/趋势/对比时填写，不强制每页都有。
        - 当来源没有足够内容时，宁可少出页，不要灌水。
        - 每页只表达一个核心结论，避免一页出现多个并列结论。
        - 输出的 JSON 必须能直接被严格的 JSON 解析器接受（无尾逗号、无注释、双引号包裹键值）。
        """;

    /// <summary>构建用户消息：原文 + 可选的请求参数。</summary>
    public static string BuildUserPrompt(string sourceText, PptGenerationRequest request)
    {
        var sb = new StringBuilder();
        sb.AppendLine("以下为用户提供的来源内容（可能是 Markdown / 纯文本 / 主题陈述）：");
        sb.AppendLine();
        sb.AppendLine(sourceText.Trim());
        sb.AppendLine();
        sb.AppendLine("生成要求：");

        if (!string.IsNullOrWhiteSpace(request.Audience))
            sb.AppendLine($"- 受众：{request.Audience}");
        if (!string.IsNullOrWhiteSpace(request.Purpose))
            sb.AppendLine($"- 演示目的：{request.Purpose}");
        if (!string.IsNullOrWhiteSpace(request.Tone))
            sb.AppendLine($"- 语气：{request.Tone}");
        if (request.TargetSlides is int t and > 0)
            sb.AppendLine($"- 目标页数（含封面/结尾）：约 {t} 页");
        if (request.IncludeSpeakerNotes)
            sb.AppendLine("- 需要为每张内容页生成演讲备注（speakerNotes）。");
        if (!string.IsNullOrWhiteSpace(request.AdditionalInstructions))
        {
            sb.AppendLine("- 附加约束：");
            sb.AppendLine(request.AdditionalInstructions.Trim());
        }

        sb.AppendLine();
        sb.AppendLine("请严格按系统说明的 JSON 结构输出。");
        return sb.ToString();
    }

    /// <summary>
    /// 构建系统提示：新版 schema + 风格契约 + 沙箱技能（与旧 BuildLlmSystemPrompt 兼容，复用同一目录）。
    /// </summary>
    public static string BuildSystemPrompt(string? sandboxConfigPath, string? builtinSkillMarkdown = null)
    {
        var sb = new StringBuilder();
        sb.AppendLine(SystemPrompt);
        sb.AppendLine();
        sb.AppendLine(StyleContract);

        // 内置技能（例如精简版 ppt-agent-workflow）：始终最先装载
        if (!string.IsNullOrWhiteSpace(builtinSkillMarkdown))
        {
            sb.AppendLine();
            sb.AppendLine("### 内置 PPT 工作流技能");
            sb.AppendLine(builtinSkillMarkdown.Trim());
        }

        // 沙箱技能：与「技能管理」共用同一目录。失败时静默忽略，不阻塞生成。
        AppendSandboxSkills(sb, sandboxConfigPath);

        return sb.ToString();
    }

    private static void AppendSandboxSkills(StringBuilder sb, string? sandboxConfigPath)
    {
        IReadOnlyList<PptSandboxSkills.SkillItem> items;
        try
        {
            items = PptSandboxSkills.ListSkills(sandboxConfigPath);
        }
        catch
        {
            return;
        }

        if (items.Count == 0) return;

        const int maxExtraTotal = 12000;
        var extra = new StringBuilder();
        extra.AppendLine();
        extra.AppendLine("以下为「技能管理」中配置的技能（与 Agent 共用同一目录）。生成大纲 JSON 时须遵守其中关于行业/风格/合规的说明；");
        extra.AppendLine("若与上方 JSON 结构或「不得编造」冲突，以 JSON 与事实约束为准。技能内容：");
        extra.AppendLine();

        var used = 0;
        foreach (var it in items.OrderBy(x => x.Name, StringComparer.OrdinalIgnoreCase))
        {
            string text;
            try
            {
                text = File.ReadAllText(it.SkillFilePath, System.Text.Encoding.UTF8).Trim();
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
    }
}
