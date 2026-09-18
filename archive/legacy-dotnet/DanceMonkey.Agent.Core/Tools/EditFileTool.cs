using DanceMonkey.Agent.Core.Abstractions;
using DanceMonkey.Agent.Core.Models;

namespace DanceMonkey.Agent.Core.Tools;

/// <summary>
/// edit_file：在已存在的文件中把 old_text 替换为 new_text（首次出现）。
/// 设计对齐 Claude Code 的 Edit 工具，强制<see cref="ITool"/>重叠精确匹配以避免误改。
/// <code>{ "path": "...", "old_text": "...", "new_text": "...", "replace_all": false }</code>
/// </summary>
public sealed class EditFileTool : ITool
{
    private readonly IFileSystem _fs;

    public EditFileTool(IFileSystem fs) => _fs = fs;

    public string Name => "edit_file";

    public string Description => """
edit_file: 在已存在文件中做精确字符串替换。old_text 必须在文件中唯一出现（或启用 replace_all）。
参数:
  path (string, 必填) - 文件相对路径
  old_text (string, 必填) - 原文（必须精确匹配，含空白与换行）
  new_text (string, 必填) - 替换后的新文本
  replace_all (bool, 可选, 默认 false) - 为 true 时替换所有出现
""";

    public ToolRiskLevel Risk => ToolRiskLevel.Write;

    public string SummarizeCall(ToolRequest request)
    {
        var path = ToolArgs.GetString(request.Arguments, "path", "?");
        var all = ToolArgs.GetBool(request.Arguments, "replace_all", false);
        return all ? $"全局替换 {path} 中的匹配文本" : $"编辑文件 {path}";
    }

    public async Task<ToolResult> ExecuteAsync(ToolRequest request, CancellationToken ct)
    {
        var path = ToolArgs.GetString(request.Arguments, "path");
        var oldText = ToolArgs.GetString(request.Arguments, "old_text");
        var newText = ToolArgs.GetString(request.Arguments, "new_text");
        var all = ToolArgs.GetBool(request.Arguments, "replace_all", false);

        if (string.IsNullOrEmpty(path))
            return ToolResult.Fail("edit_file 缺少参数 path");
        if (string.IsNullOrEmpty(oldText))
            return ToolResult.Fail("edit_file 缺少参数 old_text");
        if (oldText == newText)
            return ToolResult.Fail("old_text 与 new_text 相同，未执行修改");

        try
        {
            if (!_fs.FileExists(path))
                return ToolResult.Fail($"文件不存在: {path}");

            // 读取原文，校验匹配次数
            var original = await _fs.ReadTextAsync(path, int.MaxValue, ct).ConfigureAwait(false);
            var count = CountOccurrences(original, oldText);
            if (count == 0)
                return ToolResult.Fail($"在 {path} 中未找到 old_text（请检查是否精确匹配，含空白与换行）");

            if (!all && count > 1)
                return ToolResult.Fail(
                    $"old_text 在 {path} 中出现 {count} 次，不唯一。请增加上下文使其唯一，或将 replace_all 设为 true。");

            string updated;
            int replacements;
            if (all)
            {
                updated = original.Replace(oldText, newText);
                replacements = count;
            }
            else
            {
                var idx = original.IndexOf(oldText, StringComparison.Ordinal);
                updated = original[..idx] + newText + original[(idx + oldText.Length)..];
                replacements = 1;
            }

            await _fs.WriteTextAsync(path, updated, ct).ConfigureAwait(false);

            var msg = $"[edit_file] {path}: 替换 {replacements} 处";
            return ToolResult.Ok(msg, display: $"✓ {msg}");
        }
        catch (UnauthorizedAccessException ex)
        {
            return ToolResult.Fail($"拒绝写入: {ex.Message}");
        }
        catch (Exception ex)
        {
            return ToolResult.Fail($"编辑失败: {ex.Message}");
        }
    }

    private static int CountOccurrences(string haystack, string needle)
    {
        if (needle.Length == 0) return 0;
        int count = 0, idx = 0;
        while ((idx = haystack.IndexOf(needle, idx, StringComparison.Ordinal)) >= 0)
        {
            count++;
            idx += needle.Length;
        }
        return count;
    }
}
