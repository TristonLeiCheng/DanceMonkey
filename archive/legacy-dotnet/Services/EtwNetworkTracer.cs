using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using DesktopAssistant.Models;
using Microsoft.Diagnostics.Tracing;
using Microsoft.Diagnostics.Tracing.Parsers;
using Microsoft.Diagnostics.Tracing.Parsers.Kernel;
using Microsoft.Diagnostics.Tracing.Session;

namespace DesktopAssistant.Services;

/// <summary>
/// 基于 ETW (Event Tracing for Windows) 的实时网络流量捕获器。
/// 追踪 Kernel TCP/IP 事件，提供每个连接的真实流量数据（发送/接收字节数）。
/// <para>需要管理员权限启动 ETW 会话。如无权限则退化为仅连接枚举模式。</para>
/// </summary>
public sealed class EtwNetworkTracer : IDisposable
{
    private const string SessionName = "DanceMonkey-NetTrace";

    private TraceEventSession? _session;
    private ETWTraceEventSource? _source;
    private Thread? _processingThread;
    private volatile bool _running;

    /// <summary>目标进程 PID 集合（线程安全读写）。</summary>
    private HashSet<int> _targetPids = new();
    private readonly object _pidLock = new();

    /// <summary>
    /// 每条连接的累计流量统计。Key = "PID|LocalIP:Port→RemoteIP:Port"。
    /// </summary>
    private readonly ConcurrentDictionary<string, TrafficStats> _connTraffic = new();

    /// <summary>全进程聚合统计。</summary>
    private long _totalBytesSent;
    private long _totalBytesRecv;
    private long _totalPacketsSent;
    private long _totalPacketsRecv;

    /// <summary>DNS 查询记录。</summary>
    private readonly ConcurrentQueue<DnsQueryRecord> _dnsQueries = new();
    private const int MaxDnsRecords = 200;

    /// <summary>ETW 会话是否成功启动（需要管理员权限）。</summary>
    public bool IsActive => _running && _session != null;

    /// <summary>如果没有管理员权限，会记录此消息。</summary>
    public string? ActivationError { get; private set; }

    #region 公开数据访问

    /// <summary>获取所有连接的流量快照。</summary>
    public Dictionary<string, TrafficStats> GetTrafficSnapshot()
        => new(_connTraffic);

    /// <summary>获取聚合统计。</summary>
    public TrafficSummary GetSummary() => new()
    {
        TotalBytesSent = Interlocked.Read(ref _totalBytesSent),
        TotalBytesRecv = Interlocked.Read(ref _totalBytesRecv),
        TotalPacketsSent = Interlocked.Read(ref _totalPacketsSent),
        TotalPacketsRecv = Interlocked.Read(ref _totalPacketsRecv),
    };

    /// <summary>获取最近的 DNS 查询列表。</summary>
    public List<DnsQueryRecord> GetDnsQueries() => _dnsQueries.ToList();

    /// <summary>获取单条连接的流量。按 local+remote endpoint 匹配。</summary>
    public TrafficStats? GetConnectionTraffic(int pid, IPEndPoint local, IPEndPoint remote)
    {
        var key = MakeKey(pid, local.Address, (ushort)local.Port, remote.Address, (ushort)remote.Port);
        return _connTraffic.TryGetValue(key, out var stats) ? stats : null;
    }

    #endregion

    #region 生命周期

    /// <summary>更新要追踪的 PID 集合。</summary>
    public void SetTargetPids(HashSet<int> pids)
    {
        lock (_pidLock)
        {
            _targetPids = new HashSet<int>(pids);
        }
    }

    /// <summary>启动 ETW 抓包会话。</summary>
    public void Start()
    {
        if (_running) return;

        try
        {
            // 清理可能残留的旧会话
            try { TraceEventSession.GetActiveSession(SessionName)?.Dispose(); } catch { }

            _session = new TraceEventSession(SessionName)
            {
                StopOnDispose = true,
            };

            // 启用内核级 TCP/IP 事件
            _session.EnableKernelProvider(
                KernelTraceEventParser.Keywords.NetworkTCPIP);

            // 启用 DNS Client 事件（用户态 provider）
            // Microsoft-Windows-DNS-Client: {1C95126E-7EEA-49A9-A3FE-A378B03DDB4D}
            try
            {
                _session.EnableProvider(
                    new Guid("1C95126E-7EEA-49A9-A3FE-A378B03DDB4D"),
                    TraceEventLevel.Informational);
            }
            catch
            {
                // DNS provider 不可用不影响核心功能
            }

            _source = _session.Source;
            SubscribeEvents(_source);

            _running = true;
            _processingThread = new Thread(ProcessEvents)
            {
                Name = "ETW-NetTrace",
                IsBackground = true,
            };
            _processingThread.Start();
        }
        catch (UnauthorizedAccessException)
        {
            ActivationError = "需要管理员权限才能启用实时流量捕获。请以管理员身份运行程序。";
            _session?.Dispose();
            _session = null;
        }
        catch (Exception ex)
        {
            ActivationError = $"ETW 会话启动失败: {ex.Message}";
            _session?.Dispose();
            _session = null;
        }
    }

