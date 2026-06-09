using System.Runtime.InteropServices;
using System.Windows.Input;
using System.Windows.Interop;

namespace DesktopAssistant.Controllers;

public sealed class GlobalHotkeyController : IDisposable
{
    [DllImport("user32.dll")]
    private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

    [DllImport("user32.dll")]
    private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    private const int WM_HOTKEY = 0x0312;

    private const uint MOD_ALT = 0x0001;
    private const uint MOD_CTRL = 0x0002;
    private const uint MOD_SHIFT = 0x0004;
    private const uint MOD_WIN = 0x0008;

    private readonly Func<(string GlobalChat, string QuickShot, string RegionShot)> _getHotkeyStrings;
    private readonly Action _onGlobalChat;
    private readonly Action _onQuickScreenshot;
    private readonly Action _onRegionScreenshot;

    private HwndSource? _source;
    private IntPtr _hwnd;

    public const int HotkeyId_GlobalChat = 9001;
    public const int HotkeyId_QuickScreenshot = 9002;
    public const int HotkeyId_RegionScreenshot = 9003;

    public GlobalHotkeyController(
        Func<(string GlobalChat, string QuickShot, string RegionShot)> getHotkeyStrings,
        Action onGlobalChat,
        Action onQuickScreenshot,
        Action onRegionScreenshot)
    {
        _getHotkeyStrings = getHotkeyStrings;
        _onGlobalChat = onGlobalChat;
        _onQuickScreenshot = onQuickScreenshot;
        _onRegionScreenshot = onRegionScreenshot;
    }

    public void Attach(WindowInteropHelper window)
    {
        _hwnd = window.Handle;
        if (_hwnd == IntPtr.Zero)
            return;

        _source = HwndSource.FromHwnd(_hwnd);
    }

    public void Register()
    {
        if (_hwnd == IntPtr.Zero)
            return;

        // Unregister previous
        UnregisterHotKey(_hwnd, HotkeyId_GlobalChat);
        UnregisterHotKey(_hwnd, HotkeyId_QuickScreenshot);
        UnregisterHotKey(_hwnd, HotkeyId_RegionScreenshot);

        var (globalChat, quickShot, regionShot) = _getHotkeyStrings();

        if (TryParseHotkey(globalChat, out var modifiers, out var vk))
            RegisterHotKey(_hwnd, HotkeyId_GlobalChat, modifiers, vk);

        if (TryParseHotkey(quickShot, out var quickModifiers, out var quickVk))
            RegisterHotKey(_hwnd, HotkeyId_QuickScreenshot, quickModifiers, quickVk);

        if (TryParseHotkey(regionShot, out var regionModifiers, out var regionVk))
            RegisterHotKey(_hwnd, HotkeyId_RegionScreenshot, regionModifiers, regionVk);
    }

    public void Unregister()
    {
        if (_hwnd == IntPtr.Zero)
            return;

        UnregisterHotKey(_hwnd, HotkeyId_GlobalChat);
        UnregisterHotKey(_hwnd, HotkeyId_QuickScreenshot);
        UnregisterHotKey(_hwnd, HotkeyId_RegionScreenshot);
    }

    public bool TryHandleWndProc(int msg, IntPtr wParam)
    {
        if (msg != WM_HOTKEY)
            return false;

        var id = wParam.ToInt32();
        if (id == HotkeyId_GlobalChat)
        {
            _onGlobalChat();
            return true;
        }

        if (id == HotkeyId_QuickScreenshot)
        {
            _onQuickScreenshot();
            return true;
        }

        if (id == HotkeyId_RegionScreenshot)
        {
            _onRegionScreenshot();
            return true;
        }

        return false;
    }

    private static bool TryParseHotkey(string hotkey, out uint modifiers, out uint vk)
    {
        modifiers = 0;
        vk = 0;
        if (string.IsNullOrWhiteSpace(hotkey))
            return false;

        var parts = hotkey.Split('+', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        foreach (var part in parts)
        {
            var upper = part.ToUpperInvariant();
            switch (upper)
            {
                case "CTRL":
                case "CONTROL":
                    modifiers |= MOD_CTRL;
                    break;
                case "SHIFT":
                    modifiers |= MOD_SHIFT;
                    break;
                case "ALT":
                    modifiers |= MOD_ALT;
                    break;
                case "WIN":
                case "WINDOWS":
                    modifiers |= MOD_WIN;
                    break;
                default:
                    if (upper.Length == 1 && char.IsLetterOrDigit(upper[0]))
                    {
                        // A-Z, 0-9 VK codes match ASCII
                        vk = (uint)upper[0];
                    }
                    else if (Enum.TryParse<Key>(part, ignoreCase: true, out var key))
                    {
                        vk = (uint)KeyInterop.VirtualKeyFromKey(key);
                    }
                    break;
            }
        }

        return modifiers != 0 && vk != 0;
    }

    public void Dispose()
    {
        try { Unregister(); } catch { /* best effort */ }
        _source = null;
        _hwnd = IntPtr.Zero;
    }
}

