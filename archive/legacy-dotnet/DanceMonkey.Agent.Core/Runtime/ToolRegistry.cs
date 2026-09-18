using System.Text;
using DanceMonkey.Agent.Core.Abstractions;

namespace DanceMonkey.Agent.Core.Runtime;

/// <summary>工具注册表：按名字查找工具，并聚合它们的描述给 system prompt 使用。</summary>
public sealed class ToolRegistry
{
    private readonly Dictionary<string, ITool> _tools = new(StringComparer.OrdinalIgnoreCase);

    public ToolRegistry Register(ITool tool)
    {
        _tools[tool.Name] = tool;
        return this;
    }

    public ToolRegistry RegisterRange(IEnumerable<ITool> tools)
    {
        foreach (var t in tools) Register(t);
        return this;
    }

    public bool TryGet(string name, out ITool tool) => _tools.TryGetValue(name, out tool!);

    public IReadOnlyCollection<ITool> All => _tools.Values;

    /// <summary>生成给模型阅读的工具说明文档。</summary>
    public string RenderCatalog()
    {
        var sb = new StringBuilder();
        foreach (var tool in _tools.Values.OrderBy(t => t.Name))
        {
            sb.AppendLine(tool.Description.TrimEnd());
            sb.AppendLine();
        }
        return sb.ToString().TrimEnd();
    }
}
