using DanceMonkey.Ppt.Abstractions;
using DanceMonkey.Ppt.Models;

namespace DanceMonkey.Ppt.Importers;

/// <summary>
/// PDF 导入器。
/// <para>主路径：Office Word COM「打开 PDF 后转换为可编辑文档」抽取段落 + 标题层级 + 表格（见 <see cref="OfficeWordReader"/>）。</para>
/// <para>限制：若本机未装 Word，会返回空块 + 警告；图片不在 PDF 路径里抽取（Word 转换过来的图片读取复杂，留待后续）。</para>
/// </summary>
internal sealed class PdfSourceImporter : IPptSourceImporter
{
    public PptSourceKind SourceKind => PptSourceKind.PdfFile;

    public Task<PptSourceDocument> ImportAsync(
        string payload,
        string? assetsDirectory,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();

        if (string.IsNullOrWhiteSpace(payload) || !File.Exists(payload))
        {
            return Task.FromResult(new PptSourceDocument
            {
                OriginDescription = "PDF (missing)",
                Warnings = new[] { $"文件不存在：{payload}" },
            });
        }

        if (!OfficeWordReader.IsAvailable())
        {
            return Task.FromResult(new PptSourceDocument
            {
                Title = Path.GetFileNameWithoutExtension(payload),
                OriginDescription = "PDF (Word COM unavailable)",
                Warnings = new[] { "本机未安装 Microsoft Word，无法解析 PDF。可改用 Markdown 或纯文本来源。" },
            });
        }

        var doc = OfficeWordReader.Read(payload, assetsDirectory);
        return Task.FromResult(new PptSourceDocument
        {
            Title = doc.Title ?? Path.GetFileNameWithoutExtension(payload),
            OriginDescription = "PDF via Word COM",
            Blocks = doc.Blocks,
            Warnings = doc.Warnings,
        });
    }
}
