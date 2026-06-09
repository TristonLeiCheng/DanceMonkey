using System.Text.Json;
using DesktopAssistant.Models;

namespace DesktopAssistant.Services;

/// <summary>
/// AI 文件管理服务：将用户自然语言指令通过 AI 解析为沙箱文件操作并执行。
/// AI 返回 JSON 操作指令，服务解析后在沙箱内安全执行。
/// </summary>
public sealed class AiFileManagerService
{
    private readonly AppConfig _config;
    private readonly SandboxFileService _sandbox;

    public AiFileManagerService(AppConfig config, SandboxFileService sandbox)
    {
        _config = config;
        _sandbox = sandbox;
    }

    /// <summary>
    /// 处理用户指令：先让 AI 生成操作计划（JSON），然后执行并返回结果。
    /// </summary>
    public async Task<FileManagerResult> ProcessCommandAsync(
        string userInput,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(userInput))
            return FileManagerResult.Fail("请输入文件操作指令。");

        // 1. 获取当前沙箱状态作为上下文
        var tree = _sandbox.GetDirectoryTree(maxDepth: 3);
        var stats = _sandbox.GetStats();

        // 2. 让 AI 生成操作指令
        var systemPrompt = BuildSystemPrompt(tree, stats);
        var client = new OpenAiApiClient(_config);
        var aiResult = await client.CallAsync(
            userInput,
            systemPrompt,
            maxTokens: 4096,
            temperature: 0.1,
            cancellationToken: cancellationToken);

        if (!aiResult.Success)
            return FileManagerResult.Fail($"AI 调用失败：{aiResult.Error}");

        var aiText = aiResult.Result?.Trim() ?? "";

        // 3. 解析 AI 返回的 JSON 操作
        var ops = ParseOperations(aiText);
        if (ops == null || ops.Count == 0)
        {
            // AI 可能直接给出了文本回复（如解释性回答），直接返回
            return new FileManagerResult
            {
                Success = true,
                Message = aiText,
                Operations = new List<FileOpResult>()
            };
        }

        // 4. 逐条执行操作
        var results = new List<FileOpResult>();
        foreach (var op in ops)
        {
            var opResult = ExecuteOperation(op);
            results.Add(opResult);
        }

        // 5. 汇总结果
        var succeeded = results.Count(r => r.Success);
        var failed = results.Count(r => !r.Success);
        var summary = $"执行完成：{succeeded} 成功";
        if (failed > 0) summary += $"，{failed} 失败";

