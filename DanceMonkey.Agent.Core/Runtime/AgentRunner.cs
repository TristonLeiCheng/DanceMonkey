using DanceMonkey.Agent.Core.Abstractions;
using DanceMonkey.Agent.Core.Models;
using DanceMonkey.Agent.Core.Tools;
using System.Text.RegularExpressions;

namespace DanceMonkey.Agent.Core.Runtime;

/// <summary>
/// Agent 主循环。每次 <see cref="RunTurnAsync"/> 处理一轮用户输入：
/// 调用 LLM → 解析工具调用 → 审批 → 执行 → 把结果回灌 → 再调用 LLM，直到模型给出纯文本终态或达到步数上限。
/// </summary>
public sealed class AgentRunner
{
    public const string IncompleteToolCallsError = "检测到不完整的 tool_calls 输出（可能因回复被截断）。请将任务切分为更小子任务，并分多轮使用 write_file/edit_file 执行。";
    public const string DisabledAllSkillsMarker = "__disabled_all__";
    private readonly ILlmClient _llm;
    private readonly ToolRegistry _tools;
    private readonly IApprovalService _approval;
    private readonly IFileSystem _fs;

    /// <summary>可选项目记忆文本，注入 system prompt。</summary>
    public string? ProjectMemory { get; set; }

    /// <summary>偏好的用户名，注入 system prompt。</summary>
    public string? UserName { get; set; }

    /// <summary>当前运行时已发现的 Skills。</summary>
    public SkillCatalog Skills { get; set; } = new();

    /// <summary>单轮最多的工具执行步数（防止模型死循环）。</summary>
    public int MaxToolSteps { get; set; } = 8;

    /// <summary>LLM 单次请求的 max_tokens。</summary>
    public int MaxTokens { get; set; } = 4096;

    /// <summary>LLM 温度。工具调用建议较低。</summary>
    public double Temperature { get; set; } = 0.2;

    /// <summary>是否启用流式输出到 <see cref="IAgentSink"/>。</summary>
    public bool Streaming { get; set; } = true;

    public AgentRunner(ILlmClient llm, ToolRegistry tools, IApprovalService approval, IFileSystem fs)
    {
        _llm = llm;
        _tools = tools;
        _approval = approval;
        _fs = fs;
    }

    /// <summary>
    /// 跑一轮：把 <paramref name="userInput"/> 作为新用户消息加入 <paramref name="session"/>，执行完整 Agent loop。
    /// </summary>
    public async Task<AgentRunResult> RunTurnAsync(
        AgentSession session,
        string userInput,
        IAgentSink sink,
        CancellationToken ct,
        IReadOnlyList<AgentImagePart>? images = null)
    {
        var hasImages = images is { Count: > 0 };
        if (string.IsNullOrWhiteSpace(userInput) && !hasImages)
            return new AgentRunResult { Success = false, Error = "空输入" };

        var text = userInput?.Trim() ?? "";
        if (string.IsNullOrWhiteSpace(text) && hasImages)
            text = "请根据附带的图片内容回答；如需读写文件、笔记或任务请使用工具。";

        if (hasImages)
            text += $"\n\n[附带 {images!.Count} 张图片]";

        session.Messages.Add(AgentMessage.User(text, images));
        session.UpdatedUtc = DateTime.UtcNow;
        if (string.IsNullOrEmpty(session.Title))
            session.Title = Truncate(string.IsNullOrWhiteSpace(userInput) ? "图片消息" : userInput, 40);

        var enabledSkills = ResolveEnabledSkills(session, userInput);
        string systemPrompt = SystemPromptBuilder.Build(
            _tools,
            _fs,
            session.Mode,
            enabledSkills,
            ProjectMemory,
            UserName,
            Skills.All.OrderBy(s => s.Name, StringComparer.OrdinalIgnoreCase).ToList());
        long totalTokens = 0;

        for (int step = 0; step < MaxToolSteps; step++)
        {
            ct.ThrowIfCancellationRequested();

            var llmReq = new LlmRequest
            {
                SystemPrompt = systemPrompt,
                Messages = session.Messages.ToList(),
                Model = session.Model,
                MaxTokens = MaxTokens,
                Temperature = Temperature,
                Stream = Streaming,
            };

            Action<string>? onChunk = Streaming ? sink.OnAssistantChunk : null;
            var llmResult = await _llm.CompleteAsync(llmReq, onChunk, ct).ConfigureAwait(false);
            if (step == 0 && llmResult.Success)
                StripImagesFromSession(session);

            if (!llmResult.Success)
            {
                sink.OnError(llmResult.Error ?? "LLM 调用失败");
                return new AgentRunResult { Success = false, Error = llmResult.Error, ApproxTokens = totalTokens };
            }

            var assistantRaw = llmResult.Text ?? "";
            totalTokens += llmResult.ApproxTokens;
            sink.OnAssistantCompleted(assistantRaw);

            session.Messages.Add(AgentMessage.Assistant(assistantRaw));

            var toolCalls = ToolCallParser.Parse(assistantRaw, out _, out var hadToolCallBlock, out var parseFailed);
            if (toolCalls.Count == 0)
            {
                var hasUnclosedToolCallTag = ToolCallParser.HasUnclosedToolCallTag(assistantRaw);
                if (parseFailed || hasUnclosedToolCallTag || hadToolCallBlock)
                {
                    var err = IncompleteToolCallsError;
                    sink.OnWarning(err);
                    session.ApproxTokens += totalTokens;
                    session.UpdatedUtc = DateTime.UtcNow;
                    return new AgentRunResult
                    {
                        Success = false,
                        Error = err,
                        FinalAssistantText = assistantRaw,
                        ApproxTokens = totalTokens,
                        StepsUsed = step + 1,
                    };
                }

                session.ApproxTokens += totalTokens;
                session.UpdatedUtc = DateTime.UtcNow;
                return new AgentRunResult
                {
                    Success = true,
                    FinalAssistantText = assistantRaw,
                    ApproxTokens = totalTokens,
                    StepsUsed = step + 1,
                };
            }

            // 执行每一个工具调用
            foreach (var call in toolCalls)
            {
                ct.ThrowIfCancellationRequested();

                if (!_tools.TryGet(call.Tool, out var tool))
                {
                    var err = $"未知工具: {call.Tool}";
                    sink.OnWarning(err);
                    session.Messages.Add(AgentMessage.Tool(call.Tool, err));
                    continue;
                }

                // Plan 模式下禁止所有副作用工具
                if (session.Mode == AgentMode.Plan && tool.Risk > ToolRiskLevel.ReadOnly)
                {
                    var err = $"Plan 模式禁止调用 {tool.Name}（风险={tool.Risk}）。请先切到 Ask / Auto 模式。";
                    sink.OnWarning(err);
                    session.Messages.Add(AgentMessage.Tool(tool.Name, err));
                    continue;
                }

                var summary = tool.SummarizeCall(call);

                // 审批
                var approvalReq = new ApprovalRequest
                {
                    Tool = tool.Name,
                    Risk = tool.Risk,
                    Summary = summary,
                    Scope = $"{tool.Name}:{ExtractScopeHint(call)}",
                };
                var decision = await _approval.RequestAsync(approvalReq, session, ct).ConfigureAwait(false);

                if (decision == ApprovalDecision.AllowSessionScope)
                    session.AllowedScopes.Add(approvalReq.Scope!);

                if (decision == ApprovalDecision.Reject)
                {
                    var rejected = ToolResult.RejectedByUser();
                    sink.OnToolEnd(call, rejected);
                    session.Messages.Add(AgentMessage.Tool(tool.Name, rejected.Output));
                    continue;
                }

                sink.OnToolStart(call, summary);

                ToolResult result;
                try
                {
                    result = await tool.ExecuteAsync(call, ct).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    result = ToolResult.Fail($"工具抛出异常: {ex.Message}");
                }

                sink.OnToolEnd(call, result);
                session.Messages.Add(AgentMessage.Tool(tool.Name, result.Output));
            }

            // 继续下一轮让模型处理工具结果
        }

        sink.OnWarning($"达到最大工具步数 {MaxToolSteps}，已停止。");
        return new AgentRunResult
        {
            Success = false,
            Error = "达到最大工具步数",
            ApproxTokens = totalTokens,
            StepsUsed = MaxToolSteps,
        };
    }

