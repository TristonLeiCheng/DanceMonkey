using DanceMonkey.Agent.Core.Abstractions;
using DanceMonkey.Agent.Core.Models;

namespace DanceMonkey.Agent.Core.Tools;

/// <summary>
/// write_file：整文件写入（覆盖）。用于新建文件或整体重写。
/// <code>{ "path": "...", "content": "..." }</code>
/// </summary>
public sealed class WriteFileTool : ITool
{
    private readonly IFileSystem _fs;

    public WriteFileTool(IFileSystem fs) => _fs = fs;

    public string Name => "write_file";

    public string Description => """
write_file: 整文件写入（覆盖已有或创建新文件）。仅用于新建或整体重写，局部修改请用 edit_file。
参数:
  path (string, 必填) - 文件相对路径
  content (string, 必填) - 完整文件内容（含换行）
""";

    public ToolRiskLevel Risk => ToolRiskLevel.Write;

    public string SummarizeCall(ToolRequest request)
    {
        var path = ToolArgs.GetString(request.Arguments, "path", "?");
        var content = ToolArgs.GetString(request.Arguments, "content");
        var lines = content.Length == 0 ? 0 : content.Split('\n').Length;
        return $"写入文件 {path}（{lines} 行，{content.Length} 字符）";
    }

    public async Task<ToolResult> ExecuteAsync(ToolRequest request, CancellationToken ct)
    {
        var path = ToolArgs.GetString(request.Arguments, "path");
        if (string.IsNullOrWhiteSpace(path))
            return ToolResult.Fail("write_file 缺少参数 path");

        var content = ToolArgs.GetString(request.Arguments, "content");

        try
        {
            var existed = _fs.FileExists(path);
            await _fs.WriteTextAsync(path, content, ct).ConfigureAwait(false);
            var verb = existed ? "覆盖" : "创建";
            var msg = $"[write_file] {verb} {path} ({content.Length} chars)";
            return ToolResult.Ok(msg, display: $"✓ {msg}");
        }
        catch (UnauthorizedAccessException ex)
        {
            return ToolResult.Fail($"拒绝写入: {ex.Message}");
        }
        catch (Exception ex)
        {
            return ToolResult.Fail($"写入失败: {ex.Message}");
        }
    }
}
