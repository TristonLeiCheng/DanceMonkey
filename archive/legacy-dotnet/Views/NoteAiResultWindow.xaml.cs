using System.Text;
using System.Windows;
using System.Windows.Threading;
using DesktopAssistant.Models;
using DesktopAssistant.Services;

namespace DesktopAssistant.Views;

/// <summary>
/// AI 结果预览窗口：流式展示 AI 生成内容，用户可在接受前直接编辑 AI 结果。
/// 支持「接受替换」（覆盖原文）和「追加到文末」两种模式。
/// </summary>
public partial class NoteAiResultWindow : Window
{
    private readonly string _originalText;
    private readonly NoteAiAction _action;
    private readonly AppConfig _cfg;
    private readonly string _userMessage;
    private readonly StringBuilder _resultBuilder = new();
    private CancellationTokenSource _cts = new();

    /// <summary>用户接受的 AI 结果文本（可能经过编辑）。</summary>
    public string ResultText => ResultBox.Text.Trim();

    /// <summary>true = 追加到文末；false = 替换原文。</summary>
    public bool IsAppendMode { get; private set; }

    public NoteAiResultWindow(string originalText, NoteAiAction action, AppConfig cfg, string userMessage)
    {
        InitializeComponent();
        _originalText = originalText;
        _action = action;
        _cfg = cfg;
        _userMessage = userMessage;
    }

    private void Window_Loaded(object sender, RoutedEventArgs e)
    {
        var displayName = NoteAiService.GetDisplayName(_action);
        ActionTitle.Text = $"AI · {displayName}  —  结果预览";
        ResultPanelLabel.Text = $"AI {displayName}";

        OriginalBox.Text = _originalText;
        StartStreamingAsync();
    }

    private void Window_Closing(object sender, System.ComponentModel.CancelEventArgs e)
    {
        _cts.Cancel();
    }

    private async void StartStreamingAsync()
    {
        var client = new OpenAiApiClient(_cfg);
        var (systemPrompt, maxTokens, temperature) = NoteAiService.GetParameters(_action);

        try
        {
            var result = await client.CallStreamAsync(
                _userMessage, systemPrompt, maxTokens, temperature,
                chunk => Dispatcher.BeginInvoke(() =>
                {
                    _resultBuilder.Append(chunk);
                    ResultBox.AppendText(chunk);
                    ResultBox.ScrollToEnd();
                }),
                _cts.Token).ConfigureAwait(true);

            if (_cts.IsCancellationRequested) return;

            if (result.Success)
            {
                SetStatus("生成完成", "#D1FAE5", "#065F46");
                BtnAccept.IsEnabled = true;
                BtnAppend.IsEnabled = true;
                FooterHint.Text = "可直接编辑 AI 结果后再点击接受";
            }
            else
            {
                // 流式失败，回退到普通请求
                SetStatus("流式失败，正在重试…", "#FEF3C7", "#B45309");
                ResultBox.Clear();
                _resultBuilder.Clear();

                var fallback = await client.CallAsync(_userMessage, systemPrompt, maxTokens, temperature, _cts.Token)
                    .ConfigureAwait(true);

                if (_cts.IsCancellationRequested) return;

                if (fallback.Success && !string.IsNullOrEmpty(fallback.Result))
                {
                    _resultBuilder.Append(fallback.Result);
                    ResultBox.Text = fallback.Result;
                    SetStatus("生成完成", "#D1FAE5", "#065F46");
                    BtnAccept.IsEnabled = true;
                    BtnAppend.IsEnabled = true;
                }
                else
                {
                    SetStatus($"生成失败：{fallback.Error ?? result.Error}", "#FEE2E2", "#991B1B");
                    FooterHint.Text = "生成失败，请检查 API 设置后重试";
                }
            }
        }
        catch (OperationCanceledException)
        {
            // 用户取消，不处理
        }
        catch (Exception ex)
        {
            if (!_cts.IsCancellationRequested)
                SetStatus($"异常：{ex.Message}", "#FEE2E2", "#991B1B");
        }
    }

    private void SetStatus(string text, string bgHex, string fgHex)
    {
        StatusText.Text = text;
        StatusBadge.Background = HexBrush(bgHex);
        StatusText.Foreground = HexBrush(fgHex);
    }

    private static System.Windows.Media.SolidColorBrush HexBrush(string hex) =>
        new((System.Windows.Media.Color)System.Windows.Media.ColorConverter.ConvertFromString(hex));

    private void BtnAccept_OnClick(object sender, RoutedEventArgs e)
    {
        IsAppendMode = false;
        DialogResult = true;
    }

    private void BtnAppend_OnClick(object sender, RoutedEventArgs e)
    {
        IsAppendMode = true;
        DialogResult = true;
    }

    private void BtnCancel_OnClick(object sender, RoutedEventArgs e)
    {
        _cts.Cancel();
        DialogResult = false;
        Close();
    }

    protected override void OnClosed(EventArgs e)
    {
        _cts.Cancel();
        _cts.Dispose();
        base.OnClosed(e);
    }
}
