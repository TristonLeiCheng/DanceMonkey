using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace DanceMonkey.Cli;

/// <summary>
/// 让老派 Windows conhost 正确显示中文（及其它非 ASCII 字形）。
/// <para>
/// 症状：双击 <c>dancemonkey.exe</c> 启动后中文显示为 □（tofu）。
/// 原因：conhost 当前字体（Consolas / Raster Fonts）不包含 CJK 字形；
///   UTF-8 字节已经正确输出，但字体不渲染 → 回退成 □。
/// </para>
/// <para>
/// 本类在启动时尝试把控制台字体改成系统里存在的 CJK 字体。
/// 在 Windows Terminal 下自动跳过（WT 有自己的字体链，CJK 本就正常）。
/// </para>
/// </summary>
[SupportedOSPlatform("windows")]
internal static class ConsoleHostSupport
{
    public static void TryEnableCjkFont()
    {
        // Windows Terminal：设置环境变量 WT_SESSION，直接跳过
        if (!string.IsNullOrEmpty(Environment.GetEnvironmentVariable("WT_SESSION")))
            return;

        // 现代 conhost（ConPTY，wt、终端 tabs）通常也支持，但宁可多写一次设置 —— 设置失败不会影响渲染
        try
        {
            var stdout = GetStdHandle(STD_OUTPUT_HANDLE);
            if (stdout == IntPtr.Zero || stdout == new IntPtr(-1)) return;

            var info = new CONSOLE_FONT_INFO_EX
            {
                cbSize = (uint)Marshal.SizeOf<CONSOLE_FONT_INFO_EX>(),
            };
            if (!GetCurrentConsoleFontEx(stdout, false, ref info))
                return;

            var current = info.FaceName ?? "";

            // 已经是 CJK 能覆盖的字体就不折腾
            if (IsFontLikelyCjkCapable(current))
                return;

            // 依次尝试系统上常见的、含中文字形的 TrueType 等宽字体
            string[] candidates =
            {
                "NSimSun",        // 新宋体：中文 Windows 默认自带
                "SimSun-ExtB",    // 宋体-扩展 B
                "MS Gothic",      // 日文 Windows 常驻，含大量 CJK
                "FangSong",       // 仿宋
                "KaiTi",          // 楷体
                "Microsoft YaHei",// 非严格等宽，但字形覆盖最广；最后兜底
            };

            foreach (var face in candidates)
            {
                var next = info;
                next.FaceName = face;
                // 不动 nFont / dwFontSize，尽量保留用户当前字号
                if (SetCurrentConsoleFontEx(stdout, false, ref next))
                    return;
            }
        }
        catch
        {
            // 任何异常都悄悄吞掉，别让字体设置挡住主流程
        }
    }

    private static bool IsFontLikelyCjkCapable(string faceName)
    {
        if (string.IsNullOrEmpty(faceName)) return false;
        string[] known =
        {
            "NSimSun", "SimSun", "SimHei", "MingLiU", "PMingLiU",
            "MS Gothic", "MS Mincho", "Yu Gothic", "Meiryo",
            "Malgun Gothic", "Gulim", "Dotum",
            "Microsoft YaHei", "Microsoft JhengHei",
            "FangSong", "KaiTi",
        };
        foreach (var k in known)
            if (faceName.StartsWith(k, StringComparison.OrdinalIgnoreCase))
                return true;
        return false;
    }

    // ═══════════ Win32 ═══════════

    private const int STD_OUTPUT_HANDLE = -11;

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int nStdHandle);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetCurrentConsoleFontEx(
        IntPtr hConsoleOutput,
        [MarshalAs(UnmanagedType.Bool)] bool bMaximumWindow,
        ref CONSOLE_FONT_INFO_EX lpConsoleCurrentFontEx);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetCurrentConsoleFontEx(
        IntPtr hConsoleOutput,
        [MarshalAs(UnmanagedType.Bool)] bool bMaximumWindow,
        ref CONSOLE_FONT_INFO_EX lpConsoleCurrentFontEx);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct CONSOLE_FONT_INFO_EX
    {
        public uint cbSize;
        public uint nFont;
        public COORD dwFontSize;
        public int FontFamily;
        public int FontWeight;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string FaceName;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct COORD
    {
        public short X;
        public short Y;
    }
}
