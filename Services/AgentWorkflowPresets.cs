using DanceMonkey.Agent.Core.Models;

namespace DesktopAssistant.Services;

/// <summary>GUI Agent 一键工作流 preset（Phase 3 场景化 Agent）。</summary>
public sealed class AgentWorkflowPreset
{
    public required string Id { get; init; }
    public required string Title { get; init; }
    public required string Prompt { get; init; }
    public bool AutoSend { get; init; }
    public AgentMode? SuggestedMode { get; init; }

    public static IReadOnlyList<AgentWorkflowPreset> All { get; } = new[]
    {
        new AgentWorkflowPreset
        {
            Id = "inbox-tidy",
            Title = "整理 Inbox",
            SuggestedMode = AgentMode.Ask,
            Prompt = """
请帮我整理笔记库 Inbox 目录：
1. 用 list_dir 查看 notes/Inbox 结构（含 Captures、Screenshots 子目录）
2. 用 search_notes 找出最近 7 天修改或内容杂乱的笔记
3. 给出分类/归档/合并建议；若需创建整理计划笔记，用 create_note 写到 Inbox
4. 未经我确认不要 delete 或大规模移动文件
""".Trim(),
        },
        new AgentWorkflowPreset
        {
            Id = "today-focus",
            Title = "今日 Focus",
            SuggestedMode = AgentMode.Plan,
            Prompt = """
请基于 Zen Task 帮我规划今日 Focus：
1. 用 list_tasks 列出状态为 Todo / In Progress 的任务（limit 40）
2. 按 Q1/Q2 与到期日排序，推荐 3–5 项今日重心
3. 说明每项理由与建议时间段；如需我确认后再 add_task 补充遗漏项
""".Trim(),
        },
        new AgentWorkflowPreset
        {
            Id = "note-to-ppt",
            Title = "笔记→PPT",
            SuggestedMode = AgentMode.Ask,
            Prompt = """
我想把一篇笔记做成 PPT。请先问我笔记路径或关键词；然后：
1. search_notes 或 read_file 读取笔记正文
2. 用 ppt_generate 生成 .pptx（output_path 建议 out/deck.pptx，source_kind=markdown）
3. 生成后告诉我输出路径与页数概要
""".Trim(),
        },
        new AgentWorkflowPreset
        {
            Id = "save-chat-note",
            Title = "对话存笔记",
            SuggestedMode = AgentMode.Ask,
            Prompt = """
请把本次对话要点整理成 Markdown 笔记：
1. 用 create_note 创建到 AI/Conversations/，标题含今日日期
2. 结构：背景、结论、待办、引用；保留关键代码/路径
3. 若有关联笔记，在文末加 [[双链]] 建议
""".Trim(),
        },
        new AgentWorkflowPreset
        {
            Id = "search-summarize",
            Title = "搜索汇总",
            SuggestedMode = AgentMode.Plan,
            Prompt = """
我要在笔记库中调研一个主题。请先问我关键词，然后：
1. search_notes 全文搜索（可多轮换词）
2. read_file 阅读最相关的 3–5 篇
3. 输出结构化摘要：要点、矛盾、缺失信息、建议下一步
""".Trim(),
        },
        new AgentWorkflowPreset
        {
            Id = "chat-to-tasks",
            Title = "提取待办",
            SuggestedMode = AgentMode.Ask,
            Prompt = """
请从我们的对话中提取可执行的待办项：
1. 列出建议任务（标题、项目、优先级、建议截止日期）
2. 经我确认后，用 add_task 写入 Zen Task
3. 可选：create_note 在 Journal 留一份会议纪要式记录
""".Trim(),
        },
        new AgentWorkflowPreset
        {
            Id = "recent-screenshots",
            Title = "最近截图",
            SuggestedMode = AgentMode.Plan,
            Prompt = """
请帮我处理最近的截图相关笔记：
1. list_recent_screenshots 列出最近 10 张截图
2. search_notes 搜索 Inbox/Screenshots 或 Captures 相关笔记
3. 汇总每张截图的上下文（若有 .md 引用），建议归档或待办
""".Trim(),
        },
    };

    public static AgentWorkflowPreset? Find(string? id) =>
        string.IsNullOrWhiteSpace(id)
            ? null
            : All.FirstOrDefault(p => p.Id.Equals(id, StringComparison.OrdinalIgnoreCase));
}
