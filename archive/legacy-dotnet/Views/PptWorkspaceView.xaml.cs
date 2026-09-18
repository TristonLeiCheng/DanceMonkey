using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.CompilerServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using DanceMonkey.Ppt.Abstractions;
using DanceMonkey.Ppt.Models;
using DanceMonkey.Ppt.Services;
using DesktopAssistant.Services;
using Microsoft.Win32;

namespace DesktopAssistant.Views;

/// <summary>
/// PPT 工作台：选择来源 → 主题与参数 → 生成大纲 → 渲染 .pptx。
/// 与 <see cref="NotesView"/> 解耦：通过 <see cref="IPptModule"/> 调用 PPT 大模块。
/// </summary>
public partial class PptWorkspaceView : UserControl
{
    private PptDeck? _currentDeck;
    private bool _isBusy;
    /// <summary>XAML 解析期间 <c>IsChecked</c> 会触发 Checked，此时尚未 InitializeComponent 完成。</summary>
    private bool _uiReady;

    /// <summary>视图模型化的主题选项：UI 通过 ItemsControl 绑定。</summary>
    private readonly ObservableCollection<ThemeOption> _themeOptions = new();

    public PptWorkspaceView()
    {
        InitializeComponent();
        _uiReady = true;
        ApplySourceModeUi();
        Loaded += OnLoaded;
    }

    private void OnLoaded(object sender, RoutedEventArgs e)
    {
        // 加载主题（来自 PptModuleFactory.Themes，避免触达模型与网络）
        if (_themeOptions.Count == 0)
        {
            foreach (var t in PptModuleFactory.Themes.List())
            {
                _themeOptions.Add(new ThemeOption
                {
                    Id = t.Id,
                    DisplayName = t.DisplayName,
                    Description = t.Description,
                });
            }
            // 默认主题：与 PptModuleFactory.Themes.Default 对齐
            var defaultId = PptModuleFactory.Themes.Default.Id;
            foreach (var opt in _themeOptions)
                opt.IsSelected = string.Equals(opt.Id, defaultId, StringComparison.OrdinalIgnoreCase);
            ThemeList.ItemsSource = _themeOptions;
        }

        ApplySourceModeUi();
        UpdateOfficeAvailabilityHint();
    }

    /// <summary>外部入口（例如 NotesView「发送到工作台」）：填入正文并切回 Markdown 模式。</summary>
    public void LoadSource(string markdown, string? topicHint = null)
    {
        SourceMarkdownRadio.IsChecked = true;
        SourceBox.Text = markdown ?? string.Empty;
        if (!string.IsNullOrWhiteSpace(topicHint))
            TopicBox.Text = topicHint;
        ApplySourceModeUi();
        ResetOutline("已载入笔记内容。");
    }

    // ── 来源切换 ─────────────────────────────────────────────────────

    private void SourceRadio_OnChecked(object sender, RoutedEventArgs e) => ApplySourceModeUi();

    private void ApplySourceModeUi()
    {
        if (!_uiReady || SourceBox == null || FilePickerRow == null)
            return;

        var topicOnly = SourceTopicRadio?.IsChecked == true;
        var isFileMode = SourcePdfRadio?.IsChecked == true || SourceWordRadio?.IsChecked == true;
        SourceBox.IsEnabled = !topicOnly && !isFileMode;
        SourceBox.Opacity = (topicOnly || isFileMode) ? 0.5 : 1.0;
        FilePickerRow.Visibility = isFileMode ? Visibility.Visible : Visibility.Collapsed;
        UpdateOfficeAvailabilityHint();
    }

