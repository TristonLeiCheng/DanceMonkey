using System.Text;
using System.Text.RegularExpressions;
using DanceMonkey.Agent.Core.Abstractions;
using DanceMonkey.Agent.Core.Models;

namespace DanceMonkey.Agent.Core.Tools;

/// <summary>
/// grep：在工作目录内按正则搜索文件内容。为避免上下文过大，强制限制文件数与匹配数。
/// <code>{ "pattern": "...", "path": "src/", "glob": "*.cs", "max_matches": 50 }</code>
/// </summary>
public sealed class GrepTool : ITool
{
    private readonly IFileSystem _fs;

    public GrepTool(IFileSystem fs) => _fs = fs;

    public string Name => "grep";

    public string Description => """
grep: 在工作目录内按正则表达式搜索文件内容，返回匹配位置及上下文。
参数:
  pattern (string, 必填) - .NET 正则表达式
  path (string, 可选, 默认根) - 起始目录；CLI 下可用 notes/ 前缀搜索笔记库
  glob (string, 可选, 默认 *) - 文件名通配（如 *.cs）
  max_matches (int, 可选, 默认 100) - 最多返回多少条匹配
  ignore_case (bool, 可选, 默认 true)
""";

    public ToolRiskLevel Risk => ToolRiskLevel.ReadOnly;

    public string SummarizeCall(ToolRequest request)
    {
        var pattern = ToolArgs.GetString(request.Arguments, "pattern", "?");
        var glob = ToolArgs.GetString(request.Arguments, "glob", "*");
        return $"搜索 /{pattern}/ 于 {glob}";
    }

    public Task<ToolResult> ExecuteAsync(ToolRequest request, CancellationToken ct)
    {
        var pattern = ToolArgs.GetString(request.Arguments, "pattern");
        if (string.IsNullOrEmpty(pattern))
            return Task.FromResult(ToolResult.Fail("grep 缺少参数 pattern"));

        var path = ToolArgs.GetString(request.Arguments, "path", "");
        var glob = ToolArgs.GetString(request.Arguments, "glob", "*");
        var maxMatches = ToolArgs.GetInt(request.Arguments, "max_matches", 100);
        if (maxMatches <= 0) maxMatches = 100;
        var ignoreCase = ToolArgs.GetBool(request.Arguments, "ignore_case", true);

        Regex regex;
        try
        {
            var opts = RegexOptions.Multiline | RegexOptions.Compiled;
            if (ignoreCase) opts |= RegexOptions.IgnoreCase;
            regex = new Regex(pattern, opts, TimeSpan.FromSeconds(5));
        }
        catch (ArgumentException ex)
        {
            return Task.FromResult(ToolResult.Fail($"正则表达式无效: {ex.Message}"));
        }

        string rootAbs;
        try
        {
            if (string.IsNullOrEmpty(path))
            {
                rootAbs = _fs.WorkingDirectory;
            }
            else
            {
                var cleaned = path.Replace('\\', '/').TrimEnd('/');
                rootAbs = Path.GetFullPath(_fs.ResolveAbsolute(cleaned));
            }

            if (!_fs.IsAllowedAbsolute(rootAbs))
                return Task.FromResult(ToolResult.Fail("搜索路径越界"));
            if (!Directory.Exists(rootAbs))
                return Task.FromResult(ToolResult.Fail($"目录不存在: {path}"));
        }
        catch (Exception ex)
        {
            return Task.FromResult(ToolResult.Fail($"路径无效: {ex.Message}"));
        }

        var sb = new StringBuilder();
        int fileHits = 0, totalMatches = 0;
        var files = SafeEnumerateFiles(rootAbs, glob).Take(2000);

        foreach (var file in files)
        {
            ct.ThrowIfCancellationRequested();
            if (totalMatches >= maxMatches) break;

            string[] lines;
            try
            {
                lines = File.ReadAllLines(file);
            }
            catch
            {
                continue;
            }

            bool fileHeaderWritten = false;
            for (int i = 0; i < lines.Length && totalMatches < maxMatches; i++)
            {
                if (!regex.IsMatch(lines[i])) continue;
                if (!fileHeaderWritten)
                {
                    sb.Append("── ").AppendLine(Path.GetRelativePath(rootAbs, file));
                    fileHeaderWritten = true;
                    fileHits++;
                }
                var trimmed = lines[i].Length > 300 ? lines[i][..300] + "…" : lines[i];
                sb.Append(i + 1).Append(": ").AppendLine(trimmed);
                totalMatches++;
            }
        }

        if (totalMatches == 0)
            return Task.FromResult(ToolResult.Ok($"[grep] 无匹配: /{pattern}/"));

        var header = $"[grep] /{pattern}/  →  {totalMatches} 条，{fileHits} 个文件" +
                     (totalMatches >= maxMatches ? "（已截断）" : "");
        return Task.FromResult(ToolResult.Ok(header + "\n" + sb.ToString().TrimEnd()));
    }

    private static IEnumerable<string> SafeEnumerateFiles(string root, string glob)
    {
        IEnumerable<string> result;
        try
        {
            result = Directory.EnumerateFiles(root, glob, SearchOption.AllDirectories);
        }
        catch
        {
            yield break;
        }
        foreach (var f in result) yield return f;
    }
}
