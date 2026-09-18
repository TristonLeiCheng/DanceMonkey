using System.IO.Compression;
using DanceMonkey.Ppt.Abstractions;
using DanceMonkey.Ppt.Models;

namespace DanceMonkey.Ppt.Importers;

/// <summary>
/// Word 文件导入器。
/// <para>主路径：Office Word COM 抽取段落 + 标题层级 + 表格（见 <see cref="OfficeWordReader"/>）。</para>
/// <para>图片抽取：对 .docx 直接读 zip 包里的 <c>word/media/*</c>，独立于 COM 链路，避免 Word 占用文件期间无法读 zip。</para>
/// <para>若本机无 Word：会在 <see cref="PptSourceDocument.Warnings"/> 中显式告知，并退化为 ".docx 元数据 + 媒体图"。</para>
/// </summary>
internal sealed class WordSourceImporter : IPptSourceImporter
{
    public PptSourceKind SourceKind => PptSourceKind.WordFile;

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
                OriginDescription = "Word file (missing)",
                Warnings = new[] { $"文件不存在：{payload}" },
            });
        }

        // 通过 COM 取文字/表格（若 Word 不可用则返回空块 + 警告）
        var doc = OfficeWordReader.Read(payload, assetsDirectory);
        var blocks = new List<PptSourceBlock>(doc.Blocks);
        var warnings = new List<string>(doc.Warnings);

        // 对 .docx 走 zip 补充图片（与 COM 链路并行，不影响主流程；失败则忽略）
        if (HasDocxExtension(payload))
        {
            try
            {
                var imageBlocks = ExtractDocxImages(payload, assetsDirectory);
                blocks.AddRange(imageBlocks);
            }
            catch (Exception ex)
            {
                warnings.Add($"读取 docx 内嵌图片失败：{ex.Message}");
            }
        }

        return Task.FromResult(new PptSourceDocument
        {
            Title = doc.Title ?? Path.GetFileNameWithoutExtension(payload),
            OriginDescription = doc.OriginDescription ?? "Word",
            Blocks = blocks,
            Warnings = warnings,
        });
    }

    private static bool HasDocxExtension(string path) =>
        string.Equals(Path.GetExtension(path), ".docx", StringComparison.OrdinalIgnoreCase);

    internal static IReadOnlyList<PptSourceBlock> ExtractDocxImages(string docxPath, string? assetsDirectory)
    {
        if (string.IsNullOrWhiteSpace(assetsDirectory)) return Array.Empty<PptSourceBlock>();
        Directory.CreateDirectory(assetsDirectory!);

        var result = new List<PptSourceBlock>();
        using var zip = ZipFile.OpenRead(docxPath);
        var i = 0;
        foreach (var entry in zip.Entries)
        {
            if (!entry.FullName.StartsWith("word/media/", StringComparison.OrdinalIgnoreCase)) continue;
            if (string.IsNullOrEmpty(entry.Name)) continue;
            if (!IsRecognizedImage(entry.Name)) continue;

            i++;
            var dest = Path.Combine(assetsDirectory!, $"image-{i:D3}{Path.GetExtension(entry.Name)}");
            try
            {
                using var src = entry.Open();
                using var fs = File.Create(dest);
                src.CopyTo(fs);
                result.Add(new PptSourceBlock
                {
                    Kind = PptSourceBlockKind.Image,
                    MediaPath = dest,
                });
            }
            catch
            {
                // 跳过单张失败的图，不阻塞整体
            }
        }
        return result;
    }

    private static bool IsRecognizedImage(string fileName)
    {
        var ext = Path.GetExtension(fileName).ToLowerInvariant();
        return ext is ".png" or ".jpg" or ".jpeg" or ".gif" or ".bmp" or ".tif" or ".tiff";
    }
}
