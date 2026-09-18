using System.Diagnostics;
using System.Net.NetworkInformation;
using System.Runtime.InteropServices;

namespace DesktopAssistant.Services;

public sealed class ResourceSnapshot
{
    public double CpuPercent { get; init; }
    public double MemoryPercent { get; init; }
    public double DiskUsedPercent { get; init; }
    public double DownloadKbps { get; init; }
    public double UploadKbps { get; init; }
}

public sealed class ResourceMonitorService
{
    private TimeSpan _prevCpu;
    private DateTime _prevAtUtc;
    private long _prevRecvBytes;
    private long _prevSentBytes;
    private bool _initialized;

    public ResourceSnapshot Capture()
    {
        var now = DateTime.UtcNow;
        var proc = Process.GetCurrentProcess();
        var cpuNow = proc.TotalProcessorTime;

        var totalRecv = 0L;
        var totalSent = 0L;
        foreach (var ni in NetworkInterface.GetAllNetworkInterfaces())
        {
            if (ni.OperationalStatus != OperationalStatus.Up || ni.NetworkInterfaceType == NetworkInterfaceType.Loopback)
                continue;
            try
            {
                var stats = ni.GetIPv4Statistics();
                totalRecv += stats.BytesReceived;
                totalSent += stats.BytesSent;
            }
            catch
            {
                // ignore adapter-level errors
            }
        }

        if (!_initialized)
        {
            _initialized = true;
            _prevCpu = cpuNow;
            _prevAtUtc = now;
            _prevRecvBytes = totalRecv;
            _prevSentBytes = totalSent;
            return BuildSnapshot(0, 0, 0);
        }

        var elapsed = Math.Max((now - _prevAtUtc).TotalSeconds, 0.1);
        var cpuDelta = (cpuNow - _prevCpu).TotalSeconds;
        var cpu = Math.Clamp(cpuDelta / (elapsed * Environment.ProcessorCount) * 100.0, 0, 100);

        var downKbps = Math.Max(0, (totalRecv - _prevRecvBytes) / 1024d / elapsed);
        var upKbps = Math.Max(0, (totalSent - _prevSentBytes) / 1024d / elapsed);

        _prevCpu = cpuNow;
        _prevAtUtc = now;
        _prevRecvBytes = totalRecv;
        _prevSentBytes = totalSent;

        return BuildSnapshot(cpu, downKbps, upKbps);
    }

    private static ResourceSnapshot BuildSnapshot(double cpuPercent, double downKbps, double upKbps)
    {
        var memPct = GetMemoryPercent();
        var diskPct = GetSystemDiskUsedPercent();
        return new ResourceSnapshot
        {
            CpuPercent = cpuPercent,
            MemoryPercent = memPct,
            DiskUsedPercent = diskPct,
            DownloadKbps = downKbps,
            UploadKbps = upKbps
        };
    }

    private static double GetSystemDiskUsedPercent()
    {
        try
        {
            var root = Path.GetPathRoot(Environment.SystemDirectory);
            if (string.IsNullOrWhiteSpace(root))
                return 0;
            var drive = new DriveInfo(root);
            if (!drive.IsReady || drive.TotalSize <= 0)
                return 0;
            var used = drive.TotalSize - drive.AvailableFreeSpace;
            return Math.Clamp(used * 100.0 / drive.TotalSize, 0, 100);
        }
        catch
        {
            return 0;
        }
    }

    private static double GetMemoryPercent()
    {
        try
        {
            if (!GlobalMemoryStatusEx(out var status) || status.ullTotalPhys == 0)
                return 0;
            var used = status.ullTotalPhys - status.ullAvailPhys;
            return Math.Clamp(used * 100.0 / status.ullTotalPhys, 0, 100);
        }
        catch
        {
            return 0;
        }
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    private struct MEMORYSTATUSEX
    {
        public uint dwLength;
        public uint dwMemoryLoad;
        public ulong ullTotalPhys;
        public ulong ullAvailPhys;
        public ulong ullTotalPageFile;
        public ulong ullAvailPageFile;
        public ulong ullTotalVirtual;
        public ulong ullAvailVirtual;
        public ulong ullAvailExtendedVirtual;
    }

    private static bool GlobalMemoryStatusEx(out MEMORYSTATUSEX status)
    {
        status = new MEMORYSTATUSEX();
        status.dwLength = (uint)Marshal.SizeOf(typeof(MEMORYSTATUSEX));
        return GlobalMemoryStatusExNative(out status);
    }

    [DllImport("kernel32.dll", EntryPoint = "GlobalMemoryStatusEx", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern bool GlobalMemoryStatusExNative(out MEMORYSTATUSEX lpBuffer);
}
