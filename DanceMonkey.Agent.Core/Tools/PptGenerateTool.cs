using DanceMonkey.Agent.Core.Abstractions;
using DanceMonkey.Agent.Core.Models;
using DanceMonkey.Ppt.Abstractions;
using DanceMonkey.Ppt.Models;
using DanceMonkey.Ppt.Services;

namespace DanceMonkey.Agent.Core.Tools;

/// <summary>
/// ppt_generate：使用与桌面端相同的内置 PPT 模块（ShapeCrawler）一键生成 .pptx，无需 python-pptx。
/// 参数:
/// <code>{ "output_path": "out/deck.pptx", "source_kind": "markdown", "source": "# 标题\n..." }</code>
/// </summary>
public sealed class PptGenerateTool : ITool
{
    private readonly IPptLlmBridge _llm;
    private readonly IFileSystem _fs;
    private readonly string? _sandboxPath;

    public PptGenerateTool(IPptLlmBridge llm, IFileSystem fs, string? sandboxPath)
    {
        _llm = llm ?? throw new ArgumentNullException(nameof(llm));
        _fs = fs ?? throw new ArgumentNullException(nameof(fs));
        _sandboxPath = sandboxPath;
    }

    public string Name => "ppt_generate";

    public string Description => """
ppt_generate: 使用内置 PPT 模块（与桌面工作台同一套）生成 .pptx，无需 python-pptx。
参数:
  output_path (string, 必填) - 相对于工作目录的 .pptx 输出路径
  source_kind (string, 必填) - markdown | plaintext | topic | pdf_file | word_file
  source (string, 必填) - markdown/plaintext/topic 时为正文；pdf_file/word_file 时为相对路径
  theme_id (string, 可选) - light-business | tech-blue | dark-premium | warm-magazine，默认 light-business
  audience (string, 可选) - 目标受众，例如「管理层」「技术团队」
  purpose (string, 可选) - 演示目的，例如「persuasive」「informational」「training」
  tone (string, 可选) - 语气，例如「专业克制」「热情活泼」
  target_slides (int, 可选) - 期望页数（含封面/结尾）
  include_speaker_notes (bool, 可选, 默认 true) - 是否生成演讲备注
  preserve_images (bool, 可选, 默认 true) - 是否保留来源图片
  legacy_prompt (bool, 可选, 默认 false) - true 时使用旧版 JSON 大纲 schema
  additional_instructions (string, 可选) - 附加约束，例如「不要提竞争对手 X」
""";

    public ToolRiskLevel Risk => ToolRiskLevel.Write;

    public string SummarizeCall(ToolRequest request)
    {
        var outPath = ToolArgs.GetString(request.Arguments, "output_path", "?");
        var kind = ToolArgs.GetString(request.Arguments, "source_kind", "?");
        return $"生成 PPT → {outPath}（{kind}）";
    }

    public async Task<ToolResult> ExecuteAsync(ToolRequest request, CancellationToken ct)
    {
        var outputPath = ToolArgs.GetString(request.Arguments, "output_path");
        if (string.IsNullOrWhiteSpace(outputPath))
            return ToolResult.Fail("ppt_generate 缺少参数 output_path");
        if (!outputPath.EndsWith(".pptx", StringComparison.OrdinalIgnoreCase))
            return ToolResult.Fail("output_path 须以 .pptx 结尾");

        var kindRaw = ToolArgs.GetString(request.Arguments, "source_kind").Trim().ToLowerInvariant();
        var source = ToolArgs.GetString(request.Arguments, "source");
        if (string.IsNullOrWhiteSpace(source))
            return ToolResult.Fail("ppt_generate 缺少参数 source");

        if (!TryMapKind(kindRaw, out var kind, out var kindErr))
            return ToolResult.Fail(kindErr!);

        string payload = source;
        if (kind is PptSourceKind.PdfFile or PptSourceKind.WordFile)
        {
            if (!_fs.FileExists(source))
                return ToolResult.Fail($"源文件不存在: {source}");
            var abs = _fs.ResolveAbsolute(source);
            if (!_fs.IsAllowedAbsolute(abs))
                return ToolResult.Fail("源文件路径不在允许范围内");
            payload = abs;
        }

        var targetSlides = ToolArgs.GetInt(request.Arguments, "target_slides", 0);
        var pptRequest = new PptGenerationRequest
        {
            SourceKind = kind,
            Source = payload,
            Topic = kind == PptSourceKind.Topic ? source : null,
            ThemeId = ToolArgs.GetString(request.Arguments, "theme_id", "light-business"),
            Audience = NullIfEmpty(ToolArgs.GetString(request.Arguments, "audience")),
            Purpose = NullIfEmpty(ToolArgs.GetString(request.Arguments, "purpose")),
            Tone = NullIfEmpty(ToolArgs.GetString(request.Arguments, "tone")),
            TargetSlides = targetSlides > 0 ? targetSlides : null,
            IncludeSpeakerNotes = ToolArgs.GetBool(request.Arguments, "include_speaker_notes", true),
            PreserveImages = ToolArgs.GetBool(request.Arguments, "preserve_images", true),
            AdditionalInstructions = NullIfEmpty(ToolArgs.GetString(request.Arguments, "additional_instructions")),
        };

        var legacy = ToolArgs.GetBool(request.Arguments, "legacy_prompt", false);
        var absOut = _fs.ResolveAbsolute(outputPath);
        if (!_fs.IsAllowedAbsolute(absOut))
            return ToolResult.Fail("输出路径不在允许范围内");

        try
        {
            var module = PptModuleFactory.Create(_llm, _sandboxPath, legacy);
            var result = await module.GenerateFromSourceAsync(pptRequest, absOut, ct).ConfigureAwait(false);
            if (!result.Success)
                return ToolResult.Fail(result.Error ?? "PPT 生成失败");

            var msg = $"[ppt_generate] 已写入 {result.OutputFilePath ?? absOut}";
            return ToolResult.Ok(msg, display: $"✓ {msg}");
        }
        catch (Exception ex)
        {
            return ToolResult.Fail($"ppt_generate 异常: {ex.Message}");
        }
    }

    private static bool TryMapKind(string raw, out PptSourceKind kind, out string? error)
    {
        error = null;
        kind = default;
        switch (raw)
        {
            case "markdown":
                kind = PptSourceKind.Markdown;
                return true;
            case "plaintext":
            case "plain_text":
                kind = PptSourceKind.PlainText;
                return true;
            case "topic":
                kind = PptSourceKind.Topic;
                return true;
            case "pdf_file":
            case "pdf":
                kind = PptSourceKind.PdfFile;
                return true;
            case "word_file":
            case "word":
            case "docx":
                kind = PptSourceKind.WordFile;
                return true;
            default:
                error = $"不支持的 source_kind: {raw}";
                return false;
        }
    }

    private static string? NullIfEmpty(string s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();
}
