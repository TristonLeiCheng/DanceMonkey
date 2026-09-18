namespace DanceMonkey.Agent.Core.Models;

/// <summary>
/// 工具风险级别：审批服务据此决定是否需要用户确认。
/// </summary>
public enum ToolRiskLevel
{
    /// <summary>只读、无副作用（read_file、list_dir、grep）。三档模式下都免审批。</summary>
    ReadOnly = 0,

    /// <summary>写入沙箱 / 已授权工作目录（edit_file、write_file、create_dir）。Ask 档需审批，Auto 档放行。</summary>
    Write = 1,

    /// <summary>执行命令或外部副作用（run_shell）。默认需审批，Auto 档走白名单。</summary>
    Shell = 2,

    /// <summary>高危操作（delete、网络、破坏性）。任何模式都必须审批。</summary>
    Dangerous = 3,
}
