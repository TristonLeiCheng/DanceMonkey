using System.Diagnostics;
using System.Management;
using System.Text;
using DesktopAssistant.Models;

namespace DesktopAssistant.Services;

/// <summary>
/// 进程检查器：枚举进程树（含子进程）、模块信息、CPU/内存快照。
/// 使用 WMI (<c>Win32_Process</c>) 获取父子关系和命令行。
/// </summary>
public static class ProcessInspectorService
{
    /// <summary>
    /// 根据可执行文件路径查找正在运行的主进程列表。
    /// 对 .lnk 快捷方式会先解析目标路径。
    /// </summary>
    public static List<Process> FindProcessesByPath(string filePath)
    {
        var resolved = filePath;
        if (filePath.EndsWith(".lnk", StringComparison.OrdinalIgnoreCase))
            resolved = ResolveShortcut(filePath) ?? filePath;

        var result = new List<Process>();
        foreach (var proc in Process.GetProcesses())
        {
            try
            {
                if (proc.MainModule?.FileName is { } fn &&
                    fn.Equals(resolved, StringComparison.OrdinalIgnoreCase))
                {
                    result.Add(proc);
                }
            }
            catch
            {
                // 无权限访问部分系统进程，跳过
            }
        }
        return result;
    }

    /// <summary>构建以 <paramref name="rootPid"/> 为根的完整进程树。</summary>
    public static ProcessNode BuildProcessTree(int rootPid)
    {
        // 通过 WMI 一次性获取所有进程的 PID、PPID、Name、ExecutablePath、CommandLine
        var allProcs = new Dictionary<int, WmiProcessInfo>();
        var children = new Dictionary<int, List<int>>();

        try
        {
            using var searcher = new ManagementObjectSearcher(
                "SELECT ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine FROM Win32_Process");
            foreach (var obj in searcher.Get())
            {
                var pid = Convert.ToInt32(obj["ProcessId"]);
                var ppid = Convert.ToInt32(obj["ParentProcessId"]);
                allProcs[pid] = new WmiProcessInfo
                {
                    Pid = pid,
                    ParentPid = ppid,
                    Name = obj["Name"]?.ToString() ?? "",
                    ExePath = obj["ExecutablePath"]?.ToString(),
                    CommandLine = obj["CommandLine"]?.ToString(),
                };
                if (!children.ContainsKey(ppid))
                    children[ppid] = new List<int>();
                children[ppid].Add(pid);
            }
        }
        catch
        {
            // WMI 不可用时退化为只有根进程
        }

        return BuildNode(rootPid, allProcs, children, depth: 0);
    }

    /// <summary>获取目标进程的所有 PID（含整棵子进程树）。</summary>
    public static HashSet<int> CollectAllPids(ProcessNode root)
    {
        var set = new HashSet<int>();
        Collect(root, set);
        return set;

        static void Collect(ProcessNode node, HashSet<int> s)
        {
            s.Add(node.Pid);
            foreach (var child in node.Children)
                Collect(child, s);
        }
    }

    /// <summary>刷新节点的 CPU / 内存等实时指标。</summary>
    public static void RefreshMetrics(ProcessNode node)
    {
        try
        {
            var proc = Process.GetProcessById(node.Pid);
            node.WorkingSetBytes = proc.WorkingSet64;
            node.PrivateBytes = proc.PrivateMemorySize64;
            node.ThreadCount = proc.Threads.Count;
            node.HandleCount = proc.HandleCount;
        }
        catch
        {
            // 进程已退出
        }

        foreach (var child in node.Children)
            RefreshMetrics(child);
    }

    /// <summary>计算每个进程的 CPU 百分比（需要两次采样）。</summary>
    public static Dictionary<int, TimeSpan> SnapshotCpuTimes(HashSet<int> pids)
    {
        var result = new Dictionary<int, TimeSpan>();
        foreach (var pid in pids)
        {
            try
            {
                var p = Process.GetProcessById(pid);
                result[pid] = p.TotalProcessorTime;
            }
            catch { }
        }
        return result;
    }

    /// <summary>用两次 CPU 快照计算百分比并写入树节点。</summary>
    public static void ApplyCpuDelta(ProcessNode node, Dictionary<int, TimeSpan> before, Dictionary<int, TimeSpan> after, double elapsedMs)
    {
        if (before.TryGetValue(node.Pid, out var t0) && after.TryGetValue(node.Pid, out var t1))
        {
            var delta = (t1 - t0).TotalMilliseconds;
            node.CpuPercent = delta / elapsedMs / Environment.ProcessorCount * 100.0;
        }
        foreach (var child in node.Children)
            ApplyCpuDelta(child, before, after, elapsedMs);
    }