        return new FileManagerResult
        {
            Success = failed == 0,
            Message = summary,
            Operations = results,
            AiResponse = aiText
        };
    }

    /// <summary>
    /// 仅让 AI 回答关于文件的问题（不执行操作），如"我的沙箱里有什么文件"。
    /// </summary>
    public async Task<string> AskAboutFilesAsync(
        string question,
        CancellationToken cancellationToken = default)
    {
        var tree = _sandbox.GetDirectoryTree(maxDepth: 4);
        var stats = _sandbox.GetStats();

        var systemPrompt = $"""
你是文件管理助手。用户询问关于文件的问题，请根据以下沙箱状态回答。

沙箱目录结构：
{tree}

统计：{stats.FileCount} 个文件，{stats.DirCount} 个文件夹，占用 {FormatSize(stats.TotalBytes)}

请用简体中文回答，简洁明了。
""";

        var client = new OpenAiApiClient(_config);
        var result = await client.CallAsync(question, systemPrompt, 2000, 0.5, cancellationToken);
        return result.Success ? result.Result ?? "无法获取回答。" : $"错误：{result.Error}";
    }

    private string BuildSystemPrompt(string tree, (int FileCount, int DirCount, long TotalBytes) stats)
    {
        return $$"""
你是文件管理助手。用户会用自然语言描述文件操作需求，你需要将其转化为 JSON 操作指令。

## 沙箱当前状态
目录结构：
{{tree}}

统计：{{stats.FileCount}} 个文件，{{stats.DirCount}} 个文件夹，占用 {{FormatSize(stats.TotalBytes)}}

## 支持的操作类型
- create_file: 创建或覆盖文件
- append_file: 追加内容到文件
- read_file: 读取文件内容
- delete_file: 删除文件
- rename_file: 重命名文件
- move_file: 移动文件
- create_dir: 创建目录
- delete_dir: 删除目录
- list_dir: 列出目录内容

## 返回格式
你必须返回一个 JSON 数组，每个元素是一个操作对象。严格遵循以下格式，不要添加任何 JSON 之外的文字：

```json
[
  {"op": "create_file", "path": "相对路径/文件名.txt", "content": "文件内容"},
  {"op": "create_dir", "path": "新目录名"},
  {"op": "rename_file", "path": "原路径", "new_name": "新文件名"},
  {"op": "move_file", "path": "原路径", "target": "目标目录"},
  {"op": "delete_file", "path": "文件路径"},
  {"op": "delete_dir", "path": "目录路径"},
  {"op": "read_file", "path": "文件路径"},
  {"op": "list_dir", "path": "目录路径"},
  {"op": "append_file", "path": "文件路径", "content": "追加内容"}
]
```

## 规则
1. 所有路径都是相对于沙箱根目录的相对路径
2. 路径使用 / 分隔符
3. 创建文件时根据用户需求生成合理内容
4. 如果用户要求创建代码文件、配置文件、文档等，生成完整的专业内容
5. 如果用户的请求不涉及文件操作（如纯粹的问答），返回纯文本回答，不要包裹在 JSON 中
6. 不要在 JSON 外添加任何解释文字
7. 文件内容中的换行用 \n 表示
""";
    }

    private static List<JsonElement>? ParseOperations(string aiText)
    {
        // 尝试从 AI 回复中提取 JSON 数组
        var text = aiText.Trim();

        // 去掉 markdown 代码块标记
        if (text.StartsWith("```"))
        {
            var firstNewline = text.IndexOf('\n');
            if (firstNewline > 0) text = text[(firstNewline + 1)..];
            if (text.EndsWith("```")) text = text[..^3];
            text = text.Trim();
        }

        // 尝试找到 JSON 数组
        var start = text.IndexOf('[');
        var end = text.LastIndexOf(']');
        if (start < 0 || end < 0 || end <= start)
            return null;

        var jsonStr = text[start..(end + 1)];

        try
        {
            var doc = JsonDocument.Parse(jsonStr);
            if (doc.RootElement.ValueKind != JsonValueKind.Array)
                return null;

            var ops = new List<JsonElement>();
            foreach (var elem in doc.RootElement.EnumerateArray())
                ops.Add(elem.Clone());
            return ops.Count == 0 ? null : ops;
        }
        catch
        {
            return null;
        }
    }

    private FileOpResult ExecuteOperation(JsonElement op)
    {
        var opType = op.TryGetProperty("op", out var opProp) ? opProp.GetString() ?? "" : "";
        var path = op.TryGetProperty("path", out var pathProp) ? pathProp.GetString() ?? "" : "";

        try
        {
            return opType switch
            {
                "create_file" => ExecuteCreateFile(op, path),
                "append_file" => ExecuteAppendFile(op, path),
                "read_file" => ExecuteReadFile(path),
                "delete_file" => ExecuteDeleteFile(path),
                "rename_file" => ExecuteRenameFile(op, path),
                "move_file" => ExecuteMoveFile(op, path),
                "create_dir" => ExecuteCreateDir(path),
                "delete_dir" => ExecuteDeleteDir(path),
                "list_dir" => ExecuteListDir(path),
                _ => new FileOpResult { Success = false, Operation = opType, Path = path, Message = $"未知操作：{opType}" }
            };
        }
        catch (UnauthorizedAccessException ex)
        {
            return new FileOpResult { Success = false, Operation = opType, Path = path, Message = $"安全限制：{ex.Message}" };
        }
        catch (Exception ex)
        {
            return new FileOpResult { Success = false, Operation = opType, Path = path, Message = ex.Message };
        }
    }

    private FileOpResult ExecuteCreateFile(JsonElement op, string path)
    {
        var content = op.TryGetProperty("content", out var c) ? c.GetString() ?? "" : "";
        var fullPath = _sandbox.CreateFile(path, content);
        return new FileOpResult
        {
            Success = true,
            Operation = "create_file",
            Path = path,
            Message = $"已创建文件：{path}（{content.Length} 字符）"
        };
    }

    private FileOpResult ExecuteAppendFile(JsonElement op, string path)
    {
        var content = op.TryGetProperty("content", out var c) ? c.GetString() ?? "" : "";
        _sandbox.AppendFile(path, content);
        return new FileOpResult
        {
            Success = true,
            Operation = "append_file",
            Path = path,
            Message = $"已追加内容到：{path}"
        };
    }

    private FileOpResult ExecuteReadFile(string path)
    {
        var content = _sandbox.ReadFile(path);
        return new FileOpResult
        {
            Success = true,
            Operation = "read_file",
            Path = path,
            Message = $"文件内容（{content.Length} 字符）：\n{content}"
        };
    }

    private FileOpResult ExecuteDeleteFile(string path)
    {
        _sandbox.DeleteFile(path);
        return new FileOpResult
        {
            Success = true,
            Operation = "delete_file",
            Path = path,
            Message = $"已删除文件：{path}"
        };
    }

    private FileOpResult ExecuteRenameFile(JsonElement op, string path)
    {
        var newName = op.TryGetProperty("new_name", out var n) ? n.GetString() ?? "" : "";
        _sandbox.RenameFile(path, newName);
        return new FileOpResult
        {
            Success = true,
            Operation = "rename_file",
            Path = path,
            Message = $"已重命名：{path} → {newName}"
        };
    }

    private FileOpResult ExecuteMoveFile(JsonElement op, string path)
    {
        var target = op.TryGetProperty("target", out var t) ? t.GetString() ?? "" : "";
        _sandbox.MoveFile(path, target);
        return new FileOpResult
        {
            Success = true,
            Operation = "move_file",
            Path = path,
            Message = $"已移动：{path} → {target}/"
        };
    }

    private FileOpResult ExecuteCreateDir(string path)
    {
        _sandbox.CreateDirectory(path);
        return new FileOpResult
        {
            Success = true,
            Operation = "create_dir",
            Path = path,
            Message = $"已创建目录：{path}"
        };
    }

    private FileOpResult ExecuteDeleteDir(string path)
    {
        _sandbox.DeleteDirectory(path, recursive: true);
        return new FileOpResult
        {
            Success = true,
            Operation = "delete_dir",
            Path = path,
            Message = $"已删除目录：{path}"
        };
    }

    private FileOpResult ExecuteListDir(string path)
    {
        var entries = _sandbox.ListDirectory(string.IsNullOrEmpty(path) ? null : path);
        var listing = string.Join("\n", entries.Select(e =>
            e.IsDirectory ? $"📁 {e.Name}/" : $"📄 {e.Name}  ({e.SizeDisplay})"));

        return new FileOpResult
        {
            Success = true,
            Operation = "list_dir",
            Path = string.IsNullOrEmpty(path) ? "/" : path,
            Message = entries.Count == 0 ? "（空目录）" : listing
        };
    }

    private static string FormatSize(long bytes) => bytes switch
    {
        < 1024 => $"{bytes} B",
        < 1024 * 1024 => $"{bytes / 1024.0:F1} KB",
        _ => $"{bytes / (1024.0 * 1024.0):F1} MB"
    };
}

/// <summary>文件管理器整体结果。</summary>
public sealed class FileManagerResult
{
    public bool Success { get; init; }
    public string Message { get; init; } = "";
    public List<FileOpResult> Operations { get; init; } = new();
    public string? AiResponse { get; init; }

    public static FileManagerResult Fail(string msg) =>
        new() { Success = false, Message = msg, Operations = new() };
}

/// <summary>单个文件操作结果。</summary>
public sealed class FileOpResult
{
    public bool Success { get; init; }
    public string Operation { get; init; } = "";
    public string Path { get; init; } = "";
    public string Message { get; init; } = "";
}
