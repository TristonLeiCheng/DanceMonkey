using System.Windows;
using System.Windows.Controls;
using DesktopAssistant.Models;
using DesktopAssistant.Services;

namespace DesktopAssistant.Views;

public partial class ChatView : UserControl
{
    private bool _snippetComboProgrammatic;

    public ChatView()
    {
        InitializeComponent();
        Loaded += (_, _) => ReloadPromptSnippets();
    }

    /// <summary>设置保存后刷新下拉中的 Prompt 片段。</summary>
    public void ReloadPromptSnippets()
    {
        _snippetComboProgrammatic = true;
        try
        {
            PromptSnippetCombo.Items.Clear();
            PromptSnippetCombo.Items.Add(new ComboBoxItem { Content = "（选择常用 Prompt…）", Tag = (PromptSnippetItem?)null });
            foreach (var s in App.Config.Load().PromptSnippets)
            {
                if (string.IsNullOrWhiteSpace(s.Title) && string.IsNullOrWhiteSpace(s.SystemPrompt))
                    continue;
                var label = string.IsNullOrWhiteSpace(s.Title) ? s.SystemPrompt.Trim().Substring(0, Math.Min(24, s.SystemPrompt.Trim().Length)) + "…" : s.Title.Trim();
                PromptSnippetCombo.Items.Add(new ComboBoxItem { Content = label, Tag = s });
            }

            PromptSnippetCombo.SelectedIndex = 0;
        }
        finally
        {
            _snippetComboProgrammatic = false;
        }
    }

    private void PromptSnippetCombo_OnSelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_snippetComboProgrammatic)
            return;
        // 仅在选择变更时可选自动应用；此处不自动写入，避免误覆盖，由「应用所选」确认
    }

    private void ApplySnippetBtn_OnClick(object sender, RoutedEventArgs e)
    {
        if (PromptSnippetCombo.SelectedItem is not ComboBoxItem item || item.Tag is not PromptSnippetItem snippet)
        {
            MessageBox.Show("请先在列表中选择一个 Prompt 片段（在「设置」中维护）。", "提示", MessageBoxButton.OK,
                MessageBoxImage.Information);
            return;
        }

        var text = snippet.SystemPrompt?.Trim() ?? "";
        if (string.IsNullOrEmpty(text))
        {
            MessageBox.Show("该片段未填写系统提示词内容。", "提示", MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        SystemPrompt.Text = text;
    }

    private void PasteFromClipboard_OnClick(object sender, RoutedEventArgs e)
    {
        try
        {
            if (Clipboard.ContainsText())
            {
                UserInput.Text = Clipboard.GetText();
                return;
            }
        }
        catch
        {
            // ignore
        }

        MessageBox.Show("剪贴板中没有文本。", "提示", MessageBoxButton.OK, MessageBoxImage.Information);
    }

    private async void SummarizeClipboard_OnClick(object sender, RoutedEventArgs e)
    {
        string? clip = null;
        try
        {
            if (Clipboard.ContainsText())
                clip = Clipboard.GetText();
        }
        catch
        {
            // ignore
        }

        if (string.IsNullOrWhiteSpace(clip))
        {
            MessageBox.Show("剪贴板中没有可用于摘要的文本。", "提示", MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        var cfg = App.Config.Load();
        if (string.IsNullOrWhiteSpace(cfg.ApiKey))
        {
            MessageBox.Show("请先在设置中配置API密钥", "提示", MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        UserInput.Text = clip;
        var systemPrompt = SystemPrompt.Text.Trim();
        if (string.IsNullOrEmpty(systemPrompt))
            systemPrompt = "你是精炼的中文助理，请将用户给出的长文本整理为要点摘要，使用 Markdown 小标题与列表，保留关键数字与日期。";

        SummarizeClipboardBtn.IsEnabled = false;
        SubmitBtn.IsEnabled = false;
        SummarizeClipboardBtn.Content = "摘要中…";

        try
        {
            var client = new OpenAiApiClient(cfg);
            var userMessage = "请摘要以下内容：\n\n" + clip.Trim();
            var result = await client.CallAsync(userMessage, systemPrompt);

            if (result.Success)
            {
                ResultText.Text = result.Result ?? "";
                MessageBox.Show("摘要已生成。", "成功", MessageBoxButton.OK, MessageBoxImage.Information);
            }
            else
                MessageBox.Show($"处理失败：{result.Error}", "错误", MessageBoxButton.OK, MessageBoxImage.Error);
        }
        finally
        {
            SummarizeClipboardBtn.IsEnabled = true;
            SubmitBtn.IsEnabled = true;
            SummarizeClipboardBtn.Content = "摘要剪贴板内容";
        }
    }

    private async void SubmitBtn_OnClick(object sender, RoutedEventArgs e)
    {
        var userInput = UserInput.Text.Trim();
        if (string.IsNullOrEmpty(userInput))
        {
            MessageBox.Show("请输入你的问题或需求", "提示", MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        var cfg = App.Config.Load();
        if (string.IsNullOrWhiteSpace(cfg.ApiKey))
        {
            MessageBox.Show("请先在设置中配置API密钥", "提示", MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        var systemPrompt = SystemPrompt.Text.Trim();
        if (string.IsNullOrEmpty(systemPrompt))
            systemPrompt = "你是一个有帮助的AI助手，请根据用户的需求提供准确、详细的回答。";

        SubmitBtn.IsEnabled = false;
        SubmitBtn.Content = "处理中...";

        try
        {
            var client = new OpenAiApiClient(cfg);
            var result = await client.CallAsync(userInput, systemPrompt);

            if (result.Success)
            {
                ResultText.Text = result.Result ?? "";
                MessageBox.Show("处理完成！", "成功", MessageBoxButton.OK, MessageBoxImage.Information);
            }
            else
            {
                MessageBox.Show($"处理失败：{result.Error}", "错误", MessageBoxButton.OK, MessageBoxImage.Error);
            }
        }
        finally
        {
            SubmitBtn.IsEnabled = true;
            SubmitBtn.Content = "发送请求";
        }
    }

    private void CopyBtn_OnClick(object sender, RoutedEventArgs e)
    {
        var text = ResultText.Text;
        if (!string.IsNullOrWhiteSpace(text))
        {
            Clipboard.SetText(text);
            MessageBox.Show("已复制到剪贴板！", "成功", MessageBoxButton.OK, MessageBoxImage.Information);
        }
        else
        {
            MessageBox.Show("没有可复制的内容", "提示", MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }
}
