using DesktopAssistant.Models;

namespace DesktopAssistant.Services;

/// <summary>
/// 会议摘要服务：将转写全文通过 AI 整理为纪要、决策、行动项、待确认事项。
/// 复用现有 OpenAiApiClient。
/// </summary>
public sealed class MeetingSummaryService
{
    private readonly AppConfig _config;

    public MeetingSummaryService(AppConfig config)
    {
        _config = config;
    }

    private const string DefaultSystemPrompt = """
你是专业的会议纪要整理助手。请根据提供的会议转写文本与会上手记，用**简体中文**输出结构化的会议纪要。

输出必须使用 Markdown 格式，包含以下部分：

## 会议摘要
用 3-5 句话概括会议核心内容。

## 关键讨论点
- 按议题分点列出主要讨论内容。

## 决策记录
- 列出会议中达成的明确决策（若无则写"本次无明确决策"）。

## 行动项
| 序号 | 任务 | 负责人 | 截止时间 |
|------|------|--------|----------|
（若无法从文本中识别负责人或截止时间，标注"待确认"。）

## 待确认事项
- 列出会议中提到但未最终确定的事项。

## 下一步
- 列出后续需要跟进的事项。

要求：
- 忽略口语化的语气词和重复内容。
- 保留关键数字、日期、人名。
- 如果转写内容过短或内容不清，在摘要中注明。
""";

    /// <summary>
    /// 生成会议纪要。
    /// </summary>
    /// <param name="transcript">完整会议转写文本（可附加会上手记）。</param>
    /// <param name="systemPromptOverride">模板专属 system prompt（留空用默认）。</param>
    /// <param name="cancellationToken">取消令牌。</param>
    public async Task<ApiCallResult> GenerateSummaryAsync(
        string transcript,
        string? systemPromptOverride = null,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(transcript))
            return new ApiCallResult { Success = false, Error = "转写内容为空，无法生成摘要。" };

        var systemPrompt = string.IsNullOrWhiteSpace(systemPromptOverride)
            ? DefaultSystemPrompt
            : systemPromptOverride!.Trim();

        var prompt = $"以下是会议转写全文（可能含会上手记），请整理为会议纪要：\n\n{transcript}";

        var client = new OpenAiApiClient(_config);
        return await client.CallAsyncLong(
            prompt,
            systemPrompt,
            maxTokens: 4096,
            temperature: 0.3,
            cancellationToken: cancellationToken
        );
    }
}