using System.Runtime.InteropServices;

namespace DesktopAssistant.Services;

/// <summary>
/// 读取 Windows 桌面上图标的屏幕位置，支持 Progman / WorkerW 两种桌面宿主。
/// 通过跨进程读取 SysListView32 的 LVM_GETITEMRECT 获取每个图标的 bounds。
/// </summary>
public static class DesktopIconService
{
    // ── P/Invoke ──

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    private static extern IntPtr FindWindow(string lpClassName, string? lpWindowName);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    private static extern IntPtr FindWindowEx(IntPtr hwndParent, IntPtr hwndChildAfter, string? lpszClass, string? lpszWindow);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ClientToScreen(IntPtr hWnd, ref POINT lpPoint);

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left, Top, Right, Bottom; }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr VirtualAllocEx(IntPtr hProcess, IntPtr lpAddress, IntPtr dwSize,
        uint flAllocationType, uint flProtect);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool VirtualFreeEx(IntPtr hProcess, IntPtr lpAddress, IntPtr dwSize, uint dwFreeType);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ReadProcessMemory(IntPtr hProcess, IntPtr lpBaseAddress, [Out] byte[] lpBuffer,
        IntPtr nSize, out IntPtr lpNumberOfBytesRead);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WriteProcessMemory(IntPtr hProcess, IntPtr lpBaseAddress, byte[] lpBuffer,
        IntPtr nSize, out IntPtr lpNumberOfBytesWritten);

    private const uint PROCESS_VM_OPERATION = 0x0008;
    private const uint PROCESS_VM_READ = 0x0010;
    private const uint PROCESS_VM_WRITE = 0x0020;
    private const uint PROCESS_QUERY_INFORMATION = 0x0400;
    private const uint MEM_COMMIT = 0x1000;
    private const uint MEM_RESERVE = 0x2000;
    private const uint MEM_RELEASE = 0x8000;
    private const uint PAGE_READWRITE = 0x04;

    private const uint LVM_FIRST = 0x1000;
    private const uint LVM_GETITEMCOUNT = LVM_FIRST + 4;
    private const uint LVM_GETITEMRECT = LVM_FIRST + 14;
    private const int LVIR_BOUNDS = 0;

    // ── Public API ──

    /// <summary>
    /// 返回桌面图标的屏幕像素坐标矩形列表（Screen，非 DIP）。若读不到返回空列表。
    /// </summary>
    public static List<System.Windows.Rect> GetDesktopIconScreenRects()
    {
        var result = new List<System.Windows.Rect>();
        var lv = FindDesktopListView();
        if (lv == IntPtr.Zero) return result;

        int count = (int)SendMessage(lv, LVM_GETITEMCOUNT, IntPtr.Zero, IntPtr.Zero);
        if (count <= 0) return result;

        GetWindowThreadProcessId(lv, out uint pid);
        if (pid == 0) return result;

        IntPtr hProc = OpenProcess(
            PROCESS_VM_OPERATION | PROCESS_VM_READ | PROCESS_VM_WRITE | PROCESS_QUERY_INFORMATION,
            false, pid);
        if (hProc == IntPtr.Zero) return result;

        try
        {
            int rectSize = Marshal.SizeOf<RECT>();
            IntPtr remoteBuffer = VirtualAllocEx(hProc, IntPtr.Zero, (IntPtr)rectSize,
                MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
            if (remoteBuffer == IntPtr.Zero) return result;

            try
            {
                for (int i = 0; i < count; i++)
                {
                    // LVM_GETITEMRECT 要求 rect.left 预置 LVIR_BOUNDS(0) 作为子矩形代码
                    var rectIn = new byte[rectSize];
                    rectIn[0] = (byte)LVIR_BOUNDS;
                    if (!WriteProcessMemory(hProc, remoteBuffer, rectIn, (IntPtr)rectSize, out _))
                        continue;

                    var r = SendMessage(lv, LVM_GETITEMRECT, (IntPtr)i, remoteBuffer);
                    if (r == IntPtr.Zero) continue;

                    var buf = new byte[rectSize];
                    if (!ReadProcessMemory(hProc, remoteBuffer, buf, (IntPtr)rectSize, out _))
                        continue;

                    int left = BitConverter.ToInt32(buf, 0);
                    int top = BitConverter.ToInt32(buf, 4);
                    int right = BitConverter.ToInt32(buf, 8);
                    int bottom = BitConverter.ToInt32(buf, 12);

                    var ptLT = new POINT { X = left, Y = top };
                    ClientToScreen(lv, ref ptLT);
                    int w = right - left;
                    int h = bottom - top;
                    if (w <= 0 || h <= 0) continue;

                    result.Add(new System.Windows.Rect(ptLT.X, ptLT.Y, w, h));
                }
            }
            finally
            {
                VirtualFreeEx(hProc, remoteBuffer, IntPtr.Zero, MEM_RELEASE);
            }
        }
        finally
        {
            CloseHandle(hProc);
        }

        return result;
    }

    // ── Internal helpers ──

    private static IntPtr FindDesktopListView()
    {
        // Path 1: Progman → SHELLDLL_DefView → SysListView32
        var progman = FindWindow("Progman", null);
        if (progman != IntPtr.Zero)
        {
            var shellView = FindWindowEx(progman, IntPtr.Zero, "SHELLDLL_DefView", null);
            if (shellView != IntPtr.Zero)
            {
                var lv = FindWindowEx(shellView, IntPtr.Zero, "SysListView32", null);
                if (lv != IntPtr.Zero) return lv;
            }
        }

        // Path 2: 遍历 WorkerW（Win10/11 开启桌面壁纸动态效果时 SHELLDLL_DefView 挂在 WorkerW 上）
        IntPtr workerw = IntPtr.Zero;
        while ((workerw = FindWindowEx(IntPtr.Zero, workerw, "WorkerW", null)) != IntPtr.Zero)
        {
            var sv = FindWindowEx(workerw, IntPtr.Zero, "SHELLDLL_DefView", null);
            if (sv != IntPtr.Zero)
            {
                var lv = FindWindowEx(sv, IntPtr.Zero, "SysListView32", null);
                if (lv != IntPtr.Zero) return lv;
            }
        }

        return IntPtr.Zero;
    }
}
