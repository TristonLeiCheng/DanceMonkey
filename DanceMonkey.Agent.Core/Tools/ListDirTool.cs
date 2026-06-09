using System.Text;
using DanceMonkey.Agent.Core.Abstractions;
using DanceMonkey.Agent.Core.Models;

namespace DanceMonkey.Agent.Core.Tools;

/// <summary>
/// list_dir：列出指定目录下的条目（非递归）。
/// <code>{ "path": "." }</code>
/// </summary>
public sealed class ListDirTool : ITool
{
    private readonly IFileSystem _fs;

    public ListDirTool(IFileSystem fs) => _fs = fs;

    public string Name => "list_dir";

    public string Description => """
list_dir: 列出目录下的文件与子目录（非递归）。
参数:
  path (string, 可选, 默认根目录) - 目录相对路径
""";

    public ToolRiskLevel Risk => ToolRiskLevel.ReadOnly;

    public string SummarizeCall(ToolRequest request)
    {
        var path = ToolArgs.GetString(request.Arguments, "path", ".");
        return $"列出目录 {path}";
    }

    public async Task<ToolResult> ExecuteAsync(ToolRequest request, CancellationToken ct)
    {
        var path = ToolArgs.GetString(request.Arguments, "path", "");
        if (path == ".") path = "";

        try
        {
            var entries = await _fs.ListDirectoryAsync(string.IsNullOrEmpty(path) ? null : path, ct)
                .ConfigureAwait(false);

            if (entries.Count == 0)
                return ToolResult.Ok($"[list_dir] {(string.IsNullOrEmpty(path) ? "/" : path)}: (空目录)");

            var sb = new StringBuilder();
            sb.Append("[list_dir] ").Append(string.IsNullOrEmpty(path) ? "/" : path).AppendLine();
            foreach (var e in entries)
                sb.AppendLine(e);
            return ToolResult.Ok(sb.ToString().TrimEnd());
        }
        catch (DirectoryNotFoundException)
        {
            return ToolResult.Fail($"目录不存在: {path}");
        }
        catch (UnauthorizedAccessException ex)
        {
            return ToolResult.Fail($"拒绝访问: {ex.Message}");
        }
        catch (Exception ex)
        {
            return ToolResult.Fail($"列目录失败: {ex.Message}");
        }
    }
}