    /// <summary>停止 ETW 会话并释放资源。</summary>
    public void Stop()
    {
        _running = false;
        try { _session?.Stop(); } catch { }
        _processingThread?.Join(3000);
        _session?.Dispose();
        _session = null;
        _source = null;
    }

    /// <summary>清空所有累计数据。</summary>
    public void Reset()
    {
        _connTraffic.Clear();
        Interlocked.Exchange(ref _totalBytesSent, 0);
        Interlocked.Exchange(ref _totalBytesRecv, 0);
        Interlocked.Exchange(ref _totalPacketsSent, 0);
        Interlocked.Exchange(ref _totalPacketsRecv, 0);
        while (_dnsQueries.TryDequeue(out _)) { }
    }

    public void Dispose() => Stop();

    #endregion

    #region 事件处理

    private void ProcessEvents()
    {
        try
        {
            _source?.Process(); // 阻塞直到 session 停止
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"[EtwNetworkTracer] Processing ended: {ex.Message}");
        }
        finally
        {
            _running = false;
        }
    }

    private void SubscribeEvents(ETWTraceEventSource source)
    {
        var kernelParser = new KernelTraceEventParser(source);

        // TCP Send (TcpIpSendTraceData)
        kernelParser.TcpIpSend += data =>
            RecordTraffic(data.ProcessID, data.saddr, (ushort)data.sport, data.daddr, (ushort)data.dport, data.size, isSend: true);
        kernelParser.TcpIpSendIPV6 += data =>
            RecordTrafficV6(data.ProcessID, data.saddr, data.sport, data.daddr, data.dport, data.size, isSend: true);

        // TCP Receive (TcpIpTraceData)
        kernelParser.TcpIpRecv += data =>
            RecordTraffic(data.ProcessID, data.saddr, (ushort)data.sport, data.daddr, (ushort)data.dport, data.size, isSend: false);
        kernelParser.TcpIpRecvIPV6 += data =>
            RecordTrafficV6(data.ProcessID, data.saddr, data.sport, data.daddr, data.dport, data.size, isSend: false);

        // UDP Send / Receive (UdpIpTraceData)
        kernelParser.UdpIpSend += data =>
            RecordTraffic(data.ProcessID, data.saddr, (ushort)data.sport, data.daddr, (ushort)data.dport, data.size, isSend: true, isUdp: true);
        kernelParser.UdpIpRecv += data =>
            RecordTraffic(data.ProcessID, data.saddr, (ushort)data.sport, data.daddr, (ushort)data.dport, data.size, isSend: false, isUdp: true);

        // TCP Connect / Disconnect（连接生命周期）
        kernelParser.TcpIpConnect += data =>
        {
            if (!IsTargetPid(data.ProcessID)) return;
            var key = MakeKey(data.ProcessID, data.saddr, (ushort)data.sport, data.daddr, (ushort)data.dport);
            _connTraffic.TryAdd(key, new TrafficStats { FirstSeen = DateTime.Now });
        };

        kernelParser.TcpIpDisconnect += data =>
        {
            if (!IsTargetPid(data.ProcessID)) return;
            var key = MakeKey(data.ProcessID, data.saddr, (ushort)data.sport, data.daddr, (ushort)data.dport);
            if (_connTraffic.TryGetValue(key, out var stats))
                stats.Closed = true;
        };

        // DNS 事件（通过 dynamic 解析用户态 provider）
        source.Dynamic.All += data =>
        {
            if (data.ProviderGuid == new Guid("1C95126E-7EEA-49A9-A3FE-A378B03DDB4D"))
            {
                OnDnsEvent(data);
            }
        };
    }

    private void RecordTraffic(int pid, IPAddress srcIp, ushort srcPort, IPAddress dstIp, ushort dstPort, int bytes, bool isSend, bool isUdp = false)
    {
        if (!IsTargetPid(pid)) return;

        // Key 始终以 local→remote 方向存储
        var key = isSend
            ? MakeKey(pid, srcIp, srcPort, dstIp, dstPort)
            : MakeKey(pid, dstIp, dstPort, srcIp, srcPort);

        var stats = _connTraffic.GetOrAdd(key, _ => new TrafficStats { FirstSeen = DateTime.Now, IsUdp = isUdp });

        if (isSend)
        {
            Interlocked.Add(ref stats._bytesSent, bytes);
            Interlocked.Increment(ref stats._packetsSent);
            Interlocked.Add(ref _totalBytesSent, bytes);
            Interlocked.Increment(ref _totalPacketsSent);
        }
        else
        {
            Interlocked.Add(ref stats._bytesRecv, bytes);
            Interlocked.Increment(ref stats._packetsRecv);
            Interlocked.Add(ref _totalBytesRecv, bytes);
            Interlocked.Increment(ref _totalPacketsRecv);
        }
        stats.LastSeen = DateTime.Now;
    }

    private void RecordTrafficV6(int pid, IPAddress srcIp, int srcPort, IPAddress dstIp, int dstPort, int bytes, bool isSend)
    {
        if (!IsTargetPid(pid)) return;

        var key = isSend
            ? $"{pid}|[{srcIp}]:{srcPort}→[{dstIp}]:{dstPort}"
            : $"{pid}|[{dstIp}]:{dstPort}→[{srcIp}]:{srcPort}";

        var stats = _connTraffic.GetOrAdd(key, _ => new TrafficStats { FirstSeen = DateTime.Now });

        if (isSend)
        {
            Interlocked.Add(ref stats._bytesSent, bytes);
            Interlocked.Increment(ref stats._packetsSent);
            Interlocked.Add(ref _totalBytesSent, bytes);
            Interlocked.Increment(ref _totalPacketsSent);
        }
        else
        {
            Interlocked.Add(ref stats._bytesRecv, bytes);
            Interlocked.Increment(ref stats._packetsRecv);
            Interlocked.Add(ref _totalBytesRecv, bytes);
            Interlocked.Increment(ref _totalPacketsRecv);
        }
        stats.LastSeen = DateTime.Now;
    }

    private void OnDnsEvent(TraceEvent data)
    {
        try
        {
            // DNS query events typically have QueryName payload
            var queryName = data.PayloadStringByName("QueryName");
            if (string.IsNullOrEmpty(queryName)) return;

            var pid = data.ProcessID;
            if (!IsTargetPid(pid)) return;

            var record = new DnsQueryRecord
            {
                Timestamp = data.TimeStamp,
                Pid = pid,
                QueryName = queryName,
                QueryType = data.PayloadStringByName("QueryType") ?? "",
                EventName = data.EventName ?? "",
            };

            // 尝试获取 QueryResults（仅 response 事件有）
            try { record.QueryResults = data.PayloadStringByName("QueryResults") ?? ""; } catch { }

            _dnsQueries.Enqueue(record);
            while (_dnsQueries.Count > MaxDnsRecords)
                _dnsQueries.TryDequeue(out _);
        }
        catch { }
    }

    #endregion

    #region Helpers

    private bool IsTargetPid(int pid)
    {
        lock (_pidLock)
        {
            return _targetPids.Contains(pid);
        }
    }

    private static string MakeKey(int pid, IPAddress srcIp, ushort srcPort, IPAddress dstIp, ushort dstPort)
        => $"{pid}|{srcIp}:{srcPort}→{dstIp}:{dstPort}";

    #endregion
}

