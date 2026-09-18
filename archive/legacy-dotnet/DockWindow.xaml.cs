using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.Net.Http;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Threading;
using DesktopAssistant.Services;
using Forms = System.Windows.Forms;
using FormsScreen = System.Windows.Forms.Screen;
using DrawingPoint = System.Drawing.Point;

namespace DesktopAssistant;

/// <summary>
/// 桌面 Dock 模式：半透明磨砂玻璃卡片，显示时钟、日期、天气、快捷按钮、快速笔记、搜索。
/// </summary>
public partial class DockWindow : Window
{
    private sealed record DockThemeSpec(
        string Key,
        byte R,
        byte G,
        byte B,
        double Opacity,
        byte PanelAlpha,
        byte DividerAlpha,
        byte QuickAlpha,
        byte QuickHoverAlpha,
        byte QuickPressedAlpha,
        byte ChipAlpha,
        byte ChipHoverAlpha,
        byte ChipActiveAlpha,
        byte InputAlpha,
        byte InputFocusAlpha,
        byte SendAlpha,
        byte SendHoverAlpha);

    private static readonly DockThemeSpec[] DockThemes =
    [
        new("ocean", 0x1A, 0x3A, 0x5C, 0.82, 0x18, 0x1C, 0x22, 0x36, 0x4A, 0x22, 0x38, 0x50, 0x28, 0x3C, 0x22, 0x34),
        new("aurora", 0x16, 0x4E, 0x45, 0.84, 0x22, 0x24, 0x26, 0x3A, 0x50, 0x26, 0x3E, 0x58, 0x2A, 0x40, 0x24, 0x3A),
        new("sunset", 0x5E, 0x34, 0x2A, 0.84, 0x22, 0x22, 0x25, 0x38, 0x4E, 0x25, 0x3D, 0x56, 0x2A, 0x40, 0x22, 0x38),
        new("grape", 0x3E, 0x34, 0x68, 0.84, 0x22, 0x24, 0x26, 0x3A, 0x52, 0x26, 0x3E, 0x58, 0x2A, 0x42, 0x24, 0x3A),
        new("graphite", 0x2A, 0x2E, 0x35, 0.86, 0x24, 0x28, 0x2A, 0x40, 0x58, 0x2A, 0x42, 0x5E, 0x30, 0x46, 0x28, 0x40),
        new("noirpro", 0x12, 0x14, 0x17, 0.90, 0x28, 0x2E, 0x30, 0x48, 0x62, 0x30, 0x4A, 0x68, 0x36, 0x50, 0x30, 0x4A)
    ];

    private readonly MainWindow _main;
    private readonly DispatcherTimer _clockTimer;

    // 拖动支持
    private System.Windows.Point _dragStart;

    // 当前输入模式
    private enum DockInputMode { Ai, ZenTask, Search, LocalSearch }
    private DockInputMode _inputMode = DockInputMode.Ai;

    // 当前 Dock 样式
    private string _currentStyle = "classic";

    // 舞蹈家 Overlay 窗口（选择舞蹈家样式时创建，切换离开或关闭时销毁）

    public DockWindow(MainWindow main)
    {
        InitializeComponent();
        _main = main;

        // 初始化时钟
        _clockTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
        _clockTimer.Tick += ClockTimer_Tick;

        Loaded += OnLoaded;

        // 初始化输入框占位符
        SetPlaceholder(UnifiedInputBox);
        SetPlaceholder(AssistantInputBox);
    }

    private void OnLoaded(object sender, RoutedEventArgs e)
    {
        ApplyThemeFromConfig();
        ApplyDockStyleFromConfig();
        UpdateClock();
        UpdateDate();
        _clockTimer.Start();

        // 异步获取天气
        _ = LoadWeatherAsync();

        // 定位到屏幕右上角
        PositionOnScreen();
    }

    private void ThemeMenuButton_OnClick(object sender, RoutedEventArgs e)
    {
        if (ThemeMenuButton.ContextMenu == null)
            return;
        ThemeMenuButton.ContextMenu.PlacementTarget = ThemeMenuButton;
        ThemeMenuButton.ContextMenu.IsOpen = true;
    }

