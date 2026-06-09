using System.Windows;
using System.Windows.Media.Animation;
using DesktopAssistant.Services;

namespace DesktopAssistant;

public partial class HealthReminderWindow : Window
{
    private readonly HealthReminderType _type;
    private readonly HealthReminderService _service;

    /// <summary>今日喝水次数。</summary>
    public static int TodayWaterCount { get; private set; }

    /// <summary>今日运动次数。</summary>
    public static int TodayExerciseCount { get; private set; }

    private static DateTime _statsDate = DateTime.Today;

    public HealthReminderWindow(HealthReminderType type, HealthReminderService service)
    {
        InitializeComponent();
        _type = type;
        _service = service;
        Loaded += (_, _) =>
        {
            Activate();
            Topmost = true;
            Focus();
        };

        // 每日重置统计
        if (DateTime.Today != _statsDate)
        {
            _statsDate = DateTime.Today;
            TodayWaterCount = 0;
            TodayExerciseCount = 0;
        }

        ApplyType();
    }

    private void ApplyType()
    {
        if (_type == HealthReminderType.DrinkWater)
        {
            IconText.Text = "💧";
            TitleText.Text = L("Health.WaterTitle");
            DescText.Text = L("Health.WaterDesc");
            DoneBtnIcon.Text = "✅";
            DoneBtnText.Text = L("Health.WaterDone");
            StatsText.Text = string.Format(L("Health.WaterStats"), TodayWaterCount);
            LaterBtn.Content = "稍后再喝";
        }
        else
        {
            IconText.Text = "🏃";
            TitleText.Text = L("Health.StandTitle");
            DescText.Text = L("Health.StandDesc");
            DoneBtnIcon.Text = "💪";
            DoneBtnText.Text = L("Health.StandDone");
            StatsText.Text = string.Format(L("Health.StandStats"), TodayExerciseCount);
            LaterBtn.Content = "稍后去动";
        }
    }

    private void Done_OnClick(object sender, RoutedEventArgs e)
    {
        if (_type == HealthReminderType.DrinkWater)
        {
            TodayWaterCount++;
            _service.AcknowledgeWater();
        }
        else
        {
            TodayExerciseCount++;
            _service.AcknowledgeMovement();
        }
        CloseWithAnimation();
    }

    private void Later_OnClick(object sender, RoutedEventArgs e) => CloseWithAnimation();
    private void Close_OnClick(object sender, RoutedEventArgs e) => CloseWithAnimation();

    private void CloseWithAnimation()
    {
        var anim = new DoubleAnimation(1, 0, TimeSpan.FromMilliseconds(180));
        anim.Completed += (_, _) => Close();
        BeginAnimation(OpacityProperty, anim);
    }

    private static string L(string key) => LocalizationManager.Get(key);
}
