using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;

namespace DesktopAssistant.Services;

/// <summary>
/// Win10 1803+ / Win11 窗口 Acrylic 模糊（SetWindowCompositionAttribute）。
/// </summary>
public static class WindowBackdropHelper
{
    private enum WindowCompositionAttribute
    {
        WcaAccentPolicy = 19
    }

    private enum AccentState
    {
        AccentDisabled = 0,
        AccentEnableGradient = 1,
        AccentEnableTransparentGradient = 2,
        AccentEnableBlurBehind = 3,
        AccentEnableAcrylicBlurBehind = 4
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct AccentPolicy
    {
        public int AccentState;
        public int AccentFlags;
        public int GradientColor;
        public int AnimationId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct WindowCompositionAttributeData
    {
        public WindowCompositionAttribute Attribute;
        public IntPtr Data;
        public int SizeOfData;
    }

    [DllImport("user32.dll")]
    private static extern int SetWindowCompositionAttribute(IntPtr hwnd, ref WindowCompositionAttributeData data);

    /// <summary>
    /// 为 WPF 窗口启用 Acrylic。ABGR 色调，默认浅灰蓝半透明。
    /// </summary>
    public static bool TryEnableAcrylic(Window window, uint tintAbgr = 0xCCF2F6FA)
    {
        if (!OperatingSystem.IsWindowsVersionAtLeast(10, 0, 17763))
            return false;

        void Apply(object? _, EventArgs __)
        {
            var hwnd = new WindowInteropHelper(window).Handle;
            if (hwnd == IntPtr.Zero)
                return;

            var accent = new AccentPolicy
            {
                AccentState = (int)AccentState.AccentEnableAcrylicBlurBehind,
                AccentFlags = 2,
                GradientColor = unchecked((int)tintAbgr)
            };

            var accentSize = Marshal.SizeOf<AccentPolicy>();
            var accentPtr = Marshal.AllocHGlobal(accentSize);
            try
            {
                Marshal.StructureToPtr(accent, accentPtr, false);
                var data = new WindowCompositionAttributeData
                {
                    Attribute = WindowCompositionAttribute.WcaAccentPolicy,
                    Data = accentPtr,
                    SizeOfData = accentSize
                };
                SetWindowCompositionAttribute(hwnd, ref data);
            }
            finally
            {
                Marshal.FreeHGlobal(accentPtr);
            }
        }

        if (window.IsLoaded)
            Apply(null, EventArgs.Empty);
        else
            window.SourceInitialized += Apply;

        return true;
    }
}
