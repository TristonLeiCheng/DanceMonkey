using System.IO;
using System.Net;
using DesktopAssistant;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Shapes;
using System.Windows.Media.Imaging;
using Microsoft.Web.WebView2.Wpf;

namespace DesktopAssistant.Services;

/// <summary>
/// 截图后的 AI 分析 / OCR，供结果窗口与框选工具栏共用。
/// </summary>
public static class ScreenshotAnalysisHelper
{
    public static async Task RunAiAnalysisAsync(string imagePath, Window? owner, string dialogTitle)
    {
        if (!File.Exists(imagePath))
        {
            MessageBox.Show("图片文件不存在。", dialogTitle, MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        var cfg = App.Config.Load();
        if (string.IsNullOrWhiteSpace(cfg.ApiKey))
        {
            MessageBox.Show("请先在「设置」中配置 API 密钥与端点。", dialogTitle, MessageBoxButton.OK,
                MessageBoxImage.Warning);
            return;
        }

        Window? analyzingWindow = null;
        try
        {
            analyzingWindow = CreateAnalyzingWindow(owner);
            analyzingWindow.Show();

            var bytes = await File.ReadAllBytesAsync(imagePath).ConfigureAwait(true);
            var client = new OpenAiApiClient(cfg);
            var r = await client.CallWithImageAsync(
                """
请结合本截图完成分析，并按系统说明的结构用 Markdown 输出：
- 先描述画面与关键信息；
- 再推断用户可能意图；
- 若意图明确则直接给出可执行结论；若不明确则友好追问。
""",
                bytes,
                maxTokens: 4096).ConfigureAwait(true);

            CloseAnalyzingWindow(analyzingWindow);
            analyzingWindow = null;

            if (r.Success && !string.IsNullOrEmpty(r.Result))
                await ShowMarkdownAnalysisResultAsync(r.Result, imagePath, owner, dialogTitle).ConfigureAwait(true);
            else
                MessageBox.Show(r.Error ?? "未返回内容。", dialogTitle, MessageBoxButton.OK, MessageBoxImage.Warning);
        }
        catch (Exception ex)
        {
            CloseAnalyzingWindow(analyzingWindow);
            analyzingWindow = null;
            MessageBox.Show($"分析失败：{ex.Message}", dialogTitle, MessageBoxButton.OK, MessageBoxImage.Error);
        }
        finally
        {
            CloseAnalyzingWindow(analyzingWindow);
        }
    }

    /// <summary>框选/截图 AI 分析等待窗：不确定进度条 + 文案呼吸动画 + 旋转指示。</summary>
    private static Window CreateAnalyzingWindow(Window? owner)
    {
        var muted = new SolidColorBrush(System.Windows.Media.Color.FromRgb(0x64, 0x74, 0x8B));
        var accent = new SolidColorBrush(System.Windows.Media.Color.FromRgb(0x4F, 0x6E, 0xF7));

        var w = new Window
        {
            Title = "AI 分析中",
            Width = 380,
            Height = 200,
            WindowStyle = WindowStyle.None,
            ResizeMode = ResizeMode.NoResize,
            WindowStartupLocation = owner != null
                ? WindowStartupLocation.CenterOwner
                : WindowStartupLocation.CenterScreen,
            Owner = owner,
            ShowInTaskbar = false,
            Topmost = true,
            Background = System.Windows.Media.Brushes.Transparent,
            AllowsTransparency = true
        };

        var outer = new Border
        {
            Margin = new Thickness(16),
            Padding = new Thickness(28, 26, 28, 22),
            CornerRadius = new CornerRadius(16),
            Background = System.Windows.Media.Brushes.White,
            BorderBrush = new SolidColorBrush(System.Windows.Media.Color.FromRgb(0xE2, 0xE8, 0xF0)),
            BorderThickness = new Thickness(1),
            Effect = new System.Windows.Media.Effects.DropShadowEffect
            {
                Color = System.Windows.Media.Colors.Black,
                BlurRadius = 28,
                ShadowDepth = 4,
                Opacity = 0.14
            }
        };

        var sp = new StackPanel { HorizontalAlignment = HorizontalAlignment.Stretch };

        var spinRow = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 0, 0, 14) };
        var ring = new Ellipse
        {
            Width = 36,
            Height = 36,
            Stroke = accent,
            StrokeThickness = 3,
            StrokeDashArray = new DoubleCollection(new[] { 8.0, 99.0 }),
            RenderTransformOrigin = new System.Windows.Point(0.5, 0.5)
        };
        var rotate = new RotateTransform();
        ring.RenderTransform = rotate;
        spinRow.Children.Add(ring);

        var title = new TextBlock
        {
            Text = "AI 正在分析截图",
            FontSize = 16,
            FontWeight = FontWeights.SemiBold,
            Foreground = new SolidColorBrush(System.Windows.Media.Color.FromRgb(0x0F, 0x17, 0x2A)),
            HorizontalAlignment = HorizontalAlignment.Center,
            Margin = new Thickness(0, 0, 0, 8)
        };

        var sub = new TextBlock
        {
            Text = "请稍候，正在请求模型理解画面内容…",
            FontSize = 12,
            Foreground = muted,
            TextWrapping = TextWrapping.Wrap,
            TextAlignment = TextAlignment.Center,
            HorizontalAlignment = HorizontalAlignment.Center,
            Margin = new Thickness(0, 0, 0, 16),
            Opacity = 0.92
        };

        var pb = new ProgressBar
        {
            Height = 4,
            IsIndeterminate = true,
            Foreground = accent,
            Background = new SolidColorBrush(System.Windows.Media.Color.FromRgb(0xF1, 0xF5, 0xF9)),
            BorderThickness = new Thickness(0)
        };

        sp.Children.Add(spinRow);
        sp.Children.Add(title);
        sp.Children.Add(sub);
        sp.Children.Add(pb);
        outer.Child = sp;
        w.Content = outer;

        w.Loaded += (_, _) =>
        {
            var spinAnim = new DoubleAnimation(0, 360, TimeSpan.FromSeconds(1.1))
            {
                RepeatBehavior = RepeatBehavior.Forever
            };
            rotate.BeginAnimation(RotateTransform.AngleProperty, spinAnim);

            var pulse = new DoubleAnimation(0.45, 1.0, TimeSpan.FromSeconds(1.0))
            {
                AutoReverse = true,
                RepeatBehavior = RepeatBehavior.Forever
            };
            sub.BeginAnimation(UIElement.OpacityProperty, pulse);
        };

        return w;
    }

