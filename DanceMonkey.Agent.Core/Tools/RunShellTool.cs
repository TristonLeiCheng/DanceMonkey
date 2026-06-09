using DanceMonkey.Agent.Core.Abstractions;
using DanceMonkey.Agent.Core.Models;
using System.Text.RegularExpressions;

namespace DanceMonkey.Agent.Core.Tools;

/// <summary>
/// run_shell：执行一条命令并返回输出。默认 60 秒超时。审批层必须介入。
/// <code>{ "command": "git status", "cwd": ".", "timeout_sec": 60 }</code>
/// </summary>
public sealed class RunShellTool : ITool
{
    private const int DefaultTimeoutSec = 60;
    private const int MaxTimeoutSec = 600;
    private static readonly string[] DangerousTokens =
    {
        "rm -rf", "rm -fr", "sudo rm", "del /f", "rmdir /s", "rd /s", "format ", "shutdown ", "reboot ",
        "mkfs", "dd if=", "poweroff", "halt", "init 0", "init 6", "diskpart", "bcdedit ", "cipher /w",
    };

    private readonly IShellRunner _shell;
    private readonly IFileSystem _fs;

    public RunShellTool(IShellRunner shell, IFileSystem fs)
    {
        _shell = shell;
        _fs = fs;
    }

    public string Name => "run_shell";

    public string Description => """
run_shell: 在工作目录执行一条 shell 命令并返回合并后的 stdout+stderr。
参数:
  command (string, 必填) - 完整命令行
  cwd (string, 可选, 默认工作目录) - 子目录；CLI 下可用 notes/ 前缀访问笔记库根下的路径
  timeout_sec (int, 可选, 默认 60, 最大 600) - 超时秒数

返回中会附带 exit_code。命令默认 60 秒超时；超时会被强制结束。
""";

    public ToolRiskLevel Risk => ToolRiskLevel.Shell;

    public string SummarizeCall(ToolRequest request)
    {
        var cmd = ToolArgs.GetString(request.Arguments, "command", "?");
        return $"执行命令: {Truncate(cmd, 80)}";
    }

    public async Task<ToolResult> ExecuteAsync(ToolRequest request, CancellationToken ct)
    {
        var cmd = ToolArgs.GetString(request.Arguments, "command");
        if (string.IsNullOrWhiteSpace(cmd))
            return ToolResult.Fail("run_shell 缺少参数 command");
        if (IsDangerousCommand(cmd))
            return ToolResult.Fail("命令被安全策略拦截: 检测到危险命令模式。");

        var cwdRel = ToolArgs.GetString(request.Arguments, "cwd", "");
        var timeoutSec = ToolArgs.GetInt(request.Arguments, "timeout_sec", DefaultTimeoutSec);
        if (timeoutSec <= 0) timeoutSec = DefaultTimeoutSec;
        if (timeoutSec > MaxTimeoutSec) timeoutSec = MaxTimeoutSec;

        string cwdAbs;
        try
        {
            if (string.IsNullOrEmpty(cwdRel) || cwdRel == ".")
            {
                cwdAbs = _fs.WorkingDirectory;
            }
            else
            {
                var cleaned = cwdRel.Replace('\\', '/').TrimEnd('/');
                cwdAbs = Path.GetFullPath(_fs.ResolveAbsolute(cleaned));
            }

            if (!_fs.IsAllowedAbsolute(cwdAbs))
                return ToolResult.Fail($"cwd 越界: {cwdRel}");
            if (!Directory.Exists(cwdAbs))
                return ToolResult.Fail($"cwd 不存在: {cwdRel}");
        }
        catch (Exception ex)
        {
            return ToolResult.Fail($"cwd 无效: {ex.Message}");
        }

        var result = await _shell.RunAsync(cmd, cwdAbs, TimeSpan.FromSeconds(timeoutSec), ct)
            .ConfigureAwait(false);

        if (result.Blocked)
            return ToolResult.Fail($"命令被安全策略拦截: {result.BlockReason ?? "(未提供原因)"}");

        var header = result.TimedOut
            ? $"[run_shell] ⏱️ 超时终止（{timeoutSec}s），exit={result.ExitCode}"
            : $"[run_shell] exit={result.ExitCode}";

        // 给模型的输出含 exit 码，便于它判断成功失败
        var forModel = $"{header}\n{result.Output}";
        var success = result.ExitCode == 0 && !result.TimedOut;

        return new ToolResult
        {
            Success = success,
            Output = forModel,
            Display = $"{(success ? "✓" : "⚠")} {header}",
        };
    }

    private static string Truncate(string s, int n) =>
        s.Length <= n ? s : s[..n] + "…";

    /// <summary>提取审批 scope 使用的命令特征：最多保留前两个 token（如 git status / dotnet test）。</summary>
    public static string BuildApprovalScopeHint(string? command)
    {
        if (string.IsNullOrWhiteSpace(command)) return "";
        var normalized = Regex.Replace(command.Trim(), @"\s+", " ");
        var tokens = normalized.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (tokens.Length == 0) return "";
        if (tokens.Length == 1) return tokens[0].ToLowerInvariant();
        return $"{tokens[0]} {tokens[1]}".ToLowerInvariant();
    }

    /// <summary>硬拦截明显危险的命令模式（与审批模式无关）。</summary>
    public static bool IsDangerousCommand(string? command)
    {
        if (string.IsNullOrWhiteSpace(command)) return false;
        var normalized = Regex.Replace(command.ToLowerInvariant(), @"\s+", " ").Trim();
        foreach (var token in DangerousTokens)
        {
            if (normalized.Contains(token, StringComparison.Ordinal))
                return true;
        }
        return false;
    }
}
