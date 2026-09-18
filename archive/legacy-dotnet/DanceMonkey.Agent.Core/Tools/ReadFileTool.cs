using DanceMonkey.Agent.Core.Abstractions;
using DanceMonkey.Agent.Core.Models;

namespace DanceMonkey.Agent.Core.Tools;

/// <summary>
/// read_file：读取一个文本文件。参数：
/// <code>{ "path": "相对路径", "max_bytes": 64000 }</code>
/// </summary>
public sealed class ReadFileTool : ITool
{
    private const int DefaultMaxBytes = 64 * 1024;

    private readonly IFileSystem _fs;

    public ReadFileTool(IFileSystem fs) => _fs = fs;

    public string Name => "read_file";

    public string Description => """
read_file: 读取一个文本文件的内容。
参数:
  path (string, 必填) - 相对于工作目录的文件路径
  max_bytes (int, 可选, 默认 65536) - 最多读取字节数，超出截断
""";

    public ToolRiskLevel Risk => ToolRiskLevel.ReadOnly;

    public string SummarizeCall(ToolRequest request)
    {
        var path = ToolArgs.GetString(request.Arguments, "path", "?");
        return $"读取文件 {path}";
    }

    public async Task<ToolResult> ExecuteAsync(ToolRequest request, CancellationToken ct)
    {
        var path = ToolArgs.GetString(request.Arguments, "path");
        if (string.IsNullOrWhiteSpace(path))
            return ToolResult.Fail("read_file 缺少参数 path");

        var maxBytes = ToolArgs.GetInt(request.Arguments, "max_bytes", DefaultMaxBytes);
        if (maxBytes <= 0) maxBytes = DefaultMaxBytes;

        try
        {
            if (!_fs.FileExists(path))
                return ToolResult.Fail($"文件不存在: {path}");

            var content = await _fs.ReadTextAsync(path, maxBytes, ct).ConfigureAwait(false);
            var header = $"[read_file] {path} ({content.Length} chars)";
            return ToolResult.Ok($"{header}\n{content}", display: $"✓ {header}");
        }
        catch (UnauthorizedAccessException ex)
        {
            return ToolResult.Fail($"拒绝访问: {ex.Message}");
        }
        catch (Exception ex)
        {
            return ToolResult.Fail($"读取失败: {ex.Message}");
        }
    }
}
