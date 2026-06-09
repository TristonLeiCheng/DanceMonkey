using DanceMonkey.Ppt.Models;

namespace DanceMonkey.Ppt.Abstractions;

/// <summary>把不同来源（Markdown/PDF/Word/纯文本）归一化为 <see cref="PptSourceDocument"/>。</summary>
public interface IPptSourceImporter
{
    /// <summary>该导入器支持的来源类别。</summary>
    PptSourceKind SourceKind { get; }

    /// <summary>
    /// 导入并返回中间表示。
    /// <para><paramref name="payload"/>：当 SourceKind 为 Markdown/PlainText/Topic 时是文本；否则是文件路径。</para>
    /// <para><paramref name="assetsDirectory"/>：导入器把图片等媒体落盘到该目录（已存在或由实现创建）。</para>
    /// </summary>
    Task<PptSourceDocument> ImportAsync(
        string payload,
        string? assetsDirectory,
        CancellationToken cancellationToken = default);
}
