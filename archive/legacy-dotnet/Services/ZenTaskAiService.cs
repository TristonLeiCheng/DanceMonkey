namespace DesktopAssistant.Services;

public static class ZenTaskAiService
{
    public static string BuildRecentTaskAnalysisPrompt(string userName, IReadOnlyList<Views.TodoView.StrategicTaskItem> tasks)
    {
        var lines = BuildTaskLines(tasks);
        return
            $"请分析用户 {userName} 近期的任务状态，输出中文建议。\n" +
            "请按以下结构输出：\n" +
            "1. 总体观察\n" +
            "2. 当前风险\n" +
            "3. 本周最值得关注的 3 件事\n" +
            "4. 一句行动建议\n\n" +
            "任务清单：\n" + lines;
    }

    public static string BuildTaskPlanningPrompt(string userName, IReadOnlyList<Views.TodoView.StrategicTaskItem> tasks)
    {
        var lines = BuildTaskLines(tasks);
        return
            $"你是任务调度助手，请帮助用户 {userName} 决定下一步先做什么。\n" +
            "请综合截止时间、优先级、能量消耗、RACI 角色，给出可执行安排。\n" +
            "输出要求：\n" +
            "1. 先做哪 1 件事，以及原因\n" +
            "2. 接下来 3 步行动顺序\n" +
            "3. 哪些任务可以延后、委派或拆分\n" +
            "4. 给出一个今天的建议工作节奏\n\n" +
            "任务清单：\n" + lines;
    }

    public static string BuildTodaySchedulePrompt(string userName, IReadOnlyList<Views.TodoView.StrategicTaskItem> tasks)
    {
        var lines = BuildTaskLines(tasks);
        return
            $"请为用户 {userName} 生成今天的任务时间块安排。\n" +
            "请输出中文，并严格按以下结构：\n" +
            "1. 上午：适合处理什么\n" +
            "2. 下午：适合处理什么\n" +
            "3. 晚些时候/收尾：适合处理什么\n" +
            "4. 今天不要做什么\n" +
            "5. 一句节奏建议\n\n" +
            "任务清单：\n" + lines;
    }

    public static string AnalysisSystemPrompt =>
        "你是资深执行管理顾问，擅长从任务清单中识别风险、优先级冲突和执行瓶颈。输出务必简洁、务实、中文，不要空话。";

    public static string PlanningSystemPrompt =>
        "你是高效能任务规划助手，擅长将任务列表排出清晰先后顺序。请输出明确、可执行、中文的安排建议。";

    public static string ScheduleSystemPrompt =>
        "你是时间管理教练，擅长把任务清单排成今天可执行的时间块安排。输出要具体、简洁、中文。";

    public static string BuildWorkReviewPrompt(
        string userName,
        DateTime startDate,
        DateTime endDate,
        string? projectName,
        IReadOnlyList<Views.TodoView.StrategicTaskItem> tasks)
    {
        var lines = BuildTaskLines(tasks);
        var scope = string.IsNullOrWhiteSpace(projectName) ? "全部项目" : projectName;
        return
            $"请为用户 {userName} 生成工作回顾，时间范围为 {startDate:yyyy-MM-dd} 到 {endDate:yyyy-MM-dd}，范围：{scope}。\n" +
            "请输出中文 Markdown，并严格按以下结构：\n" +
            "## 本期概览\n" +
            "## 已完成事项（按价值与影响分组）\n" +
            "## 项目维度进展\n" +
            "## 风险与阻塞\n" +
            "## 下周期建议（3-5条）\n" +
            "## 可复用经验\n\n" +
            "任务清单：\n" + lines;
    }

    public static string WorkReviewSystemPrompt =>
        "你是资深工作复盘教练，擅长从完成任务中提炼业务价值、风险和下一步建议。输出必须结构化、务实、中文、Markdown。";

    private static string BuildTaskLines(IReadOnlyList<Views.TodoView.StrategicTaskItem> tasks)
    {
        if (tasks.Count == 0)
            return "暂无任务。";

        return string.Join("\n", tasks.Select((task, index) =>
            $"{index + 1}. 标题:{task.Title} | 项目:{task.Project} | 优先级:{task.PriorityLabel} | 状态:{task.WorkflowStatus} | 截止:{task.DueDateDisplay} | RACI:{task.RaciRole} | 能量:{task.EnergyLevel} | 更新时间:{task.UpdatedAt:yyyy-MM-dd HH:mm}"));
    }
}
