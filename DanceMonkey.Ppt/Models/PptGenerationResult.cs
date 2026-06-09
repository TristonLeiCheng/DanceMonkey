namespace DanceMonkey.Ppt.Models;

/// <summary>
/// 生成结果：统一成功/失败/警告，避免上层四处 try/catch。
/// </summary>
public sealed class PptGenerationResult
{
    /// <summary>是否成功生成 .pptx 文件（或大纲）。</summary>
    public bool Success { get; init; }

    /// <summary>失败时的错误描述（成功时为 null）。</summary>
    public string? Error { get; init; }

    /// <summary>非致命警告（例如来源中部分图片未提取、主题降级）。</summary>
    public IReadOnlyList<string> Warnings { get; init; } = Array.Empty<string>();

    /// <summary>当请求渲染为文件时，最终落盘的完整路径。</summary>
    public string? OutputFilePath { get; init; }

    /// <summary>当请求仅生成大纲时返回的中间表示。</summary>
    public PptDeck? Deck { get; init; }

    public static PptGenerationResult Ok(string outputPath, IReadOnlyList<string>? warnings = null) =>
        new()
        {
            Success = true,
            OutputFilePath = outputPath,
            Warnings = warnings ?? Array.Empty<string>(),
        };

    public static PptGenerationResult OkDeck(PptDeck deck, IReadOnlyList<string>? warnings = null) =>
        new()
        {
            Success = true,
            Deck = deck,
            Warnings = warnings ?? Array.Empty<string>(),
        };

    public static PptGenerationResult Fail(string error, IReadOnlyList<string>? warnings = null) =>
        new()
        {
            Success = false,
            Error = error,
            Warnings = warnings ?? Array.Empty<string>(),
        };
}