    private static void CloseAnalyzingWindow(Window? win)
    {
        if (win == null) return;
        try
        {
            win.Close();
        }
        catch
        {
            /* 窗口可能已关闭 */
        }
    }

    public static async Task RunOcrAsync(string imagePath, Window? owner, string dialogTitle)
    {
        if (!File.Exists(imagePath))
        {
            MessageBox.Show("图片文件不存在。", dialogTitle, MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        try
        {
            var text = await ScreenshotOcrService.RecognizeTextFromImageFileAsync(imagePath).ConfigureAwait(true);
            if (string.IsNullOrWhiteSpace(text))
                MessageBox.Show("未识别到文字（或图片中无文本）。", dialogTitle, MessageBoxButton.OK,
                    MessageBoxImage.Information);
            else
                ShowLongTextDialog("提取的文字", text, owner);
        }
        catch (Exception ex)
        {
            MessageBox.Show($"OCR 失败：{ex.Message}", dialogTitle, MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }

    private static async Task ShowMarkdownAnalysisResultAsync(
        string markdown,
        string screenshotImagePath,
        Window? owner,
        string parentTitle)
    {
        var w = new Window
        {
            Title = "AI 截图分析",
            Width = 640,
            Height = 560,
            MinWidth = 400,
            MinHeight = 360,
            WindowStartupLocation = owner != null
                ? WindowStartupLocation.CenterOwner
                : WindowStartupLocation.CenterScreen,
            Owner = owner,
            Background = owner?.TryFindResource("BrushPageBg") as System.Windows.Media.Brush
        };

        var root = new Grid { Margin = new Thickness(12) };
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

        var web = new WebView2 { MinHeight = 280 };
        Grid.SetRow(web, 0);

        var bar = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            HorizontalAlignment = HorizontalAlignment.Right,
            Margin = new Thickness(0, 12, 0, 0)
        };
        var btnContinue = new Button
        {
            Content = "继续对话",
            ToolTip = "打开全局对话，结合本次分析继续追问",
            Margin = new Thickness(0, 0, 8, 0),
            Padding = new Thickness(16, 8, 16, 8)
        };
        if (owner?.TryFindResource("UiBtnAccentBlue") is Style s1)
            btnContinue.Style = s1;
        var btnClose = new Button { Content = "关闭", Padding = new Thickness(16, 8, 16, 8) };
        if (owner?.TryFindResource("UiBtnSecondary") is Style s2)
            btnClose.Style = s2;

        var snapshot = markdown;
        btnContinue.Click += (_, _) => { w.DialogResult = true; };
        btnClose.Click += (_, _) => { w.DialogResult = false; };

        bar.Children.Add(btnContinue);
        bar.Children.Add(btnClose);
        Grid.SetRow(bar, 1);
        root.Children.Add(web);
        root.Children.Add(bar);
        w.Content = root;

        var webPrepared = false;
        w.ContentRendered += async (_, _) =>
        {
            if (webPrepared)
                return;
            webPrepared = true;
            try
            {
                await web.EnsureCoreWebView2Async(null).ConfigureAwait(true);
                var html = MarkdownHtml.WrapFullDocument(MarkdownHtml.ToHtmlBody(markdown));
                web.NavigateToString(html);
            }
            catch (Exception ex)
            {
                try
                {
                    await web.EnsureCoreWebView2Async(null).ConfigureAwait(true);
                    var fallback =
                        $"<p style=\"color:#b91c1c\">{WebUtility.HtmlEncode(ex.Message)}</p><pre style=\"white-space:pre-wrap\">{WebUtility.HtmlEncode(markdown)}</pre>";
                    web.NavigateToString(
                        "<!DOCTYPE html><html><head><meta charset=\"utf-8\"/></head><body>" + fallback +
                        "</body></html>");
                }
                catch
                {
                    // 忽略
                }
            }
        };

        w.ShowDialog();

        if (w.DialogResult == true)
            OpenGlobalChatWithScreenshotAnalysis(snapshot, screenshotImagePath);
    }

    private static void OpenGlobalChatWithScreenshotAnalysis(string analysisMarkdown, string screenshotImagePath)
    {
        if (Application.Current.MainWindow is MainWindow main)
            main.OpenGlobalChatWithScreenshotAnalysis(analysisMarkdown, screenshotImagePath);
    }

    private static void ShowLongTextDialog(string dialogTitle, string body, Window? owner)
    {
        var w = new Window
        {
            Title = dialogTitle,
            Width = 560,
            Height = 440,
            WindowStartupLocation = owner != null
                ? WindowStartupLocation.CenterOwner
                : WindowStartupLocation.CenterScreen,
            Owner = owner,
            Background = owner?.TryFindResource("BrushPageBg") as System.Windows.Media.Brush
        };
        var grid = new Grid { Margin = new Thickness(16) };
        grid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        var tb = new TextBox
        {
            Text = body,
            IsReadOnly = true,
            TextWrapping = TextWrapping.Wrap,
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            AcceptsReturn = true,
            FontSize = 13
        };
        if (owner?.TryFindResource("UiResultBox") is Style st)
            tb.Style = st;
        Grid.SetRow(tb, 0);
        var btn = new Button
        {
            Content = "关闭",
            Margin = new Thickness(0, 12, 0, 0),
            HorizontalAlignment = HorizontalAlignment.Right,
            MinWidth = 100
        };
        if (owner?.TryFindResource("UiBtnPrimary") is Style bst)
            btn.Style = bst;
        btn.Click += (_, _) => w.Close();
        Grid.SetRow(btn, 1);
        grid.Children.Add(tb);
        grid.Children.Add(btn);
        w.Content = grid;
        w.ShowDialog();
    }
}
