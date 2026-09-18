using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Threading;
using DesktopAssistant.Services;
using FormsScreen = System.Windows.Forms.Screen;

namespace DesktopAssistant;

/// <summary>
/// 桌面全屏覆盖的舞蹈家小人：可在整个桌面行走、跳舞、翻跟头，并识别桌面图标进行
/// 攀爬 / 站立表演 / 跳下等互动。窗口 Topmost + 鼠标穿透，不影响正常使用。
/// </summary>
public partial class DancerOverlayWindow : Window
{
    // ═══════ Win32（鼠标穿透） ═══════

    private const int GWL_EXSTYLE = -20;
    private const int WS_EX_TRANSPARENT = 0x00000020;
    private const int WS_EX_LAYERED     = 0x00080000;
    private const int WS_EX_NOACTIVATE  = 0x08000000;
    private const int WS_EX_TOOLWINDOW  = 0x00000080;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern int GetWindowLong(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);

    // ═══════ 世界坐标（DIP） ═══════

    private double _worldX = 200;          // 角色左上角世界 X（DIP）
    private double _worldY;                // 角色左上角世界 Y（DIP）
    private double _groundY;               // 脚接触的世界 Y（DIP）
    private double _screenWidthDip;
    private double _screenHeightDip;

    private int _facing = 1;               // 1 右, -1 左

    // 角色在 XAML 中大约 70 × 96 DIP（头+身+腿）
    private const double CharWidth = 70;
    private const double CharHeight = 96;

    // ═══════ 状态机 ═══════

    private enum DancerMotion { Idle, Walk, Dance, Flip, ApproachIcon, Climb, OnIcon, JumpOff, Sleep, Eat, React, Greet }
    private DancerMotion _motion = DancerMotion.Idle;
    private Storyboard? _activeSb;

    // ═══════ 桌面宠物模式 ═══════

    private bool _petModeEnabled;
    private int _mood = 80;                    // 0-100，影响行为权重
    private DispatcherTimer? _moodDecayTimer;
    private DispatcherTimer? _bubbleHideTimer;

    private static readonly string[] _reactMessages =
        ["嘿！", "哦耶！", "你好呀~", "(＾▽＾)", "嗷呜！", "再戳一下？", "哈哈哈", "别动我！"];

    // 桌面图标（屏幕像素 → 转 DIP）
    private readonly DispatcherTimer _iconRefreshTimer;
    private readonly Random _rng = new();
    private List<Rect> _iconRectsDip = new();
    private Rect? _targetIcon;
    private bool _closed;

    /// <summary>是否已关闭（避免空引用访问）。</summary>
    public bool IsClosedSafe => _closed;

    /// <summary>当前识别到的桌面图标个数。</summary>
    public int DesktopIconCount => _iconRectsDip.Count;

    /// <summary>由外部触发的一次桌面图标刷新。</summary>
    public void ReloadDesktopIcons() => RefreshDesktopIcons();

    // 设备 DPI 系数
    private double _dpiScaleX = 1.0, _dpiScaleY = 1.0;

    public DancerOverlayWindow()
    {
        InitializeComponent();

        _iconRefreshTimer = new DispatcherTimer
        {
            Interval = TimeSpan.FromSeconds(5)
        };
        _iconRefreshTimer.Tick += (_, _) => RefreshDesktopIcons();

        Loaded += OnLoaded;
    }

    private void OnLoaded(object sender, RoutedEventArgs e)
    {
        ApplyClickThrough();
        LayoutToPrimaryScreen();

        RefreshDesktopIcons();
        _iconRefreshTimer.Start();

        // 初始状态：从屏幕左下角开始走
        _worldX = 120;
        _worldY = _groundY;
        _facing = 1;
        UpdateRootPosition();
        UpdateFacing();
        ResetPose();
        BeginRandomMotion();
    }

    protected override void OnSourceInitialized(EventArgs e)
    {
        base.OnSourceInitialized(e);
        ApplyClickThrough();
    }

    private void ApplyClickThrough()
    {
        IsHitTestVisible = false;
        var hwnd = new WindowInteropHelper(this).Handle;
        if (hwnd == IntPtr.Zero) return;
        int ex = GetWindowLong(hwnd, GWL_EXSTYLE);
        ex |= WS_EX_TRANSPARENT | WS_EX_LAYERED | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW;
        SetWindowLong(hwnd, GWL_EXSTYLE, ex);
    }

    // ═══════ 宠物模式 ═══════

    /// <summary>启用桌面宠物模式：允许点击互动，开启情绪衰减系统。</summary>
    public void EnablePetMode()
    {
        _petModeEnabled = true;
        // 恢复 hit-test（AllowsTransparency=True 保证透明像素自然穿透）
        IsHitTestVisible = true;
        var hwnd = new WindowInteropHelper(this).Handle;
        if (hwnd != IntPtr.Zero)
        {
            int ex = GetWindowLong(hwnd, GWL_EXSTYLE);
            ex &= ~WS_EX_TRANSPARENT;
            ex |= WS_EX_LAYERED | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW;
            SetWindowLong(hwnd, GWL_EXSTYLE, ex);
        }
        _mood = 80;
        _moodDecayTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(5) };
        _moodDecayTimer.Tick += (_, _) =>
        {
            _mood = Math.Max(0, _mood - 1);
            UpdateMoodBadge();
        };
        _moodDecayTimer.Start();