    private static string ExtractScopeHint(ToolRequest call)
    {
        try
        {
            if (call.Arguments.ValueKind != System.Text.Json.JsonValueKind.Object) return "";
            // 对 shell：取更细粒度的命令特征（前两个 token）；对文件操作：取一级目录
            if (call.Tool == "run_shell" && call.Arguments.TryGetProperty("command", out var c))
            {
                var cmd = c.GetString() ?? "";
                return RunShellTool.BuildApprovalScopeHint(cmd);
            }
            if (call.Arguments.TryGetProperty("path", out var p) && p.ValueKind == System.Text.Json.JsonValueKind.String)
            {
                var path = p.GetString() ?? "";
                var slash = path.IndexOf('/');
                return slash < 0 ? path : path[..slash];
            }
        }
        catch { }
        return "";
    }

    private static string Truncate(string s, int n) =>
        s.Length <= n ? s : s[..n] + "…";

    private IReadOnlyList<SkillDefinition> ResolveEnabledSkills(AgentSession session, string? userInput)
    {
        if (Skills.Count == 0)
            return Array.Empty<SkillDefinition>();

        var explicitlyRequested = ResolvePromptRequestedSkills(userInput);
        if (explicitlyRequested.Count > 0)
            return explicitlyRequested;

        if (session.EnabledSkills.Contains(DisabledAllSkillsMarker))
            return Array.Empty<SkillDefinition>();

        if (session.EnabledSkills.Count == 0)
            return Skills.All
                .Where(s => SkillCatalog.MatchesPrompt(s, userInput))
                .OrderBy(s => s.Name, StringComparer.OrdinalIgnoreCase)
                .ToList();

        var resolved = new List<SkillDefinition>();
        foreach (var name in session.EnabledSkills)
        {
            if (Skills.TryGet(name, out var skill))
                resolved.Add(skill);
        }
        return resolved;
    }

    private IReadOnlyList<SkillDefinition> ResolvePromptRequestedSkills(string? userInput)
    {
        if (string.IsNullOrWhiteSpace(userInput) || Skills.Count == 0)
            return Array.Empty<SkillDefinition>();

        var input = userInput.Trim();
        var mentionsSkillKeyword = Regex.IsMatch(input, @"\bskill\b|技能|@[\w.-]+", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

        var matches = new List<SkillDefinition>();
        foreach (var skill in Skills.All)
        {
            if (mentionsSkillKeyword && input.IndexOf(skill.Name, StringComparison.OrdinalIgnoreCase) >= 0)
                matches.Add(skill);
        }

        return matches;
    }

    private static void StripImagesFromSession(AgentSession session)
    {
        foreach (var m in session.Messages)
            m.ClearImages();
    }
}
