namespace DanceMonkey.Cli;

internal static class ContinuationPromptHelper
{
    public static string BuildTemplate(string originalPrompt)
    {
        var brief = (originalPrompt ?? "").Trim();
        if (brief.Length > 80)
            brief = brief[..80] + "…";
        if (string.IsNullOrWhiteSpace(brief))
            brief = "继续上一个任务";

        return
            "检测到输出疑似被截断，建议直接使用下面模板继续：\n\n" +
            "```text\n" +
            $"任务背景：{brief}\n" +
            "请继续执行，但必须拆分为子任务并分多轮工具调用。\n" +
            "要求：\n" +
            "1) 先列出接下来 3-5 个子任务。\n" +
            "2) 本轮仅完成第 1 个子任务，禁止一次性写完整大文件。\n" +
            "3) 对代码文件：先写骨架，再用 edit_file 分块追加（每块 80-150 行）。\n" +
            "4) 每完成一块后先 read_file 校验，再决定下一块。\n" +
            "5) 不要重写已完成内容；如果续写脚本，仅追加缺失段落（例如只补 Slide 4-5）。\n" +
            "```";
    }
}
