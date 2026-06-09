using System.Text;
using DanceMonkey.Agent.Core.Abstractions;
using DanceMonkey.Agent.Core.Models;

namespace DanceMonkey.Agent.Core.Runtime;

/// <summary>
/// 构造 Agent 的 system prompt。将工具目录、当前工作目录树、权限模式、项目上下文拼接成单一文本。
/// </summary>
public static class SystemPromptBuilder
{
    public static string Build(
        ToolRegistry tools,
        IFileSystem fs,
        AgentMode mode,
        IReadOnlyList<SkillDefinition>? enabledSkills = null,
        string? projectMemory = null,
        string? userName = null,
        IReadOnlyCollection<SkillDefinition>? availableSkills = null)
    {
        var sb = new StringBuilder();

        sb.AppendLine("你是 **DanceMonkey Agent**，一个在用户桌面端运行、能够读写文件与执行命令的 AI 助手。");
        sb.AppendLine("用**简体中文**回答。遇到代码或命令，用 Markdown 代码块包裹。");
        sb.AppendLine();

        if (!string.IsNullOrWhiteSpace(userName))
            sb.AppendLine($"当前用户：{userName}。");

        sb.AppendLine($"当前权限模式：**{mode}**。");
        sb.AppendLine(mode switch
        {
            AgentMode.Plan => "你处于 **只读规划** 模式：**禁止**调用任何写入或执行类工具（edit_file / write_file / run_shell）。只能 read_file / list_dir / grep。请先给出方案再让用户切换模式执行。",
            AgentMode.Ask => "每次写入或执行命令都会请用户审批。请先说明意图再调用工具。",
            AgentMode.Auto => "写文件与安全命令可自动执行，危险操作仍需用户审批。",
            _ => "",
        });
        sb.AppendLine();

        sb.AppendLine("## 工作目录");
        sb.AppendLine($"根目录：`{fs.WorkingDirectory}`");
        sb.AppendLine("当前目录树（截断到 3 层）：");
        sb.AppendLine("```");
        sb.AppendLine(fs.RenderTree(3));
        sb.AppendLine("```");
        sb.AppendLine();

        sb.AppendLine("## 可用工具");
        sb.AppendLine();
        sb.AppendLine(tools.RenderCatalog());
        sb.AppendLine();

        if (availableSkills is { Count: > 0 })
        {
            sb.AppendLine("## 可用 Skills（Claude/Codex 风格）");
            sb.AppendLine("Skills 是可复用的工作流说明，来源于 `SKILL.md`。当用户显式点名 skill，或任务与 description/triggers 匹配时，本轮会注入对应 skill 的完整说明。");
            sb.AppendLine("如果你认为某个未激活 skill 适合当前任务，请先说明建议使用的 skill 名称；用户下一轮可点名或通过 /skill 启用。");
            sb.AppendLine();
            foreach (var skill in availableSkills.OrderBy(s => s.Name, StringComparer.OrdinalIgnoreCase))
            {
                sb.Append($"- `{skill.Name}`");
                if (!string.IsNullOrWhiteSpace(skill.EffectiveDescription))
                    sb.Append($": {skill.EffectiveDescription}");
                sb.Append($"（activation: {skill.Activation}");
                if (skill.AllowedTools.Count > 0)
                    sb.Append($", allowed-tools: {string.Join(", ", skill.AllowedTools)}");
                if (skill.Triggers.Count > 0)
                    sb.Append($", triggers: {string.Join(", ", skill.Triggers)}");
                sb.AppendLine("）");
            }
            sb.AppendLine();
        }

        if (enabledSkills is { Count: > 0 })
        {
            sb.AppendLine("## 本轮激活的 Skill 指令");
            sb.AppendLine("以下 skill 已由用户显式启用、点名或根据 description/triggers 自动触发。请遵守其约束与流程（若冲突，以系统与用户指令优先）：");
            sb.AppendLine();
            foreach (var skill in enabledSkills.OrderBy(s => s.Name, StringComparer.OrdinalIgnoreCase))
            {
                sb.AppendLine($"### Skill: {skill.Name}");
                if (!string.IsNullOrWhiteSpace(skill.EffectiveDescription))
                    sb.AppendLine($"> {skill.EffectiveDescription}");
                if (skill.AllowedTools.Count > 0)
                    sb.AppendLine($"> allowed-tools: {string.Join(", ", skill.AllowedTools)}");
                sb.AppendLine(skill.Content);
                sb.AppendLine();
            }
        }

        sb.AppendLine("## 调用工具的协议（严格遵守）");
        sb.AppendLine(@"
当你需要调用一个或多个工具时，**只能**在回复末尾输出如下结构（前面可附思考说明）：

<tool_calls>
[
  {""tool"": ""read_file"", ""arguments"": {""path"": ""README.md""}},
  {""tool"": ""grep"", ""arguments"": {""pattern"": ""TODO"", ""glob"": ""*.cs""}}
]
</tool_calls>

规则：
1. 标签必须是 `<tool_calls>` ... `</tool_calls>`，中间放 JSON 数组。
2. 若需要工具：**必须**发出 tool_calls 块并等待结果，**不要**自行编造结果。
3. 若**不再**需要工具，直接写最终答复的 Markdown 文本，且**不要**输出 `<tool_calls>`。
4. 每轮可同时发起多个工具（建议 ≤ 4 个），系统会并发或顺序执行并把结果以 `tool` 角色返还。
5. 如果某工具失败，检查 Output 中的错误信息再决定是否换方式重试；**不要**盲目重试同一参数。
6. 所有文件路径都是<b>相对于根目录</b>的相对路径，使用 `/` 作为分隔符。
7. 对长内容（例如长脚本、PPT 生成器、长 Markdown）：禁止一次性 `write_file` 写完。请拆成子任务并分多轮执行：先写骨架，再用 `edit_file` 分块追加（每块建议 80-150 行），每完成一块就读取/校验一次。
8. 当任务可自然拆分时，先给出子任务清单再执行，例如：`创建文件骨架` → `补充模块A` → `补充模块B` → `运行并修复`。任何单次工具调用都应保持短小、可回滚、可验证。
");

        sb.AppendLine();
        sb.AppendLine("## PPT 生成（优先内置模块，其次 python-pptx）");
        sb.AppendLine(@"
1. **首选 `ppt_generate` 工具**：当用户要生成/导出 .pptx 且内容可由「Markdown / 纯文本 / 主题 / 工作目录下的 PDF 或 Word 路径」描述时，应优先调用 `ppt_generate`，由内置 ShapeCrawler 渲染，无需 python 环境。
2. **禁止默认纯黑背景**：除非用户明确要求「纯黑/极暗风」，否则不得整套使用纯黑底。
3. 若仍走 python-pptx 脚本路径：必须提供至少 3 套可选主题并择一实现（例如：浅色商务、科技蓝、暖色杂志），并在首页/章节页/内容页保持一致视觉系统。
4. 每页必须有明确层级：标题、正文、强调信息；禁止「整页只有黑底+白字」。
5. 至少使用 2 种设计增强手段：卡片容器、分隔线、图标/编号、强调色块、留白网格、页脚页码。
6. 字体与配色要可读：正文与背景对比充足（建议对比度 >= 4.5:1）；标题、正文、注释字号有梯度。
7. 若未给设计方向，默认优先「浅色商务高级感」，背景用浅灰/米白/蓝灰，不要大面积纯黑。
8. 生成 python-pptx 脚本时，先抽象 `theme`（颜色、字号、间距）与通用组件函数（标题、卡片、要点列表），再写各页，避免样式散乱。
9. 多页文稿必须包含至少 1 页封面、N 页内容、1 页总结/结束页；页内元素对齐一致，留边一致。
10. 输出前自检：若背景接近纯黑（如 RGB 各通道都 < 25）且用户未要求暗黑风，必须自动改为非纯黑主题后再输出。
11. **内置脚手架路径（仅当必须用 python-pptx 时）**：CLI 会在工作目录下同步 `ppt_scaffold/` 到 **`.dancemonkey/ppt_scaffold/`**。若用户明确要求脚本化或 `ppt_generate` 不适用，再 `read_file` 阅读该目录并在其主题与布局函数上扩展。
");

        if (!string.IsNullOrWhiteSpace(projectMemory))
        {
            sb.AppendLine();
            sb.AppendLine("## 项目记忆（来自 CLAUDE.md / DANCEMONKEY.md）");
            sb.AppendLine(projectMemory.Trim());
        }

        return sb.ToString();
    }
}
