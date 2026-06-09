using System.Windows;
using System.Windows.Controls;
using System.Windows.Data;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;
using MediaBrushes = System.Windows.Media.Brushes;
using MediaColor = System.Windows.Media.Color;

namespace DesktopAssistant;

public sealed class ContinuousScreenshotOverlayWindow : Window
{
    private readonly TextBlock _countBadgeText;
    private readonly Border _savedBadge;
    private readonly TextBlock _savedText;

    public event Action? CaptureRequested;
    public event Action? FinishRequested;

    public ContinuousScreenshotOverlayWindow()
    {
        Width = 146;
        Height = 62;
        WindowStyle = WindowStyle.None;
        ResizeMode = ResizeMode.NoResize;
        AllowsTransparency = true;
        Background = MediaBrushes.Transparent;
        Topmost = true;
        ShowInTaskbar = false;
        ShowActivated = false;

        var root = new Border
        {
            CornerRadius = new CornerRadius(19),
            BorderThickness = new Thickness(1),
            BorderBrush = new SolidColorBrush(MediaColor.FromArgb(55, 255, 255, 255)),
            Background = new SolidColorBrush(MediaColor.FromArgb(150, 20, 22, 28)),
            Padding = new Thickness(8, 7, 8, 7)
        };

        var layout = new Grid();
        var buttonsRow = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            HorizontalAlignment = HorizontalAlignment.Left,
            VerticalAlignment = VerticalAlignment.Center
        };
        const string glyphCamera = "\U0001F4F7";
        const string glyphCheck = "\u2714";
        var captureBtn = BuildRoundButton(
            glyphCamera,
            "截图（框选）",
            OnCaptureClick,
            MediaColor.FromArgb(160, 65, 126, 253),
            18);
        var finishBtn = BuildRoundButton(
            glyphCheck,
            "完成并打开文档",
            OnFinishClick,
            MediaColor.FromArgb(160, 38, 166, 91),
            18);
        finishBtn.Margin = new Thickness(8, 0, 0, 0);
        buttonsRow.Children.Add(captureBtn);
        buttonsRow.Children.Add(finishBtn);

        var countBadge = new Border
        {
            HorizontalAlignment = HorizontalAlignment.Right,
            VerticalAlignment = VerticalAlignment.Top,
            MinWidth = 20,
            Height = 20,
            Padding = new Thickness(5, 0, 5, 0),
            CornerRadius = new CornerRadius(10),
            Background = new SolidColorBrush(MediaColor.FromArgb(210, 239, 77, 77)),
            BorderThickness = new Thickness(1),
            BorderBrush = new SolidColorBrush(MediaColor.FromArgb(130, 255, 255, 255))
        };
        _countBadgeText = new TextBlock
        {
            Foreground = new SolidColorBrush(MediaColor.FromArgb(250, 255, 255, 255)),
            VerticalAlignment = VerticalAlignment.Center,
            HorizontalAlignment = HorizontalAlignment.Center,
            TextAlignment = TextAlignment.Center,
            FontSize = 10,
            FontWeight = FontWeights.SemiBold,
            Text = "0"
        };
        countBadge.Child = _countBadgeText;

        _savedBadge = new Border
        {
            HorizontalAlignment = HorizontalAlignment.Right,
            VerticalAlignment = VerticalAlignment.Bottom,
            Margin = new Thickness(0, 0, 0, -22),
            Padding = new Thickness(6, 2, 6, 2),
            CornerRadius = new CornerRadius(7),
            Background = new SolidColorBrush(MediaColor.FromArgb(195, 58, 165, 116)),
            Opacity = 0
        };
        _savedText = new TextBlock
        {
            Foreground = new SolidColorBrush(MediaColor.FromArgb(248, 255, 255, 255)),
            FontSize = 10,
            Text = "已保存"
        };
        _savedBadge.Child = _savedText;

        layout.Children.Add(buttonsRow);
        layout.Children.Add(countBadge);
        layout.Children.Add(_savedBadge);
        root.Child = layout;
        Content = root;

        MouseLeftButtonDown += (_, e) =>
        {
            if (e.ButtonState == MouseButtonState.Pressed)
                DragMove();
        };
    }

    public void UpdateCount(int count)
    {
        _countBadgeText.Text = count > 99 ? "99+" : count.ToString();
    }

    public void ShowSavedPulse(int count)
    {
        _savedText.Text = $"已保存，第 {count} 张";
        var fadeIn = new DoubleAnimation(1, TimeSpan.FromMilliseconds(120));
        var fadeOut = new DoubleAnimation(0, TimeSpan.FromMilliseconds(520))
        {
            BeginTime = TimeSpan.FromMilliseconds(950)
        };
        var sb = new Storyboard();
        Storyboard.SetTarget(fadeIn, _savedBadge);
        Storyboard.SetTargetProperty(fadeIn, new PropertyPath(OpacityProperty));
        Storyboard.SetTarget(fadeOut, _savedBadge);
        Storyboard.SetTargetProperty(fadeOut, new PropertyPath(OpacityProperty));
        sb.Children.Add(fadeIn);
        sb.Children.Add(fadeOut);
        sb.Begin();
    }

    private static Button BuildRoundButton(string glyph, string toolTip, RoutedEventHandler onClick, MediaColor fill, double radius)
    {
        var btn = new Button
        {
            Content = new TextBlock
            {
                Text = glyph,
                FontSize = 13,
                LineHeight = 16,
                TextAlignment = TextAlignment.Center,
                Foreground = new SolidColorBrush(MediaColor.FromArgb(245, 255, 255, 255))
            },
            Width = 36,
            Height = 36,
            Background = new SolidColorBrush(fill),
            BorderBrush = new SolidColorBrush(MediaColor.FromArgb(85, 255, 255, 255)),
            BorderThickness = new Thickness(1),
            HorizontalContentAlignment = HorizontalAlignment.Center,
            VerticalContentAlignment = VerticalAlignment.Center,
            Cursor = Cursors.Hand,
            ToolTip = toolTip
        };
        var style = new Style(typeof(Button));
        style.Setters.Add(new Setter(TemplateProperty, BuildRoundButtonTemplate(radius)));
        btn.Style = style;
        btn.Click += onClick;
        return btn;
    }

    private static ControlTemplate BuildRoundButtonTemplate(double cornerRadius)
    {
        var border = new FrameworkElementFactory(typeof(Border));
        border.SetBinding(Border.BackgroundProperty, new Binding("Background") { RelativeSource = RelativeSource.TemplatedParent });
        border.SetBinding(Border.BorderBrushProperty, new Binding("BorderBrush") { RelativeSource = RelativeSource.TemplatedParent });
        border.SetBinding(Border.BorderThicknessProperty, new Binding("BorderThickness") { RelativeSource = RelativeSource.TemplatedParent });
        border.SetValue(Border.CornerRadiusProperty, new CornerRadius(cornerRadius));

        var content = new FrameworkElementFactory(typeof(ContentPresenter));
        content.SetValue(HorizontalAlignmentProperty, HorizontalAlignment.Center);
        content.SetValue(VerticalAlignmentProperty, VerticalAlignment.Center);
        border.AppendChild(content);

        return new ControlTemplate(typeof(Button))
        {
            VisualTree = border
        };
    }

    private void OnCaptureClick(object sender, RoutedEventArgs e)
    {
        CaptureRequested?.Invoke();
    }

    private void OnFinishClick(object sender, RoutedEventArgs e)
    {
        FinishRequested?.Invoke();
    }
}
