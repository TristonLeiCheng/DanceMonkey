using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media.Imaging;
using DesktopAssistant.Services;

namespace DesktopAssistant;

public partial class ScreenshotResultWindow : Window
{
    private readonly string _imagePath;
    private readonly Action<string>? _onSavedToNote;

    public ScreenshotResultWindow(string imageFilePath, Action<string>? onSavedToNote = null)
    {
        InitializeComponent();
        _imagePath = imageFilePath;
        _onSavedToNote = onSavedToNote;
        Loaded += (_, _) => LoadPreview();
    }

    private void LoadPreview()
    {
        try
        {
            if (!File.Exists(_imagePath))
            {
                StatusText.Text = "图片文件不存在。";
                return;
            }

            var bmp = new BitmapImage();
            bmp.BeginInit();
            bmp.CacheOption = BitmapCacheOption.OnLoad;
            bmp.UriSource = new Uri(Path.GetFullPath(_imagePath));
            bmp.EndInit();
            bmp.Freeze();
            PreviewImage.Source = bmp;
        }
        catch (Exception ex)
        {
            StatusText.Text = $"无法加载预览：{ex.Message}";
        }
    }

    private void Copy_OnClick(object sender, RoutedEventArgs e)
    {
        try
        {
            if (!File.Exists(_imagePath))
            {
                MessageBox.Show("图片文件不存在。", Title, MessageBoxButton.OK, MessageBoxImage.Warning);
                return;
            }

            var data = File.ReadAllBytes(_imagePath);
            using var ms = new MemoryStream(data);
            var bmp = new BitmapImage();
            bmp.BeginInit();
            bmp.CacheOption = BitmapCacheOption.OnLoad;
            bmp.StreamSource = ms;
            bmp.EndInit();
            bmp.Freeze();
            Clipboard.SetImage(bmp);
            StatusText.Text = "已复制到剪贴板。";
        }
        catch (Exception ex)
        {
            MessageBox.Show($"复制失败：{ex.Message}", Title, MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }

    private void SaveToNote_OnClick(object sender, RoutedEventArgs e)
    {
        try
        {
            if (!File.Exists(_imagePath))
            {
                MessageBox.Show("图片文件不存在。", Title, MessageBoxButton.OK, MessageBoxImage.Warning);
                return;
            }

            var cfg = App.Config.Load();
            var notes = new NoteService(cfg.NotesRootPath);
            var mdPath = notes.SaveScreenshotAsNote(_imagePath);
            _onSavedToNote?.Invoke(mdPath);
            MessageBox.Show($"已保存到笔记：\n{mdPath}", Title, MessageBoxButton.OK, MessageBoxImage.Information);
            StatusText.Text = "已写入 Inbox 下的 Markdown 与 Screenshots。";
        }
        catch (Exception ex)
        {
            MessageBox.Show($"保存失败：{ex.Message}", Title, MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private async void AiAnalyze_OnClick(object sender, RoutedEventArgs e)
    {
        if (!File.Exists(_imagePath))
        {
            MessageBox.Show("图片文件不存在。", Title, MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        SetBusy(true, "正在分析截图（理解内容与意图）…");
        try
        {
            await ScreenshotAnalysisHelper.RunAiAnalysisAsync(_imagePath, this, Title).ConfigureAwait(true);
        }
        finally
        {
            SetBusy(false, "");
        }
    }

    private async void Ocr_OnClick(object sender, RoutedEventArgs e)
    {
        if (!File.Exists(_imagePath))
        {
            MessageBox.Show("图片文件不存在。", Title, MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        SetBusy(true, "正在识别文字…");
        try
        {
            await ScreenshotAnalysisHelper.RunOcrAsync(_imagePath, this, Title).ConfigureAwait(true);
        }
        finally
        {
            SetBusy(false, "");
        }
    }

    private void Close_OnClick(object sender, RoutedEventArgs e) => Close();

    private void SetBusy(bool busy, string message)
    {
        StatusText.Text = message;
        IsEnabled = !busy;
    }
}
