using System.Net;
using System.Runtime.InteropServices;
using DesktopAssistant.Models;

namespace DesktopAssistant.Services;

/// <summary>
/// 按进程枚举 TCP/UDP 网络连接（通过 iphlpapi.dll P/Invoke，无需管理员权限）。
/// 每次调用 <see cref="CaptureConnections"/> 返回当前快照。
/// </summary>
public static class ProcessNetworkCaptureService
{
    /// <summary>获取指定 PID 集合的所有 TCP + UDP 连接快照。</summary>
    public static List<ProcessConnectionRow> CaptureConnections(HashSet<int> targetPids)
    {
        var result = new List<ProcessConnectionRow>();
        result.AddRange(GetTcpConnections(targetPids));
        result.AddRange(GetUdpListeners(targetPids));
        return result;
    }

    /// <summary>对连接列表做一次反向 DNS 解析（限 8 秒超时）。</summary>
    public static async Task ResolveHostNamesAsync(IEnumerable<ProcessConnectionRow> connections, CancellationToken ct)
    {
        var uniqueIps = connections
            .Select(c => c.RemoteEndPoint.Address)
            .Where(a => !IPAddress.IsLoopback(a) && !a.Equals(IPAddress.Any) && !a.Equals(IPAddress.IPv6Any))
            .Distinct()
            .ToList();

        var cache = new Dictionary<IPAddress, string>();
        foreach (var ip in uniqueIps)
        {
            if (ct.IsCancellationRequested) break;
            try
            {
                var entry = await Dns.GetHostEntryAsync(ip).WaitAsync(TimeSpan.FromSeconds(2), ct).ConfigureAwait(false);
                if (!string.IsNullOrEmpty(entry.HostName))
                    cache[ip] = entry.HostName;
            }
            catch { }
        }

        foreach (var conn in connections)
        {
            if (cache.TryGetValue(conn.RemoteEndPoint.Address, out var host))
                conn.RemoteHostName = host;
        }
    }

    #region TCP (GetExtendedTcpTable)

    private static List<ProcessConnectionRow> GetTcpConnections(HashSet<int> pids)
    {
        var result = new List<ProcessConnectionRow>();
        var table = GetExtendedTcpTableBytes();
        if (table == null) return result;

        int numEntries = BitConverter.ToInt32(table, 0);
        var rowSize = Marshal.SizeOf<MIB_TCPROW_OWNER_PID>();
        var offset = 4;

        for (int i = 0; i < numEntries && offset + rowSize <= table.Length; i++)
        {
            var handle = GCHandle.Alloc(table, GCHandleType.Pinned);
            try
            {
                var row = Marshal.PtrToStructure<MIB_TCPROW_OWNER_PID>(handle.AddrOfPinnedObject() + offset);
                if (pids.Contains(row.owningPid))
                {
                    string procName = "";
                    try { procName = System.Diagnostics.Process.GetProcessById(row.owningPid).ProcessName; } catch { }

                    result.Add(new ProcessConnectionRow
                    {
                        OwningPid = row.owningPid,
                        ProcessName = procName,
                        Protocol = "TCP",
                        LocalEndPoint = new IPEndPoint(row.localAddr, (ushort)IPAddress.NetworkToHostOrder((short)row.localPort)),
                        RemoteEndPoint = new IPEndPoint(row.remoteAddr, (ushort)IPAddress.NetworkToHostOrder((short)row.remotePort)),
                        State = MapTcpState(row.state),
                    });
                }
            }
            finally
            {
                handle.Free();
            }
            offset += rowSize;
        }
        return result;
    }

    private static byte[]? GetExtendedTcpTableBytes()
    {
        int size = 0;
        // 第一次调用获取所需缓冲区大小
        GetExtendedTcpTable(IntPtr.Zero, ref size, true, AF_INET, TCP_TABLE_CLASS.TCP_TABLE_OWNER_PID_ALL, 0);
        var buffer = new byte[size];
        var handle = GCHandle.Alloc(buffer, GCHandleType.Pinned);
        try
        {
            int ret = GetExtendedTcpTable(handle.AddrOfPinnedObject(), ref size, true, AF_INET, TCP_TABLE_CLASS.TCP_TABLE_OWNER_PID_ALL, 0);
            return ret == 0 ? buffer : null;
        }
        finally
        {
            handle.Free();
        }
    }

    #endregion

    #region UDP (GetExtendedUdpTable)

