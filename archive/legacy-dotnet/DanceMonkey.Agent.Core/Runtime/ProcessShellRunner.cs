using System.Diagnostics;
using System.Text;
using DanceMonkey.Agent.Core.Abstractions;

namespace DanceMonkey.Agent.Core.Runtime;

/// <summary>
/// 基于 <see cref="Process"/> 的默认 <see cref="IShellRunner"/>。
/// <para>Windows 下使用 <c>cmd.exe /c</c>，非 Windows 下使用 <c>/bin/sh -c</c>。</para>
/// 输出按字节上限截断，防止超长日志塞爆上下文。
/// </summary>
public sealed class ProcessShellRunner : IShellRunner
{
    private const int MaxOutputChars = 16 * 1024;

    /// <summary>命令拒绝清单（大小写不敏感的前缀/子串匹配）。</summary>
    public HashSet<string> DenyList { get; } = new(StringComparer.OrdinalIgnoreCase)
    {
        "format ",
        "rm -rf /",
        "rm -rf ~",
        "rm -rf *",
        "del /s /q c:\\",
        "rd /s /q c:\\",
        "shutdown",
        "reg delete",
        "mkfs",
        ":(){ :|:& };:",
        "diskpart",
    };

    public async Task<ShellResult> RunAsync(
        string command,
        string? workingDirectory,
        TimeSpan timeout,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(command))
            return new ShellResult { ExitCode = -1, Output = "", Blocked = true, BlockReason = "空命令" };

        // 安全检查
        foreach (var deny in DenyList)
        {
            if (command.Contains(deny, StringComparison.OrdinalIgnoreCase))
            {
                return new ShellResult
                {
                    ExitCode = -1,
                    Output = "",
                    Blocked = true,
                    BlockReason = $"命令匹配拒绝清单项: {deny.Trim()}",
                };
            }
        }

        var (shell, args) = BuildShellInvocation(command);

        var psi = new ProcessStartInfo
        {
            FileName = shell,
            Arguments = args,
            WorkingDirectory = workingDirectory ?? Directory.GetCurrentDirectory(),
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };

        using var proc = new Process { StartInfo = psi };
        var output = new StringBuilder();
        var outputLock = new object();

        proc.OutputDataReceived += (_, e) =>
        {
            if (e.Data == null) return;
            lock (outputLock)
            {
                if (output.Length < MaxOutputChars)
                    output.AppendLine(e.Data);
            }
        };
        proc.ErrorDataReceived += (_, e) =>
        {
            if (e.Data == null) return;
            lock (outputLock)
            {
                if (output.Length < MaxOutputChars)
                    output.Append("[stderr] ").AppendLine(e.Data);
            }
        };

        try
        {
            if (!proc.Start())
                return new ShellResult { ExitCode = -1, Output = "无法启动进程", Blocked = true, BlockReason = "Process.Start 返回 false" };
        }
        catch (Exception ex)
        {
            return new ShellResult { ExitCode = -1, Output = $"启动进程失败: {ex.Message}", Blocked = true, BlockReason = ex.Message };
        }

        proc.BeginOutputReadLine();
        proc.BeginErrorReadLine();

        using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        linkedCts.CancelAfter(timeout);

        bool timedOut = false;
        try
        {
            await proc.WaitForExitAsync(linkedCts.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            timedOut = !ct.IsCancellationRequested;
            try { if (!proc.HasExited) proc.Kill(entireProcessTree: true); } catch { /* best effort */ }
        }

        try { await proc.WaitForExitAsync(CancellationToken.None).ConfigureAwait(false); } catch { }

        string finalOutput;
        lock (outputLock)
        {
            finalOutput = output.ToString();
            if (finalOutput.Length >= MaxOutputChars)
                finalOutput = finalOutput[..MaxOutputChars] + "\n[... 输出已截断 ...]";
        }

        return new ShellResult
        {
            ExitCode = timedOut ? -1 : proc.ExitCode,
            Output = finalOutput.TrimEnd(),
            TimedOut = timedOut,
        };
    }

    private static (string shell, string args) BuildShellInvocation(string command)
    {
        if (OperatingSystem.IsWindows())
        {
            // 使用 cmd.exe /c "..."，外层再包一层引号
            var escaped = command.Replace("\"", "\\\"");
            return ("cmd.exe", $"/c \"{escaped}\"");
        }
        return ("/bin/sh", $"-c \"{command.Replace("\"", "\\\"")}\"");
    }
}
