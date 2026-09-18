using DanceMonkey.Ppt.Abstractions;
using DanceMonkey.Ppt.Models;
using Markdig;
using Markdig.Extensions.Tables;
using Markdig.Syntax;
using Markdig.Syntax.Inlines;

namespace DanceMonkey.Ppt.Importers;

/// <summary>
/// P2 Markdown 导入器：用 Markdig 解析 AST，抽出 Heading/Paragraph/ListItem/Image/Table/Quote。
/// 图片只记录原始路径，不在此处复制到 assetsDirectory（P3 PDF/Word 导入时再统一处理媒体落地）。
/// </summary>
internal sealed class MarkdownSourceImporter : IPptSourceImporter
{
    private static readonly MarkdownPipeline Pipeline = new MarkdownPipelineBuilder()
        .UseAdvancedExtensions()
        .Build();

    public PptSourceKind SourceKind => PptSourceKind.Markdown;

    public Task<PptSourceDocument> ImportAsync(
        string payload,
        string? assetsDirectory,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        _ = assetsDirectory; // P2 暂未使用，P3 接 PDF/Word 时复用此参数

        var text = payload ?? string.Empty;
        var blocks = new List<PptSourceBlock>();
        string? title = null;

        try
        {
            var doc = Markdown.Parse(text, Pipeline);
            foreach (var node in doc)
            {
                cancellationToken.ThrowIfCancellationRequested();
                EmitBlock(node, blocks, ref title);
            }
        }
        catch
        {
            // Markdig 解析失败：退化为「整段当 Paragraph」，避免上游崩溃
            blocks.Clear();
            blocks.Add(new PptSourceBlock { Kind = PptSourceBlockKind.Paragraph, Text = text });
        }

        var doc2 = new PptSourceDocument
        {
            Title = title,
            OriginDescription = "Markdown (Markdig AST)",
            Blocks = blocks,
        };
        return Task.FromResult(doc2);
    }

    private static void EmitBlock(Block node, List<PptSourceBlock> output, ref string? title)
    {
        switch (node)
        {
            case HeadingBlock heading:
            {
                var text = ExtractInlineText(heading.Inline);
                if (!string.IsNullOrWhiteSpace(text))
                {
                    if (title == null && heading.Level == 1)
                        title = text.Trim();

                    output.Add(new PptSourceBlock
                    {
                        Kind = PptSourceBlockKind.Heading,
                        Level = heading.Level,
                        Text = text.Trim(),
                    });
                }
                break;
            }

            case ParagraphBlock paragraph:
            {
                var text = ExtractInlineText(paragraph.Inline);
                if (!string.IsNullOrWhiteSpace(text))
                {
                    output.Add(new PptSourceBlock
                    {
                        Kind = PptSourceBlockKind.Paragraph,
                        Text = text.Trim(),
                    });
                }
                // 段落中可能内嵌图片，单独再发一条 Image 块
                CollectImages(paragraph.Inline, output);
                break;
            }

            case ListBlock list:
            {
                foreach (var item in list)
                {
                    if (item is not ListItemBlock listItem) continue;
                    foreach (var sub in listItem)
                    {
                        if (sub is ParagraphBlock p)
                        {
                            var line = ExtractInlineText(p.Inline);
                            if (!string.IsNullOrWhiteSpace(line))
                            {
                                output.Add(new PptSourceBlock
                                {
                                    Kind = PptSourceBlockKind.ListItem,
                                    Text = line.Trim(),
                                });
                            }
                            CollectImages(p.Inline, output);
                        }
                        else if (sub is ListBlock nested)
                        {
                            // 嵌套列表平铺为同级 list item，保留前缀
                            foreach (var nestedItem in nested)
                            {
                                if (nestedItem is ListItemBlock li2 &&
                                    li2.FirstOrDefault() is ParagraphBlock pp)
                                {
                                    var line = ExtractInlineText(pp.Inline);
                                    if (!string.IsNullOrWhiteSpace(line))
                                    {
                                        output.Add(new PptSourceBlock
                                        {
                                            Kind = PptSourceBlockKind.ListItem,
                                            Text = "· " + line.Trim(),
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
                break;
            }

            case QuoteBlock quote:
            {
                foreach (var sub in quote)
                {
                    if (sub is ParagraphBlock p)
                    {
                        var line = ExtractInlineText(p.Inline);
                        if (!string.IsNullOrWhiteSpace(line))
                        {
                            output.Add(new PptSourceBlock
                            {
                                Kind = PptSourceBlockKind.Quote,
                                Text = line.Trim(),
                            });
                        }
                    }
                }
                break;
            }

            case Table table:
            {
                var rows = new List<IReadOnlyList<string>>();
                foreach (var row in table)
                {
                    if (row is not TableRow tr) continue;
                    var cells = new List<string>();
                    foreach (var cell in tr)
                    {
                        if (cell is not TableCell tc) continue;
                        var sb = new System.Text.StringBuilder();
                        foreach (var sub in tc)
                        {
                            if (sub is ParagraphBlock pb)
                                sb.Append(ExtractInlineText(pb.Inline));
                        }
                        cells.Add(sb.ToString().Trim());
                    }
                    if (cells.Count > 0) rows.Add(cells);
                }
                if (rows.Count > 0)
                {
                    output.Add(new PptSourceBlock
                    {
                        Kind = PptSourceBlockKind.Table,
                        TableRows = rows,
                    });
                }
                break;
            }

            case FencedCodeBlock code:
            {
                // 代码块作为单段 Paragraph 透传，便于 LLM 读取上下文
                var content = code.Lines.ToString();
                if (!string.IsNullOrWhiteSpace(content))
                {
                    output.Add(new PptSourceBlock
                    {
                        Kind = PptSourceBlockKind.Paragraph,
                        Text = "```\n" + content + "\n```",
                    });
                }
                break;
            }
        }
    }

    private static void CollectImages(ContainerInline? inlines, List<PptSourceBlock> output)
    {
        if (inlines == null) return;
        foreach (var inline in inlines)
        {
            if (inline is LinkInline link && link.IsImage && !string.IsNullOrWhiteSpace(link.Url))
            {
                output.Add(new PptSourceBlock
                {
                    Kind = PptSourceBlockKind.Image,
                    MediaPath = link.Url,
                    Text = ExtractInlineText(link),
                });
            }
            else if (inline is ContainerInline child)
            {
                CollectImages(child, output);
            }
        }
    }

    private static string ExtractInlineText(ContainerInline? inlines)
    {
        if (inlines == null) return string.Empty;
        var sb = new System.Text.StringBuilder();
        foreach (var inline in inlines)
        {
            switch (inline)
            {
                case LiteralInline lit:
                    sb.Append(lit.Content.ToString());
                    break;
                case CodeInline code:
                    sb.Append('`').Append(code.Content).Append('`');
                    break;
                case LineBreakInline:
                    sb.Append(' ');
                    break;
                case LinkInline link when !link.IsImage:
                    sb.Append(ExtractInlineText(link));
                    break;
                case ContainerInline child:
                    sb.Append(ExtractInlineText(child));
                    break;
            }
        }
        return sb.ToString();
    }
}