    private void UpdateOfficeAvailabilityHint()
    {
        if (!_uiReady || OfficeAvailabilityHint == null)
            return;

        var needOffice = SourcePdfRadio?.IsChecked == true || SourceWordRadio?.IsChecked == true;
        if (!needOffice)
        {
            OfficeAvailabilityHint.Visibility = Visibility.Collapsed;
            return;
        }
        var ok = PptModuleFactory.IsOfficeWordAvailable();
        OfficeAvailabilityHint.Text = ok
            ? "已检测到本机安装 Microsoft Word，可解析 PDF / Word。"
            : "未检测到 Microsoft Word，无法解析 PDF / Word 文件。请改用 Markdown 或 Topic 模式。";
        OfficeAvailabilityHint.Foreground = ok
            ? new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(58, 122, 64))
            : new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(194, 90, 0));
        OfficeAvailabilityHint.Visibility = Visibility.Visible;
    }

    private void BrowseFileBtn_OnClick(object sender, RoutedEventArgs e)
    {
        var isPdf = SourcePdfRadio.IsChecked == true;
        var filter = isPdf
            ? "PDF 文档|*.pdf|所有文件|*.*"
            : "Word 文档|*.docx;*.doc|所有文件|*.*";
        var dlg = new OpenFileDialog
        {
            Filter = filter,
            Title = isPdf ? "选择 PDF 文件" : "选择 Word 文件",
        };
        if (dlg.ShowDialog() != true) return;
        FilePathBox.Text = dlg.FileName;
        ResetOutline($"已选择文件：{Path.GetFileName(dlg.FileName)}");
    }

    private void ThemeRadio_OnChecked(object sender, RoutedEventArgs e)
    {
        if (sender is RadioButton rb && rb.Tag is string id)
        {
            foreach (var opt in _themeOptions)
                opt.IsSelected = string.Equals(opt.Id, id, StringComparison.OrdinalIgnoreCase);
        }
    }

    private void LoadFromNoteBtn_OnClick(object sender, RoutedEventArgs e)
    {
        var dlg = new OpenFileDialog
        {
            Filter = "Markdown / 文本|*.md;*.markdown;*.txt|所有文件|*.*",
            Title = "从笔记载入正文",
        };
        if (dlg.ShowDialog() != true) return;
        try
        {
            var text = File.ReadAllText(dlg.FileName, System.Text.Encoding.UTF8);
            SourceMarkdownRadio.IsChecked = true;
            SourceBox.Text = text;
            ApplySourceModeUi();
            ResetOutline($"已载入：{Path.GetFileName(dlg.FileName)}");
        }
        catch (Exception ex)
        {
            MessageBox.Show($"读取失败：{ex.Message}", "PPT 工作台", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    // ── 生成大纲 ─────────────────────────────────────────────────────

    private async void GenerateOutlineBtn_OnClick(object sender, RoutedEventArgs e)
    {
        if (_isBusy) return;
        if (!TryBuildRequest(out var request, out var error))
        {
            MessageBox.Show(error, "PPT 工作台", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }

        var cfg = App.Config.Load();
        if (string.IsNullOrWhiteSpace(cfg.ApiKey))
        {
            MessageBox.Show("请先在「设置」中配置 API 密钥与端点（与智能对话相同）。", "PPT 工作台", MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        SetBusy(true, "正在生成大纲…");
        try
        {
            var module = DesktopPptModuleFactory.CreateForDesktop(cfg, useLegacyPrompt: LegacyPromptCheck.IsChecked == true);
            var result = await module.GenerateOutlineAsync(request).ConfigureAwait(true);
            if (!result.Success || result.Deck == null)
            {
                MessageBox.Show(result.Error ?? "未返回有效内容。", "PPT 工作台", MessageBoxButton.OK, MessageBoxImage.Error);
                return;
            }

            _currentDeck = result.Deck;
            RenderOutlinePreview(result.Deck);
            RenderBtn.IsEnabled = true;
            StatusText.Text = $"大纲已生成：{CountTotalSlides(result.Deck)} 页（含封面与结尾）。可在右侧调整后再渲染。";
            if (result.Warnings.Count > 0)
                StatusText.Text += $"  · 警告：{string.Join("；", result.Warnings)}";
        }
        catch (Exception ex)
        {
            MessageBox.Show($"生成大纲失败：{ex.Message}", "PPT 工作台", MessageBoxButton.OK, MessageBoxImage.Error);
        }
        finally
        {
            SetBusy(false);
        }
    }

    private async void RenderBtn_OnClick(object sender, RoutedEventArgs e)
    {
        if (_isBusy) return;
        if (_currentDeck == null)
        {
            MessageBox.Show("请先「生成大纲」。", "PPT 工作台", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }

        // 把右侧的主题选择套用到当前 Deck
        var selectedTheme = GetSelectedThemeId();
        if (!string.IsNullOrWhiteSpace(selectedTheme))
            _currentDeck.ThemeId = selectedTheme;

        var dlg = NewPptxSaveDialog(_currentDeck.Title);
        if (dlg.ShowDialog() != true) return;

        SetBusy(true, "正在渲染 PPTX…");
        try
        {
            var cfg = App.Config.Load();
            var module = DesktopPptModuleFactory.CreateForDesktop(cfg, useLegacyPrompt: LegacyPromptCheck.IsChecked == true);
            var result = await module.RenderAsync(_currentDeck, dlg.FileName).ConfigureAwait(true);
            if (!result.Success)
            {
                MessageBox.Show(result.Error ?? "渲染失败。", "PPT 工作台", MessageBoxButton.OK, MessageBoxImage.Error);
                return;
            }
            PromptOpen(result.OutputFilePath ?? dlg.FileName);
            StatusText.Text = $"已保存：{result.OutputFilePath ?? dlg.FileName}";
        }
        catch (Exception ex)
        {
            MessageBox.Show($"渲染失败：{ex.Message}", "PPT 工作台", MessageBoxButton.OK, MessageBoxImage.Error);
        }
        finally
        {
            SetBusy(false);
        }
    }

    private async void OneShotBtn_OnClick(object sender, RoutedEventArgs e)
    {
        if (_isBusy) return;
        if (!TryBuildRequest(out var request, out var error))
        {
            MessageBox.Show(error, "PPT 工作台", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }
        var cfg = App.Config.Load();
        if (string.IsNullOrWhiteSpace(cfg.ApiKey))
        {
            MessageBox.Show("请先在「设置」中配置 API 密钥与端点。", "PPT 工作台", MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        var dlg = NewPptxSaveDialog(
            request.Topic ??
            (request.SourceKind is PptSourceKind.PdfFile or PptSourceKind.WordFile
                ? Path.GetFileNameWithoutExtension(request.Source)
                : "演示文稿"));
        if (dlg.ShowDialog() != true) return;

        SetBusy(true, "正在一键生成 PPTX…");
        try
        {
            var module = DesktopPptModuleFactory.CreateForDesktop(cfg, useLegacyPrompt: LegacyPromptCheck.IsChecked == true);
            var result = await module.GenerateFromSourceAsync(request, dlg.FileName).ConfigureAwait(true);
            if (!result.Success)
            {
                MessageBox.Show(result.Error ?? "生成失败。", "PPT 工作台", MessageBoxButton.OK, MessageBoxImage.Error);
                return;
            }
            PromptOpen(result.OutputFilePath ?? dlg.FileName);
            StatusText.Text = $"已保存：{result.OutputFilePath ?? dlg.FileName}";
        }
        catch (Exception ex)
        {
            MessageBox.Show($"一键生成失败：{ex.Message}", "PPT 工作台", MessageBoxButton.OK, MessageBoxImage.Error);
        }
        finally
        {
            SetBusy(false);
        }
    }

    // ── 工具 ─────────────────────────────────────────────────────────

    private bool TryBuildRequest(out PptGenerationRequest request, out string error)
    {
        request = default!;
        error = "";

        var themeId = GetSelectedThemeId() ?? PptModuleFactory.Themes.Default.Id;
        var audience = AudienceBox.Text?.Trim();
        var purpose = PurposeBox.Text?.Trim();
        var tone = ToneBox.Text?.Trim();
        var extra = ExtraInstructionsBox.Text?.Trim();
        var includeNotes = SpeakerNotesCheck.IsChecked == true;
        var target = TryParsePositiveInt(TargetSlidesBox.Text);

        if (SourceTopicRadio.IsChecked == true)
        {
            var topic = TopicBox.Text?.Trim();
            if (string.IsNullOrWhiteSpace(topic))
            {
                error = "Topic 模式下，请填写「主题 / Topic」。";
                return false;
            }
            request = new PptGenerationRequest
            {
                SourceKind = PptSourceKind.Topic,
                Source = topic!,
                Topic = topic,
                ThemeId = themeId,
                Audience = string.IsNullOrWhiteSpace(audience) ? null : audience,
                Purpose = string.IsNullOrWhiteSpace(purpose) ? null : purpose,
                Tone = string.IsNullOrWhiteSpace(tone) ? null : tone,
                TargetSlides = target,
                IncludeSpeakerNotes = includeNotes,
                AdditionalInstructions = string.IsNullOrWhiteSpace(extra) ? null : extra,
            };
            return true;
        }

        if (SourcePdfRadio.IsChecked == true || SourceWordRadio.IsChecked == true)
        {
            var path = FilePathBox.Text?.Trim();
            if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
            {
                error = "请选择要导入的文件。";
                return false;
            }
            if (!PptModuleFactory.IsOfficeWordAvailable())
            {
                error = "本机未安装 Microsoft Word，无法解析 PDF / Word。请改用 Markdown 或 Topic 模式。";
                return false;
            }
            request = new PptGenerationRequest
            {
                SourceKind = SourcePdfRadio.IsChecked == true ? PptSourceKind.PdfFile : PptSourceKind.WordFile,
                Source = path!,
                ThemeId = themeId,
                Audience = string.IsNullOrWhiteSpace(audience) ? null : audience,
                Purpose = string.IsNullOrWhiteSpace(purpose) ? null : purpose,
                Tone = string.IsNullOrWhiteSpace(tone) ? null : tone,
                TargetSlides = target,
                IncludeSpeakerNotes = includeNotes,
                PreserveImages = true,
                AdditionalInstructions = string.IsNullOrWhiteSpace(extra) ? null : extra,
            };
            return true;
        }

        // Markdown / 纯文本
        var body = SourceBox.Text ?? string.Empty;
        if (string.IsNullOrWhiteSpace(body))
        {
            error = "请填写「正文」或切换到 Topic 模式。";
            return false;
        }

        request = new PptGenerationRequest
        {
            SourceKind = PptSourceKind.Markdown,
            Source = body,
            ThemeId = themeId,
            Audience = string.IsNullOrWhiteSpace(audience) ? null : audience,
            Purpose = string.IsNullOrWhiteSpace(purpose) ? null : purpose,
            Tone = string.IsNullOrWhiteSpace(tone) ? null : tone,
            TargetSlides = target,
            IncludeSpeakerNotes = includeNotes,
            AdditionalInstructions = string.IsNullOrWhiteSpace(extra) ? null : extra,
        };
        return true;
    }

    private static int? TryParsePositiveInt(string? s)
    {
        if (int.TryParse(s, out var v) && v > 0) return v;
        return null;
    }

    private string? GetSelectedThemeId() =>
        _themeOptions.FirstOrDefault(o => o.IsSelected)?.Id;

    private static int CountTotalSlides(PptDeck deck)
    {
        // 渲染层会自动补封面/结尾页，这里近似估算
        var content = deck.EnumerateSlides().Count();
        var sectionPages = deck.Sections.Count > 1 ? deck.Sections.Count : 0;
        return 1 + sectionPages + content + 1;
    }

    private static SaveFileDialog NewPptxSaveDialog(string? deckTitle)
    {
        var name = string.IsNullOrWhiteSpace(deckTitle) ? "演示文稿" : SafeFileName(deckTitle!);
        return new SaveFileDialog
        {
            Filter = "PowerPoint 演示文稿|*.pptx",
            FileName = name + ".pptx",
            Title = "保存生成的演示文稿",
            AddExtension = true,
            DefaultExt = ".pptx",
        };
    }

    private static string SafeFileName(string s)
    {
        foreach (var c in Path.GetInvalidFileNameChars())
            s = s.Replace(c, '_');
        return s.Length > 64 ? s[..64] : s;
    }

    private void PromptOpen(string path)
    {
        var open = MessageBox.Show(
            $"已保存：\n{path}\n\n是否在 PowerPoint 中打开？",
            "PPT 工作台",
            MessageBoxButton.YesNo,
            MessageBoxImage.Information);
        if (open == MessageBoxResult.Yes)
        {
            try { Process.Start(new ProcessStartInfo { FileName = path, UseShellExecute = true }); }
            catch (Exception ex)
            {
                MessageBox.Show($"无法打开文件：{ex.Message}", "PPT 工作台", MessageBoxButton.OK, MessageBoxImage.Warning);
            }
        }
    }

    private void SetBusy(bool busy, string? status = null)
    {
        _isBusy = busy;
        Mouse.OverrideCursor = busy ? Cursors.Wait : null;
        GenerateOutlineBtn.IsEnabled = !busy;
        OneShotBtn.IsEnabled = !busy;
        RenderBtn.IsEnabled = !busy && _currentDeck != null;
        if (status != null) StatusText.Text = status;
    }

    private void ResetOutline(string? status)
    {
        _currentDeck = null;
        RenderBtn.IsEnabled = false;
        OutlinePanel.Children.Clear();
        OutlinePanel.Children.Add(new TextBlock
        {
            Text = "点击「生成大纲」后，这里会按章节展示页标题与要点，可直接编辑后再渲染。",
            Foreground = System.Windows.Media.Brushes.Gray,
            TextWrapping = TextWrapping.Wrap,
            FontSize = 12,
        });
        OutlineStatusText.Text = "";
        if (!string.IsNullOrWhiteSpace(status)) StatusText.Text = status!;
    }

    private void RenderOutlinePreview(PptDeck deck)
    {
        OutlinePanel.Children.Clear();
        var totalSlides = deck.EnumerateSlides().Count();
        OutlineStatusText.Text = $"· 章节 {deck.Sections.Count}，内容页 {totalSlides}（封面/结尾由渲染器自动补）";

        var deckHeader = new TextBlock
        {
            Text = string.IsNullOrWhiteSpace(deck.Title) ? "（未命名 Deck）" : deck.Title!,
            FontWeight = FontWeights.SemiBold,
            FontSize = 15,
            Foreground = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(31, 35, 48)),
            Margin = new Thickness(0, 4, 0, 6),
            TextWrapping = TextWrapping.Wrap,
        };
        OutlinePanel.Children.Add(deckHeader);
        if (!string.IsNullOrWhiteSpace(deck.Subtitle))
        {
            OutlinePanel.Children.Add(new TextBlock
            {
                Text = deck.Subtitle,
                Foreground = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(122, 129, 148)),
                FontSize = 12,
                Margin = new Thickness(0, 0, 0, 8),
                TextWrapping = TextWrapping.Wrap,
            });
        }

        for (var si = 0; si < deck.Sections.Count; si++)
        {
            var section = deck.Sections[si];
            var sectionTitle = new TextBlock
            {
                Text = $"第 {si + 1} 章 · {section.Title}",
                FontWeight = FontWeights.SemiBold,
                FontSize = 13,
                Foreground = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(31, 79, 245)),
                Margin = new Thickness(0, 10, 0, 4),
                TextWrapping = TextWrapping.Wrap,
            };
            OutlinePanel.Children.Add(sectionTitle);

            for (var idx = 0; idx < section.Slides.Count; idx++)
            {
                var slide = section.Slides[idx];
                var card = new Border
                {
                    BorderBrush = System.Windows.Media.Brushes.LightGray,
                    BorderThickness = new Thickness(1),
                    CornerRadius = new CornerRadius(3),
                    Padding = new Thickness(10),
                    Margin = new Thickness(0, 4, 0, 0),
                    Background = System.Windows.Media.Brushes.White,
                };
                var sp = new StackPanel();
                sp.Children.Add(new TextBlock
                {
                    Text = $"#{idx + 1}  {slide.Title}",
                    FontWeight = FontWeights.SemiBold,
                    FontSize = 12,
                    TextWrapping = TextWrapping.Wrap,
                });
                if (slide.Bullets.Count > 0)
                {
                    sp.Children.Add(new TextBlock
                    {
                        Text = string.Join("\n", slide.Bullets.Select(b => "• " + b)),
                        Foreground = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(58, 66, 82)),
                        FontSize = 12,
                        Margin = new Thickness(0, 4, 0, 0),
                        TextWrapping = TextWrapping.Wrap,
                    });
                }
                if (!string.IsNullOrWhiteSpace(slide.SpeakerNotes))
                {
                    sp.Children.Add(new TextBlock
                    {
                        Text = "🗣 " + slide.SpeakerNotes,
                        Foreground = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(122, 129, 148)),
                        FontSize = 11,
                        Margin = new Thickness(0, 4, 0, 0),
                        TextWrapping = TextWrapping.Wrap,
                    });
                }
                card.Child = sp;
                OutlinePanel.Children.Add(card);
            }
        }
    }

    // ── 主题选项的轻量 ViewModel ─────────────────────────────────────

    private sealed class ThemeOption : INotifyPropertyChanged
    {
        private bool _isSelected;
        public string Id { get; init; } = "";
        public string DisplayName { get; init; } = "";
        public string Description { get; init; } = "";
        public bool IsSelected
        {
            get => _isSelected;
            set { if (_isSelected != value) { _isSelected = value; OnChanged(); } }
        }

        public event PropertyChangedEventHandler? PropertyChanged;
        private void OnChanged([CallerMemberName] string? p = null) =>
            PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(p));
    }
}
