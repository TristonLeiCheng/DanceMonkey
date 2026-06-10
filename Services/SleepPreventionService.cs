using System.Runtime.InteropServices;
using System.Threading;

namespace DesktopAssistant.Services;

/// <summary>
/// 在宠物模式的防休眠开关开启时，通过 SetThreadExecutionState 同时阻止：
/// <list type="bullet">
///   <item>系统因空闲进入睡眠 / 休眠（ES_SYSTEM_REQUIRED）</item>
///   <item>显示器因空闲关闭（ES_DISPLAY_REQUIRED）——关键：显示器关闭会触发锁屏</item>
/// </list>
/// 同时启动心跳定时器每 30 秒重置一次系统空闲计时器，防止部分 Windows 策略或更新绕过 ES_CONTINUOUS。
/// 合盖 / 手动睡眠 / 强制锁屏（Win+L）不受影响，属操作系统行为。
/// </summary>
public static class SleepPreventionService
{
    // ── Win32 标志 ──
    private const uint ES_CONTINUOUS      = 0x80000000u;
    private const uint ES_SYSTEM_REQUIRED = 0x00000001u;
    /// <summary>阻止显示器因空闲关闭；防锁屏的关键标志。</summary>
    private const uint ES_DISPLAY_REQUIRED = 0x00000002u;

    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern uint SetThreadExecutionState(uint esFlags);

    // ── 心跳定时器（每 30 秒重置系统空闲计时器，双重保障） ──
    private static Timer? _heartbeatTimer;
    private static volatile bool _enabled;

    /// <summary>
    /// 开启或关闭防睡眠 + 防锁屏。
    /// <para>开启：立即设置 ES_CONTINUOUS 持久标志，并启动 30 秒心跳刷新。</para>
    /// <para>关闭：停止心跳，清除 ES_CONTINUOUS，恢复系统默认电源策略。</para>
    /// </summary>
    public static void SetEnabled(bool preventSleepAndLock)
    {
        _enabled = preventSleepAndLock;

        if (preventSleepAndLock)
        {
            // 1. 立即设置持久执行状态（ES_CONTINUOUS 使其不因线程切换而失效）
            SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED);

            // 2. 启动心跳（重用已有实例，避免重复创建）
            if (_heartbeatTimer == null)
            {
                _heartbeatTimer = new Timer(
                    _ =>
                    {
                        // 不带 ES_CONTINUOUS：每次调用重置系统空闲计时器
                        if (_enabled)
                            SetThreadExecutionState(ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED);
                    },
                    state: null,
                    dueTime: TimeSpan.FromSeconds(30),
                    period: TimeSpan.FromSeconds(30));
            }
        }
        else
        {
            // 停止心跳
            _heartbeatTimer?.Dispose();
            _heartbeatTimer = null;

            // 清除持久标志，恢复系统默认（ES_CONTINUOUS 单独调用 = 清除所有持久位）
            SetThreadExecutionState(ES_CONTINUOUS);
        }
    }
}
