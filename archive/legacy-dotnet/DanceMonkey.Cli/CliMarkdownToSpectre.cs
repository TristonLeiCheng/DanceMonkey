using System.Text;
using Markdig;
using Markdig.Extensions.EmphasisExtras;
using Markdig.Syntax;
using Markdig.Syntax.Inlines;
using Spectre.Console;

namespace DanceMonkey.Cli;

/// <summary>
/// 将 CommonMark 片段转为 Spectre Console 的 Markup 字符串，便于在终端中呈现粗体、行内代码、链接等
///（终端并非 HTML，这里仅映射常用子集）。
/// </summary>
internal static class CliMarkdownToSpectre
{
    private static readonly MarkdownPipeline Pipeline = new MarkdownPipelineBuilder()
        .UseEmphasisExtras()
        .Build();

    /// <summary>解析单行/单块文本，生成整段可交给 <see cref="Markup"/> 的字符串。</summary>
    public static string LineToMarkup(string line)
    {
        if (string.IsNullOrEmpty(line)) return " ";
        var document = Markdown.Parse(line + "\n", Pipeline);
        var sb = new StringBuilder();
        foreach (var block in document)
        {
            AppendBlock(sb, block);
        }
        if (sb.Length == 0) return Markup.Escape(line);
        return sb.ToString();
    }

    private static void AppendBlock(StringBuilder sb, Block block)
    {
        switch (block)
        {
            case ThematicBreakBlock:
                sb.Append("[grey]────────────────────[/]");
                break;
            case HeadingBlock h:
            {
                var open = h.Level <= 1 ? "[bold white]" : h.Level == 2 ? "[bold]" : "[bold grey]";
                var close = h.Level <= 1 ? "[/] " : "[/] ";
                sb.Append(open);
                AppendInlinesFromLeaf(sb, h);
                sb.Append(close);
                break;
            }
            case QuoteBlock quote:
            {
                foreach (var inner in quote)
                {
                    if (inner is not Block b) continue;
                    sb.Append("[grey]▍[/] ");
                    AppendBlock(sb, b);
                }
                break;
            }
            case ListBlock list:
            {
                foreach (var item in list)
                {
                    if (item is not ListItemBlock lib) continue;
                    var bullet = list.IsOrdered ? "[grey]·[/] " : "[grey]•[/] ";
                    foreach (var inner in lib)
                    {
                        if (inner is not Block b) continue;
                        sb.Append(bullet);
                        AppendBlockTrim(sb, b);
                    }
                }
                break;
            }
            case ParagraphBlock p:
            {
                AppendInlinesFromLeaf(sb, p);
                break;
            }
            case FencedCodeBlock:
            case CodeBlock:
                // 围栏/缩进代码多行，由调用方以 Panel 等单独处理
                break;
        }
    }

    /// <summary>列表项内子块不重复加引导符号（已在列表分支加过）。</summary>
    private static void AppendBlockTrim(StringBuilder sb, Block block)
    {
        switch (block)
        {
            case ParagraphBlock p:
                AppendInlinesFromLeaf(sb, p);
                break;
            case HeadingBlock h:
            {
                sb.Append(h.Level is >= 1 and <= 2 ? "[bold]" : "[bold grey]");
                AppendInlinesFromLeaf(sb, h);
                sb.Append("[/] ");
                break;
            }
            default:
                AppendBlock(sb, block);
                break;
        }
    }

    private static void AppendInlinesFromLeaf(StringBuilder sb, LeafBlock leaf)
    {
        if (leaf.Inline is null) return;
        AppendInlineList(sb, leaf.Inline);
    }

    private static void AppendInlineList(StringBuilder sb, Inline? first)
    {
        for (var n = first; n != null; n = n.NextSibling)
            AppendInlineNode(sb, n);
    }

    private static void AppendInlineNode(StringBuilder sb, Inline? n)
    {
        if (n is null) return;

        switch (n)
        {
            case LiteralInline l:
            {
                var t = l.Content.ToString();
                if (l.IsFirstCharacterEscaped && t.Length > 0) t = t[1..];
                sb.Append(Markup.Escape(t));
                return;
            }
            case CodeInline code:
            {
                sb.Append("[grey]");
                sb.Append(Markup.Escape(code.Content));
                sb.Append("[/]");
                return;
            }
            case EmphasisInline em:
            {
                var isStrong = em.DelimiterCount >= 2;
                if (isStrong) sb.Append("[bold]");
                else sb.Append(em.DelimiterChar is '_' ? "[underline]" : "[italic]");
                AppendInlineList(sb, em.FirstChild);
                if (isStrong) sb.Append("[/]");
                else sb.Append(em.DelimiterChar is '_' ? "[/]" : "[/]");
                return;
            }
            case LineBreakInline br:
            {
                sb.Append(br.IsHard ? "\n" : " ");
                return;
            }
            case AutolinkInline a:
            {
                if (a.IsEmail)
                {
                    sb.Append("[link]");
                    sb.Append(Markup.Escape(a.Url));
                    sb.Append("[/]");
                }
                else
                {
                    var u = a.Url;
                    var escU = u.Replace("]", "\\]", StringComparison.Ordinal);
                    sb.Append($"[link {escU}]{Markup.Escape(a.Url)}[/]");
                }
                return;
            }
            case LinkInline lk when !lk.IsImage:
            {
                var u = string.IsNullOrEmpty(lk.Url) && lk.GetDynamicUrl is { } d ? d() : lk.Url;
                u ??= "";
                sb.Append("[cyan underline]");
                AppendInlineList(sb, lk.FirstChild);
                sb.Append("[/]");
                if (!string.IsNullOrEmpty(u))
                {
                    sb.Append(" [dim]");
                    sb.Append(Markup.Escape(u));
                    sb.Append("[/]");
                }
                return;
            }
            case LinkInline lk when lk.IsImage:
            {
                sb.Append("[dim][img: ");
                sb.Append(Markup.Escape(lk.Url ?? ""));
                sb.Append("][/]");
                return;
            }
            case HtmlInline h:
            {
                sb.Append(Markup.Escape(h.Tag));
                return;
            }
        }

        if (n is ContainerInline childContainer && n is not (EmphasisInline or LinkInline))
        {
            AppendInlineList(sb, childContainer.FirstChild);
        }
    }
}
