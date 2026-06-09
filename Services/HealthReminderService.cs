using System.Runtime.InteropServices;
using System.Windows.Threading;

namespace DesktopAssistant.Services;

/// <summary>
/// 健康提醒服务：定时提醒喝水，久坐超时提醒起身运动。
/// 通过 Windows GetLastInputInfo 检测用户是否在持续操作电脑。
/// </summary>
public sealed class HealthReminderService
{
    [DllImport("user32.dll")]
    private static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);

    [StructLayout(LayoutKind.Sequential)]
    private struct LASTINPUTINFO
    {
        public uint cbSize;
        public uint dwTime;
    }

    private readonly DispatcherTimer _timer;
    private DateTime _lastWaterReminder;
    private DateTime _continuousUseStart;
    private DateTime _lastMovementReminder;
    private bool _wasIdle;

    /// <summary>喝水提醒间隔（分钟）。</summary>
    public int WaterIntervalMinutes { get; set; } = 45;

    /// <summary>久坐提醒阈值（分钟）。</summary>
    public int SedentaryThresholdMinutes { get; set; } = 60;

    /// <summary>判定用户空闲的时长（秒）——超过此值认为用户离开了。</summary>
    public int IdleThresholdSeconds { get; set; } = 300; // 5 分钟

    /// <summary>是否启用。</summary>
    public bool Enabled { get; set; }

    /// <summary>当需要弹出提醒时触发。</summary>
    public event Action<HealthReminderType>? ReminderTriggered;

    public HealthReminderService()
    {
        _timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(30) };
        _timer.Tick += OnTick;
        ResetTimestamps();
    }

    public void Start()
    {
        if (!Enabled) return;
        ResetTimestamps();
        _timer.Start();
    }

    public void Stop() => _timer.Stop();

    public void Restart()
    {
        Stop();
        Start();
    }

    /// <summary>用户确认喝水后调用，重置喝水计时。</summary>
    public void AcknowledgeWater() => _lastWaterReminder = DateTime.Now;

    /// <summary>用户确认运动后调用，重置久坐计时。</summary>
    public void AcknowledgeMovement()
    {
        _lastMovementReminder = DateTime.Now;
        _continuousUseStart = DateTime.Now;
    }

    private void ResetTimestamps()
    {
        var now = DateTime.Now;
        _lastWaterReminder = now;
        _continuousUseStart = now;
        _lastMovementReminder = now;
        _wasIdle = false;
    }

    private void OnTick(object? sender, EventArgs e)
    {
        if (!Enabled) return;

        var idleSeconds = GetIdleSeconds();
        var isIdle = idleSeconds > IdleThresholdSeconds;

        // 用户从空闲恢复操作 → 重置久坐起点
        if (_wasIdle && !isIdle)
            _continuousUseStart = DateTime.Now;

        _wasIdle = isIdle;

        // 如果用户当前空闲，不提醒
        if (isIdle) return;

        var now = DateTime.Now;

        // 喝水提醒
        if ((now - _lastWaterReminder).TotalMinutes >= WaterIntervalMinutes)
        {
            _lastWaterReminder = now;
            ReminderTriggered?.Invoke(HealthReminderType.DrinkWater);
            return; // 一次只弹一个
        }

        // 久坐提醒
        if ((now - _continuousUseStart).TotalMinutes >= SedentaryThresholdMinutes
            && (now - _lastMovementReminder).TotalMinutes >= SedentaryThresholdMinutes)
        {
            _lastMovementReminder = now;
            ReminderTriggered?.Invoke(HealthReminderType.StandUp);
        }
    }

    private static double GetIdleSeconds()
    {
        var info = new LASTINPUTINFO { cbSize = (uint)Marshal.SizeOf<LASTINPUTINFO>() };
        if (!GetLastInputInfo(ref info))
            return 0;
        return (Environment.TickCount - (int)info.dwTime) / 1000.0;
    }
}

public enum HealthReminderType
{
    DrinkWater,
    StandUp
}
