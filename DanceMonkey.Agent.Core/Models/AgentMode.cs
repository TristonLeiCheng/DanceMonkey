namespace DanceMonkey.Agent.Core.Models;

/// <summary>
/// Agent 的三档权限模式，对应 Claude Code 的 Plan / Ask / Auto-accept。
/// 级别由低到高，越高模型自主执行越多。
/// </summary>
public enum AgentMode
{
    /// <summary>只读规划：模型只能读取与搜索，禁止任何写入与命令执行。适合前期探索。</summary>
    Plan = 0,

    /// <summary>逐次审批：读操作自由，写文件 / Shell / 网络等需要用户每次批准。默认模式。</summary>
    Ask = 1,

    /// <summary>自动执行：除高危操作外自动放行；写文件、白名单命令不再询问。</summary>
    Auto = 2,
}
