using System.Net;

namespace DesktopAssistant.Models;

/// <summary>进程诊断报告：进程树 + 网络连接快照。</summary>
public sealed class ProcessDiagnosticReport
{
    public required ProcessNode Root { get; init; }
    public required IReadOnlyList<ProcessConnectionRow> Connections { get; init; }
    public DateTime Timestamp { get; init; } = DateTime.Now;
}

/// <summary>进程树节点。</summary>
public sealed class ProcessNode
{
    public int Pid { get; init; }
    public string Name { get; init; } = "";
    public string? ExePath { get; init; }
    public string? CommandLine { get; init; }
    public double CpuPercent { get; set; }
    public long WorkingSetBytes { get; set; }
    public long PrivateBytes { get; set; }
    public int ThreadCount { get; set; }
    public int HandleCount { get; set; }
    public DateTime? StartTime { get; init; }
    public List<ProcessNode> Children { get; init; } = new();
}

/// <summary>单条 TCP/UDP 连接信息（含所属 PID）。</summary>
public sealed class ProcessConnectionRow
{
    public int OwningPid { get; init; }
    public string ProcessName { get; init; } = "";
    public string Protocol { get; init; } = "TCP";
    public IPEndPoint LocalEndPoint { get; init; } = new(IPAddress.Any, 0);
    public IPEndPoint RemoteEndPoint { get; init; } = new(IPAddress.Any, 0);
    public string State { get; init; } = "";

    /// <summary>对远程 IP 的反向 DNS 缓存（可为空）。</summary>
    public string? RemoteHostName { get; set; }

    // ── 流量统计（由 ETW 填充，无 ETW 时为 0）──
    public long BytesSent { get; set; }
    public long BytesRecv { get; set; }
    public long PacketsSent { get; set; }
    public long PacketsRecv { get; set; }
}