    private void ThemeMenuItem_OnClick(object sender, RoutedEventArgs e)
    {
        if (sender is not MenuItem { Tag: string key } || string.IsNullOrWhiteSpace(key))
            return;
        ApplyTheme(key);
        var cfg = App.Config.Load();
        cfg.DockTheme = key;
        App.Config.Save(cfg);
    }

    private void ApplyThemeFromConfig()
    {
        var cfg = App.Config.Load();
        ApplyTheme(cfg.DockTheme);
    }

    private void ApplyTheme(string? themeKey)
    {
        var key = string.IsNullOrWhiteSpace(themeKey) ? "ocean" : themeKey.Trim().ToLowerInvariant();
        var spec = DockThemes.FirstOrDefault(t => t.Key == key) ?? DockThemes[0];

        Resources["DockThemeCardBrush"] = new System.Windows.Media.SolidColorBrush(
            System.Windows.Media.Color.FromRgb(spec.R, spec.G, spec.B))
        {
            Opacity = spec.Opacity
        };
        Resources["DockThemeCardBorderBrush"] = new System.Windows.Media.SolidColorBrush(
            System.Windows.Media.Color.FromArgb(0x50, 0xFF, 0xFF, 0xFF));
        Resources["DockThemePanelBrush"] = new System.Windows.Media.SolidColorBrush(
            System.Windows.Media.Color.FromArgb(spec.PanelAlpha, 0xFF, 0xFF, 0xFF));
        Resources["DockThemeDividerBrush"] = new System.Windows.Media.SolidColorBrush(
            System.Windows.Media.Color.FromArgb(spec.DividerAlpha, 0xFF, 0xFF, 0xFF));
        Resources["DockThemeQuickBtnBrush"] = new System.Windows.Media.SolidColorBrush(
            System.Windows.Media.Color.FromArgb(spec.QuickAlpha, 0xFF, 0xFF, 0xFF));
        Resources["DockThemeQuickBtnHoverBrush"] = new System.Windows.Media.SolidColorBrush(
            System.Windows.Media.Color.FromArgb(spec.QuickHoverAlpha, 0xFF, 0xFF, 0xFF));
        Resources["DockThemeQuickBtnPressedBrush"] = new System.Windows.Media.SolidColorBrush(
            System.Windows.Media.Color.FromArgb(spec.QuickPressedAlpha, 0xFF, 0xFF, 0xFF));
        Resources["DockThemeChipBrush"] = new System.Windows.Media.SolidColorBrush(
            System.Windows.Media.Color.FromArgb(spec.ChipAlpha, 0xFF, 0xFF, 0xFF));
        Resources["DockThemeChipHoverBrush"] = new System.Windows.Media.SolidColorBrush(
            System.Windows.Media.Color.FromArgb(spec.ChipHoverAlpha, 0xFF, 0xFF, 0xFF));
        Resources["DockThemeChipActiveBrush"] = new System.Windows.Media.SolidColorBrush(
            System.Windows.Media.Color.FromArgb(spec.ChipActiveAlpha, 0xFF, 0xFF, 0xFF));
        Resources["DockThemeInputBrush"] = new System.Windows.Media.SolidColorBrush(
            System.Windows.Media.Color.FromArgb(spec.InputAlpha, 0xFF, 0xFF, 0xFF));
        Resources["DockThemeInputFocusBrush"] = new System.Windows.Media.SolidColorBrush(
            System.Windows.Media.Color.FromArgb(spec.InputFocusAlpha, 0xFF, 0xFF, 0xFF));
        Resources["DockThemeSendBtnBrush"] = new System.Windows.Media.SolidColorBrush(
            System.Windows.Media.Color.FromArgb(spec.SendAlpha, 0xFF, 0xFF, 0xFF));
        Resources["DockThemeSendBtnHoverBrush"] = new System.Windows.Media.SolidColorBrush(
            System.Windows.Media.Color.FromArgb(spec.SendHoverAlpha, 0xFF, 0xFF, 0xFF));

        UpdateThemeMenuChecks(spec.Key);
    }