        _bubbleHideTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(2.5) };
        _bubbleHideTimer.Tick += (_, _) =>
        {
            HideBubble();
            _bubbleHideTimer!.Stop();
        };
        UpdateMoodBadge();
    }

    /// <summary>禁用桌面宠物模式，恢复全窗口鼠标穿透。</summary>
    public void DisablePetMode()
    {
        _petModeEnabled = false;
        _moodDecayTimer?.Stop();
        _moodDecayTimer = null;
        _bubbleHideTimer?.Stop();
        _bubbleHideTimer = null;
        HideBubble();
        HideZzz();
        ApplyClickThrough();
        if (StateIcon != null) StateIcon.Text = "🎭";
    }

    private void UpdateMoodBadge()
    {
        if (!_petModeEnabled) return;
        string moodIcon = _mood >= 70 ? "😊" : _mood >= 40 ? "😐" : "😢";
        if (StateIcon != null && _motion != DancerMotion.React) StateIcon.Text = moodIcon;
    }

    private void ShowBubble(string message)
    {
        if (SpeechBubble == null || SpeechText == null) return;
        SpeechText.Text = message;
        SpeechBubble.Visibility = Visibility.Visible;
        if (SpeechBubbleTail != null) SpeechBubbleTail.Visibility = Visibility.Visible;
        _bubbleHideTimer?.Stop();
        _bubbleHideTimer?.Start();
    }

    private void HideBubble()
    {
        if (SpeechBubble != null) SpeechBubble.Visibility = Visibility.Collapsed;
        if (SpeechBubbleTail != null) SpeechBubbleTail.Visibility = Visibility.Collapsed;
    }

    private void ShowZzz()
    {
        if (ZzzLabel != null) ZzzLabel.Visibility = Visibility.Visible;
    }

    private void HideZzz()
    {
        if (ZzzLabel != null) ZzzLabel.Visibility = Visibility.Collapsed;
    }

    // ═══════ 动物皮肤 ═══════

    /// <summary>切换宠物外形皮肤。animal: "human" / "cat" / "dog" / "rabbit" / "fox"</summary>
    public void ApplySkin(string? animal)
    {
        var a = string.IsNullOrWhiteSpace(animal) ? "human" : animal.Trim().ToLowerInvariant();

        // 设置肢体颜色
        var (skinHex, shirtHex, pantsHex, armHex, legHex) = a switch
        {
            "cat"    => ("#FFEE9960", "#FFEEaa60", "#FFCC7730", "#FFEE9960", "#FFEE9960"),
            "dog"    => ("#FFC4935A", "#FFB08040", "#FF885520", "#FFC4935A", "#FFC4935A"),
            "rabbit" => ("#FFF8F5F2", "#FFDDEEDD", "#FFBBAACC", "#FFF8F5F2", "#FFF8F5F2"),
            "fox"    => ("#FFCB6030", "#FFAA4010", "#FFAA4010", "#FFCB6030", "#FFCB6030"),
            _        => ("#FFE9CC", "#FF6C8BE8", "#FF3A4B78", "#FFE9CC", "#FFE9CC"),
        };
        SetBodyColors(skinHex, shirtHex, pantsHex, armHex, legHex);

        // 加载/隐藏宠物皮肤头像
        if (PetSkinImage == null) return;
        if (a == "human")
        {
            PetSkinImage.Visibility = Visibility.Collapsed;
        }
        else
        {
            try
            {
                var uri = new Uri($"pack://application:,,,/Resources/PetIcons/pet_{a}.png");
                PetSkinImage.Source     = new System.Windows.Media.Imaging.BitmapImage(uri);
                PetSkinImage.Visibility = Visibility.Visible;
            }
            catch { PetSkinImage.Visibility = Visibility.Collapsed; }
        }
    }

    private void SetBodyColors(string skinHex, string shirtHex, string pantsHex, string armHex, string legHex)
    {
        var skin  = ParseHexColor(skinHex);
        var shirt = ParseHexColor(shirtHex);
        var pants = ParseHexColor(pantsHex);
        var arm   = ParseHexColor(armHex);
        var leg   = ParseHexColor(legHex);

        if (NeckVisual       != null) NeckVisual.Stroke       = new SolidColorBrush(skin);
        if (BodyVisual       != null) BodyVisual.Fill         = new SolidColorBrush(shirt);
        if (LeftUpperArmLine  != null) LeftUpperArmLine.Stroke  = new SolidColorBrush(arm);
        if (LeftForearmLine   != null) LeftForearmLine.Stroke   = new SolidColorBrush(arm);
        if (LeftHandEllipse   != null) { LeftHandEllipse.Fill   = new SolidColorBrush(arm); LeftHandEllipse.Stroke = new SolidColorBrush(arm); }
        if (RightUpperArmLine != null) RightUpperArmLine.Stroke = new SolidColorBrush(arm);
        if (RightForearmLine  != null) RightForearmLine.Stroke  = new SolidColorBrush(arm);
        if (RightHandEllipse  != null) { RightHandEllipse.Fill  = new SolidColorBrush(arm); RightHandEllipse.Stroke = new SolidColorBrush(arm); }
        if (LeftUpperLegLine  != null) LeftUpperLegLine.Stroke  = new SolidColorBrush(pants);
        if (LeftShinLine      != null) LeftShinLine.Stroke      = new SolidColorBrush(leg);
        if (RightUpperLegLine != null) RightUpperLegLine.Stroke = new SolidColorBrush(pants);
        if (RightShinLine     != null) RightShinLine.Stroke     = new SolidColorBrush(leg);
    }

    private static System.Windows.Media.Color ParseHexColor(string hex)
    {
        var h = hex.TrimStart('#');
        if (h.Length == 8)
            return System.Windows.Media.Color.FromArgb(
                Convert.ToByte(h.Substring(0, 2), 16),
                Convert.ToByte(h.Substring(2, 2), 16),
                Convert.ToByte(h.Substring(4, 2), 16),
                Convert.ToByte(h.Substring(6, 2), 16));
        if (h.Length == 6)
            return System.Windows.Media.Color.FromRgb(
                Convert.ToByte(h.Substring(0, 2), 16),
                Convert.ToByte(h.Substring(2, 2), 16),
                Convert.ToByte(h.Substring(4, 2), 16));
        return Colors.White;
    }

    private void DancerRoot_MouseLeftButtonDown(object sender, System.Windows.Input.MouseButtonEventArgs e)
    {
        if (!_petModeEnabled) return;
        e.Handled = true;
        _mood = Math.Min(100, _mood + 20);
        UpdateMoodBadge();
        if (_motion == DancerMotion.Sleep)
        {
            HideZzz();
            ShowBubble("啊！被戳醒了！(>_<)");
            StopStoryboard();
            _worldY = _groundY;
            UpdateRootPosition();
            ResetPose();
            BeginRandomMotion();
        }
        else if (_motion != DancerMotion.React)
        {
            PlayReact();
        }
    }

    // ═══════ 布局 ═══════

    private void LayoutToPrimaryScreen()
    {
        var screen = FormsScreen.PrimaryScreen ?? FormsScreen.AllScreens[0];
        var wa = WpfScreenPlacement.GetWorkingAreaDip(screen);
        Left = wa.Left;
        Top = wa.Top;
        Width = wa.Width;
        Height = wa.Height;

        _screenWidthDip = wa.Width;
        _screenHeightDip = wa.Height;
        // 地面：屏幕底部，留给状态栏一点空间
        _groundY = _screenHeightDip - CharHeight - 20;

        Stage.Width = _screenWidthDip;
        Stage.Height = _screenHeightDip;

        // DPI
        var src = PresentationSource.FromVisual(this);
        if (src?.CompositionTarget != null)
        {
            var m = src.CompositionTarget.TransformFromDevice;
            _dpiScaleX = m.M11;
            _dpiScaleY = m.M22;
        }
    }

    private void UpdateRootPosition()
    {
        if (DancerRoot == null) return;
        Canvas.SetLeft(DancerRoot, _worldX);
        Canvas.SetTop(DancerRoot, _worldY);
        if (DancerShadow != null)
        {
            Canvas.SetLeft(DancerShadow, _worldX);
            Canvas.SetTop(DancerShadow, _groundY + CharHeight - 5);
        }
    }

    private void UpdateFacing()
    {
        if (DancerFacing != null) DancerFacing.ScaleX = _facing;
    }

    private void SetState(string icon, string label, DancerMotion motion)
    {
        _motion = motion;
        if (StateIcon != null) StateIcon.Text = icon;
        if (StateLabel != null) StateLabel.Text = label;
    }

    // ═══════ 桌面图标识别 ═══════

    private void RefreshDesktopIcons()
    {
        try
        {
            var pixels = DesktopIconService.GetDesktopIconScreenRects();
            var wa = this; // window is aligned to screen, Left/Top give screen DIP origin
            var screenLeftDip = this.Left;
            var screenTopDip = this.Top;

            var dip = new List<Rect>(pixels.Count);
            foreach (var p in pixels)
            {
                // 屏幕像素 → DIP
                double l = p.X * _dpiScaleX - screenLeftDip;
                double t = p.Y * _dpiScaleY - screenTopDip;
                double w = p.Width * _dpiScaleX;
                double h = p.Height * _dpiScaleY;

                // 限制到本窗口范围
                if (l + w < 0 || t + h < 0 || l > _screenWidthDip || t > _screenHeightDip)
                    continue;

                dip.Add(new Rect(l, t, w, h));
            }

            _iconRectsDip = dip;
        }
        catch
        {
            // 读取失败忽略，下次再试
        }
    }

    // ═══════ 状态机调度 ═══════

    private void BeginRandomMotion()
    {
        int r = _rng.Next(100);

        if (_petModeEnabled)
        {
            // 宠物模式：根据情绪值动态调整行为权重
            if (_mood < 20)
            {
                // 情绪低落 → 容易睡觉
                if (r < 35) { PlaySleep(); return; }
                if (r < 55) { PlayWalk(); return; }
                if (r < 65) { PlayEat(); return; }
                if (r < 75) { PlayFlip(); return; }
            }
            else if (_mood >= 70)
            {
                // 情绪高涨 → 活泼好动
                if (r < 5)  { PlayGreet(); return; }
                if (r < 18) { PlayEat(); return; }
                if (r < 38) { PlayWalk(); return; }
                if (r < 58) { PlayDance(); return; }
                if (r < 72) { PlayFlip(); return; }
            }
            else
            {
                // 普通情绪 → 均衡
                if (r < 5)  { PlaySleep(); return; }
                if (r < 18) { PlayEat(); return; }
                if (r < 43) { PlayWalk(); return; }
                if (r < 60) { PlayDance(); return; }
                if (r < 73) { PlayFlip(); return; }
            }
            // 剩余概率：攀爬图标
            var petIcon = PickClimbableIcon();
            if (petIcon.HasValue) { _targetIcon = petIcon; PlayApproachIcon(); return; }
            PlayWalk();
            return;
        }

        // 原有逻辑：走 40% / 跳舞 20% / 翻跟头 15% / 逼近图标并攀爬 25%（需至少有图标）
        if (r < 40) { PlayWalk(); return; }
        if (r < 60) { PlayDance(); return; }
        if (r < 75) { PlayFlip(); return; }

        // 尝试找一个可爬的图标（位于地面附近、宽高合理）
        var icon = PickClimbableIcon();
        if (icon.HasValue)
        {
            _targetIcon = icon;
            PlayApproachIcon();
        }
        else
        {
            PlayWalk();
        }
    }

    private Rect? PickClimbableIcon()
    {
        if (_iconRectsDip.Count == 0) return null;
        // 只挑在当前 "地面层" 的图标：顶部 y 必须高于地面（即图标位于角色能攀爬到的上方）
        // 同时图标矩形宽度在合理范围（30~200 DIP）
        var candidates = _iconRectsDip
            .Where(r => r.Width >= 30 && r.Width <= 200 && r.Height >= 30 && r.Height <= 200)
            .Where(r => r.Bottom <= _groundY + CharHeight + 5)
            .Where(r => r.Top < _groundY)
            .ToList();
        if (candidates.Count == 0) return null;
        return candidates[_rng.Next(candidates.Count)];
    }

    private void StopStoryboard()
    {
        if (_activeSb != null)
        {
            try { _activeSb.Stop(this); } catch { /* ignore */ }
            _activeSb = null;
        }
    }

    private void ResetPose()
    {
        LeftShoulderRot.Angle = -20;
        RightShoulderRot.Angle = 20;
        LeftElbowRot.Angle = 25;
        RightElbowRot.Angle = -25;
        LeftHipRot.Angle = -5;
        RightHipRot.Angle = 5;
        LeftKneeRot.Angle = 5;
        RightKneeRot.Angle = -5;
        DancerBounce.Y = 0;
        DancerFlipRotate.Angle = 0;
    }

    // ═══════ 动画：走 ═══════

    private void PlayWalk()
    {
        StopStoryboard();
        SetState("🚶", _facing > 0 ? "巡游中 →" : "巡游中 ←", DancerMotion.Walk);
        ResetPose();

        // 距离：屏幕宽度 30%~60%
        double distance = _screenWidthDip * (0.3 + _rng.NextDouble() * 0.3);
        double dir = _facing;
        double startX = _worldX;
        double endX = Math.Clamp(startX + dir * distance, 40, _screenWidthDip - CharWidth - 40);
        // 若贴边了，翻转方向
        if (Math.Abs(endX - startX) < 50)
        {
            _facing = -_facing;
            UpdateFacing();
            endX = Math.Clamp(startX + _facing * distance, 40, _screenWidthDip - CharWidth - 40);
        }

        double totalSeconds = Math.Max(2.0, Math.Abs(endX - startX) / 180.0);
        var sb = new Storyboard { Duration = TimeSpan.FromSeconds(totalSeconds) };

        // 位移 - 用附加属性动画
        AddAnim(sb, "DancerRoot", "(Canvas.Left)", totalSeconds,
            (0, startX), (totalSeconds, endX));
        AddShadowFollow(sb, totalSeconds, startX, endX);

        // 腿摆
        int steps = Math.Max(2, (int)(totalSeconds * 2));
        double stepDur = totalSeconds / steps;
        var lhip = new double[steps * 2 + 1];
        var rhip = new double[steps * 2 + 1];
        var lkn = new double[steps * 2 + 1];
        var rkn = new double[steps * 2 + 1];
        for (int i = 0; i <= steps * 2; i++)
        {
            bool even = i % 2 == 0;
            lhip[i] = even ? -5 : 30;
            rhip[i] = even ? 5 : -20;
            lkn[i] = even ? 5 : 45;
            rkn[i] = even ? -5 : -10;
            // 半步反转
            if ((i / 2) % 2 == 1)
            {
                (lhip[i], rhip[i]) = (rhip[i], lhip[i]);
                (lkn[i], rkn[i]) = (rkn[i], lkn[i]);
            }
        }
        AddArrayAnim(sb, "LeftHipRot", "Angle", stepDur / 2, lhip);
        AddArrayAnim(sb, "RightHipRot", "Angle", stepDur / 2, rhip);
        AddArrayAnim(sb, "LeftKneeRot", "Angle", stepDur / 2, lkn);
        AddArrayAnim(sb, "RightKneeRot", "Angle", stepDur / 2, rkn);

        // 手摆
        AddArrayAnim(sb, "LeftShoulderRot", "Angle", stepDur / 2,
            BuildSwing(steps * 2, -40, 0));
        AddArrayAnim(sb, "RightShoulderRot", "Angle", stepDur / 2,
            BuildSwing(steps * 2, 0, 40));

        // 上下轻微跳动
        AddArrayAnim(sb, "DancerBounce", "Y", stepDur / 2,
            BuildBounce(steps * 2, 0, -4));

        sb.Completed += (_, _) =>
        {
            _worldX = endX;
            UpdateRootPosition();
            BeginRandomMotion();
        };
        _activeSb = sb;
        sb.Begin(this, true);
    }

    // ═══════ 动画：跳舞 ═══════

    private void PlayDance()
    {
        StopStoryboard();
        SetState("🎵", "自由跳舞中…", DancerMotion.Dance);
        ResetPose();

        double dur = 4.0;
        var sb = new Storyboard { Duration = TimeSpan.FromSeconds(dur) };

        AddArrayAnim(sb, "LeftShoulderRot", "Angle", 1,
            -20, 60, -40, 70, -20);
        AddArrayAnim(sb, "RightShoulderRot", "Angle", 1,
            20, -60, 40, -70, 20);
        AddArrayAnim(sb, "LeftElbowRot", "Angle", 1,
            25, 80, 40, 90, 25);
        AddArrayAnim(sb, "RightElbowRot", "Angle", 1,
            -25, -80, -40, -90, -25);
        AddArrayAnim(sb, "LeftHipRot", "Angle", 1, -5, 10, -10, 12, -5);
        AddArrayAnim(sb, "RightHipRot", "Angle", 1, 5, -10, 10, -12, 5);
        AddArrayAnim(sb, "LeftKneeRot", "Angle", 1, 5, 20, 10, 25, 5);
        AddArrayAnim(sb, "RightKneeRot", "Angle", 1, -5, -20, -10, -25, -5);
        AddArrayAnim(sb, "DancerBounce", "Y", 0.5,
            0, -8, 0, -8, 0, -8, 0, -8, 0);

        sb.Completed += (_, _) => BeginRandomMotion();
        _activeSb = sb;
        sb.Begin(this, true);
    }

    // ═══════ 动画：翻跟头 ═══════

    private void PlayFlip()
    {
        StopStoryboard();
        SetState("🤸", "翻跟头！", DancerMotion.Flip);
        ResetPose();

        double dur = 1.8;
        double startX = _worldX;
        double endX = Math.Clamp(startX + _facing * 80, 40, _screenWidthDip - CharWidth - 40);
        double startY = _worldY;
        // 翻跟头时抛物线上下
        double midY = startY - 60;

        var sb = new Storyboard { Duration = TimeSpan.FromSeconds(dur) };

        AddAnim(sb, "DancerRoot", "(Canvas.Left)", dur, (0, startX), (dur, endX));
        // Y 用两段弧线
        AddAnim(sb, "DancerRoot", "(Canvas.Top)", dur, (0, startY), (dur / 2, midY), (dur, startY));
        AddShadowFollow(sb, dur, startX, endX);

        AddArrayAnim(sb, "DancerFlipRotate", "Angle", dur, 0, _facing > 0 ? 360 : -360);

        AddArrayAnim(sb, "LeftShoulderRot", "Angle", dur / 2, -20, -120, -20);
        AddArrayAnim(sb, "RightShoulderRot", "Angle", dur / 2, 20, 120, 20);
        AddArrayAnim(sb, "LeftHipRot", "Angle", dur / 2, -5, 60, -5);
        AddArrayAnim(sb, "RightHipRot", "Angle", dur / 2, 5, -60, 5);
        AddArrayAnim(sb, "LeftKneeRot", "Angle", dur / 2, 5, 100, 5);
        AddArrayAnim(sb, "RightKneeRot", "Angle", dur / 2, -5, -100, -5);

        sb.Completed += (_, _) =>
        {
            _worldX = endX;
            _worldY = startY;
            DancerFlipRotate.Angle = 0;
            UpdateRootPosition();
            BeginRandomMotion();
        };
        _activeSb = sb;
        sb.Begin(this, true);
    }

    // ═══════ 动画：逼近图标 ═══════

    private void PlayApproachIcon()
    {
        if (_targetIcon is not { } icon)
        {
            PlayWalk();
            return;
        }

        // 走到图标中心下方（脚对齐地面）
        double targetX = icon.Left + icon.Width / 2 - CharWidth / 2;
        targetX = Math.Clamp(targetX, 20, _screenWidthDip - CharWidth - 20);
        double startX = _worldX;
        double distance = Math.Abs(targetX - startX);
        if (distance < 4)
        {
            PlayClimb();
            return;
        }

        // 朝目标调整 facing
        _facing = targetX > startX ? 1 : -1;
        UpdateFacing();

        double dur = Math.Max(1.2, distance / 200.0);
        SetState("🎯", "朝图标走过去…", DancerMotion.ApproachIcon);
        ResetPose();

        var sb = new Storyboard { Duration = TimeSpan.FromSeconds(dur) };
        AddAnim(sb, "DancerRoot", "(Canvas.Left)", dur, (0, startX), (dur, targetX));
        AddShadowFollow(sb, dur, startX, targetX);

        int steps = Math.Max(2, (int)(dur * 2));
        double stepDur = dur / steps;
        AddArrayAnim(sb, "LeftHipRot", "Angle", stepDur / 2, BuildWalkHip(steps * 2, -5, 30));
        AddArrayAnim(sb, "RightHipRot", "Angle", stepDur / 2, BuildWalkHip(steps * 2, 5, -20));
        AddArrayAnim(sb, "LeftKneeRot", "Angle", stepDur / 2, BuildWalkKnee(steps * 2, 5, 45));
        AddArrayAnim(sb, "RightKneeRot", "Angle", stepDur / 2, BuildWalkKnee(steps * 2, -5, -10));

        sb.Completed += (_, _) =>
        {
            _worldX = targetX;
            UpdateRootPosition();
            PlayClimb();
        };
        _activeSb = sb;
        sb.Begin(this, true);
    }

    // ═══════ 动画：攀爬上图标 ═══════

    private void PlayClimb()
    {
        if (_targetIcon is not { } icon)
        {
            BeginRandomMotion();
            return;
        }

        SetState("🧗", "攀爬图标中…", DancerMotion.Climb);
        ResetPose();

        double startX = _worldX;
        double startY = _worldY;
        double topY = icon.Top - CharHeight; // 角色脚踩到图标顶部
        if (topY < 20) topY = 20;
        double dur = 0.9;

        var sb = new Storyboard { Duration = TimeSpan.FromSeconds(dur) };
        AddAnim(sb, "DancerRoot", "(Canvas.Top)", dur, (0, startY), (dur, topY));
        // 阴影留在原地
        AddArrayAnim(sb, "DancerBounce", "Y", dur, 0, -2, 0);

        // 攀爬姿势：双手上举
        AddArrayAnim(sb, "LeftShoulderRot", "Angle", dur, -20, -150);
        AddArrayAnim(sb, "RightShoulderRot", "Angle", dur, 20, 150);
        AddArrayAnim(sb, "LeftElbowRot", "Angle", dur, 25, 10);
        AddArrayAnim(sb, "RightElbowRot", "Angle", dur, -25, -10);
        AddArrayAnim(sb, "LeftHipRot", "Angle", dur, -5, -20);
        AddArrayAnim(sb, "RightHipRot", "Angle", dur, 5, 20);
        AddArrayAnim(sb, "LeftKneeRot", "Angle", dur, 5, 40);
        AddArrayAnim(sb, "RightKneeRot", "Angle", dur, -5, -40);

        sb.Completed += (_, _) =>
        {
            _worldY = topY;
            UpdateRootPosition();
            PlayOnIcon();
        };
        _activeSb = sb;
        sb.Begin(this, true);
    }

    // ═══════ 动画：图标上表演 ═══════

    private void PlayOnIcon()
    {
        if (_targetIcon is not { } icon)
        {
            BeginRandomMotion();
            return;
        }

        SetState("🪩", "在图标上表演！", DancerMotion.OnIcon);
        ResetPose();

        double dur = 3.0;
        var sb = new Storyboard { Duration = TimeSpan.FromSeconds(dur) };

        AddArrayAnim(sb, "LeftShoulderRot", "Angle", 0.75, -20, 60, -40, 70, -20);
        AddArrayAnim(sb, "RightShoulderRot", "Angle", 0.75, 20, -60, 40, -70, 20);
        AddArrayAnim(sb, "LeftElbowRot", "Angle", 0.75, 25, 80, 40, 90, 25);
        AddArrayAnim(sb, "RightElbowRot", "Angle", 0.75, -25, -80, -40, -90, -25);
        AddArrayAnim(sb, "DancerBounce", "Y", 0.375, 0, -6, 0, -6, 0, -6, 0, -6, 0);

        sb.Completed += (_, _) => PlayJumpOff();
        _activeSb = sb;
        sb.Begin(this, true);
    }

    // ═══════ 动画：从图标跳下 ═══════

    private void PlayJumpOff()
    {
        if (_targetIcon is not { } icon)
        {
            BeginRandomMotion();
            return;
        }

        SetState("🪂", "跳下来！", DancerMotion.JumpOff);
        ResetPose();

        double startX = _worldX;
        double startY = _worldY;
        double endX = Math.Clamp(startX + _facing * 80, 20, _screenWidthDip - CharWidth - 20);
        double topY = startY - 30;
        double endY = _groundY;
        double dur = 1.2;

        var sb = new Storyboard { Duration = TimeSpan.FromSeconds(dur) };
        AddAnim(sb, "DancerRoot", "(Canvas.Left)", dur, (0, startX), (dur, endX));
        AddAnim(sb, "DancerRoot", "(Canvas.Top)", dur, (0, startY), (dur * 0.35, topY), (dur, endY));
        AddShadowFollow(sb, dur, startX, endX);

        // 跳跃中翻转半圈
        AddArrayAnim(sb, "DancerFlipRotate", "Angle", dur, 0, _facing > 0 ? 180 : -180, 0);

        // 空中打开四肢
        AddArrayAnim(sb, "LeftShoulderRot", "Angle", dur / 2, -20, -140, -20);
        AddArrayAnim(sb, "RightShoulderRot", "Angle", dur / 2, 20, 140, 20);
        AddArrayAnim(sb, "LeftHipRot", "Angle", dur / 2, -5, -40, -5);
        AddArrayAnim(sb, "RightHipRot", "Angle", dur / 2, 5, 40, 5);

        sb.Completed += (_, _) =>
        {
            _worldX = endX;
            _worldY = endY;
            _targetIcon = null;
            DancerFlipRotate.Angle = 0;
            UpdateRootPosition();
            BeginRandomMotion();
        };
        _activeSb = sb;
        sb.Begin(this, true);
    }

    // ═══════ 动画：睡眠（宠物模式） ═══════

    private void PlaySleep()
    {
        StopStoryboard();
        SetState("💤", "呼呼大睡中…", DancerMotion.Sleep);
        ResetPose();
        ShowZzz();
        ShowBubble("zzzZZZ…");

        double dur = 8.0;
        var sb = new Storyboard { Duration = TimeSpan.FromSeconds(dur) };

        // 缓慢蹲下
        AddAnim(sb, "DancerRoot", "(Canvas.Top)", 1.5,
            (0, _worldY), (1.5, _worldY + 10));
        AddArrayAnim(sb, "LeftHipRot", "Angle", 0.5, -5, 25, 25, 25);
        AddArrayAnim(sb, "RightHipRot", "Angle", 0.5, 5, -20, -20, -20);
        AddArrayAnim(sb, "LeftKneeRot", "Angle", 0.5, 5, 45, 45, 45);
        AddArrayAnim(sb, "RightKneeRot", "Angle", 0.5, -5, -35, -35, -35);
        AddArrayAnim(sb, "LeftShoulderRot", "Angle", 0.5, -20, -5, -5, -5);
        AddArrayAnim(sb, "RightShoulderRot", "Angle", 0.5, 20, 5, 5, 5);
        // 轻微呼吸起伏
        AddArrayAnim(sb, "DancerBounce", "Y", 1.5, 0, 2, 0, 2, 0, 2);

        sb.Completed += (_, _) =>
        {
            if (_motion == DancerMotion.Sleep)
            {
                HideZzz();
                _worldY = _groundY;
                UpdateRootPosition();
                ResetPose();
                BeginRandomMotion();
            }
        };
        _activeSb = sb;
        sb.Begin(this, true);
    }

    // ═══════ 动画：进食（宠物模式） ═══════

    private void PlayEat()
    {
        StopStoryboard();
        SetState("🍖", "吃东西中…", DancerMotion.Eat);
        ResetPose();
        ShowBubble("好吃！");

        double dur = 3.0;
        var sb = new Storyboard { Duration = TimeSpan.FromSeconds(dur) };

        // 左臂弯腰取食并反复送入嘴
        AddArrayAnim(sb, "LeftShoulderRot", "Angle", 0.4,
            -20, 60, -10, 60, -10, 60, -20, -20);
        AddArrayAnim(sb, "LeftElbowRot", "Angle", 0.4,
            25, 70, 20, 70, 20, 70, 25, 25);
        // 咀嚼头部轻微弹动
        AddArrayAnim(sb, "DancerBounce", "Y", 0.3,
            0, -2, 0, -2, 0, -2, 0, -2, 0, -2);

        sb.Completed += (_, _) =>
        {
            _mood = Math.Min(100, _mood + 10);
            UpdateMoodBadge();
            BeginRandomMotion();
        };
        _activeSb = sb;
        sb.Begin(this, true);
    }

    // ═══════ 动画：被点击反应（宠物模式） ═══════

    private void PlayReact()
    {
        StopStoryboard();
        SetState("✨", "开心！", DancerMotion.React);
        ResetPose();
        ShowBubble(_reactMessages[_rng.Next(_reactMessages.Length)]);

        double dur = 2.0;
        double startY = _worldY;
        var sb = new Storyboard { Duration = TimeSpan.FromSeconds(dur) };

        // 跳跃欢呼
        AddAnim(sb, "DancerRoot", "(Canvas.Top)", dur,
            (0, startY), (0.3, startY - 30), (0.6, startY), (0.9, startY - 15), (1.2, startY));
        // 双手挥舞
        AddArrayAnim(sb, "LeftShoulderRot", "Angle", 0.3,
            -20, -140, -30, -140, -20, -20, -20);
        AddArrayAnim(sb, "RightShoulderRot", "Angle", 0.3,
            20, 140, 30, 140, 20, 20, 20);
        AddArrayAnim(sb, "LeftElbowRot", "Angle", 0.3,
            25, 10, 25, 10, 25, 25, 25);
        AddArrayAnim(sb, "RightElbowRot", "Angle", 0.3,
            -25, -10, -25, -10, -25, -25, -25);

        sb.Completed += (_, _) =>
        {
            _worldY = startY;
            UpdateRootPosition();
            ResetPose();
            BeginRandomMotion();
        };
        _activeSb = sb;
        sb.Begin(this, true);
    }

    // ═══════ 动画：打招呼（宠物模式） ═══════

    private void PlayGreet()
    {
        StopStoryboard();
        SetState("👋", "打招呼！", DancerMotion.Greet);
        ResetPose();
        ShowBubble("你好！主人~");

        double dur = 2.5;
        var sb = new Storyboard { Duration = TimeSpan.FromSeconds(dur) };

        // 右手挥动
        AddArrayAnim(sb, "RightShoulderRot", "Angle", 0.4,
            20, 120, 60, 120, 60, 20, 20);
        AddArrayAnim(sb, "RightElbowRot", "Angle", 0.4,
            -25, -40, -15, -40, -15, -25, -25);
        AddArrayAnim(sb, "DancerBounce", "Y", 0.5,
            0, -5, 0, -5, 0);

        sb.Completed += (_, _) => BeginRandomMotion();
        _activeSb = sb;
        sb.Begin(this, true);
    }

    // ═══════ 动画助手 ═══════

    private static void AddAnim(Storyboard sb, string targetName, string propertyPath,
        double totalSeconds, params (double t, double v)[] frames)
    {
        var anim = new DoubleAnimationUsingKeyFrames { Duration = TimeSpan.FromSeconds(totalSeconds) };
        foreach (var (t, v) in frames)
        {
            anim.KeyFrames.Add(new EasingDoubleKeyFrame(v,
                KeyTime.FromTimeSpan(TimeSpan.FromSeconds(t)),
                new SineEase { EasingMode = EasingMode.EaseInOut }));
        }
        Storyboard.SetTargetName(anim, targetName);
        Storyboard.SetTargetProperty(anim, new PropertyPath(propertyPath));
        sb.Children.Add(anim);
    }

    /// <summary>将等间隔的关键帧数组附加到 storyboard。间隔单位是秒。</summary>
    private static void AddArrayAnim(Storyboard sb, string targetName, string propertyPath,
        double intervalSeconds, params double[] values)
    {
        var anim = new DoubleAnimationUsingKeyFrames();
        for (int i = 0; i < values.Length; i++)
        {
            anim.KeyFrames.Add(new EasingDoubleKeyFrame(values[i],
                KeyTime.FromTimeSpan(TimeSpan.FromSeconds(intervalSeconds * i)),
                new SineEase { EasingMode = EasingMode.EaseInOut }));
        }
        anim.Duration = TimeSpan.FromSeconds(intervalSeconds * (values.Length - 1));
        Storyboard.SetTargetName(anim, targetName);
        Storyboard.SetTargetProperty(anim, new PropertyPath(propertyPath));
        sb.Children.Add(anim);
    }

    private static double[] BuildSwing(int steps, double a, double b)
    {
        var arr = new double[steps + 1];
        for (int i = 0; i <= steps; i++)
            arr[i] = (i % 2 == 0) ? a : b;
        return arr;
    }

    private static double[] BuildBounce(int steps, double ground, double air)
    {
        var arr = new double[steps + 1];
        for (int i = 0; i <= steps; i++)
            arr[i] = (i % 2 == 0) ? ground : air;
        return arr;
    }

    private static double[] BuildWalkHip(int steps, double idle, double lift)
    {
        var arr = new double[steps + 1];
        for (int i = 0; i <= steps; i++)
            arr[i] = (i % 2 == 0) ? idle : lift;
        return arr;
    }

    private static double[] BuildWalkKnee(int steps, double idle, double bend)
    {
        var arr = new double[steps + 1];
        for (int i = 0; i <= steps; i++)
            arr[i] = (i % 2 == 0) ? idle : bend;
        return arr;
    }

    private void AddShadowFollow(Storyboard sb, double totalSeconds, double startX, double endX)
    {
        AddAnim(sb, "DancerShadow", "(Canvas.Left)", totalSeconds,
            (0, startX), (totalSeconds, endX));
    }

    // ═══════ 生命周期 ═══════

    protected override void OnClosing(System.ComponentModel.CancelEventArgs e)
    {
        // 真关闭，避免被 Hide 卡住
        base.OnClosing(e);
    }

    protected override void OnClosed(EventArgs e)
    {
        _closed = true;
        _iconRefreshTimer.Stop();
        _moodDecayTimer?.Stop();
        _bubbleHideTimer?.Stop();
        StopStoryboard();
        base.OnClosed(e);
    }
}