/// <summary>单条连接的流量统计（线程安全累计）。</summary>
public sealed class TrafficStats
{
    internal long _bytesSent;
    internal long _bytesRecv;
    internal long _packetsSent;
    internal long _packetsRecv;

    public long BytesSent => Interlocked.Read(ref _bytesSent);
    public long BytesRecv => Interlocked.Read(ref _bytesRecv);
    public long PacketsSent => Interlocked.Read(ref _packetsSent);
    public long PacketsRecv => Interlocked.Read(ref _packetsRecv);

    public DateTime FirstSeen { get; init; }
    public DateTime LastSeen { get; set; }
    public bool Closed { get; set; }
    public bool IsUdp { get; init; }
}

/// <summary>全进程聚合流量摘要。</summary>
public sealed class TrafficSummary
{
    public long TotalBytesSent { get; init; }
    public long TotalBytesRecv { get; init; }
    public long TotalPacketsSent { get; init; }
    public long TotalPacketsRecv { get; init; }
    public long TotalBytes => TotalBytesSent + TotalBytesRecv;
}

/// <summary>DNS 查询记录。</summary>
public sealed class DnsQueryRecord
{
    public DateTime Timestamp { get; init; }
    public int Pid { get; init; }
    public string QueryName { get; init; } = "";
    public string QueryType { get; init; } = "";
    public string QueryResults { get; set; } = "";
    public string EventName { get; init; } = "";
}