    private void UpdateThemeMenuChecks(string selectedKey)
    {
        if (ThemeMenu == null)
            return;

        foreach (var item in ThemeMenu.Items)
        {
            if (item is not MenuItem menuItem || menuItem.Tag is not string key)
                continue;
            var selected = string.Equals(key, selectedKey, StringComparison.OrdinalIgnoreCase);
            menuItem.IsChecked = selected;
        }
    }

    // ═══════════════ 时钟 & 日期 ═══════════════

    private void ClockTimer_Tick(object? sender, EventArgs e)
    {
        UpdateClock();
        // 每分钟更新一次日期
        if (DateTime.Now.Second == 0)
            UpdateDate();
    }

    private void UpdateClock()
    {
        var now = DateTime.Now;
        var hh = now.ToString("HH");
        var mm = now.ToString("mm");
        if (ClockHour != null) ClockHour.Text = hh;
        if (ClockMinute != null) ClockMinute.Text = mm;
        if (ClockHourAst != null) ClockHourAst.Text = hh;
        if (ClockMinuteAst != null) ClockMinuteAst.Text = mm;
    }

    private void UpdateDate()
    {
        var now = DateTime.Now;
        var culture = new CultureInfo("zh-CN");
        var dayOfWeek = now.ToString("dddd", culture);
        var dateStr = $"{now.Month}月{now.Day}日  {dayOfWeek}";

        // 尝试获取农历
        try
        {
            var lunar = new ChineseLunisolarCalendar();
            var lunarYear = lunar.GetYear(now);
            var lunarMonth = lunar.GetMonth(now);
            var lunarDay = lunar.GetDayOfMonth(now);

            // 处理闰月
            var leapMonth = lunar.GetLeapMonth(lunarYear);
            var actualMonth = lunarMonth;
            if (leapMonth > 0 && lunarMonth >= leapMonth)
                actualMonth = lunarMonth - 1;

            var monthNames = new[] { "", "正月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "冬月", "腊月" };
            var dayNames = new[]
            {
                "", "初一", "初二", "初三", "初四", "初五", "初六", "初七", "初八", "初九", "初十",
                "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十",
                "廿一", "廿二", "廿三", "廿四", "廿五", "廿六", "廿七", "廿八", "廿九", "三十"
            };

            // 天干地支
            var heavenlyStems = new[] { "甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸" };
            var earthlyBranches = new[] { "子", "丑", "寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥" };
            var animals = new[] { "鼠", "牛", "虎", "兔", "龙", "蛇", "马", "羊", "猴", "鸡", "狗", "猪" };

            var stemIdx = (lunarYear - 4) % 10;
            var branchIdx = (lunarYear - 4) % 12;
            var ganZhi = $"{heavenlyStems[stemIdx]}{earthlyBranches[branchIdx]}";
            var animal = animals[branchIdx];

            var lunarMonthName = actualMonth >= 1 && actualMonth <= 12 ? monthNames[actualMonth] : "?";
            var lunarDayName = lunarDay >= 1 && lunarDay <= 30 ? dayNames[lunarDay] : "?";

            dateStr += $"  {ganZhi}·{animal}·{lunarMonthName}{lunarDayName}";
        }
        catch
        {
            // 忽略农历计算失败
        }

        DateLabel.Text = dateStr;
        if (DateLabelAst != null) DateLabelAst.Text = dateStr;
    }

    // ═══════════════ 天气 ═══════════════

    private async Task LoadWeatherAsync()
    {
        try
        {
            var cfg = App.Config.Load();
            var city = string.IsNullOrWhiteSpace(cfg.WeatherCity) ? "" : cfg.WeatherCity.Trim();

            // 使用 wttr.in 免费 API（无需 Key），指定城市
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
            var url = string.IsNullOrEmpty(city)
                ? "https://wttr.in/?format=j1&lang=zh"
                : $"https://wttr.in/{Uri.EscapeDataString(city)}?format=j1&lang=zh";

            var json = await http.GetStringAsync(url).ConfigureAwait(false);
            var doc = JsonDocument.Parse(json);
            var current = doc.RootElement.GetProperty("current_condition")[0];
            var tempC = current.GetProperty("temp_C").GetString();

            // 尝试获取中文描述
            string? desc = null;
            if (current.TryGetProperty("lang_zh", out var langZh) && langZh.GetArrayLength() > 0)
                desc = langZh[0].GetProperty("value").GetString();
            desc ??= current.GetProperty("weatherDesc")[0].GetProperty("value").GetString();

            var weatherCode = current.GetProperty("weatherCode").GetString();
            var icon = GetWeatherEmoji(weatherCode);

            // 获取地点名
            var area = "";
            if (doc.RootElement.TryGetProperty("nearest_area", out var nearestArea) && nearestArea.GetArrayLength() > 0)
            {
                var areaObj = nearestArea[0];
                if (areaObj.TryGetProperty("areaName", out var an) && an.GetArrayLength() > 0)
                    area = an[0].GetProperty("value").GetString() ?? "";
            }

            var displayCity = !string.IsNullOrEmpty(city) ? city : area;
            var cityLabel = !string.IsNullOrEmpty(displayCity) ? $"[{displayCity}] " : "";

            Dispatcher.Invoke(() =>
            {
                WeatherIcon.Text = icon;
                WeatherText.Text = $"{cityLabel}{tempC}°C  {desc}";
                if (WeatherIconAst != null) WeatherIconAst.Text = icon;
                if (WeatherTextAst != null) WeatherTextAst.Text = $"{cityLabel}{tempC}°C  {desc}";
            });
        }
        catch
        {
            Dispatcher.Invoke(() =>
            {
                WeatherIcon.Text = "🌤";
                WeatherText.Text = L("Dock.WeatherFailed");
                if (WeatherIconAst != null) WeatherIconAst.Text = "🌤";
                if (WeatherTextAst != null) WeatherTextAst.Text = L("Dock.WeatherFailed");
            });
        }
    }

    /// <summary>点击 📍 设置天气城市。</summary>
    private void BtnWeatherCity_OnClick(object sender, RoutedEventArgs e)
    {
        var cfg = App.Config.Load();
        var current = cfg.WeatherCity ?? "";

        // 简易输入对话框
        var dlg = new Window
        {
            Title = L("Dock.SetWeatherCity"),
            Width = 380,
            Height = 180,
            WindowStartupLocation = WindowStartupLocation.CenterScreen,
            WindowStyle = WindowStyle.ToolWindow,
            ResizeMode = ResizeMode.NoResize,
            Topmost = true,
            Background = new System.Windows.Media.SolidColorBrush(
                System.Windows.Media.Color.FromRgb(0x2B, 0x2B, 0x2B)),
        };

        var sp = new System.Windows.Controls.StackPanel { Margin = new Thickness(16) };
        sp.Children.Add(new System.Windows.Controls.TextBlock
        {
            Text = "请输入天气城市名称（英文，如 Shanghai、Beijing、London）。\n留空则自动根据 IP 定位。",
            Foreground = System.Windows.Media.Brushes.White,
            FontSize = 12.5,
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 0, 0, 10)
        });

        var tb = new System.Windows.Controls.TextBox
        {
            Text = current,
            FontSize = 14,
            Padding = new Thickness(6, 4, 6, 4),
            Margin = new Thickness(0, 0, 0, 12)
        };
        sp.Children.Add(tb);

        var btnPanel = new System.Windows.Controls.StackPanel
        {
            Orientation = System.Windows.Controls.Orientation.Horizontal,
            HorizontalAlignment = HorizontalAlignment.Right
        };
        var btnOk = new System.Windows.Controls.Button
        {
            Content = "确定",
            Width = 70,
            Height = 28,
            Margin = new Thickness(0, 0, 8, 0),
            IsDefault = true
        };
        var btnCancel = new System.Windows.Controls.Button
        {
            Content = "取消",
            Width = 70,
            Height = 28,
            IsCancel = true
        };
        btnOk.Click += (_, _) => { dlg.DialogResult = true; dlg.Close(); };
        btnPanel.Children.Add(btnOk);
        btnPanel.Children.Add(btnCancel);
        sp.Children.Add(btnPanel);
        dlg.Content = sp;

        if (dlg.ShowDialog() != true) return;

        var input = tb.Text?.Trim() ?? "";
        if (input == current) return;

        cfg.WeatherCity = input;
        App.Config.Save(cfg);

        // 立即刷新天气
        WeatherText.Text = L("Dock.FetchingWeather");
        _ = LoadWeatherAsync();
    }

