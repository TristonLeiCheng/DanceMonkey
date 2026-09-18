using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Windows;
using System.Windows.Input;
using System.Windows.Media.Imaging;
using WpfPoint = System.Windows.Point;
using System.Windows.Media.Animation;
using System.Windows.Threading;
using DesktopAssistant.Models;
using DesktopAssistant.Services;
using DrawingPixelFormat = System.Drawing.Imaging.PixelFormat;
using DrawingPoint = System.Drawing.Point;
using Forms = System.Windows.Forms;
using FormsScreen = System.Windows.Forms.Screen;

namespace DesktopAssistant;

/// <summary>
/// 屏幕右下角桌面宠物：像素风格实时计算渲染，每种宠物有独立像素精灵与帧动画。
/// 增强功能：情绪系统、多种动画状态、双击互动。
/// </summary>
public partial class DesktopPetWindow : Window
{
    private const double MoveThreshold = 6;

    private readonly MainWindow _main;
    private readonly Func<AppConfig> _loadConfig;
    private readonly Action<AppConfig> _saveConfig;

    private WpfPoint _pressScreen;
    private Vector _dragOffset;
    private bool _moved;
    private int _clickCount;

    private readonly PixelPetRenderer _pixelRenderer = new();
    private string _activeAnimal = "cat";
    private Forms.ContextMenuStrip? _contextMenu;
    private Forms.ToolStripMenuItem? _petToggleMenuItem;
    private DispatcherTimer? _bubbleHideTimer;

    // ── 情绪系统 ──
    private enum PetMood
    {
        Happy,
        Normal,
        Bored,
        Sleepy,
        Sleeping,
        Focused,
        Encouraging,
        TaskReminder,
        Eating,
        Working,
        Reading,
        Exercising,
        Relaxing
    }
    private PetMood _mood = PetMood.Normal;
    private int _interactionCount;
    private DateTime _lastInteraction = DateTime.Now;
    private DateTime _temporaryMoodUntil = DateTime.MinValue;
    private DispatcherTimer? _moodDecayTimer;
    private DispatcherTimer? _autoActionTimer;
    private DispatcherTimer? _taskReminderTimer;
    private DateTime _nextTaskReminderAt = DateTime.MaxValue;
    private int _taskReminderIntervalMinutes = -1;
    private string? _lastTaskReminderId;
    private string? _scheduledReminderId;
    private Action? _scheduledReminderAck;
    private Action<int>? _scheduledReminderSnooze;

    private static readonly string[] _tapMessages =
    [
        "喵~", "汪！", "蹦蹦！", "嗷呜~", "嘿！", "(＾▽＾)", "摸摸我~", "今天也要加油！"
    ];

    private static readonly string[] _happyMessages =
    [
        "好开心！✨", "最喜欢你了！💕", "嘻嘻~", "继续摸！", "幸福~🌟"
    ];

    private static readonly string[] _boredMessages =
    [
        "好无聊…", "来陪我玩嘛~", "💤", "有人在吗？", "戳戳我呀"
    ];

    private static readonly string[] _sleepyMessages =
    [
        "Zzz…", "💤💤", "好困…", "(打哈欠)", "晚安…"
    ];

    private static readonly string[] _focusedMessages =
    [
        "专注一下，先推进一小步。", "现在适合处理一个任务。", "我陪你进入专注模式。", "先做最重要的一件事吧。"
    ];

    private static readonly string[] _encouragingMessages =
    [
        "做得不错，继续前进！", "任务一点点清掉就好。", "别急，完成一项就是胜利。", "今天也在认真变好。"
    ];

    private static readonly string[] _eatingMessages =
    [
        "先吃点东西补充能量。", "咔嚓咔嚓，开饭啦。", "吃饱了才有精神。", "我在认真干饭。"
    ];

    private static readonly string[] _workingMessages =
    [
        "上班中，努力敲键盘。", "今天也在认真工作。", "先处理一小块任务。", "工作模式启动。"
    ];

    private static readonly string[] _readingMessages =
    [
        "看会儿书，充充电。", "这一页很有意思。", "学习时间到。", "读书让宠物变聪明。"
    ];

    private static readonly string[] _exercisingMessages =
    [
        "活动一下身体。", "伸个懒腰再继续。", "运动五分钟也不错。", "保持活力！"
    ];

    private static readonly string[] _relaxingMessages =
    [
        "放松一下也很重要。", "发会儿呆，恢复能量。", "慢慢来，不着急。", "休息片刻。"
    ];

