namespace DanceMonkey.Agent.Core.Abstractions;

/// <summary>
/// Shell 命令执行器抽象。实现负责设置工作目录、超时、编码与拒绝清单。
/// </summary>
public interface IShellRunner
{
    /// <summary>
    /// 执行一条命令并等待结束（或超时）。
    /// </summary>
    /// <param name="command">完整命令行（含参数）。实现可选择用 cmd.exe /c、pwsh -c 等包装。</param>
    /// <param name="workingDirectory">工作目录（绝对路径）。null 表示使用默认。</param>
    /// <param name="timeout">超时；超时后进程被强制结束。</param>
    /// <param name="ct">外部取消信号。</param>
    Task<ShellResult> RunAsync(
        string command,
        string? workingDirectory,
        TimeSpan timeout,
        CancellationToken ct);
}

/// <summary>Shell 执行结果。stdout / stderr 合并截断后返回。</summary>
public sealed class ShellResult
{
    public required int ExitCode { get; init; }

    /// <summary>stdout + stderr 合并后的文本。实现应按最大字节做截断并附尾标。</summary>
    public required string Output { get; init; }

    /// <summary>是否因超时被杀。</summary>
    public bool TimedOut { get; init; }

    /// <summary>是否被拒绝清单拦截。被拦截时 ExitCode = -1。</summary>
    public bool Blocked { get; init; }

    /// <summary>拦截/失败原因（如适用）。</summary>
    public string? BlockReason { get; init; }
}
