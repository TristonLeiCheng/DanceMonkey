namespace DesktopAssistant.Services;

/// <summary>笔记 AI 处理类型（与设置中的 OpenAI 兼容 API 对接）。</summary>
public enum NoteAiAction
{
    /// <summary>重新组织结构与层级，使 Markdown 更清晰。</summary>
    Organize,

    /// <summary>生成简短要点总结。</summary>
    Summarize,

    /// <summary>在文末自然续写。</summary>
    Continue,

    /// <summary>润色措辞与标点，尽量保留结构。</summary>
    Polish
}

/// <summary>构建各模式的系统提示与用户消息，供 <see cref="OpenAiApiClient"/> 调用。</summary>
public static class NoteAiService
{
    public static string GetDisplayName(NoteAiAction action) => action switch
    {
        NoteAiAction.Organize => "内容整理",
        NoteAiAction.Summarize => "内容总结",
        NoteAiAction.Continue => "续写",
        NoteAiAction.Polish => "润色",
        _ => "AI"
    };

    public static (string SystemPrompt, int MaxTokens, double Temperature) GetParameters(NoteAiAction action) =>
        action switch
        {
            NoteAiAction.Organize => (
                "你是 Markdown 笔记编辑助手。用户会粘贴一篇笔记全文。请在**不改变事实与数据**的前提下，" +
                "调整标题层级、列表与段落结构，使层次清晰、便于阅读。只输出整理后的 Markdown 正文，不要解释、不要前言后语。",
                4096,
                0.35
            ),
            NoteAiAction.Summarize => (
                "你是笔记助手。请用简洁中文总结用户提供的 Markdown 笔记要点，可使用分级标题与列表。" +
                "只输出总结内容，不要重复客套话。",
                3072,
                0.35
            ),
            NoteAiAction.Continue => (
                "你是写作助手。根据用户给出的 Markdown 笔记语境与语气，从文末**自然续写**后续内容，可分段、可使用列表。" +
                "只输出**新增**的续写部分，不要重复原文已有段落。",
                4096,
                0.75
            ),
            NoteAiAction.Polish => (
                "你是中文润色助手。对用户提供的 Markdown 笔记进行措辞与标点优化，修正明显语病，**保留原有结构与含义**。" +
                "只输出润色后的完整 Markdown 正文（即替换整篇的改进版），不要附加说明。",
                4096,
                0.45
            ),
            _ => ("你是一个有帮助的助手。", 2048, 0.7)
        };

    /// <summary>作为 user 消息发送的完整文本（含笔记正文）。</summary>
    public static string BuildUserMessage(NoteAiAction action, string noteMarkdown)
    {
        var body = noteMarkdown.TrimEnd();
        var intro = action switch
        {
            NoteAiAction.Organize => "以下为用户笔记（Markdown）。请按要求整理后只输出结果：\n\n",
            NoteAiAction.Summarize => "以下为用户笔记（Markdown）。请生成总结：\n\n",
            NoteAiAction.Continue => "以下为用户已写内容（Markdown）。请从文末续写（只输出新增部分）：\n\n",
            NoteAiAction.Polish => "以下为用户笔记（Markdown）。请输出润色后的完整正文：\n\n",
            _ => ""
        };

        return intro + body;
    }
}