    private static string GetWeatherEmoji(string? code)
    {
        return code switch
        {
            "113" => "☀",      // Sunny / Clear
            "116" => "⛅",     // Partly Cloudy
            "119" => "☁",      // Cloudy
            "122" => "☁",      // Overcast
            "143" or "248" or "260" => "🌫", // Mist / Fog
            "176" or "263" or "266" or "293" or "296" => "🌦",  // Light rain
            "299" or "302" or "305" or "308" => "🌧",           // Heavy rain
            "200" or "386" or "389" or "392" or "395" => "⛈",  // Thunder
            "179" or "182" or "185" or "227" or "230" => "🌨",  // Snow
            "311" or "314" or "317" or "320" or "323" or "326" or "329" or "332" or "335" or "338" or "350" or "353" or "356" or "359" or "362" or "365" or "368" or "371" or "374" or "377" => "🌧",
            _ => "🌤"
        };
    }

    // ═══════════════ 拖动 ═══════════════

    private void Card_OnMouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        if (e.ClickCount == 1)
        {
        _dragStart = PointToScreen(e.GetPosition(this));
            DragMove();
        }
    }

    // ═══════════════ 标题栏按钮 ═══════════════

    private void BtnCloseDock_OnClick(object sender, RoutedEventArgs e)
    {
        Hide();
    }

    // ═══════════════ 快捷按钮 ═══════════════

    private void Btn_AiChat_OnClick(object sender, RoutedEventArgs e)
        => _main.ShowAndSwitch(AppPage.AiChat);

    private void Btn_Notes_OnClick(object sender, RoutedEventArgs e)
        => _main.ShowAndSwitch(AppPage.Notes);

    private void Btn_ZenTask_OnClick(object sender, RoutedEventArgs e)
        => _main.ShowAndSwitch(AppPage.Todo);

    private void Btn_QuickAccess_OnClick(object sender, RoutedEventArgs e)
    {
        var popup = new Views.QuickAccessPopup();
        popup.Show();
        popup.Activate();
    }

    private void Btn_FileTools_OnClick(object sender, RoutedEventArgs e)
        => _main.ShowAndSwitch(AppPage.FileTools);

    private void Btn_Screenshot_OnClick(object sender, RoutedEventArgs e)
    {
        var menu = new Forms.ContextMenuStrip();
        menu.Items.Add(L("Tray.RegionScreenshot"), null, (_, _) => StartRegionCapture(RegionCaptureForm.CaptureMode.Region));
        menu.Items.Add(L("Tray.ScrollScreenshot"), null, (_, _) => StartRegionCapture(RegionCaptureForm.CaptureMode.Scrolling));
        menu.Items.Add(L("Tray.ContinuousScreenshot"), null, (_, _) => _main.StartContinuousScreenshotMode());
        var p = Forms.Cursor.Position;
        menu.Show(p);
    }

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

    private void Btn_CodexProxy_OnClick(object sender, RoutedEventArgs e)
        => _main.OpenCodexProxyFromDock();

    private void Btn_Cli_OnClick(object sender, RoutedEventArgs e)
        => _main.LaunchDanceMonkeyCli();

    // ═══════════════ 标签切换 ═══════════════

    private void DockTab_Checked(object sender, RoutedEventArgs e)
    {
        if (sender == TabAi) _inputMode = DockInputMode.Ai;
        else if (sender == TabTask) _inputMode = DockInputMode.ZenTask;
        else if (sender == TabSearch) _inputMode = DockInputMode.Search;
        else if (sender == TabLocalSearch) _inputMode = DockInputMode.LocalSearch;

        UpdateInputPlaceholder();
    }

    private void UpdateInputPlaceholder()
    {
        if (UnifiedInputBox == null) return;

        var placeholder = _inputMode switch
        {
            DockInputMode.Ai => "输入 AI 问题…",
            DockInputMode.ZenTask => L("Dock.PlaceholderZenTask"),
            DockInputMode.Search => "搜索网页…",
            DockInputMode.LocalSearch => "搜索本地文件…",
            _ => "输入…"
        };

        UnifiedInputBox.Tag = placeholder;

        // 仅当输入框没有用户输入时更新显示
        if (string.IsNullOrEmpty(UnifiedInputBox.Text) || !UnifiedInputBox.IsFocused)
        {
            UnifiedInputBox.Text = "";
            SetPlaceholder(UnifiedInputBox);
        }
    }

    // ═══════════════ 统一输入框 ═══════════════

    private void UnifiedInputBox_KeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key != Key.Enter) return;
        e.Handled = true;
        ExecuteUnifiedAction();
    }

    private void BtnUnifiedSend_OnClick(object sender, RoutedEventArgs e)
    {
        ExecuteUnifiedAction();
    }

    private void ExecuteUnifiedAction()
    {
        var text = UnifiedInputBox.Text?.Trim();
        if (string.IsNullOrEmpty(text) || text == (string)UnifiedInputBox.Tag)
            return;

        switch (_inputMode)
        {
            case DockInputMode.Ai:
                ExecuteAiAction(text);
                break;
            case DockInputMode.ZenTask:
                ExecuteZenTaskQuickAdd(text);
                break;
            case DockInputMode.Search:
                ExecuteSearchAction(text);
                break;
            case DockInputMode.LocalSearch:
                ExecuteLocalSearchAction(text);
                break;
        }

        UnifiedInputBox.Text = "";
        SetPlaceholder(UnifiedInputBox);
    }

    private void ExecuteAiAction(string question)
    {
        // 打开全局对话并自动发送问题
        _main.OpenGlobalChatWithQuestion(question);
    }

    private void ExecuteZenTaskQuickAdd(string title)
    {
        try
        {
            _main.QuickAddZenTaskFromDock(title);
        }
        catch (Exception ex)
        {
            MessageBox.Show($"Zen Task：{ex.Message}", AppBranding.DisplayName,
                MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }

    private void ExecuteSearchAction(string query)
    {
        if (query.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
            query.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
        {
            try { Process.Start(new ProcessStartInfo(query) { UseShellExecute = true }); }
            catch { /* 忽略 */ }
        }
        else
        {
            var url = $"https://www.bing.com/search?q={Uri.EscapeDataString(query)}";
            try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
            catch { /* 忽略 */ }
        }
    }

    private void ExecuteLocalSearchAction(string keyword)
    {
        // 使用 Windows 搜索协议打开资源管理器搜索
        try
        {
            var userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            var searchUrl = $"search-ms:displayname=搜索结果&crumb=System.Generic.String%3A{Uri.EscapeDataString(keyword)}&crumb=location:{Uri.EscapeDataString(userProfile)}";
            Process.Start(new ProcessStartInfo(searchUrl) { UseShellExecute = true });
        }
        catch
        {
            // 回退：使用 explorer /search 方式
            try
            {
                var userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                Process.Start("explorer.exe", $"/search,{keyword} \"{userProfile}\"");
            }
            catch { /* 忽略 */ }
        }
    }

    // ═══════════════ 占位符辅助 ═══════════════

    private static void SetPlaceholder(System.Windows.Controls.TextBox tb)
    {
        if (string.IsNullOrEmpty(tb.Text))
        {
            tb.Text = (string)tb.Tag;
            tb.Foreground = new System.Windows.Media.SolidColorBrush(
                System.Windows.Media.Color.FromArgb(0x70, 0xFF, 0xFF, 0xFF));
        }
    }

    private void InputBox_GotFocus(object sender, RoutedEventArgs e)
    {
        if (sender is System.Windows.Controls.TextBox tb && tb.Text == (string)tb.Tag)
        {
            tb.Text = "";
            tb.Foreground = System.Windows.Media.Brushes.White;
        }
    }

    private void InputBox_LostFocus(object sender, RoutedEventArgs e)
    {
        if (sender is System.Windows.Controls.TextBox tb)
            SetPlaceholder(tb);
    }

    // ═══════════════ 定位 ═══════════════

    private void PositionOnScreen()
    {
        var screen = FormsScreen.PrimaryScreen ?? FormsScreen.AllScreens[0];
        var wa = WpfScreenPlacement.GetWorkingAreaDip(screen);

        const double margin = 20;
        Left = wa.Right - Width - margin;
        Top = wa.Top + margin;
    }

    public void ShowDock()
    {
        Show();
        Activate();
    }

    protected override void OnClosing(System.ComponentModel.CancelEventArgs e)
    {
        // 不真正关闭，只隐藏
        e.Cancel = true;
        Hide();
    }

    protected override void OnClosed(EventArgs e)
    {
        _clockTimer.Stop();
        base.OnClosed(e);
    }

    // ═══════════════ Dock 样式切换（经典 / 桌面助手 / 舞蹈家） ═══════════════

    private void StyleMenuItem_OnClick(object sender, RoutedEventArgs e)
    {
        if (sender is not MenuItem { Tag: string key } || string.IsNullOrWhiteSpace(key))
            return;
        ApplyDockStyle(key);
        var cfg = App.Config.Load();
        cfg.DockStyle = key;
        App.Config.Save(cfg);
    }

    private void ApplyDockStyleFromConfig()
    {
        var cfg = App.Config.Load();
        ApplyDockStyle(cfg.DockStyle);
    }

    private void ApplyDockStyle(string? styleKey)
    {
        var key = string.IsNullOrWhiteSpace(styleKey) ? "classic" : styleKey.Trim().ToLowerInvariant();
        if (key is not ("classic" or "assistant"))
            key = "classic";

        _currentStyle = key;

        if (ClassicLayout != null)
            ClassicLayout.Visibility = key == "classic" ? Visibility.Visible : Visibility.Collapsed;
        if (AssistantLayout != null)
            AssistantLayout.Visibility = key == "assistant" ? Visibility.Visible : Visibility.Collapsed;

        // 根据样式调整窗口宽度
        Width = key switch
        {
            "assistant" => 300,
            _ => 320
        };

        UpdateStyleMenuChecks(key);

    }

    private void UpdateStyleMenuChecks(string selectedKey)
    {
        if (StyleMenuClassic != null) StyleMenuClassic.IsChecked = selectedKey == "classic";
        if (StyleMenuAssistant != null) StyleMenuAssistant.IsChecked = selectedKey == "assistant";
    }

    // ═══════════════ 桌面助手模式输入框 ═══════════════

    private void AssistantInputBox_KeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key != Key.Enter) return;
        e.Handled = true;
        ExecuteAssistantAction();
    }

    private void BtnAssistantSend_OnClick(object sender, RoutedEventArgs e)
    {
        ExecuteAssistantAction();
    }

    private void ExecuteAssistantAction()
    {
        var text = AssistantInputBox.Text?.Trim();
        if (string.IsNullOrEmpty(text) || text == (string)AssistantInputBox.Tag)
            return;
        _main.OpenGlobalChatWithQuestion(text);
        AssistantInputBox.Text = "";
        SetPlaceholder(AssistantInputBox);
    }

    private static string L(string key) => LocalizationManager.Get(key);
}
