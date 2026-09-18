using System.Text;
using System.Text.RegularExpressions;
using Markdig;

namespace DesktopAssistant.Services;

/// <summary>将 Markdown 转为用于 WebView2 展示的 HTML 文档（与笔记预览风格接近）。</summary>
public static class MarkdownHtml
{
    private static readonly MarkdownPipeline Pipeline = new MarkdownPipelineBuilder()
        .UseAdvancedExtensions()
        .Build();

    private static readonly Regex ImgSrcRegex = new(
        @"<img\s[^>]*\bsrc\s*=\s*([""'])([^""']+)\1",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    /// <summary>匹配 [[wiki link]] 双链语法（在 Markdig 输出之前预处理）。</summary>
    private static readonly Regex WikiLinkRegex = new(
        @"\[\[([^\]\|]+?)(?:\|([^\]]+?))?\]\]",
        RegexOptions.Compiled);

    /// <summary>匹配 YAML frontmatter tags 字段。</summary>
    private static readonly Regex FrontmatterRegex = new(
        @"^---\s*\r?\n([\s\S]*?)\r?\n---",
        RegexOptions.Compiled);

    /// <summary>从 Markdown 文件内容中提取 frontmatter tags。</summary>
    public static List<string> ExtractTags(string markdown)
    {
        var tags = new List<string>();
        if (string.IsNullOrWhiteSpace(markdown)) return tags;

        var fmMatch = FrontmatterRegex.Match(markdown);
        if (!fmMatch.Success) return tags;

        var yaml = fmMatch.Groups[1].Value;
        // 简单解析 tags: [tag1, tag2] 或 tags:\n- tag1\n- tag2
        var tagsLineMatch = Regex.Match(yaml, @"^tags\s*:\s*(.*)$", RegexOptions.Multiline | RegexOptions.IgnoreCase);
        if (!tagsLineMatch.Success) return tags;

        var value = tagsLineMatch.Groups[1].Value.Trim();
        if (value.StartsWith('[') && value.EndsWith(']'))
        {
            // inline format: [tag1, tag2]
            var inner = value[1..^1];
            foreach (var t in inner.Split(','))
            {
                var tag = t.Trim().Trim('"', '\'');
                if (!string.IsNullOrEmpty(tag)) tags.Add(tag);
            }
        }
        else if (string.IsNullOrEmpty(value))
        {
            // list format: - tag1
            var listRegex = new Regex(@"^-\s+(.+)$", RegexOptions.Multiline);
            var yamlAfterTags = yaml[(tagsLineMatch.Index + tagsLineMatch.Length)..];
            foreach (Match m in listRegex.Matches(yamlAfterTags))
            {
                var tag = m.Groups[1].Value.Trim().Trim('"', '\'');
                if (!string.IsNullOrEmpty(tag)) tags.Add(tag);
                // 遇到新的非缩进 key 时停止
                if (tag.Contains(':')) break;
            }
        }
        else
        {
            // single value: tags: mytag
            tags.Add(value.Trim('"', '\''));
        }

        return tags;
    }

    /// <summary>预处理 Markdown 中的 [[wiki link]] 语法，转为 HTML 链接。</summary>
    public static string PreprocessWikiLinks(string markdown)
    {
        if (string.IsNullOrEmpty(markdown)) return markdown;
        return WikiLinkRegex.Replace(markdown, m =>
        {
            var target = m.Groups[1].Value.Trim();
            var display = m.Groups[2].Success ? m.Groups[2].Value.Trim() : target;
            // 用 wikilink: 协议标记，供预览区 JS 拦截
            var encoded = Uri.EscapeDataString(target);
            return $"<a href=\"wikilink:{encoded}\" class=\"wiki-link\" title=\"{target}\">{display}</a>";
        });
    }

    /// <summary>去除 frontmatter 块（用于预览时不显示 YAML）。</summary>
    public static string StripFrontmatter(string markdown)
    {
        if (string.IsNullOrWhiteSpace(markdown)) return markdown;
        return FrontmatterRegex.Replace(markdown, "", 1).TrimStart('\r', '\n');
    }

    public static string ToHtmlBody(string markdown)
    {
        if (string.IsNullOrWhiteSpace(markdown))
            return "<p style=\"color:#6b7280;\">（无内容）</p>";

        // 预处理：去除 frontmatter，转换 wiki links
        var processed = StripFrontmatter(markdown.Trim());
        processed = PreprocessWikiLinks(processed);
        return Markdown.ToHtml(processed, Pipeline);
    }

    /// <summary>
    /// 与 <see cref="NotePreviewVirtualHost"/> + WebView2 SetVirtualHostNameToFolderMapping 配合使用。
    /// 将相对路径 img 转为 https://虚拟主机/相对路径，便于在 NavigateToString 页面中加载本地图片。
    /// </summary>
    public const string NotePreviewVirtualHost = "da-note.preview.local";

    public static string ResolveImageSrcForNotePreview(string htmlBody, string? markdownFileDirectory, string? mappedRootDirectory = null)
    {
        if (string.IsNullOrWhiteSpace(htmlBody) || string.IsNullOrWhiteSpace(markdownFileDirectory))
            return htmlBody;

        var noteDirRoot = Path.GetFullPath(markdownFileDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
        if (!Directory.Exists(noteDirRoot))
            return htmlBody;
        var mappedRoot = string.IsNullOrWhiteSpace(mappedRootDirectory)
            ? noteDirRoot
            : Path.GetFullPath(mappedRootDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
        if (!Directory.Exists(mappedRoot))
            mappedRoot = noteDirRoot;

        return ImgSrcRegex.Replace(htmlBody, m =>
        {
            var quote = m.Groups[1].Value;
            var src = m.Groups[2].Value.Trim();
            if (ShouldLeaveImgSrcUnchanged(src))
                return m.Value;

            try
            {
                var rel = src.Replace('/', Path.DirectorySeparatorChar).TrimStart(Path.DirectorySeparatorChar);
                var full = Path.GetFullPath(Path.Combine(noteDirRoot, rel));
                if (!File.Exists(full))
                    return m.Value;
                var relFromRoot = Path.GetRelativePath(mappedRoot, full);
                if (relFromRoot.StartsWith("..", StringComparison.Ordinal))
                    return m.Value;
                var segments = relFromRoot.Split(new[] { '/', '\\' }, StringSplitOptions.RemoveEmptyEntries);
                var pathPart = string.Join("/", segments.Select(Uri.EscapeDataString));
                var newUrl = $"https://{NotePreviewVirtualHost}/{pathPart}";
                return m.Value.Replace($"{quote}{src}{quote}", $"{quote}{newUrl}{quote}", StringComparison.Ordinal);
            }
            catch
            {
                return m.Value;
            }
        });
    }

    private static bool ShouldLeaveImgSrcUnchanged(string src)
    {
        if (string.IsNullOrEmpty(src))
            return true;
        if (src.StartsWith("data:", StringComparison.OrdinalIgnoreCase))
            return true;
        if (src.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
            src.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            return true;
        if (src.StartsWith("file:", StringComparison.OrdinalIgnoreCase))
            return true;
        if (src.Length >= 3 && char.IsLetter(src[0]) && src[1] == ':' && (src[2] == '\\' || src[2] == '/'))
            return true;
        return false;
    }

    public static string WrapFullDocument(string bodyHtml)
    {
        // 使用非插值原始字符串，避免 CSS 中的 { } 与 $""" 插值规则冲突（CS9006）
        // #13 增加 highlight.js CDN 实现代码语法高亮
        const string Head = """
<!DOCTYPE html>
<html><head><meta charset="utf-8"/>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css"/>
<style>
body{font-family:Segoe UI,system-ui,sans-serif;padding:16px 18px;line-height:1.6;color:#1a1d26;font-size:14px;}
h1{font-size:1.35em;margin:0.6em 0 0.35em;} h2{font-size:1.15em;margin:0.8em 0 0.35em;} h3{font-size:1.05em;margin:0.7em 0 0.3em;}
p{margin:0.45em 0;} ul,ol{padding-left:1.35em;margin:0.4em 0;}
code{font-family:Consolas,monospace;background:#f0f1f6;padding:0.1em 0.35em;border-radius:4px;font-size:0.92em;}
pre{background:#f6f8fa;padding:14px;border-radius:8px;overflow:auto;font-size:13px;border:1px solid #e8eaf0;}
pre code{background:transparent;padding:0;border-radius:0;}
blockquote{border-left:4px solid #e8eaf0;margin:0.5em 0;padding-left:12px;color:#4b5563;}
strong{font-weight:600;}
table{border-collapse:collapse;margin:0.5em 0;} th,td{border:1px solid #e8eaf0;padding:6px 8px;}
a{color:#4F6EF7;}
img{max-width:100%;height:auto;}
ul.contains-task-list{list-style:none;padding-left:0;}
li.task-list-item{margin:0.35em 0;} li.task-list-item input{margin-right:0.5em;}
.wiki-link{color:#7C5CFC;text-decoration:none;border-bottom:1px dashed #7C5CFC;}
.wiki-link:hover{border-bottom-style:solid;}
</style></head><body>
""";

        const string Tail = """
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
<script>hljs.highlightAll();</script>
</body></html>
""";

        return Head + bodyHtml + Tail;
    }

    /// <summary>全局对话页：在正文样式基础上增加气泡样式。</summary>
    public static string WrapChatDocument(string innerHtml)
    {
        const string Head = """
<!DOCTYPE html>
<html><head><meta charset="utf-8"/>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css"/>
<style>
    body{font-family:"Noto Sans SC","Segoe UI Variable","PingFang SC","Microsoft YaHei",sans-serif;line-height:1.62;color:#1f2937;font-size:15px;margin:0;background:#eceff3;}
    .page{max-width:960px;margin:0 auto;padding:24px 24px 40px;}
    .empty-shell{min-height:66vh;display:flex;align-items:center;justify-content:center;}
    .hero{width:min(760px,100%);}
    .hero-kicker{font-size:34px;font-weight:650;letter-spacing:0.01em;color:#101828;margin:0 0 6px;}
    .hero-sub{font-size:16px;color:#6b7280;margin:0 0 18px;}

    .chip-row{display:flex;flex-wrap:wrap;gap:10px;margin-top:14px;}
    .chip{display:inline-flex;align-items:center;padding:10px 14px;border-radius:999px;background:#ffffff;border:1px solid #dce3ef;color:#4b5563;font-size:13px;}
    .chat-shell{padding-top:6px;}
    h1{font-size:1.4em;margin:0.6em 0 0.35em;} h2{font-size:1.2em;margin:0.8em 0 0.35em;} h3{font-size:1.06em;margin:0.7em 0 0.3em;}
    p{margin:0.5em 0;} ul,ol{padding-left:1.35em;margin:0.42em 0;}
    code{font-family:Consolas,monospace;background:#edf2f8;padding:0.1em 0.35em;border-radius:4px;font-size:0.92em;}
    pre{position:relative;background:#f8fafc;padding:12px;border-radius:10px;overflow:auto;font-size:13px;border:1px solid #dbe4f0;}
    pre code{background:transparent;padding:0;border-radius:0;}
    blockquote{border-left:4px solid #d7deea;margin:0.5em 0;padding-left:12px;color:#4b5563;}
    strong{font-weight:620;}
    table{border-collapse:collapse;margin:0.5em 0;} th,td{border:1px solid #dbe4f0;padding:6px 8px;}
    a{color:#3258d6;}
    img{max-width:100%;height:auto;}
    .msg{margin-bottom:16px;text-align:left;}
    .msg-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;}
    .msg .label{font-size:12px;font-weight:600;letter-spacing:0.02em;}
    .msg .md{margin-top:4px;}
    .msg.user{display:flex;justify-content:flex-end;}
    .msg.user .bubble{max-width:72%;background:#dbe6fb;border:1px solid #cad8f5;border-radius:18px;padding:10px 14px;}
    .msg.user .label{display:none;}
    .msg.assistant{padding:0 2px;}
    .msg.assistant .label{color:#5b6474;}
    .msg.context{background:#f1f5f9;border:1px dashed #94a3b8;border-radius:10px;padding:12px 14px;}
    .msg.context .label{color:#475569;}
    .msg.err{background:#fff1f2;border:1px solid #fecdd3;border-radius:10px;padding:12px 14px;}
    .msg.err .label{color:#be123c;}
    .copy-btn{font-size:11px;padding:2px 8px;border-radius:6px;border:1px solid #cfd7e5;background:#fff;color:#667085;cursor:pointer;opacity:0;transition:opacity .15s ease;}
    .msg:hover .copy-btn{opacity:1;}
    .copy-btn:hover{background:#f3f6fb;}
    .copy-btn.copied{color:#15803d;border-color:#15803d;}
    .pre-copy-btn{position:absolute;top:6px;right:6px;font-size:11px;padding:2px 8px;border-radius:6px;border:1px solid #cfd7e5;background:#fff;color:#667085;cursor:pointer;opacity:0;transition:opacity .15s ease;}
    pre:hover .pre-copy-btn{opacity:1;}
    .pre-copy-btn:hover{background:#f3f6fb;}
    .pre-copy-btn.copied{color:#15803d;border-color:#15803d;}
</style></head><body>
    <div class="page">
""";

        const string Tail = """
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
<script>
hljs.highlightAll();
// 为每个 pre 块添加复制按钮
document.querySelectorAll('pre').forEach(function(pre){
  var btn=document.createElement('button');
  btn.className='pre-copy-btn';
  btn.textContent='复制';
  btn.onclick=function(){
    var code=pre.querySelector('code');
    var text=code?code.innerText:pre.innerText;
    navigator.clipboard.writeText(text).then(function(){
      btn.textContent='已复制';btn.classList.add('copied');
      setTimeout(function(){btn.textContent='复制';btn.classList.remove('copied');},2000);
    });
  };
  pre.appendChild(btn);
});
// 为助手消息气泡添加复制按钮
document.querySelectorAll('.msg.assistant').forEach(function(msg){
  var header=msg.querySelector('.msg-header');
  if(!header)return;
  var btn=document.createElement('button');
  btn.className='copy-btn';
  btn.textContent='复制';
  btn.onclick=function(){
    var md=msg.querySelector('.md');
    var text=md?md.innerText:msg.innerText;
    navigator.clipboard.writeText(text).then(function(){
      btn.textContent='已复制';btn.classList.add('copied');
      setTimeout(function(){btn.textContent='复制';btn.classList.remove('copied');},2000);
    });
  };
  header.appendChild(btn);
});
</script>
</div>
</body></html>
""";

        return Head + innerHtml + Tail;
    }
}