    private static readonly Dictionary<string, string[]> _animalTapMessages = new()
    {
        ["cat"] = ["喵~", "呼噜噜~", "别碰我尾巴！", "给你蹭蹭~", "喵呜！"],
        ["dog"] = ["汪汪！", "摸摸头！", "尾巴摇起来！", "飞盘！飞盘！", "嘿嘿~"],
        ["rabbit"] = ["蹦！", "胡萝卜！", "耳朵痒痒~", "跳跳跳！", "嗅嗅~"],
        ["fox"] = ["嗷呜~", "聪明如我！", "尾巴蓬蓬的~", "嘿嘿~", "狡猾？才不是！"],
        ["human"] = ["嗨！", "今天也要加油！", "需要帮忙吗？", "一起努力！", "✌️"],
        ["goose"] = ["嘎！", "不要惹我哦。", "今天巡逻桌面。", "翅膀先警告一下。", "嘎嘎~"],
        ["cockroach"] = ["别踩我！", "我跑得很快。", "角落是我的地盘。", "嗖一下就没影了。", "今天也很顽强。"],
        ["mosquito"] = ["嗡嗡~", "只是路过一下。", "别拍我！", "夜里更精神。", "飞一圈再说。"],
        ["capybara"] = ["今天也很淡定。", "慢慢来。", "一起发呆吗？", "泡个温泉最舒服。", "水豚式冷静。"],
        ["frog"] = ["呱。", "荷叶今天不错。", "跳一下更精神。", "雨天是主场。", "呱呱~"],
        ["penguin"] = ["摇摇摆摆出场。", "今天也很稳。", "有点想滑冰。", "别急，慢慢走。", "企鹅式礼貌。"],
        ["turtle"] = ["不急，我在路上。", "慢一点更稳。", "壳里很安全。", "今天先晒个太阳。", "慢慢爬。"],
        ["hedgehog"] = ["别戳刺啦。", "我先缩一下。", "小心我的背。", "滚一圈就回来。", "刺猬也很可爱。"]
    };

    public DesktopPetWindow(
        MainWindow main,
        Func<AppConfig> loadConfig,
        Action<AppConfig> saveConfig)
    {
        InitializeComponent();
        _main = main;
        _loadConfig = loadConfig;
        _saveConfig = saveConfig;

        _bubbleHideTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(2.5) };
        _bubbleHideTimer.Tick += (_, _) => HideBubble();

        // 绑定像素渲染器到 Image
        PetImage.Source = _pixelRenderer.Bitmap;

        // 情绪衰减计时器：每 3 分钟检查一次
        _moodDecayTimer = new DispatcherTimer { Interval = TimeSpan.FromMinutes(3) };
        _moodDecayTimer.Tick += (_, _) => DecayMood();
        _moodDecayTimer.Start();

