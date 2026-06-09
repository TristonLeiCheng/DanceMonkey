using System.Text;
using DanceMonkey.Ppt.Abstractions;
using DanceMonkey.Ppt.Models;
using DanceMonkey.Ppt.Skills;

namespace DanceMonkey.Ppt.Services;

/// <summary>
/// P2 新版大纲生成器：使用 <see cref="PptDeckPromptBuilder"/> 的新 schema，经 <see cref="IPptLlmBridge"/> 调模型，
/// 由 <see cref="PptDeckJsonParser"/> 解析（同时兼容旧 schema）。
/// </summary>
internal sealed class PptOutlineGenerator : IPptOutlineGenerator
{
    private readonly IPptLlmBridge _llm;
    private readonly string? _sandboxPath;
    private readonly int _maxTokens;
    private readonly double _temperature;

    public PptOutlineGenerator(
        IPptLlmBridge llm,
        string? sandboxPath,
        int maxTokens = 8192,
        double temperature = 0.35)
    {
        _llm = llm ?? throw new ArgumentNullException(nameof(llm));
        _sandboxPath = sandboxPath;
        _maxTokens = maxTokens;
        _temperature = temperature;
    }

    public async Task<PptDeck> GenerateAsync(
        PptGenerationRequest request,
        PptSourceDocument? document,
        CancellationToken cancellationToken = default)
    {
        var sourceText = BuildSourceText(request, document);
        if (string.IsNullOrWhiteSpace(sourceText))
            throw new InvalidOperationException("当前内容为空，无法生成大纲。");

        var systemPrompt = PptDeckPromptBuilder.BuildSystemPrompt(
            _sandboxPath,
            PptAgentWorkflowSkill.Markdown);

        var userPrompt = PptDeckPromptBuilder.BuildUserPrompt(sourceText, request);

        var result = await _llm
            .CallLongAsync(userPrompt, systemPrompt, _maxTokens, _temperature, cancellationToken)
            .ConfigureAwait(false);

        if (!result.Success || string.IsNullOrEmpty(result.Text))
            throw new InvalidOperationException(result.Error ?? "模型未返回有效内容。");

        if (!PptDeckJsonParser.TryParse(result.Text, out var deck, out var error) || deck == null)
            throw new InvalidOperationException(error ?? "无法解析 PPT 大纲。");

        // 质量闸门：对“缺 keyMessage / 缺 bullets”等硬问题，自动返工修复一次。
        var gate = PptDeckQualityGate.Evaluate(deck, request);
        if (gate.ShouldRepair)
        {
            // 返工时降低温度，提升一致性。
            var repairUser = PptDeckQualityGate.BuildRepairPrompt(request, result.Text, gate);
            var repair = await _llm
                .CallLongAsync(repairUser, systemPrompt, _maxTokens, Math.Min(_temperature, 0.2), cancellationToken)
                .ConfigureAwait(false);

            if (repair.Success && !string.IsNullOrWhiteSpace(repair.Text) &&
                PptDeckJsonParser.TryParse(repair.Text, out var repaired, out _) && repaired != null)
            {
                deck = repaired;
                // 合并 warnings：把闸门产生的 warnings 暂存到 deck 的 SpeakerNotes 之外更合适，
                // 但当前接口只返回 deck；warnings 由上层 PptModule/PptGenerationResult 统一承载。
            }
            // 修复失败不阻塞：返回原 deck，gate warnings 由上层提示用户。
        }

        // 用 request 中的元信息补全 deck（不覆盖 LLM 给出的值）
        if (string.IsNullOrWhiteSpace(deck.Audience)) deck.Audience = request.Audience;
        if (string.IsNullOrWhiteSpace(deck.Purpose)) deck.Purpose = request.Purpose;
        deck.ThemeId ??= request.ThemeId;

        return deck;
    }

    /// <summary>
    /// 组装提供给 LLM 的来源文本。优先用导入器抽取的结构化块（合成更易读的 Markdown 形态），
    /// 否则回落到 <see cref="PptGenerationRequest.Source"/> 原文。
    /// </summary>
    private static string BuildSourceText(PptGenerationRequest request, PptSourceDocument? document)
    {
        if (document == null || document.Blocks.Count == 0)
            return request.Source ?? string.Empty;

        var sb = new StringBuilder();

        if (!string.IsNullOrWhiteSpace(document.Title))
            sb.AppendLine($"# {document.Title}").AppendLine();

        foreach (var block in document.Blocks)
        {
            switch (block.Kind)
            {
                case PptSourceBlockKind.Heading:
                    if (!string.IsNullOrWhiteSpace(block.Text))
                    {
                        var level = Math.Clamp(block.Level <= 0 ? 1 : block.Level, 1, 6);
                        sb.AppendLine($"{new string('#', level)} {block.Text!.Trim()}").AppendLine();
                    }
                    break;

                case PptSourceBlockKind.Paragraph:
                case PptSourceBlockKind.Quote:
                    if (!string.IsNullOrWhiteSpace(block.Text))
                    {
                        var prefix = block.Kind == PptSourceBlockKind.Quote ? "> " : "";
                        sb.AppendLine(prefix + block.Text!.Trim()).AppendLine();
                    }
                    break;

                case PptSourceBlockKind.ListItem:
                    if (!string.IsNullOrWhiteSpace(block.Text))
                        sb.AppendLine("- " + block.Text!.Trim());
                    break;

                case PptSourceBlockKind.Image:
                    // 仅告知 AI「此处有一张图」，不传图片本身
                    if (!string.IsNullOrWhiteSpace(block.MediaPath))
                        sb.AppendLine($"![image]({block.MediaPath})").AppendLine();
                    break;

                case PptSourceBlockKind.Table:
                    if (block.TableRows is { Count: > 0 } rows)
                    {
                        foreach (var row in rows)
                            sb.AppendLine("| " + string.Join(" | ", row.Select(c => c ?? "")) + " |");
                        sb.AppendLine();
                    }
                    break;
            }
        }

        return sb.ToString();
    }
}