    private static List<ProcessConnectionRow> GetUdpListeners(HashSet<int> pids)
    {
        var result = new List<ProcessConnectionRow>();
        var table = GetExtendedUdpTableBytes();
        if (table == null) return result;

        int numEntries = BitConverter.ToInt32(table, 0);
        var rowSize = Marshal.SizeOf<MIB_UDPROW_OWNER_PID>();
        var offset = 4;

        for (int i = 0; i < numEntries && offset + rowSize <= table.Length; i++)
        {
            var handle = GCHandle.Alloc(table, GCHandleType.Pinned);
            try
            {
                var row = Marshal.PtrToStructure<MIB_UDPROW_OWNER_PID>(handle.AddrOfPinnedObject() + offset);
                if (pids.Contains(row.owningPid))
                {
                    string procName = "";
                    try { procName = System.Diagnostics.Process.GetProcessById(row.owningPid).ProcessName; } catch { }

                    result.Add(new ProcessConnectionRow
                    {
                        OwningPid = row.owningPid,
                        ProcessName = procName,
                        Protocol = "UDP",
                        LocalEndPoint = new IPEndPoint(row.localAddr, (ushort)IPAddress.NetworkToHostOrder((short)row.localPort)),
                        RemoteEndPoint = new IPEndPoint(IPAddress.Any, 0),
                        State = "LISTENING",
                    });
                }
            }
            finally
            {
                handle.Free();
            }
            offset += rowSize;
        }
        return result;
    }

    private static byte[]? GetExtendedUdpTableBytes()
    {
        int size = 0;
        GetExtendedUdpTable(IntPtr.Zero, ref size, true, AF_INET, UDP_TABLE_CLASS.UDP_TABLE_OWNER_PID, 0);
        var buffer = new byte[size];
        var handle = GCHandle.Alloc(buffer, GCHandleType.Pinned);
        try
        {
            int ret = GetExtendedUdpTable(handle.AddrOfPinnedObject(), ref size, true, AF_INET, UDP_TABLE_CLASS.UDP_TABLE_OWNER_PID, 0);
            return ret == 0 ? buffer : null;
        }
        finally
        {
            handle.Free();
        }
    }

    #endregion

    #region P/Invoke

    private const int AF_INET = 2;

    [DllImport("iphlpapi.dll", SetLastError = true)]
    private static extern int GetExtendedTcpTable(IntPtr pTcpTable, ref int dwOutBufLen, bool sort, int ipVersion, TCP_TABLE_CLASS tableClass, int reserved);

    [DllImport("iphlpapi.dll", SetLastError = true)]
    private static extern int GetExtendedUdpTable(IntPtr pUdpTable, ref int dwOutBufLen, bool sort, int ipVersion, UDP_TABLE_CLASS tableClass, int reserved);

    private enum TCP_TABLE_CLASS
    {
        TCP_TABLE_BASIC_LISTENER,
        TCP_TABLE_BASIC_CONNECTIONS,
        TCP_TABLE_BASIC_ALL,
        TCP_TABLE_OWNER_PID_LISTENER,
        TCP_TABLE_OWNER_PID_CONNECTIONS,
        TCP_TABLE_OWNER_PID_ALL,
        TCP_TABLE_OWNER_MODULE_LISTENER,
        TCP_TABLE_OWNER_MODULE_CONNECTIONS,
        TCP_TABLE_OWNER_MODULE_ALL
    }

    private enum UDP_TABLE_CLASS
    {
        UDP_TABLE_BASIC,
        UDP_TABLE_OWNER_PID,
        UDP_TABLE_OWNER_MODULE
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MIB_TCPROW_OWNER_PID
    {
        public uint state;
        public uint localAddr;
        public int localPort;
        public uint remoteAddr;
        public int remotePort;
        public int owningPid;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MIB_UDPROW_OWNER_PID
    {
        public uint localAddr;
        public int localPort;
        public int owningPid;
    }

    private static string MapTcpState(uint state) => state switch
    {
        1 => "CLOSED",
        2 => "LISTEN",
        3 => "SYN_SENT",
        4 => "SYN_RCVD",
        5 => "ESTABLISHED",
        6 => "FIN_WAIT1",
        7 => "FIN_WAIT2",
        8 => "CLOSE_WAIT",
        9 => "CLOSING",
        10 => "LAST_ACK",
        11 => "TIME_WAIT",
        12 => "DELETE_TCB",
        _ => $"UNKNOWN({state})"
    };

    #endregion
}