        // 自动行为计时器：每 30-90 秒随机触发
        _autoActionTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(45) };
        _autoActionTimer.Tick += (_, _) => AutoAction();
        _autoActionTimer.Start();

        _taskReminderTimer = new DispatcherTimer { Interval = TimeSpan.FromMinutes(5) };
        _taskReminderTimer.Tick += (_, _) => MaybeShowTaskReminder();
        _taskReminderTimer.Start();
        RefreshTaskReminderSettings();

        UpdateMoodDisplay();
    }

    public void ApplyAnimal(string? animal)
    {
        var key = NormalizeAnimal(animal);
        if (string.Equals(key, _activeAnimal, StringComparison.OrdinalIgnoreCase)
            && _pixelRenderer.Bitmap != null)
            return;

        _activeAnimal = key;
        _pixelRenderer.SetAnimal(key);
        _pixelRenderer.SetMood(MoodToString(_mood));
        _pixelRenderer.Start();
    }

    public void ApplySize(int displaySize)
    {
        var sz = displaySize is 48 or 68 or 96 or 128 ? displaySize : 68;
        PetImage.Width  = sz;
        PetImage.Height = sz;
        // 内层 Grid（含变换中心点）
        if (PetImage.Parent is System.Windows.Controls.Grid innerGrid)
        {
            innerGrid.Width  = sz;
            innerGrid.Height = sz;
            if (innerGrid.RenderTransform is System.Windows.Media.TransformGroup tg)
            {
                foreach (var t in tg.Children)
                {
                    if (t is System.Windows.Media.ScaleTransform st) { st.CenterX = sz / 2.0; st.CenterY = sz / 2.0; }
                    if (t is System.Windows.Media.RotateTransform rt) { rt.CenterX = sz / 2.0; rt.CenterY = sz / 2.0; }
                }
            }
        }
        // 外层 Border
        if (PetImage.Parent is System.Windows.Controls.Grid g && g.Parent is System.Windows.Controls.Border outerBorder)
        {
            outerBorder.Width  = sz + 8;
            outerBorder.Height = sz + 8;
        }
        Width  = sz + 22;
        Height = sz + 34;
    }

    public void RefreshTaskReminderSettings()
    {
        var cfg = _loadConfig();
        if (!cfg.TodoReminderEnabled)
        {
            _nextTaskReminderAt = DateTime.MaxValue;
            _taskReminderIntervalMinutes = -1;
            return;
        }

        var interval = GetPetTaskReminderIntervalMinutes(cfg);
        if (_taskReminderIntervalMinutes != interval || _nextTaskReminderAt == DateTime.MaxValue)
        {
            _taskReminderIntervalMinutes = interval;
            _nextTaskReminderAt = DateTime.Now.AddMinutes(interval);
        }
    }

    public void ApplyPlacement()
    {
        var screen = TargetScreen();
        var wa = WpfScreenPlacement.GetWorkingAreaDip(screen);
        var cfg = _loadConfig();

        double x, y;
        if (cfg.FloatingIconX is { } sx && cfg.FloatingIconY is { } sy)
        {
            x = sx;
            y = sy;
        }
        else
        {
            const double margin = 24;
            x = wa.Right - Width - margin;
            y = wa.Bottom - Height - margin;
        }

        x = Math.Clamp(x, wa.Left, wa.Right - Width);
        y = Math.Clamp(y, wa.Top, wa.Bottom - Height);

        Left = x;
        Top = y;
        Show();
        Topmost = true;
        _pixelRenderer.SetAnimal(_activeAnimal);
        _pixelRenderer.Start();
        ApplySize(_loadConfig().PetDisplaySize);
    }

    private static string MoodToString(PetMood mood) => mood switch
    {
        PetMood.Happy or PetMood.Encouraging => "happy",
        PetMood.Bored or PetMood.TaskReminder => "bored",
        PetMood.Sleepy or PetMood.Sleeping => "sleepy",
        PetMood.Eating => "eating",
        PetMood.Working or PetMood.Focused => "working",
        PetMood.Reading => "reading",
        PetMood.Exercising => "exercising",
        PetMood.Relaxing => "relaxing",
        _ => "normal"
    };

    private void PlayTapPop()
    {
        if (TryFindResource("PetPop") is Storyboard pop)
        {
            pop.Stop(this);
            pop.Begin(this, isControllable: true);
        }
    }

    private void PlayHappyJump()
    {
        if (TryFindResource("PetHappyJump") is Storyboard jump)
        {
            jump.Stop(this);
            jump.Begin(this, isControllable: true);
        }
    }

    private void PlayShake()
    {
        if (TryFindResource("PetShake") is Storyboard shake)
        {
            shake.Stop(this);
            shake.Begin(this, isControllable: true);
        }
    }

    private void ShowBubble(string text, double seconds = 2.5)
    {
        SpeechText.Text = text;
        SpeechBubble.Visibility = Visibility.Visible;
        _bubbleHideTimer!.Interval = TimeSpan.FromSeconds(seconds);
        _bubbleHideTimer?.Stop();
        _bubbleHideTimer?.Start();
    }

    private void HideBubble()
    {
        SpeechBubble.Visibility = Visibility.Collapsed;
        _bubbleHideTimer?.Stop();
    }

    // ── 情绪系统 ──

    private void BoostMood()
    {
        _interactionCount++;
        _lastInteraction = DateTime.Now;

        if (_interactionCount >= 5)
            _mood = PetMood.Happy;
        else if (_mood == PetMood.Sleepy || _mood == PetMood.Bored)
            _mood = PetMood.Normal;

        UpdateMoodDisplay();
    }

    private void DecayMood()
    {
        if (_temporaryMoodUntil > DateTime.Now)
        {
            UpdateMoodDisplay();
            return;
        }

        if (IsTemporaryMood(_mood))
            _mood = PetMood.Normal;

        var elapsed = DateTime.Now - _lastInteraction;
        if (elapsed.TotalMinutes > 15)
        {
            _mood = PetMood.Sleepy;
            _interactionCount = 0;
        }
        else if (elapsed.TotalMinutes > 8)
        {
            _mood = PetMood.Bored;
            _interactionCount = Math.Max(0, _interactionCount - 1);
        }
        else if (elapsed.TotalMinutes > 4)
        {
            if (_mood == PetMood.Happy)
                _mood = PetMood.Normal;
            _interactionCount = Math.Max(0, _interactionCount - 1);
        }

        UpdateMoodDisplay();
    }

    private void UpdateMoodDisplay()
    {
        _pixelRenderer.SetMood(MoodToString(_mood));
    }

    private void AutoAction()
    {
        // 随机调整下次触发间隔
        _autoActionTimer!.Interval = TimeSpan.FromSeconds(45 + Random.Shared.Next(75));

        if (_temporaryMoodUntil <= DateTime.Now && _mood == PetMood.Normal && Random.Shared.Next(100) < 45)
        {
            StartRandomLifeState();
            return;
        }

        switch (_mood)
        {
            case PetMood.Sleepy:
                ShowBubble(_sleepyMessages[Random.Shared.Next(_sleepyMessages.Length)]);
                break;
            case PetMood.Sleeping:
                ShowBubble(_sleepyMessages[Random.Shared.Next(_sleepyMessages.Length)]);
                break;
            case PetMood.Bored:
                ShowBubble(_boredMessages[Random.Shared.Next(_boredMessages.Length)]);
                PlayShake();
                break;
            case PetMood.Happy:
                // 开心时偶尔自己跳一下
                if (Random.Shared.Next(3) == 0)
                {
                    PlayHappyJump();
                    ShowBubble(_happyMessages[Random.Shared.Next(_happyMessages.Length)]);
                }
                break;
            case PetMood.Focused:
                ShowBubble(_focusedMessages[Random.Shared.Next(_focusedMessages.Length)]);
                break;
            case PetMood.Encouraging:
                PlayHappyJump();
                ShowBubble(_encouragingMessages[Random.Shared.Next(_encouragingMessages.Length)]);
                break;
            case PetMood.TaskReminder:
                PlayShake();
                break;
            case PetMood.Eating:
                ShowBubble(_eatingMessages[Random.Shared.Next(_eatingMessages.Length)]);
                break;
            case PetMood.Working:
                ShowBubble(_workingMessages[Random.Shared.Next(_workingMessages.Length)]);
                break;
            case PetMood.Reading:
                ShowBubble(_readingMessages[Random.Shared.Next(_readingMessages.Length)]);
                break;
            case PetMood.Exercising:
                PlayHappyJump();
                ShowBubble(_exercisingMessages[Random.Shared.Next(_exercisingMessages.Length)]);
                break;
            case PetMood.Relaxing:
                ShowBubble(_relaxingMessages[Random.Shared.Next(_relaxingMessages.Length)]);
                break;
        }
    }

    private static bool IsTemporaryMood(PetMood mood) =>
        mood is PetMood.Focused
            or PetMood.Encouraging
            or PetMood.TaskReminder
            or PetMood.Eating
            or PetMood.Working
            or PetMood.Reading
            or PetMood.Exercising
            or PetMood.Relaxing
            or PetMood.Sleeping;

    private void StartRandomLifeState()
    {
        var state = Random.Shared.Next(6) switch
        {
            0 => PetMood.Eating,
            1 => PetMood.Sleeping,
            2 => PetMood.Working,
            3 => PetMood.Reading,
            4 => PetMood.Exercising,
            _ => PetMood.Relaxing,
        };

        SetTemporaryMood(state, TimeSpan.FromMinutes(2 + Random.Shared.Next(3)));
        switch (state)
        {
            case PetMood.Eating:
                ShowBubble(_eatingMessages[Random.Shared.Next(_eatingMessages.Length)], 4);
                break;
            case PetMood.Sleeping:
                ShowBubble(_sleepyMessages[Random.Shared.Next(_sleepyMessages.Length)], 4);
                break;
            case PetMood.Working:
                ShowBubble(_workingMessages[Random.Shared.Next(_workingMessages.Length)], 4);
                break;
            case PetMood.Reading:
                ShowBubble(_readingMessages[Random.Shared.Next(_readingMessages.Length)], 4);
                break;
            case PetMood.Exercising:
                PlayHappyJump();
                ShowBubble(_exercisingMessages[Random.Shared.Next(_exercisingMessages.Length)], 4);
                break;
            case PetMood.Relaxing:
                ShowBubble(_relaxingMessages[Random.Shared.Next(_relaxingMessages.Length)], 4);
                break;
        }
    }

    private void SetTemporaryMood(PetMood mood, TimeSpan duration)
    {
        _mood = mood;
        _temporaryMoodUntil = DateTime.Now.Add(duration);
        UpdateMoodDisplay();
    }

    private void MaybeShowTaskReminder()
    {
        var cfg = _loadConfig();
        if (!cfg.TodoReminderEnabled)
        {
            RefreshTaskReminderSettings();
            return;
        }

        var interval = GetPetTaskReminderIntervalMinutes(cfg);
        if (_taskReminderIntervalMinutes != interval)
        {
            _taskReminderIntervalMinutes = interval;
            _nextTaskReminderAt = DateTime.Now.AddMinutes(interval);
            return;
        }

        if (DateTime.Now < _nextTaskReminderAt)
            return;

        var nextInterval = TimeSpan.FromMinutes(interval);
        _nextTaskReminderAt = DateTime.Now.Add(nextInterval);

        try
        {
            var tasks = new ZenTaskStore(cfg.NotesRootPath).LoadTasks();
            var reminder = BuildTaskReminder(tasks);
            if (reminder == null)
            {
                SetTemporaryMood(PetMood.Encouraging, TimeSpan.FromMinutes(3));
                ShowBubble("任务都处理完啦，休息一下也可以。", 5);
                PlayHappyJump();
                return;
            }

            _lastTaskReminderId = reminder.TaskId;
            SetTemporaryMood(PetMood.TaskReminder, TimeSpan.FromMinutes(8));
            ShowBubble(reminder.Message, 7);
            PlayShake();
        }
        catch (IOException ex)
        {
            ShowBubble($"任务列表暂时读不到：{ex.Message}", 5);
        }
        catch (System.Text.Json.JsonException ex)
        {
            ShowBubble($"任务列表格式异常：{ex.Message}", 5);
        }
        catch (UnauthorizedAccessException ex)
        {
            ShowBubble($"没有权限读取任务列表：{ex.Message}", 5);
        }
    }

    private static int GetPetTaskReminderIntervalMinutes(AppConfig cfg) =>
        Math.Clamp(cfg.TodoReminderMinutes, 45, 240);

    private TaskReminderMessage? BuildTaskReminder(IReadOnlyList<ZenTaskRecord> tasks)
    {
        var today = DateTime.Today;
        var pending = tasks
            .Where(IsReminderCandidate)
            .OrderBy(t => GetReminderRank(t, today))
            .ThenBy(t => t.DueDate ?? DateTime.MaxValue)
            .ThenByDescending(t => t.Impact + t.Urgency)
            .ToList();

        if (pending.Count == 0)
            return null;

        var pick = PickReminderTask(pending);
        var overdue = pending.Count(t => t.DueDate.HasValue && t.DueDate.Value.Date < today);
        var dueToday = pending.Count(t => t.DueDate.HasValue && t.DueDate.Value.Date == today);
        var urgent = pending.Count(t => t.Impact >= 4 && t.Urgency >= 4);
        var title = TrimTaskTitle(pick.Title);

        var message = overdue > 0
            ? $"还有 {overdue} 项逾期任务，先看：{title}"
            : dueToday > 0
                ? $"今天还有 {dueToday} 项任务，先推进：{title}"
                : urgent > 0
                    ? $"有 {urgent} 项高优先任务待处理：{title}"
                    : $"待办还有 {pending.Count} 项，挑一个推进吧：{title}";

        return new TaskReminderMessage(pick.Id, message);
    }

    private ZenTaskRecord PickReminderTask(IReadOnlyList<ZenTaskRecord> pending)
    {
        if (pending.Count == 1 || string.IsNullOrWhiteSpace(_lastTaskReminderId))
            return pending[0];

        return pending.FirstOrDefault(t => !string.Equals(t.Id, _lastTaskReminderId, StringComparison.OrdinalIgnoreCase))
               ?? pending[0];
    }

    private static bool IsReminderCandidate(ZenTaskRecord task)
    {
        var status = task.WorkflowStatus?.Trim() ?? "";
        if (status.Equals("Done", StringComparison.OrdinalIgnoreCase) ||
            status.Equals("Completed", StringComparison.OrdinalIgnoreCase) ||
            status.Equals("Cancelled", StringComparison.OrdinalIgnoreCase) ||
            status.Equals("Canceled", StringComparison.OrdinalIgnoreCase) ||
            status.Equals("Deferred", StringComparison.OrdinalIgnoreCase))
            return false;

        return !string.IsNullOrWhiteSpace(task.Title);
    }

    private static int GetReminderRank(ZenTaskRecord task, DateTime today)
    {
        if (task.DueDate.HasValue && task.DueDate.Value.Date < today)
            return 0;
        if (task.DueDate.HasValue && task.DueDate.Value.Date == today)
            return 1;
        if (task.Impact >= 4 && task.Urgency >= 4)
            return 2;
        if (string.Equals(task.WorkflowStatus, "In Progress", StringComparison.OrdinalIgnoreCase))
            return 3;
        return 4;
    }

    private static string TrimTaskTitle(string title)
    {
        var clean = string.IsNullOrWhiteSpace(title) ? "未命名任务" : title.Trim();
        return clean.Length <= 28 ? clean : clean[..28] + "…";
    }

    private sealed record TaskReminderMessage(string TaskId, string Message);

    public bool TryShowScheduledReminder(ReminderDefinition reminder, ScheduledReminderService service)
    {
        if (!IsVisible)
            return false;

        _scheduledReminderId = reminder.Id;
        _scheduledReminderAck = () =>
        {
            service.Acknowledge(reminder.Id);
            ClearScheduledReminder();
        };
        _scheduledReminderSnooze = minutes =>
        {
            service.Snooze(reminder.Id, minutes);
            ClearScheduledReminder();
        };

        var mood = ResolveReminderMood(reminder);
        SetTemporaryMood(mood, TimeSpan.FromMinutes(Math.Max(reminder.SnoozeMinutes, 8)));
        ShowBubble(BuildScheduledReminderBubbleText(reminder), 15);

        if (mood == PetMood.Exercising)
            PlayHappyJump();
        else
            PlayShake();

        return true;
    }

    private void ClearScheduledReminder()
    {
        _scheduledReminderId = null;
        _scheduledReminderAck = null;
        _scheduledReminderSnooze = null;
    }

    private static PetMood ResolveReminderMood(ReminderDefinition reminder) => reminder.Id switch
    {
        ReminderBuiltInIds.Water => PetMood.Eating,
        ReminderBuiltInIds.Sedentary => PetMood.Exercising,
        _ => PetMood.Encouraging
    };

    private static string BuildScheduledReminderBubbleText(ReminderDefinition reminder)
    {
        var text = string.IsNullOrWhiteSpace(reminder.Message)
            ? reminder.Title
            : $"{reminder.Title}\n{reminder.Message}";
        return text.Length <= 96 ? text : text[..93] + "…";
    }

    private bool TryHandleScheduledReminderTap()
    {
        if (_scheduledReminderId == null)
            return false;

        _scheduledReminderAck?.Invoke();
        ShowBubble("收到！继续保持~", 2.5);
        return true;
    }

    // ── 交互 ──

    private static string NormalizeAnimal(string? animal)
    {
        var key = string.IsNullOrWhiteSpace(animal) ? "cat" : animal.Trim().ToLowerInvariant();
        return key is "cat" or "dog" or "rabbit" or "fox" or "human" or "goose" or "cockroach" or "mosquito" or "capybara" or "frog" or "penguin" or "turtle" or "hedgehog"
            ? key
            : "cat";
    }

    protected override void OnMouseLeftButtonDown(MouseButtonEventArgs e)
    {
        base.OnMouseLeftButtonDown(e);
        CaptureMouse();
        _pressScreen = ScreenDevicePixelsToDip(PointToScreen(e.GetPosition(this)));
        _dragOffset = _pressScreen - new WpfPoint(Left, Top);
        _moved = false;
        _clickCount = e.ClickCount;
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        base.OnMouseMove(e);
        if (!IsMouseCaptured || e.LeftButton != MouseButtonState.Pressed)
            return;

        var now = ScreenDevicePixelsToDip(PointToScreen(e.GetPosition(this)));
        if ((now - _pressScreen).Length > MoveThreshold)
            _moved = true;

        Left = now.X - _dragOffset.X;
        Top = now.Y - _dragOffset.Y;
    }

    protected override void OnMouseLeftButtonUp(MouseButtonEventArgs e)
    {
        base.OnMouseLeftButtonUp(e);
        if (IsMouseCaptured)
            ReleaseMouseCapture();

        if (!_moved)
        {
            if (_clickCount >= 2)
                _main.ShowFromTray();
            else
                OnPetTapped();
        }
        else
        {
            CommitPosition();
        }

        _moved = false;
    }

    private void OnPetTapped()
    {
        if (TryHandleScheduledReminderTap())
            return;

        BoostMood();

        // 根据情绪选择不同反馈
        if (_mood == PetMood.Happy)
        {
            PlayHappyJump();
            var msgs = _happyMessages;
            ShowBubble(msgs[Random.Shared.Next(msgs.Length)]);
        }
        else
        {
            PlayTapPop();
            // 使用动物专属台词
            var msgs = _animalTapMessages.GetValueOrDefault(_activeAnimal, _tapMessages);
            ShowBubble(msgs[Random.Shared.Next(msgs.Length)]);
        }
    }

    protected override void OnMouseRightButtonUp(MouseButtonEventArgs e)
    {
        base.OnMouseRightButtonUp(e);
        if (_contextMenu == null)
            BuildContextMenu();

        SyncToggleMenuState();

        var p = PointToScreen(e.GetPosition(this));
        if (_scheduledReminderId != null && _scheduledReminderSnooze != null)
        {
            var menu = new Forms.ContextMenuStrip();
            menu.Items.Add("✅ 提醒已完成", null, (_, _) => _scheduledReminderAck?.Invoke());
            menu.Items.Add("⏰ 稍后 10 分钟", null, (_, _) => _scheduledReminderSnooze?.Invoke(10));
            menu.Items.Add("管理定时提醒", null, (_, _) => _main.ShowAndSwitch(AppPage.ScheduledReminders));
            menu.Items.Add(new Forms.ToolStripSeparator());
            menu.Items.Add(L("Tray.Show"), null, (_, _) => _main.ShowFromTray());
            menu.Show((int)p.X, (int)p.Y);
            return;
        }

        _contextMenu!.Show((int)p.X, (int)p.Y);
    }

    private void BuildContextMenu()
    {
        _contextMenu = new Forms.ContextMenuStrip();
        _contextMenu.Items.Add(L("Tray.Show"), null, (_, _) => _main.ShowFromTray());
        _contextMenu.Items.Add(new Forms.ToolStripSeparator());
        _petToggleMenuItem = new Forms.ToolStripMenuItem("关闭桌面宠物模式") { CheckOnClick = false };
        _petToggleMenuItem.Click += (_, _) => _main.TogglePetMode();
        _contextMenu.Items.Add(_petToggleMenuItem);
        _contextMenu.Items.Add(new Forms.ToolStripSeparator());
        _contextMenu.Items.Add(L("Nav.AiChat"), null, (_, _) => _main.ShowAndSwitch(AppPage.AiChat));
        _contextMenu.Items.Add(L("Nav.Notes"), null, (_, _) => _main.ShowAndSwitch(AppPage.Notes));
        _contextMenu.Items.Add(L("Nav.Todo"), null, (_, _) => _main.ShowAndSwitch(AppPage.Todo));
        var tools = new Forms.ToolStripMenuItem(L("Tray.Tools"));
        tools.DropDownItems.Add(L("Nav.Network"), null, (_, _) => _main.ShowAndSwitch(AppPage.NetworkMonitor));
        tools.DropDownItems.Add(L("Nav.Cleanup"), null, (_, _) => _main.ShowAndSwitch(AppPage.Cleanup));
        _contextMenu.Items.Add(tools);
        _contextMenu.Items.Add(L("Nav.QuickAccess"), null, (_, _) => _main.ShowAndSwitch(AppPage.QuickAccess));
        _contextMenu.Items.Add(L("Nav.PdfTools"), null, (_, _) => _main.ShowAndSwitch(AppPage.PdfTools));
        _contextMenu.Items.Add(L("Nav.FileTools"), null, (_, _) => _main.ShowAndSwitch(AppPage.FileTools));
        _contextMenu.Items.Add(L("Nav.Meeting"), null, (_, _) => _main.ShowAndSwitch(AppPage.MeetingAssistant));
        _contextMenu.Items.Add(L("Nav.FileManager"), null, (_, _) => _main.ShowAndSwitch(AppPage.FileManager));
        _contextMenu.Items.Add(L("Nav.Cli"), null, (_, _) => _main.LaunchDanceMonkeyCli());
        _contextMenu.Items.Add(new Forms.ToolStripSeparator());
        _contextMenu.Items.Add(L("Tray.QuickScreenshot"), null, (_, _) => QuickScreenshot());
        _contextMenu.Items.Add(L("Tray.RegionScreenshot"), null, (_, _) => RegionScreenshot());
        _contextMenu.Items.Add(L("Tray.ScrollScreenshot"), null, (_, _) => ScrollScreenshot());
        _contextMenu.Items.Add(L("Tray.ContinuousScreenshot"), null, (_, _) => _main.StartContinuousScreenshotMode());
        _contextMenu.Items.Add(new Forms.ToolStripSeparator());
        _contextMenu.Items.Add(L("Tray.DockMode"), null, (_, _) => _main.ShowDockWindow());
        _contextMenu.Items.Add(L("Tray.HideFloating"), null, (_, _) => HideAndDisableInConfig());
        _contextMenu.Items.Add(new Forms.ToolStripSeparator());
        _contextMenu.Items.Add(L("Tray.Exit"), null, (_, _) => _main.QuitFromFloating());
    }

    private void SyncToggleMenuState()
    {
        var cfg = _loadConfig();
        if (_petToggleMenuItem != null)
        {
            _petToggleMenuItem.Checked = cfg.PetModeEnabled;
            _petToggleMenuItem.Text = cfg.PetModeEnabled ? "关闭桌面宠物模式" : "开启桌面宠物模式";
        }
    }

    private void HideAndDisableInConfig()
    {
        var cfg = _loadConfig();
        cfg.PetModeEnabled = false;
        cfg.FloatingIconEnabled = false;
        _saveConfig(cfg);
        _main.SyncPetMode();
    }

    private void CommitPosition()
    {
        var cfg = _loadConfig();
        cfg.FloatingIconX = Left;
        cfg.FloatingIconY = Top;
        _saveConfig(cfg);
    }

    private static string L(string key) => LocalizationManager.Get(key);

    private FormsScreen TargetScreen()
    {
        if (WpfScreenPlacement.TryGetMainWindowCenterPhysical(_main, out var cx, out var cy))
        {
            return FormsScreen.FromPoint(new DrawingPoint(cx, cy))
                   ?? FormsScreen.PrimaryScreen
                   ?? FormsScreen.AllScreens[0];
        }

        return FormsScreen.PrimaryScreen ?? FormsScreen.AllScreens[0];
    }

    private WpfPoint ScreenDevicePixelsToDip(WpfPoint devicePixels)
    {
        var src = PresentationSource.FromVisual(this);
        if (src?.CompositionTarget != null)
            return src.CompositionTarget.TransformFromDevice.Transform(devicePixels);
        return devicePixels;
    }

    private void QuickScreenshot()
    {
        try
        {
            var screen = FormsScreen.FromPoint(Forms.Cursor.Position)
                         ?? FormsScreen.PrimaryScreen
                         ?? FormsScreen.AllScreens[0];
            var bounds = screen.Bounds;

            using var bmp = new Bitmap(bounds.Width, bounds.Height, DrawingPixelFormat.Format32bppArgb);
            using (var g = Graphics.FromImage(bmp))
            {
                g.CopyFromScreen(bounds.Left, bounds.Top, 0, 0, bounds.Size, CopyPixelOperation.SourceCopy);
            }

            var saved = ScreenshotHelper.SavePngAndClipboard(bmp, AppBranding.DisplayName, App.Config.Load().NotesRootPath);
            if (saved != null)
            {
                var p = saved;
                _main.Dispatcher.BeginInvoke(
                    DispatcherPriority.ApplicationIdle,
                    () => _main.OpenScreenshotActions(p));
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show($"截图失败：{ex.Message}", AppBranding.DisplayName,
                MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }

    private void RegionScreenshot() => StartRegionCapture(RegionCaptureForm.CaptureMode.Region);

    private void ScrollScreenshot() => StartRegionCapture(RegionCaptureForm.CaptureMode.Scrolling);

    private void StartRegionCapture(RegionCaptureForm.CaptureMode mode)
    {
        try
        {
            var form = new RegionCaptureForm(
                path =>
                {
                    _main.Dispatcher.BeginInvoke(
                        DispatcherPriority.ApplicationIdle,
                        () => _main.OpenScreenshotActions(path));
                },
                onCancel: null,
                onAiFromPath: path =>
                {
                    _main.Dispatcher.BeginInvoke(
                        DispatcherPriority.ApplicationIdle,
                        () => _main.RunScreenshotAiFromRegion(path));
                },
                onOcrFromPath: path =>
                {
                    _main.Dispatcher.BeginInvoke(
                        DispatcherPriority.ApplicationIdle,
                        () => _main.RunScreenshotOcrFromRegion(path));
                },
                mode: mode,
                notesRootPath: App.Config.Load().NotesRootPath);
            form.Show();
        }
        catch (Exception ex)
        {
            var action = mode == RegionCaptureForm.CaptureMode.Scrolling ? "滚动截图" : "框选截图";
            MessageBox.Show($"{action}失败：{ex.Message}", AppBranding.DisplayName,
                MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }
}
