using System.Diagnostics;
using DanceMonkey.Agent.Core.Abstractions;
using DanceMonkey.Agent.Core.Models;
using DanceMonkey.Agent.Core.Tools;

namespace DesktopAssistant.Services.AgentTools;

/// <summary>
/// diagnose_process：获取指定进程的进程树与网络连接信息，供 AI 分析。
/// <code>{ "pid": 1234 }</code> 或 <code>{ "name": "chrome" }</code>
/// </summary>
public sealed class ProcessDiagnoseTool : ITool
{
    public string Name => "diagnose_process";

    public string Description => """
diagnose_process: 诊断一个正在运行的进程，返回其进程树（含子进程）和所有 TCP/UDP 网络连接信息。
参数:
  pid (int, 可选) - 进程 PID，与 name 二选一
  name (string, 可选) - 进程名（模糊匹配），与 pid 二选一
返回进程树结构（PID、CPU、内存、线程数）和网络连接表（本地/远程地址、端口、状态）。
""";

    public ToolRiskLevel Risk => ToolRiskLevel.ReadOnly;

    public string SummarizeCall(ToolRequest request)
    {
        var pid = ToolArgs.GetInt(request.Arguments, "pid", 0);
        var name = ToolArgs.GetString(request.Arguments, "name");
        if (pid > 0) return $"诊断进程 PID {pid}";
        if (!string.IsNullOrEmpty(name)) return $"诊断进程 \"{name}\"";
        return "诊断进程";
    }

    public async Task<ToolResult> ExecuteAsync(ToolRequest request, CancellationToken ct)
    {
        var pid = ToolArgs.GetInt(request.Arguments, "pid", 0);
        var name = ToolArgs.GetString(request.Arguments, "name");

        if (pid <= 0 && string.IsNullOrWhiteSpace(name))
            return ToolResult.Fail("diagnose_process 需要 pid 或 name 参数");

        try
        {
            // 按 name 查找
            if (pid <= 0 && !string.IsNullOrWhiteSpace(name))
            {
                var match = Process.GetProcesses()
                    .Where(p =>
                    {
                        try { return p.ProcessName.Contains(name, StringComparison.OrdinalIgnoreCase); }
                        catch { return false; }
                    })
                    .OrderByDescending(p => { try { return p.WorkingSet64; } catch { return 0L; } })
                    .FirstOrDefault();

                if (match == null)
                    return ToolResult.Fail($"未找到名称包含 \"{name}\" 的运行中进程");

                pid = match.Id;
            }

            // 验证进程存在
            try { Process.GetProcessById(pid); }
            catch { return ToolResult.Fail($"PID {pid} 对应的进程不存在或已退出"); }

            // 构建进程树
            var tree = ProcessInspectorService.BuildProcessTree(pid);
            var allPids = ProcessInspectorService.CollectAllPids(tree);

            // CPU 采样（500ms 间隔）
            var cpuBefore = ProcessInspectorService.SnapshotCpuTimes(allPids);
            await Task.Delay(500, ct).ConfigureAwait(false);
            var cpuAfter = ProcessInspectorService.SnapshotCpuTimes(allPids);
            ProcessInspectorService.ApplyCpuDelta(tree, cpuBefore, cpuAfter, 500);
            ProcessInspectorService.RefreshMetrics(tree);

            // 网络连接
            var connections = ProcessNetworkCaptureService.CaptureConnections(allPids);
            await ProcessNetworkCaptureService.ResolveHostNamesAsync(connections, ct).ConfigureAwait(false);

            var report = ProcessInspectorService.FormatTreeText(tree, connections);
            var summary = $"✓ 已诊断 {tree.Name} (PID {pid})，{allPids.Count} 个进程，{connections.Count} 条网络连接";

            return ToolResult.Ok(report, display: summary);
        }
        catch (OperationCanceledException)
        {
            return ToolResult.Fail("操作已取消");
        }
        catch (Exception ex)
        {
            return ToolResult.Fail($"诊断失败: {ex.Message}");
        }
    }
}
