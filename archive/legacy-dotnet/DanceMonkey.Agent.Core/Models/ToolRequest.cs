using System.Text.Json;

namespace DanceMonkey.Agent.Core.Models;

/// <summary>
/// 模型发起的一次工具调用请求。参数以 <see cref="JsonElement"/> 承载，
/// 各工具自行按约定字段解析，避免为每种工具都定义强类型。
/// </summary>
public sealed class ToolRequest
{
    /// <summary>工具名（对应 <c>ITool.Name</c>），如 <c>read_file</c>。</summary>
    public required string Tool { get; init; }

    /// <summary>工具参数（JSON 对象）。空参数时调用方可传 <c>default</c>。</summary>
    public JsonElement Arguments { get; init; }

    /// <summary>可选的调用编号，便于日志与 UI 对齐（多工具并发时有用）。</summary>
    public string? CallId { get; init; }
}