    /// <summary>将进程树格式化为文本报告（供 AI 分析）。</summary>
    public static string FormatTreeText(ProcessNode root, IReadOnlyList<ProcessConnectionRow> connections,
        TrafficSummary? traffic = null, IReadOnlyList<DnsQueryRecord>? dnsQueries = null)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"=== 进程诊断报告 ({DateTime.Now:yyyy-MM-dd HH:mm:ss}) ===\n");

        sb.AppendLine("【进程树】");
        FormatNode(sb, root, "", true);

        // 流量汇总
        if (traffic != null && traffic.TotalBytes > 0)
        {
            sb.AppendLine();
            sb.AppendLine("【流量汇总】");
            sb.AppendLine($"  发送: {FormatBytes(traffic.TotalBytesSent)} ({traffic.TotalPacketsSent} 包)");
            sb.AppendLine($"  接收: {FormatBytes(traffic.TotalBytesRecv)} ({traffic.TotalPacketsRecv} 包)");
            sb.AppendLine($"  合计: {FormatBytes(traffic.TotalBytes)}");
        }

        sb.AppendLine();
        sb.AppendLine($"【网络连接 - 共 {connections.Count} 条】");
        if (connections.Count > 0)
        {
            var hasTraffic = connections.Any(c => c.BytesSent > 0 || c.BytesRecv > 0);
            if (hasTraffic)
            {
                sb.AppendLine("| PID | 进程 | 协议 | 本地地址 | 远程地址 | 状态 | 发送 | 接收 |");
                sb.AppendLine("|-----|------|------|---------|---------|------|------|------|");
            }
            else
            {
                sb.AppendLine("| PID | 进程 | 协议 | 本地地址 | 远程地址 | 状态 |");
                sb.AppendLine("|-----|------|------|---------|---------|------|");
            }

            foreach (var c in connections)
            {
                var remoteDisplay = c.RemoteHostName != null
                    ? $"{c.RemoteHostName} ({c.RemoteEndPoint})"
                    : c.RemoteEndPoint.ToString();
                if (hasTraffic)
                    sb.AppendLine($"| {c.OwningPid} | {c.ProcessName} | {c.Protocol} | {c.LocalEndPoint} | {remoteDisplay} | {c.State} | {FormatBytes(c.BytesSent)} | {FormatBytes(c.BytesRecv)} |");
                else
                    sb.AppendLine($"| {c.OwningPid} | {c.ProcessName} | {c.Protocol} | {c.LocalEndPoint} | {remoteDisplay} | {c.State} |");
            }
        }
        else
        {
            sb.AppendLine("（无活跃网络连接）");
        }

        // DNS 查询记录
        if (dnsQueries is { Count: > 0 })
        {
            sb.AppendLine();
            sb.AppendLine($"【DNS 查询记录 - 最近 {dnsQueries.Count} 条】");
            sb.AppendLine("| 时间 | PID | 域名 | 结果 |");
            sb.AppendLine("|------|-----|------|------|");
            foreach (var d in dnsQueries.TakeLast(50))
            {
                var result = string.IsNullOrEmpty(d.QueryResults) ? "-" : d.QueryResults;
                sb.AppendLine($"| {d.Timestamp:HH:mm:ss.fff} | {d.Pid} | {d.QueryName} | {result} |");
            }
        }

        return sb.ToString();
    }

    #region Private

    private static ProcessNode BuildNode(int pid, Dictionary<int, WmiProcessInfo> all, Dictionary<int, List<int>> children, int depth)
    {
        var info = all.GetValueOrDefault(pid);
        DateTime? startTime = null;
        int threads = 0, handles = 0;
        long ws = 0, pb = 0;
        try
        {
            var proc = Process.GetProcessById(pid);
            startTime = proc.StartTime;
            threads = proc.Threads.Count;
            handles = proc.HandleCount;
            ws = proc.WorkingSet64;
            pb = proc.PrivateMemorySize64;
        }
        catch { }

        var node = new ProcessNode
        {
            Pid = pid,
            Name = info?.Name ?? $"PID {pid}",
            ExePath = info?.ExePath,
            CommandLine = info?.CommandLine,
            StartTime = startTime,
            ThreadCount = threads,
            HandleCount = handles,
            WorkingSetBytes = ws,
            PrivateBytes = pb,
        };

        // 限制递归深度防止循环
        if (depth < 8 && children.TryGetValue(pid, out var kidPids))
        {
            foreach (var kidPid in kidPids)
            {
                if (kidPid != pid) // 避免自引用
                    node.Children.Add(BuildNode(kidPid, all, children, depth + 1));
            }
        }

        return node;
    }

    private static void FormatNode(StringBuilder sb, ProcessNode node, string prefix, bool isLast)
    {
        var connector = isLast ? "└── " : "├── ";
        var mem = FormatBytes(node.WorkingSetBytes);
        sb.AppendLine($"{prefix}{connector}{node.Name} (PID {node.Pid}, CPU {node.CpuPercent:F1}%, 内存 {mem}, 线程 {node.ThreadCount})");

        var childPrefix = prefix + (isLast ? "    " : "│   ");
        for (var i = 0; i < node.Children.Count; i++)
            FormatNode(sb, node.Children[i], childPrefix, i == node.Children.Count - 1);
    }

    private static string FormatBytes(long bytes) => bytes switch
    {
        >= 1024 * 1024 * 1024 => $"{bytes / (1024.0 * 1024 * 1024):F1} GB",
        >= 1024 * 1024 => $"{bytes / (1024.0 * 1024):F1} MB",
        >= 1024 => $"{bytes / 1024.0:F1} KB",
        _ => $"{bytes} B"
    };

    /// <summary>解析 Windows .lnk 快捷方式的目标路径（通过 WScript.Shell COM）。</summary>
    internal static string? ResolveShortcut(string lnkPath)
    {
        try
        {
            var shellType = Type.GetTypeFromProgID("WScript.Shell");
            if (shellType == null) return null;
            dynamic shell = Activator.CreateInstance(shellType)!;
            dynamic shortcut = shell.CreateShortcut(lnkPath);
            string targetPath = shortcut.TargetPath;
            System.Runtime.InteropServices.Marshal.FinalReleaseComObject(shortcut);
            System.Runtime.InteropServices.Marshal.FinalReleaseComObject(shell);
            return string.IsNullOrEmpty(targetPath) ? null : targetPath;
        }
        catch
        {
            return null;
        }
    }

    private sealed class WmiProcessInfo
    {
        public int Pid;
        public int ParentPid;
        public string Name = "";
        public string? ExePath;
        public string? CommandLine;
    }

    #endregion
}
