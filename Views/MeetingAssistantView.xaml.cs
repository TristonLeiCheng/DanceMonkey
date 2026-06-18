using System.Globalization;
using System.Text;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using DesktopAssistant.Models;
using DesktopAssistant.Services;
using Microsoft.Web.WebView2.Wpf;
using MediaColor = System.Windows.Media.Color;
using Brush = System.Windows.Media.Brush;
using Brushes = System.Windows.Media.Brushes;

namespace DesktopAssistant.Views;

public partial class MeetingAssistantView : UserControl
{
    private bool _isBusy;
    private string? _lastSummary;
    private bool _loaded;

    private MeetingStore? _store;
    private List<MeetingTemplate> _templates = new();
    private List<MeetingProject> _projects = new();
    private MeetingTemplate? _selectedTemplate;
    private DateTime _calMonth = new DateTime(DateTime.Now.Year, DateTime.Now.Month, 1);
    private DateTime? _calSelectedDate;
    private List<MeetingSeries> _series = new();
    private MeetingSeries? _selectedSeries;
    private MeetingRecord? _selectedLibMeeting;
    private MeetingRecord? _workbenchMeeting;
    private bool _suppressTemplateFill;
    private bool _libEditMode;
    private bool _libGroupedView;
    private string _libSearchKeyword = "";
    private bool _libShowArchived;
    private readonly List<MeetingAttendee> _workbenchAttendees = new();
    private string? _editingTemplateId;

    public MeetingAssistantView()
    {
        InitializeComponent();

        QuickNotesBox.TextChanged += (_, _) => UpdateActionButtons();
        AgendaBox.TextChanged += (_, _) => UpdateActionButtons();

        Loaded += (_, _) => LoadHub();
    }

    // ═══════════════ Hub load ═══════════════

    private void LoadHub()
    {
        if (_loaded) return;
        try
        {
            var cfg = App.Config.Load();
            _store = new MeetingStore(cfg.NotesRootPath);
            _store.MigrateLegacyMarkdown();
            _templates = _store.LoadTemplates();
            _projects = _store.LoadProjects();
        }
        catch (Exception ex)
        {
            ShowError($"加载会议数据失败：{ex.Message}");
            _templates = new List<MeetingTemplate>();
            _projects = new List<MeetingProject>();
        }

        PopulateTemplateCombo();
        PopulateProjectCombos();
        PopulateTemplateList();
        PopulateStatusCombo();
        InitLibViewModeCombo();
        _loaded = true;

        if (TemplateCombo.Items.Count > 0)
            TemplateCombo.SelectedIndex = 0;

        NewWorkbenchMeeting();
        RefreshLibrary();
        SelectCalendarDay(DateTime.Today);
        InitSeriesTab();
        ResetTemplateForm();
        UpdateActionButtons();
    }

    private void PopulateTemplateCombo()
    {
        TemplateCombo.Items.Clear();
        foreach (var t in _templates)
            TemplateCombo.Items.Add(new ComboBoxItem { Content = $"{t.Icon} {t.Name}", Tag = t.Id });
    }

    private void PopulateProjectCombos()
    {
        ProjectCombo.Items.Clear();
        ProjectCombo.Items.Add(new ComboBoxItem { Content = "（无项目）", Tag = "" });
        foreach (var p in _projects)
            ProjectCombo.Items.Add(new ComboBoxItem { Content = p.Name, Tag = p.Id });
        ProjectCombo.SelectedIndex = 0;

        var prevTag = (LibProjectFilter.SelectedItem as ComboBoxItem)?.Tag?.ToString();
        LibProjectFilter.Items.Clear();
        LibProjectFilter.Items.Add(new ComboBoxItem { Content = "全部项目", Tag = "" });
        foreach (var p in _projects)
            LibProjectFilter.Items.Add(new ComboBoxItem { Content = p.Name, Tag = p.Id });
        var restore = LibProjectFilter.Items.Cast<ComboBoxItem>()
            .FirstOrDefault(i => (i.Tag?.ToString() ?? "") == (prevTag ?? ""));
        LibProjectFilter.SelectedItem = restore ?? LibProjectFilter.Items[0];
    }

    private void PopulateTemplateList()
    {
        TplList.Items.Clear();
        foreach (var t in _templates)
        {
            var badge = t.BuiltIn ? "  ·内置" : "";
            TplList.Items.Add(new ListBoxItem { Content = $"{t.Icon} {t.Name}{badge}", Tag = t.Id });
        }
    }

    private void TemplateCombo_OnSelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!_loaded || _suppressTemplateFill) return;
        var id = (TemplateCombo.SelectedItem as ComboBoxItem)?.Tag?.ToString();
        _selectedTemplate = _templates.FirstOrDefault(t => t.Id == id);
        if (_selectedTemplate == null) return;

        AgendaBox.Text = string.Join(Environment.NewLine, _selectedTemplate.AgendaTemplate);
        if (string.IsNullOrWhiteSpace(MeetingTitleBox.Text) || MeetingTitleBox.Text.Trim() == "会议记录")
            MeetingTitleBox.Text = $"{_selectedTemplate.Name} {DateTime.Now:MM-dd}";
    }

    private void PopulateStatusCombo()
    {
        StatusCombo.Items.Clear();
        StatusCombo.Items.Add(new ComboBoxItem { Content = "计划中", Tag = MeetingStatus.Planned });
        StatusCombo.Items.Add(new ComboBoxItem { Content = "进行中", Tag = MeetingStatus.InProgress });
        StatusCombo.Items.Add(new ComboBoxItem { Content = "已完成", Tag = MeetingStatus.Completed });
        StatusCombo.Items.Add(new ComboBoxItem { Content = "已取消", Tag = MeetingStatus.Cancelled });
        StatusCombo.SelectedIndex = 2;
    }

    private void InitLibViewModeCombo()
    {
        LibViewModeCombo.Items.Clear();
        LibViewModeCombo.Items.Add(new ComboBoxItem { Content = "平铺列表", Tag = "flat" });
        LibViewModeCombo.Items.Add(new ComboBoxItem { Content = "按项目分组", Tag = "grouped" });
        LibViewModeCombo.SelectedIndex = 0;
    }

    // ═══════════════ Workbench ═══════════════

    private void BtnNewMeeting_OnClick(object sender, RoutedEventArgs e) => NewWorkbenchMeeting();

    private void BtnOpenInWorkbench_OnClick(object sender, RoutedEventArgs e)
    {
        if (_selectedLibMeeting == null)
        {
            MessageBox.Show("请先在会议库中选择一场会议。", "提示", MessageBoxButton.OK, MessageBoxImage.Information);
            HubTabs.SelectedIndex = 2;
            return;
        }
        LoadWorkbenchMeeting(_selectedLibMeeting);
        HubTabs.SelectedIndex = 0;
    }

    private void NewWorkbenchMeeting()
    {
        _workbenchMeeting = new MeetingRecord
        {
            StartTime = DateTime.Now,
            Status = MeetingStatus.InProgress,
        };
        _workbenchAttendees.Clear();
        _lastSummary = null;
        _suppressTemplateFill = true;
        try
        {
            MeetingTitleBox.Text = "会议记录";
            MeetingStartBox.Text = DateTime.Now.ToString("yyyy-MM-dd HH:mm");
            MeetingEndBox.Text = "";
            TagsBox.Text = "";
            AgendaBox.Text = "";
            QuickNotesBox.Text = "";
            AttendeesList.Items.Clear();
            AttendeeNameBox.Text = "";
            AttendeeRoleBox.Text = "";
            SelectComboByTag(StatusCombo, MeetingStatus.InProgress);
            if (ProjectCombo.Items.Count > 0) ProjectCombo.SelectedIndex = 0;
            if (TemplateCombo.Items.Count > 0) TemplateCombo.SelectedIndex = 0;
            _ = RenderMdAsync(SummaryBox, null);
            HideSummaryPanel();
        }
        finally
        {
            _suppressTemplateFill = false;
        }
        UpdateWorkbenchHint();
        UpdateActionButtons();
        ClearError();
    }

    private void LoadWorkbenchMeeting(MeetingRecord rec)
    {
        _workbenchMeeting = rec;
        _workbenchAttendees.Clear();
        _workbenchAttendees.AddRange(rec.Attendees.Select(a => new MeetingAttendee { Name = a.Name, Role = a.Role }));
        _lastSummary = rec.SummaryMarkdown;
        _suppressTemplateFill = true;
        try
        {
            MeetingTitleBox.Text = rec.Title;
            MeetingStartBox.Text = rec.StartTime.ToString("yyyy-MM-dd HH:mm");
            MeetingEndBox.Text = rec.EndTime?.ToString("yyyy-MM-dd HH:mm") ?? "";
            TagsBox.Text = string.Join(", ", rec.Tags);
            AgendaBox.Text = string.Join(Environment.NewLine, rec.AgendaItems);
            QuickNotesBox.Text = rec.QuickNotes;
            SelectComboByTag(StatusCombo, rec.Status);
            SelectComboByTag(ProjectCombo, rec.ProjectId);
            SelectComboByTag(TemplateCombo, rec.TemplateId);
            _selectedTemplate = _templates.FirstOrDefault(t => t.Id == rec.TemplateId);
            RefreshAttendeesList();
            if (!string.IsNullOrWhiteSpace(_lastSummary))
            {
                _ = RenderMdAsync(SummaryBox, _lastSummary);
                ShowSummaryPanel();
            }
            else
            {
                _ = RenderMdAsync(SummaryBox, null);
                HideSummaryPanel();
            }
        }
        finally
        {
            _suppressTemplateFill = false;
        }
        UpdateWorkbenchHint();
        UpdateActionButtons();
        ClearError();
    }

    private MeetingRecord BuildMeetingFromWorkbench()
    {
        var rec = _workbenchMeeting ?? new MeetingRecord();
        rec.Title = string.IsNullOrWhiteSpace(MeetingTitleBox.Text) ? "会议记录" : MeetingTitleBox.Text.Trim();
        rec.ProjectId = (ProjectCombo.SelectedItem as ComboBoxItem)?.Tag?.ToString() ?? "";
        rec.TemplateId = _selectedTemplate?.Id ?? (TemplateCombo.SelectedItem as ComboBoxItem)?.Tag?.ToString() ?? "";
        rec.Status = (StatusCombo.SelectedItem as ComboBoxItem)?.Tag?.ToString() ?? MeetingStatus.Completed;
        rec.StartTime = ParseDateTimeOr(MeetingStartBox.Text, DateTime.Now);
        rec.EndTime = ParseNullableDateTime(MeetingEndBox.Text);
        if (rec.EndTime.HasValue)
            rec.DurationSeconds = Math.Max(0, (int)(rec.EndTime.Value - rec.StartTime).TotalSeconds);
        rec.AgendaItems = SplitLines(AgendaBox.Text);
        rec.QuickNotes = QuickNotesBox.Text.Trim();
        rec.SummaryMarkdown = _lastSummary ?? "";
        rec.Attendees = _workbenchAttendees.Select(a => new MeetingAttendee { Name = a.Name, Role = a.Role }).ToList();
        rec.Tags = SplitTags(TagsBox.Text);
        if (rec.Tags.Count == 0 && _selectedTemplate?.DefaultTags.Count > 0)
            rec.Tags = new List<string>(_selectedTemplate.DefaultTags);
        return rec;
    }

    private void UpdateWorkbenchHint()
    {
        if (_workbenchMeeting == null)
        {
            WorkbenchHintText.Text = "未保存的新会议";
            WorkbenchIdText.Text = "";
            return;
        }
        var status = StatusLabel((StatusCombo.SelectedItem as ComboBoxItem)?.Tag?.ToString() ?? _workbenchMeeting.Status);
        var saved = !string.IsNullOrWhiteSpace(_workbenchMeeting.Id)
            && (_store?.LoadMeetings().Any(m => m.Id == _workbenchMeeting.Id) ?? false);
        WorkbenchHintText.Text = saved ? $"编辑中 · {status}" : $"新会议 · {status}";
        WorkbenchIdText.Text = saved ? $"ID: {_workbenchMeeting.Id[..Math.Min(8, _workbenchMeeting.Id.Length)]}…" : "";
    }

    private static string StatusLabel(string status) => status switch
    {
        MeetingStatus.Planned => "计划中",
        MeetingStatus.InProgress => "进行中",
        MeetingStatus.Cancelled => "已取消",
        MeetingStatus.Archived => "已归档",
        _ => "已完成",
    };

    private void RefreshAttendeesList()
    {
        AttendeesList.Items.Clear();
        foreach (var a in _workbenchAttendees)
        {
            var label = string.IsNullOrWhiteSpace(a.Role) ? a.Name : $"{a.Name}（{a.Role}）";
            AttendeesList.Items.Add(new ListBoxItem { Content = label, Tag = a });
        }
    }

    private void BtnAddAttendee_OnClick(object sender, RoutedEventArgs e)
    {
        var name = AttendeeNameBox.Text.Trim();
        if (string.IsNullOrWhiteSpace(name))
        {
            ShowError("请输入参会人姓名。");
            return;
        }
        _workbenchAttendees.Add(new MeetingAttendee { Name = name, Role = AttendeeRoleBox.Text.Trim() });
        AttendeeNameBox.Text = "";
        AttendeeRoleBox.Text = "";
        RefreshAttendeesList();
        ClearError();
    }

    private void BtnRemoveAttendee_OnClick(object sender, RoutedEventArgs e)
    {
        if (AttendeesList.SelectedItem is not ListBoxItem item || item.Tag is not MeetingAttendee a) return;
        _workbenchAttendees.RemoveAll(x => x.Name == a.Name && x.Role == a.Role);
        RefreshAttendeesList();
    }

    private static List<string> SplitTags(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return new List<string>();
        return text.Split(new[] { ',', '，', ';', '；' }, StringSplitOptions.RemoveEmptyEntries)
            .Select(t => t.Trim()).Where(t => t.Length > 0).Distinct().ToList();
    }

    private static DateTime ParseDateTimeOr(string? text, DateTime fallback)
    {
        if (string.IsNullOrWhiteSpace(text)) return fallback;
        if (DateTime.TryParse(text.Trim(), CultureInfo.CurrentCulture, DateTimeStyles.None, out var d)) return d;
        if (DateTime.TryParse(text.Trim(), CultureInfo.InvariantCulture, DateTimeStyles.None, out d)) return d;
        return fallback;
    }

    private static DateTime? ParseNullableDateTime(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        if (DateTime.TryParse(text.Trim(), CultureInfo.CurrentCulture, DateTimeStyles.None, out var d)) return d;
        if (DateTime.TryParse(text.Trim(), CultureInfo.InvariantCulture, DateTimeStyles.None, out d)) return d;
        return null;
    }

    // ═══════════════ Summary ═══════════════

    private async void BtnSummary_OnClick(object sender, RoutedEventArgs e)
    {
        await GenerateSummaryAsync();
    }

    private async Task GenerateSummaryAsync()
    {
        if (_isBusy) return;

        var transcript = BuildTranscriptForSummary();
        if (string.IsNullOrWhiteSpace(transcript))
        {
            ShowError("没有可整理的内容（议程或手记）。");
            return;
        }

        _isBusy = true;
        BtnSummary.IsEnabled = false;
        BtnSummary.Content = "⏳ 生成中...";
        ClearError();

        try
        {
            var cfg = App.Config.Load();
            var svc = new MeetingSummaryService(cfg);
            var promptOverride = string.IsNullOrWhiteSpace(_selectedTemplate?.SummaryPromptOverride)
                ? null
                : _selectedTemplate!.SummaryPromptOverride;
            var result = await svc.GenerateSummaryAsync(transcript, promptOverride);

            if (result.Success && !string.IsNullOrWhiteSpace(result.Result))
            {
                _lastSummary = result.Result;
                _ = RenderMdAsync(SummaryBox, result.Result);
                ShowSummaryPanel();
            }
            else
            {
                ShowError(result.Error ?? "摘要生成失败。");
            }
        }
        catch (Exception ex)
        {
            ShowError($"摘要生成失败：{ex.Message}");
        }
        finally
        {
            _isBusy = false;
            BtnSummary.Content = "📋 生成纪要";
            UpdateActionButtons();
        }
    }

    private string BuildTranscriptForSummary()
    {
        var sb = new StringBuilder();
        var agenda = AgendaBox.Text.Trim();
        if (!string.IsNullOrWhiteSpace(agenda))
        {
            sb.AppendLine("【会议议程】");
            sb.AppendLine(agenda);
            sb.AppendLine();
        }

        var notes = QuickNotesBox.Text.Trim();
        if (!string.IsNullOrWhiteSpace(notes))
        {
            sb.AppendLine("【会上手记】");
            sb.AppendLine(notes);
        }
        return sb.ToString().Trim();
    }

    // ═══════════════ Save / Copy / Clear ═══════════════
    private void BtnSave_OnClick(object sender, RoutedEventArgs e)
    {
        if (_store == null) return;
        if (!HasAnyContent())
        {
            ShowError("没有可保存的内容。");
            return;
        }

        var record = BuildMeetingFromWorkbench();
        try
        {
            _store.ExportMarkdown(record, null);
            _store.UpsertMeeting(record);
            _workbenchMeeting = record;
            RefreshLibrary();
            UpdateWorkbenchHint();
            MessageBox.Show($"已保存到会议库：\n{record.MarkdownPath}", "保存成功", MessageBoxButton.OK, MessageBoxImage.Information);
        }
        catch (Exception ex)
        {
            ShowError($"保存失败：{ex.Message}");
        }
    }
    private void BtnCopy_OnClick(object sender, RoutedEventArgs e)
    {
        var sb = new StringBuilder();
        var agenda = AgendaBox.Text.Trim();
        var notes = QuickNotesBox.Text.Trim();
        if (!string.IsNullOrWhiteSpace(_lastSummary))
        {
            sb.AppendLine("## 会议纪要");
            sb.AppendLine();
            sb.AppendLine(_lastSummary);
            sb.AppendLine();
        }
        if (!string.IsNullOrWhiteSpace(agenda))
        {
            sb.AppendLine("## 议程");
            sb.AppendLine();
            sb.AppendLine(agenda);
            sb.AppendLine();
        }
        if (!string.IsNullOrWhiteSpace(notes))
        {
            sb.AppendLine("## 会上手记");
            sb.AppendLine();
            sb.AppendLine(notes);
        }
        try
        {
            var text = sb.ToString().Trim();
            if (!string.IsNullOrWhiteSpace(text))
                Clipboard.SetText(text);
        }
        catch { }
    }
    private void BtnClear_OnClick(object sender, RoutedEventArgs e)
    {
        if (MessageBox.Show("确定要清空当前会议记录？", "确认", MessageBoxButton.YesNo, MessageBoxImage.Question) != MessageBoxResult.Yes)
            return;

        NewWorkbenchMeeting();
    }

    // ═══════════════ Library ═══════════════

    private List<MeetingRecord> GetFilteredMeetings()
    {
        if (_store == null) return new List<MeetingRecord>();
        List<MeetingRecord> meetings;
        try
        {
            meetings = _store.LoadMeetings();
            _projects = _store.LoadProjects();
        }
        catch
        {
            return new List<MeetingRecord>();
        }

        var filterId = (LibProjectFilter.SelectedItem as ComboBoxItem)?.Tag?.ToString() ?? "";
        var filtered = string.IsNullOrEmpty(filterId)
            ? meetings
            : meetings.Where(m => m.ProjectId == filterId).ToList();

        if (!_libShowArchived)
            filtered = filtered.Where(m => m.Status != MeetingStatus.Archived).ToList();

        if (!string.IsNullOrWhiteSpace(_libSearchKeyword))
        {
            var kw = _libSearchKeyword;
            filtered = filtered.Where(m => MeetingMatchesSearch(m, kw)).ToList();
        }

        return filtered.OrderByDescending(m => m.StartTime).ToList();
    }

    private bool MeetingMatchesSearch(MeetingRecord m, string kw)
    {
        if (m.Title.Contains(kw, StringComparison.OrdinalIgnoreCase)) return true;
        if (m.Tags.Any(t => t.Contains(kw, StringComparison.OrdinalIgnoreCase))) return true;
        if (m.Attendees.Any(a => a.Name.Contains(kw, StringComparison.OrdinalIgnoreCase)
                                 || a.Role.Contains(kw, StringComparison.OrdinalIgnoreCase))) return true;
        if (m.AgendaItems.Any(a => a.Contains(kw, StringComparison.OrdinalIgnoreCase))) return true;
        if (m.QuickNotes.Contains(kw, StringComparison.OrdinalIgnoreCase)) return true;
        if (m.SummaryMarkdown.Contains(kw, StringComparison.OrdinalIgnoreCase)) return true;
        var text = GetMeetingText(m);
        return text.Contains(kw, StringComparison.OrdinalIgnoreCase);
    }

    private void RefreshLibrary()
    {
        if (_store == null) return;
        var filtered = GetFilteredMeetings();

        if (_libGroupedView)
        {
            LibMeetingList.Visibility = Visibility.Collapsed;
            LibProjectTree.Visibility = Visibility.Visible;
            PopulateLibProjectTree(filtered);
        }
        else
        {
            LibProjectTree.Visibility = Visibility.Collapsed;
            LibMeetingList.Visibility = Visibility.Visible;
            LibMeetingList.Items.Clear();
            foreach (var m in filtered)
                LibMeetingList.Items.Add(MakeMeetingListItem(m));
        }

        var totalMinutes = filtered.Sum(m => m.DurationSeconds) / 60;
        var searchHint = string.IsNullOrWhiteSpace(_libSearchKeyword) ? "" : $" · 搜索「{_libSearchKeyword}」";
        LibStatsText.Text = $"会议 {filtered.Count} 场 · 总时长 {totalMinutes} 分钟 · 项目 {_projects.Count} 个{searchHint}";
    }

    private ListBoxItem MakeMeetingListItem(MeetingRecord m)
    {
        var projName = _projects.FirstOrDefault(p => p.Id == m.ProjectId)?.Name;
        var label = $"{m.StartTime:MM-dd HH:mm}  {m.Title}";
        if (m.Status == MeetingStatus.Planned) label += "（计划）";
        if (m.Status == MeetingStatus.Archived) label += "（归档）";
        if (!string.IsNullOrWhiteSpace(projName)) label += $"  ·{projName}";
        return new ListBoxItem { Content = label, Tag = m };
    }

    private void PopulateLibProjectTree(IReadOnlyList<MeetingRecord> meetings)
    {
        LibProjectTree.Items.Clear();
        var groups = meetings.GroupBy(m => m.ProjectId ?? "")
            .OrderBy(g => string.IsNullOrEmpty(g.Key) ? "zzz" : (_projects.FirstOrDefault(p => p.Id == g.Key)?.Name ?? g.Key))
            .ToList();

        foreach (var g in groups)
        {
            var projName = string.IsNullOrEmpty(g.Key) ? "未分类" : (_projects.FirstOrDefault(p => p.Id == g.Key)?.Name ?? "未分类");
            var header = new TreeViewItem
            {
                Header = $"{projName}（{g.Count()}）",
                Tag = $"project:{g.Key}",
                IsExpanded = true,
            };
            foreach (var m in g.OrderByDescending(x => x.StartTime))
            {
                var child = new TreeViewItem
                {
                    Header = $"{m.StartTime:MM-dd HH:mm}  {m.Title}",
                    Tag = m,
                };
                header.Items.Add(child);
            }
            LibProjectTree.Items.Add(header);
        }
    }

    private void LibViewModeCombo_OnSelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!_loaded) return;
        var mode = (LibViewModeCombo.SelectedItem as ComboBoxItem)?.Tag?.ToString() ?? "flat";
        _libGroupedView = mode == "grouped";
        RefreshLibrary();
    }

    private void BtnLibSearch_OnClick(object sender, RoutedEventArgs e)
    {
        _libSearchKeyword = LibSearchBox.Text.Trim();
        RefreshLibrary();
    }

    private void LibSearchBox_OnKeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter)
        {
            _libSearchKeyword = LibSearchBox.Text.Trim();
            RefreshLibrary();
            e.Handled = true;
        }
    }

    private void LibShowArchivedCheck_OnChanged(object sender, RoutedEventArgs e)
    {
        if (!_loaded) return;
        _libShowArchived = LibShowArchivedCheck.IsChecked == true;
        RefreshLibrary();
    }

    private void BtnLibDelete_OnClick(object sender, RoutedEventArgs e)
    {
        if (_store == null || _selectedLibMeeting == null)
        {
            MessageBox.Show("请先在左侧选择一场会议。", "提示", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }
        var rec = _selectedLibMeeting;
        if (MessageBox.Show($"确定永久删除会议「{rec.Title}」？\n此操作将删除会议记录及 Markdown 文件，不可恢复。",
                "确认删除", MessageBoxButton.YesNo, MessageBoxImage.Warning) != MessageBoxResult.Yes)
            return;

        try
        {
            if (_workbenchMeeting?.Id == rec.Id)
                NewWorkbenchMeeting();
            _store.DeleteMeeting(rec.Id);
            _selectedLibMeeting = null;
            LibDetailTitle.Text = "选择左侧会议查看详情";
            _ = RenderMdAsync(LibDetailBox, null);
            RefreshLibrary();
        }
        catch (Exception ex)
        {
            MessageBox.Show($"删除失败：{ex.Message}", "错误", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void BtnLibArchive_OnClick(object sender, RoutedEventArgs e)
    {
        if (_store == null || _selectedLibMeeting == null)
        {
            MessageBox.Show("请先在左侧选择一场会议。", "提示", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }
        var rec = _selectedLibMeeting;
        if (rec.Status == MeetingStatus.Archived)
        {
            MessageBox.Show("该会议已归档。", "提示", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }
        if (MessageBox.Show($"将会议「{rec.Title}」归档？\n归档后默认列表中隐藏，Markdown 将移至 _archive 目录。",
                "确认归档", MessageBoxButton.YesNo, MessageBoxImage.Question) != MessageBoxResult.Yes)
            return;

        try
        {
            var archived = _store.ArchiveMeeting(rec);
            _selectedLibMeeting = archived;
            if (_workbenchMeeting?.Id == archived.Id)
                _workbenchMeeting = archived;
            if (!_libShowArchived)
            {
                _selectedLibMeeting = null;
                LibDetailTitle.Text = "会议已归档（勾选「显示归档」可查看）";
                _ = RenderMdAsync(LibDetailBox, null);
            }
            else
                ShowLibraryMeetingDetail(archived);
            RefreshLibrary();
        }
        catch (Exception ex)
        {
            MessageBox.Show($"归档失败：{ex.Message}", "错误", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void LibProjectTree_OnSelectedItemChanged(object sender, RoutedPropertyChangedEventArgs<object> e)
    {
        if (e.NewValue is TreeViewItem item && item.Tag is MeetingRecord rec)
            ShowLibraryMeetingDetail(rec);
    }

    private void LibProjectFilter_OnSelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!_loaded) return;
        RefreshLibrary();
    }

    private void BtnLibRefresh_OnClick(object sender, RoutedEventArgs e)
    {
        if (_store == null) return;
        _store.MigrateLegacyMarkdown();
        PopulateProjectCombos();
        RefreshLibrary();
    }

    private void LibMeetingList_OnSelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (LibMeetingList.SelectedItem is not ListBoxItem item || item.Tag is not MeetingRecord rec)
            return;
        ShowLibraryMeetingDetail(rec);
    }

    private void ShowLibraryMeetingDetail(MeetingRecord rec)
    {
        if (_libEditMode) ExitLibEditMode(false);

        _selectedLibMeeting = rec;
        LibDetailTitle.Text = rec.Title;
        var sb = new StringBuilder();
        var projName = _projects.FirstOrDefault(p => p.Id == rec.ProjectId)?.Name;
        sb.AppendLine($"时间：{rec.StartTime:yyyy-MM-dd HH:mm}");
        if (rec.EndTime.HasValue)
            sb.AppendLine($"结束：{rec.EndTime:yyyy-MM-dd HH:mm}");
        sb.AppendLine($"状态：{StatusLabel(rec.Status)}");
        if (!string.IsNullOrWhiteSpace(projName))
            sb.AppendLine($"项目：{projName}");
        if (rec.Tags.Count > 0)
            sb.AppendLine($"标签：{string.Join("、", rec.Tags)}");
        if (rec.Attendees.Count > 0)
        {
            sb.AppendLine($"参会人：{string.Join("、", rec.Attendees.Select(a =>
                string.IsNullOrWhiteSpace(a.Role) ? a.Name : $"{a.Name}（{a.Role}）"))}");
        }
        sb.AppendLine();

        if (!string.IsNullOrWhiteSpace(rec.MarkdownPath) && File.Exists(rec.MarkdownPath))
        {
            try
            {
                sb.AppendLine(File.ReadAllText(rec.MarkdownPath, Encoding.UTF8));
                _ = RenderMdAsync(LibDetailBox, sb.ToString());
                return;
            }
            catch
            {
                // fall through
            }
        }

        if (!string.IsNullOrWhiteSpace(rec.SummaryMarkdown))
        {
            sb.AppendLine("## 会议纪要");
            sb.AppendLine();
            sb.AppendLine(rec.SummaryMarkdown);
        }
        if (!string.IsNullOrWhiteSpace(rec.QuickNotes))
        {
            sb.AppendLine();
            sb.AppendLine("## 会上手记");
            sb.AppendLine();
            sb.AppendLine(rec.QuickNotes);
        }
        _ = RenderMdAsync(LibDetailBox, sb.ToString());
    }

    private string GetEditableSummary(MeetingRecord rec)
    {
        if (!string.IsNullOrWhiteSpace(rec.SummaryMarkdown))
            return rec.SummaryMarkdown;
        return GetMeetingText(rec);
    }

    private void BtnLibEdit_OnClick(object sender, RoutedEventArgs e)
    {
        if (_selectedLibMeeting == null)
        {
            MessageBox.Show("请先在左侧选择一场会议。", "提示", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }
        EnterLibEditMode();
    }

    private void EnterLibEditMode()
    {
        if (_selectedLibMeeting == null) return;
        _libEditMode = true;
        LibDetailEditor.Text = GetEditableSummary(_selectedLibMeeting);
        LibDetailBox.Visibility = Visibility.Collapsed;
        LibDetailEditor.Visibility = Visibility.Visible;
        BtnLibEdit.Visibility = Visibility.Collapsed;
        BtnLibSaveEdit.Visibility = Visibility.Visible;
        BtnLibCancelEdit.Visibility = Visibility.Visible;
    }

    private void ExitLibEditMode(bool save)
    {
        if (save && _selectedLibMeeting != null && _store != null)
        {
            _selectedLibMeeting.SummaryMarkdown = LibDetailEditor.Text.Trim();
            try
            {
                _store.ExportMarkdown(_selectedLibMeeting, null);
                _store.UpsertMeeting(_selectedLibMeeting);
                RefreshLibrary();
            }
            catch (Exception ex)
            {
                MessageBox.Show($"保存失败：{ex.Message}", "错误", MessageBoxButton.OK, MessageBoxImage.Error);
                return;
            }
        }

        _libEditMode = false;
        LibDetailEditor.Visibility = Visibility.Collapsed;
        LibDetailBox.Visibility = Visibility.Visible;
        BtnLibEdit.Visibility = Visibility.Visible;
        BtnLibSaveEdit.Visibility = Visibility.Collapsed;
        BtnLibCancelEdit.Visibility = Visibility.Collapsed;

        if (_selectedLibMeeting != null)
            ShowLibraryMeetingDetail(_selectedLibMeeting);
    }

    private void BtnLibSaveEdit_OnClick(object sender, RoutedEventArgs e) => ExitLibEditMode(true);

    private void BtnLibCancelEdit_OnClick(object sender, RoutedEventArgs e) => ExitLibEditMode(false);

    private void BtnLibOpenWorkbench_OnClick(object sender, RoutedEventArgs e)
    {
        if (_selectedLibMeeting == null)
        {
            MessageBox.Show("请先在左侧选择一场会议。", "提示", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }
        LoadWorkbenchMeeting(_selectedLibMeeting);
        HubTabs.SelectedIndex = 0;
    }

    private void BtnAddProject_OnClick(object sender, RoutedEventArgs e)
    {
        if (_store == null) return;
        var name = NewProjectNameBox.Text.Trim();
        if (string.IsNullOrWhiteSpace(name))
        {
            ShowError("请输入项目名称。");
            return;
        }

        var project = new MeetingProject { Name = name };
        _store.UpsertProject(project);
        _projects = _store.LoadProjects();
        NewProjectNameBox.Text = "";
        PopulateProjectCombos();
        RefreshLibrary();
    }

    // ═══════════════ Templates ═══════════════

    private void BtnTplNew_OnClick(object sender, RoutedEventArgs e) => ResetTemplateForm();

    private void ResetTemplateForm()
    {
        _editingTemplateId = null;
        TplList.SelectedItem = null;
        TplFormTitle.Text = "新建模板";
        TplMetaText.Text = "自定义模板可编辑、删除；内置模板仅可修改内容。";
        TplNameBox.Text = "";
        TplCategoryBox.Text = "";
        TplAgendaBox.Text = "";
        TplPromptBox.Text = "";
        TplPreviewText.Text = "";
        BtnTplDelete.IsEnabled = false;
    }

    private void TplList_OnSelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (TplList.SelectedItem is not ListBoxItem item || item.Tag is not string id)
            return;
        var tpl = _templates.FirstOrDefault(t => t.Id == id);
        if (tpl == null) return;

        _editingTemplateId = tpl.Id;
        TplFormTitle.Text = tpl.BuiltIn ? $"编辑内置模板 · {tpl.Name}" : $"编辑模板 · {tpl.Name}";
        TplNameBox.Text = tpl.Name;
        TplCategoryBox.Text = tpl.Category;
        TplAgendaBox.Text = string.Join(Environment.NewLine, tpl.AgendaTemplate);
        TplPromptBox.Text = tpl.SummaryPromptOverride;
        BtnTplDelete.IsEnabled = !tpl.BuiltIn;

        var meta = new StringBuilder();
        meta.Append($"默认时长 {tpl.DefaultDurationMinutes} 分钟");
        if (!string.IsNullOrWhiteSpace(tpl.Category)) meta.Append($" · 分类 {tpl.Category}");
        meta.Append(tpl.BuiltIn ? " · 内置（不可删除）" : " · 自定义");
        TplMetaText.Text = meta.ToString();

        var preview = new StringBuilder();
        if (tpl.StructuredSections.Count > 0)
            preview.AppendLine($"分区：{string.Join(" / ", tpl.StructuredSections)}");
        if (tpl.DefaultTags.Count > 0)
            preview.AppendLine($"默认标签：{string.Join("、", tpl.DefaultTags)}");
        if (tpl.AgendaTemplate.Count > 0)
            preview.AppendLine($"议程：{string.Join("；", tpl.AgendaTemplate)}");
        TplPreviewText.Text = preview.ToString().Trim();
    }

    private void BtnTplSave_OnClick(object sender, RoutedEventArgs e)
    {
        if (_store == null) return;
        var name = TplNameBox.Text.Trim();
        if (string.IsNullOrWhiteSpace(name))
        {
            ShowError("请输入模板名称。");
            return;
        }

        MeetingTemplate target;
        if (!string.IsNullOrWhiteSpace(_editingTemplateId))
        {
            target = _templates.FirstOrDefault(t => t.Id == _editingTemplateId)
                     ?? new MeetingTemplate { Id = _editingTemplateId };
            if (!_templates.Any(t => t.Id == target.Id))
                _templates.Add(target);
        }
        else
        {
            target = new MeetingTemplate { BuiltIn = false };
            _templates.Add(target);
            _editingTemplateId = target.Id;
        }

        target.Name = name;
        target.Category = TplCategoryBox.Text.Trim();
        target.AgendaTemplate = SplitLines(TplAgendaBox.Text);
        target.SummaryPromptOverride = TplPromptBox.Text.Trim();

        _store.SaveTemplates(_templates);
        _templates = _store.LoadTemplates();
        PopulateTemplateCombo();
        PopulateTemplateList();
        foreach (var obj in TplList.Items)
        {
            if (obj is ListBoxItem it && it.Tag?.ToString() == _editingTemplateId)
            {
                TplList.SelectedItem = it;
                break;
            }
        }
        if (TemplateCombo.Items.Count > 0 && TemplateCombo.SelectedIndex < 0)
            TemplateCombo.SelectedIndex = 0;
        MessageBox.Show("模板已保存。", "成功", MessageBoxButton.OK, MessageBoxImage.Information);
    }

    private void BtnTplDelete_OnClick(object sender, RoutedEventArgs e)
    {
        if (_store == null || string.IsNullOrWhiteSpace(_editingTemplateId))
        {
            MessageBox.Show("请先选择要删除的自定义模板。", "提示", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }
        var tpl = _templates.FirstOrDefault(t => t.Id == _editingTemplateId);
        if (tpl == null) return;
        if (tpl.BuiltIn)
        {
            MessageBox.Show("内置模板不可删除，但可以修改议程与提示词。", "提示", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }
        if (MessageBox.Show($"确定删除模板「{tpl.Name}」？", "确认", MessageBoxButton.YesNo, MessageBoxImage.Question) != MessageBoxResult.Yes)
            return;

        _store.DeleteTemplate(tpl.Id);
        _templates = _store.LoadTemplates();
        PopulateTemplateCombo();
        PopulateTemplateList();
        ResetTemplateForm();
    }

    // ═══════════════ Calendar ═══════════════

    private void HubTabs_OnSelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!_loaded) return;
        if (e.OriginalSource is not TabControl) return;
        if (HubTabs.SelectedIndex == 1) RenderCalendar();
        else if (HubTabs.SelectedIndex == 2) RefreshLibrary();
        else if (HubTabs.SelectedIndex == 3) RefreshSeriesTab();
        else if (HubTabs.SelectedIndex == 5) RenderDashboard();
    }

    private void BtnCalPrev_OnClick(object sender, RoutedEventArgs e)
    {
        _calMonth = _calMonth.AddMonths(-1);
        RenderCalendar();
    }

    private void BtnCalNext_OnClick(object sender, RoutedEventArgs e)
    {
        _calMonth = _calMonth.AddMonths(1);
        RenderCalendar();
    }

    private void BtnCalToday_OnClick(object sender, RoutedEventArgs e)
    {
        _calMonth = new DateTime(DateTime.Now.Year, DateTime.Now.Month, 1);
        SelectCalendarDay(DateTime.Today);
    }

    private void RenderCalendar()
    {
        if (CalendarDaysGrid == null) return;

        CalMonthLabel.Text = $"{_calMonth.Year} 年 {_calMonth.Month} 月";

        List<MeetingRecord> meetings;
        try { meetings = _store?.LoadMeetings() ?? new List<MeetingRecord>(); }
        catch { meetings = new List<MeetingRecord>(); }

        var byDay = meetings
            .GroupBy(m => m.StartTime.Date)
            .ToDictionary(g => g.Key, g => g.OrderBy(m => m.StartTime).ToList());

        var monthCount = meetings.Count(m => m.StartTime.Year == _calMonth.Year && m.StartTime.Month == _calMonth.Month);
        CalSummaryText.Text = $"本月 {monthCount} 场会议";

        CalendarDaysGrid.Children.Clear();

        int offset = ((int)_calMonth.DayOfWeek + 6) % 7;
        var gridStart = _calMonth.AddDays(-offset);
        var today = DateTime.Today;

        for (int i = 0; i < 42; i++)
        {
            var date = gridStart.AddDays(i);
            byDay.TryGetValue(date.Date, out var dayMeetings);
            var inMonth = date.Month == _calMonth.Month && date.Year == _calMonth.Year;
            var isToday = date.Date == today;
            var isSelected = _calSelectedDate.HasValue && date.Date == _calSelectedDate.Value.Date;
            CalendarDaysGrid.Children.Add(BuildDayCell(date, inMonth, isToday, isSelected, dayMeetings));
        }
    }

    private Border BuildDayCell(DateTime date, bool inMonth, bool isToday, bool isSelected, List<MeetingRecord>? dayMeetings)
    {
        var cell = new Border
        {
            Margin = new Thickness(2),
            CornerRadius = new CornerRadius(6),
            BorderThickness = new Thickness(isToday ? 1.6 : 1),
            Background = (Brush)FindResource(isSelected ? "BrushSurfaceMuted" : "BrushSurface"),
            BorderBrush = (Brush)FindResource(isToday ? "BrushBorderFocus" : "BrushBorderSubtle"),
            Padding = new Thickness(6, 4, 6, 4),
            Cursor = System.Windows.Input.Cursors.Hand,
            MinHeight = 52,
        };

        var grid = new Grid();
        grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        grid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });

        var dayText = new TextBlock
        {
            Text = date.Day.ToString(),
            FontSize = 12.5,
            FontWeight = isToday ? FontWeights.Bold : FontWeights.Normal,
            Foreground = (Brush)FindResource(inMonth ? (isToday ? "BrushAccent" : "BrushTextPrimary") : "BrushTextMuted"),
        };
        Grid.SetRow(dayText, 0);
        grid.Children.Add(dayText);

        var stack = new StackPanel { Margin = new Thickness(0, 4, 0, 0) };
        Grid.SetRow(stack, 1);
        if (dayMeetings != null && dayMeetings.Count > 0)
        {
            int show = Math.Min(3, dayMeetings.Count);
            for (int i = 0; i < show; i++)
            {
                var m = dayMeetings[i];
                var pill = new Border
                {
                    Background = ProjectBrush(m.ProjectId),
                    CornerRadius = new CornerRadius(3),
                    Padding = new Thickness(4, 1, 4, 1),
                    Margin = new Thickness(0, 0, 0, 2),
                    Opacity = inMonth ? 1.0 : 0.45,
                };
                pill.Child = new TextBlock
                {
                    Text = m.Title,
                    FontSize = 10.5,
                    Foreground = Brushes.White,
                    TextTrimming = TextTrimming.CharacterEllipsis,
                };
                stack.Children.Add(pill);
            }
            if (dayMeetings.Count > show)
            {
                stack.Children.Add(new TextBlock
                {
                    Text = $"+{dayMeetings.Count - show} 更多",
                    FontSize = 10,
                    Foreground = (Brush)FindResource("BrushTextMuted"),
                });
            }
        }
        grid.Children.Add(stack);

        cell.Child = grid;
        cell.MouseLeftButtonUp += (_, _) => SelectCalendarDay(date);
        return cell;
    }

    private Brush ProjectBrush(string projectId)
    {
        var hex = _projects.FirstOrDefault(p => p.Id == projectId)?.Color;
        if (string.IsNullOrWhiteSpace(hex)) hex = "#4F6EF7";
        try { return (Brush)new BrushConverter().ConvertFromString(hex)!; }
        catch { return (Brush)new BrushConverter().ConvertFromString("#4F6EF7")!; }
    }

    private void SelectCalendarDay(DateTime date)
    {
        _calSelectedDate = date.Date;
        if (date.Year != _calMonth.Year || date.Month != _calMonth.Month)
            _calMonth = new DateTime(date.Year, date.Month, 1);
        RenderCalendar();

        List<MeetingRecord> meetings;
        try { meetings = _store?.LoadMeetings() ?? new List<MeetingRecord>(); }
        catch { meetings = new List<MeetingRecord>(); }

        var dayMeetings = meetings.Where(m => m.StartTime.Date == date.Date)
            .OrderBy(m => m.StartTime).ToList();

        var weekNames = new[] { "周日", "周一", "周二", "周三", "周四", "周五", "周六" };
        CalDayTitle.Text = $"{date:M月d日} {weekNames[(int)date.DayOfWeek]} · {dayMeetings.Count} 场";

        CalDayMeetingList.Items.Clear();
        foreach (var m in dayMeetings)
        {
            var projName = _projects.FirstOrDefault(p => p.Id == m.ProjectId)?.Name;
            var label = $"{m.StartTime:HH:mm}  {m.Title}";
            if (m.Status == MeetingStatus.Planned) label += "（计划）";
            if (!string.IsNullOrWhiteSpace(projName)) label += $"  ·{projName}";
            CalDayMeetingList.Items.Add(new ListBoxItem { Content = label, Tag = m });
        }
    }

    private void CalDayMeetingList_OnSelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (CalDayMeetingList.SelectedItem is not ListBoxItem item || item.Tag is not MeetingRecord rec)
            return;
        SelectMeetingInLibrary(rec);
    }

    private void SelectMeetingInLibrary(MeetingRecord rec)
    {
        if (LibProjectFilter.Items.Count > 0)
            LibProjectFilter.SelectedIndex = 0;
        RefreshLibrary();
        HubTabs.SelectedIndex = 2;

        if (_libGroupedView)
        {
            foreach (var obj in LibProjectTree.Items)
            {
                if (obj is not TreeViewItem group) continue;
                foreach (var childObj in group.Items)
                {
                    if (childObj is TreeViewItem child && child.Tag is MeetingRecord m && m.Id == rec.Id)
                    {
                        group.IsExpanded = true;
                        child.IsSelected = true;
                        child.BringIntoView();
                        ShowLibraryMeetingDetail(rec);
                        return;
                    }
                }
            }
        }
        else
        {
            foreach (var obj in LibMeetingList.Items)
            {
                if (obj is ListBoxItem it && it.Tag is MeetingRecord m && m.Id == rec.Id)
                {
                    LibMeetingList.SelectedItem = it;
                    it.BringIntoView();
                    break;
                }
            }
        }
    }

    private void BtnCalSchedule_OnClick(object sender, RoutedEventArgs e)
    {
        if (_store == null) return;
        var date = _calSelectedDate ?? DateTime.Today;
        var title = PromptForText("排会", $"在 {date:yyyy-MM-dd} 安排一场会议，请输入主题：", $"会议 {date:MM-dd}");
        if (string.IsNullOrWhiteSpace(title)) return;

        var rec = new MeetingRecord
        {
            Title = title.Trim(),
            StartTime = date.Date.AddHours(9),
            EndTime = null,
            DurationSeconds = 0,
            Status = MeetingStatus.Planned,
        };
        _store.UpsertMeeting(rec);
        RefreshLibrary();
        SelectCalendarDay(date);
    }

    private static string? PromptForText(string title, string prompt, string defaultValue)
    {
        var win = new Window
        {
            Title = title,
            Width = 400,
            SizeToContent = SizeToContent.Height,
            WindowStartupLocation = WindowStartupLocation.CenterScreen,
            ResizeMode = ResizeMode.NoResize,
            WindowStyle = WindowStyle.ToolWindow,
            Owner = Application.Current?.MainWindow,
            ShowInTaskbar = false,
        };
        var panel = new StackPanel { Margin = new Thickness(18) };
        panel.Children.Add(new TextBlock { Text = prompt, Margin = new Thickness(0, 0, 0, 10), TextWrapping = TextWrapping.Wrap });
        var box = new TextBox { Text = defaultValue, Padding = new Thickness(6, 4, 6, 4), FontSize = 13 };
        panel.Children.Add(box);
        var btns = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 14, 0, 0) };
        var ok = new Button { Content = "确定", MinWidth = 76, Margin = new Thickness(0, 0, 8, 0), Padding = new Thickness(10, 5, 10, 5), IsDefault = true };
        var cancel = new Button { Content = "取消", MinWidth = 76, Padding = new Thickness(10, 5, 10, 5), IsCancel = true };
        btns.Children.Add(ok);
        btns.Children.Add(cancel);
        panel.Children.Add(btns);
        win.Content = panel;

        string? result = null;
        ok.Click += (_, _) => { result = box.Text; win.DialogResult = true; };
        box.Loaded += (_, _) => { box.SelectAll(); box.Focus(); };
        return win.ShowDialog() == true ? result : null;
    }

    // ═══════════════ Recurring series ═══════════════

    private void InitSeriesTab()
    {
        InitSeriesRecurrenceCombo();
        PopulateSeriesCombos();
        RefreshSeriesList();
        ResetSeriesForm();
    }

    private void RefreshSeriesTab()
    {
        PopulateSeriesCombos();
        RefreshSeriesList();
    }

    private void InitSeriesRecurrenceCombo()
    {
        SeriesRecurrenceCombo.Items.Clear();
        SeriesRecurrenceCombo.Items.Add(new ComboBoxItem { Content = "每天", Tag = RecurrenceType.Daily });
        SeriesRecurrenceCombo.Items.Add(new ComboBoxItem { Content = "每周", Tag = RecurrenceType.Weekly });
        SeriesRecurrenceCombo.Items.Add(new ComboBoxItem { Content = "每两周", Tag = RecurrenceType.BiWeekly });
        SeriesRecurrenceCombo.Items.Add(new ComboBoxItem { Content = "每月", Tag = RecurrenceType.Monthly });
        SeriesRecurrenceCombo.Items.Add(new ComboBoxItem { Content = "工作日", Tag = RecurrenceType.Weekday });
        SeriesRecurrenceCombo.SelectedIndex = 1;
    }

    private void PopulateSeriesCombos()
    {
        var prevProj = (SeriesProjectCombo.SelectedItem as ComboBoxItem)?.Tag?.ToString();
        SeriesProjectCombo.Items.Clear();
        SeriesProjectCombo.Items.Add(new ComboBoxItem { Content = "（无项目）", Tag = "" });
        foreach (var pr in _projects)
            SeriesProjectCombo.Items.Add(new ComboBoxItem { Content = pr.Name, Tag = pr.Id });
        SeriesProjectCombo.SelectedItem = SeriesProjectCombo.Items.Cast<ComboBoxItem>()
            .FirstOrDefault(i => (i.Tag?.ToString() ?? "") == (prevProj ?? "")) ?? SeriesProjectCombo.Items[0];

        var prevTpl = (SeriesTemplateCombo.SelectedItem as ComboBoxItem)?.Tag?.ToString();
        SeriesTemplateCombo.Items.Clear();
        SeriesTemplateCombo.Items.Add(new ComboBoxItem { Content = "（无模板）", Tag = "" });
        foreach (var t in _templates)
            SeriesTemplateCombo.Items.Add(new ComboBoxItem { Content = $"{t.Icon} {t.Name}", Tag = t.Id });
        SeriesTemplateCombo.SelectedItem = SeriesTemplateCombo.Items.Cast<ComboBoxItem>()
            .FirstOrDefault(i => (i.Tag?.ToString() ?? "") == (prevTpl ?? "")) ?? SeriesTemplateCombo.Items[0];
    }

    private void RefreshSeriesList()
    {
        if (_store == null) return;
        try { _series = _store.LoadSeries(); }
        catch { _series = new List<MeetingSeries>(); }

        SeriesList.Items.Clear();
        foreach (var s in _series.OrderBy(x => x.Name))
        {
            var label = $"{(s.Active ? "🔁" : "⏸")} {s.Name}";
            var rec = RecurrenceLabel(s.Recurrence);
            if (!string.IsNullOrWhiteSpace(rec)) label += $"  ·{rec}";
            SeriesList.Items.Add(new ListBoxItem { Content = label, Tag = s });
        }
    }

    private static string RecurrenceLabel(MeetingRecurrence r)
    {
        if (r == null) return "";
        var time = $"{r.Hour:D2}:{r.Minute:D2}";
        var wk = new[] { "日", "一", "二", "三", "四", "五", "六" };
        switch (r.Type)
        {
            case RecurrenceType.Daily: return $"每天 {time}";
            case RecurrenceType.Weekday: return $"工作日 {time}";
            case RecurrenceType.Monthly: return $"每月{r.DayOfMonth}号 {time}";
            case RecurrenceType.Weekly:
            case RecurrenceType.BiWeekly:
                var days = r.DaysOfWeek.Count > 0
                    ? "周" + string.Join("", r.DaysOfWeek.OrderBy(d => d).Select(d => wk[Math.Clamp(d, 0, 6)]))
                    : "";
                var prefix = r.Type == RecurrenceType.BiWeekly ? "每两周" : "每周";
                return $"{prefix}{days} {time}";
            default: return time;
        }
    }

    private void SeriesList_OnSelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (SeriesList.SelectedItem is not ListBoxItem item || item.Tag is not MeetingSeries s) return;
        _selectedSeries = s;
        LoadSeriesIntoForm(s);
    }

    private void LoadSeriesIntoForm(MeetingSeries s)
    {
        SeriesNameBox.Text = s.Name;
        SelectComboByTag(SeriesProjectCombo, s.ProjectId);
        SelectComboByTag(SeriesTemplateCombo, s.TemplateId);
        SelectComboByTag(SeriesRecurrenceCombo, s.Recurrence.Type);
        Dow0.IsChecked = s.Recurrence.DaysOfWeek.Contains(0);
        Dow1.IsChecked = s.Recurrence.DaysOfWeek.Contains(1);
        Dow2.IsChecked = s.Recurrence.DaysOfWeek.Contains(2);
        Dow3.IsChecked = s.Recurrence.DaysOfWeek.Contains(3);
        Dow4.IsChecked = s.Recurrence.DaysOfWeek.Contains(4);
        Dow5.IsChecked = s.Recurrence.DaysOfWeek.Contains(5);
        Dow6.IsChecked = s.Recurrence.DaysOfWeek.Contains(6);
        SeriesDayOfMonthBox.Text = s.Recurrence.DayOfMonth.ToString();
        SeriesHourBox.Text = s.Recurrence.Hour.ToString();
        SeriesMinuteBox.Text = s.Recurrence.Minute.ToString();
        SeriesDurationBox.Text = s.Recurrence.DurationMinutes.ToString();
        SeriesReminderBox.Text = s.ReminderMinutesBefore.ToString();
        SeriesAgendaBox.Text = string.Join(Environment.NewLine, s.DefaultAgenda);
        SeriesActiveCheck.IsChecked = s.Active;
        UpdateRecurrencePanels();
        PreviewSeries(s);
    }

    private static void SelectComboByTag(ComboBox combo, string tag)
    {
        foreach (var obj in combo.Items)
            if (obj is ComboBoxItem ci && (ci.Tag?.ToString() ?? "") == (tag ?? ""))
            {
                combo.SelectedItem = ci;
                return;
            }
        if (combo.Items.Count > 0) combo.SelectedIndex = 0;
    }

    private void SeriesRecurrenceCombo_OnSelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!_loaded) return;
        UpdateRecurrencePanels();
    }

    private void UpdateRecurrencePanels()
    {
        var type = (SeriesRecurrenceCombo.SelectedItem as ComboBoxItem)?.Tag?.ToString() ?? RecurrenceType.Weekly;
        var weekly = type == RecurrenceType.Weekly || type == RecurrenceType.BiWeekly;
        SeriesWeekdayPanel.Visibility = weekly ? Visibility.Visible : Visibility.Collapsed;
        SeriesMonthdayPanel.Visibility = type == RecurrenceType.Monthly ? Visibility.Visible : Visibility.Collapsed;
    }

    private MeetingSeries BuildSeriesFromForm()
    {
        var s = _selectedSeries ?? new MeetingSeries();
        s.Name = SeriesNameBox.Text.Trim();
        s.ProjectId = (SeriesProjectCombo.SelectedItem as ComboBoxItem)?.Tag?.ToString() ?? "";
        s.TemplateId = (SeriesTemplateCombo.SelectedItem as ComboBoxItem)?.Tag?.ToString() ?? "";
        var type = (SeriesRecurrenceCombo.SelectedItem as ComboBoxItem)?.Tag?.ToString() ?? RecurrenceType.Weekly;
        var days = new List<int>();
        if (Dow0.IsChecked == true) days.Add(0);
        if (Dow1.IsChecked == true) days.Add(1);
        if (Dow2.IsChecked == true) days.Add(2);
        if (Dow3.IsChecked == true) days.Add(3);
        if (Dow4.IsChecked == true) days.Add(4);
        if (Dow5.IsChecked == true) days.Add(5);
        if (Dow6.IsChecked == true) days.Add(6);
        s.Recurrence = new MeetingRecurrence
        {
            Type = type,
            Interval = type == RecurrenceType.BiWeekly ? 2 : 1,
            DaysOfWeek = days,
            DayOfMonth = ParseIntOr(SeriesDayOfMonthBox.Text, 1, 1, 31),
            Hour = ParseIntOr(SeriesHourBox.Text, 10, 0, 23),
            Minute = ParseIntOr(SeriesMinuteBox.Text, 0, 0, 59),
            DurationMinutes = ParseIntOr(SeriesDurationBox.Text, 30, 5, 1440),
        };
        s.ReminderMinutesBefore = ParseIntOr(SeriesReminderBox.Text, 10, 0, 1440);
        s.DefaultAgenda = SplitLines(SeriesAgendaBox.Text);
        s.Active = SeriesActiveCheck.IsChecked == true;
        return s;
    }

    private static int ParseIntOr(string? text, int def, int min, int max)
    {
        if (int.TryParse(text?.Trim(), out var v)) return Math.Clamp(v, min, max);
        return def;
    }

    private void ResetSeriesForm()
    {
        _selectedSeries = null;
        SeriesList.SelectedItem = null;
        SeriesNameBox.Text = "";
        if (SeriesProjectCombo.Items.Count > 0) SeriesProjectCombo.SelectedIndex = 0;
        if (SeriesTemplateCombo.Items.Count > 0) SeriesTemplateCombo.SelectedIndex = 0;
        SeriesRecurrenceCombo.SelectedIndex = 1;
        Dow0.IsChecked = false;
        Dow1.IsChecked = true;
        Dow2.IsChecked = false;
        Dow3.IsChecked = false;
        Dow4.IsChecked = false;
        Dow5.IsChecked = false;
        Dow6.IsChecked = false;
        SeriesDayOfMonthBox.Text = "1";
        SeriesHourBox.Text = "10";
        SeriesMinuteBox.Text = "0";
        SeriesDurationBox.Text = "30";
        SeriesReminderBox.Text = "10";
        SeriesAgendaBox.Text = "";
        SeriesActiveCheck.IsChecked = true;
        UpdateRecurrencePanels();
        SeriesNextText.Text = "下次发生：保存或预览后显示";
    }

    private void BtnSeriesNew_OnClick(object sender, RoutedEventArgs e) => ResetSeriesForm();

    private void BtnSeriesSave_OnClick(object sender, RoutedEventArgs e)
    {
        if (_store == null) return;
        if (string.IsNullOrWhiteSpace(SeriesNameBox.Text))
        {
            ShowError("请输入例会名称。");
            return;
        }
        var s = BuildSeriesFromForm();
        if (_series.All(x => x.Id != s.Id)) _series.Add(s);
        _store.SaveSeries(_series);
        _selectedSeries = s;
        RefreshSeriesList();
        foreach (var obj in SeriesList.Items)
        {
            if (obj is ListBoxItem it && it.Tag is MeetingSeries ms && ms.Id == s.Id)
            {
                SeriesList.SelectedItem = it;
                break;
            }
        }
        PreviewSeries(s);
        ClearError();
    }

    private void BtnSeriesDelete_OnClick(object sender, RoutedEventArgs e)
    {
        if (_store == null || _selectedSeries == null) return;
        if (MessageBox.Show($"确定删除例会「{_selectedSeries.Name}」？", "确认", MessageBoxButton.YesNo, MessageBoxImage.Question) != MessageBoxResult.Yes)
            return;
        var id = _selectedSeries.Id;
        _series.RemoveAll(x => x.Id == id);
        _store.SaveSeries(_series);
        RefreshSeriesList();
        ResetSeriesForm();
    }

    private void BtnSeriesPreview_OnClick(object sender, RoutedEventArgs e) => PreviewSeries(BuildSeriesFromForm());

    private void PreviewSeries(MeetingSeries s)
    {
        try
        {
            var occ = MeetingStore.NextOccurrences(s, DateTime.Now, 3);
            if (occ.Count == 0)
            {
                SeriesNextText.Text = "下次发生：（无匹配，请检查重复设置）";
                return;
            }
            SeriesNextText.Text = "下次发生：\n" + string.Join("\n", occ.Select(o => $"· {o:yyyy-MM-dd ddd HH:mm}"));
        }
        catch (Exception ex)
        {
            SeriesNextText.Text = $"预览失败：{ex.Message}";
        }
    }

    private void BtnSeriesStart_OnClick(object sender, RoutedEventArgs e)
    {
        var s = _selectedSeries ?? BuildSeriesFromForm();
        NewWorkbenchMeeting();
        _suppressTemplateFill = true;
        try
        {
            if (!string.IsNullOrWhiteSpace(s.TemplateId))
                SelectComboByTag(TemplateCombo, s.TemplateId);
            SelectComboByTag(ProjectCombo, s.ProjectId);
            _selectedTemplate = _templates.FirstOrDefault(t => t.Id == s.TemplateId);
            MeetingTitleBox.Text = $"{s.Name} {DateTime.Now:MM-dd}";
            if (s.DefaultAgenda.Count > 0)
                AgendaBox.Text = string.Join(Environment.NewLine, s.DefaultAgenda);
            if (s.DefaultAttendees.Count > 0)
            {
                _workbenchAttendees.Clear();
                _workbenchAttendees.AddRange(s.DefaultAttendees.Select(a => new MeetingAttendee { Name = a.Name, Role = a.Role }));
                RefreshAttendeesList();
            }
            _workbenchMeeting!.SeriesId = s.Id;
        }
        finally
        {
            _suppressTemplateFill = false;
        }
        UpdateWorkbenchHint();
        HubTabs.SelectedIndex = 0;
    }

    // ═══════════════ UI helpers ═══════════════

    private bool HasAnyContent()
    {
        var hasNotes = !string.IsNullOrWhiteSpace(QuickNotesBox.Text);
        var hasAgenda = !string.IsNullOrWhiteSpace(AgendaBox.Text);
        var hasSummary = !string.IsNullOrWhiteSpace(_lastSummary);
        return hasNotes || hasAgenda || hasSummary;
    }

    private void UpdateActionButtons()
    {
        if (!_loaded) return;
        var hasNotes = !string.IsNullOrWhiteSpace(QuickNotesBox.Text);
        var hasAgenda = !string.IsNullOrWhiteSpace(AgendaBox.Text);
        var content = hasNotes || hasAgenda || !string.IsNullOrWhiteSpace(_lastSummary);

        BtnSummary.IsEnabled = (hasNotes || hasAgenda) && !_isBusy;
        BtnSave.IsEnabled = content;
        BtnCopy.IsEnabled = content;
        BtnClear.IsEnabled = content;
    }

    private void ShowSummaryPanel()
    {
        SummaryPanel.Visibility = Visibility.Visible;
        SummaryColumn.Width = new GridLength(1, GridUnitType.Star);
    }

    private void HideSummaryPanel()
    {
        SummaryPanel.Visibility = Visibility.Collapsed;
        SummaryColumn.Width = new GridLength(0);
    }

    private void ShowError(string msg) => ErrorText.Text = msg;
    private void ClearError() => ErrorText.Text = "";

    private static List<string> SplitLines(string text)
    {
        if (string.IsNullOrWhiteSpace(text))
            return new List<string>();
        return text.Replace("\r\n", "\n").Split('\n')
            .Select(l => l.Trim())
            .Where(l => l.Length > 0)
            .ToList();
    }

    // ═══════════════ Phase 4: 统计仪表盘 ═══════════════

    private void BtnDashRefresh_OnClick(object sender, RoutedEventArgs e) => RenderDashboard();

    private void RenderDashboard()
    {
        if (_store == null) return;
        List<MeetingRecord> meetings;
        try { meetings = _store.LoadMeetings(); _projects = _store.LoadProjects(); }
        catch { meetings = new List<MeetingRecord>(); }

        DashCardsHost.Children.Clear();
        DashProjectsHost.Children.Clear();

        var now = DateTime.Now;
        int diff = (7 + (int)now.DayOfWeek - (int)DayOfWeek.Monday) % 7;
        var weekStart = now.Date.AddDays(-diff);
        int weekCount = meetings.Count(m => m.StartTime.Date >= weekStart);
        int totalMin = meetings.Sum(m => m.DurationSeconds) / 60;
        int planned = meetings.Count(m => m.Status == MeetingStatus.Planned);
        var allItems = meetings.SelectMany(m => m.ActionItems).ToList();
        int doneItems = allItems.Count(a => a.Done);
        string rate = allItems.Count == 0 ? "—" : $"{doneItems * 100 / allItems.Count}%";

        DashCardsHost.Children.Add(MakeStatCard("📋", meetings.Count.ToString(), "总会议数"));
        DashCardsHost.Children.Add(MakeStatCard("🗓", weekCount.ToString(), "本周会议"));
        DashCardsHost.Children.Add(MakeStatCard("⏱", totalMin >= 60 ? $"{totalMin / 60.0:0.#}h" : $"{totalMin}m", "累计时长"));
        DashCardsHost.Children.Add(MakeStatCard("📁", _projects.Count.ToString(), "项目数"));
        DashCardsHost.Children.Add(MakeStatCard("📅", planned.ToString(), "计划中"));
        DashCardsHost.Children.Add(MakeStatCard("✅", rate, "行动项完成率"));

        var groups = meetings.GroupBy(m => m.ProjectId ?? "")
            .Select(g => new { Id = g.Key, Count = g.Count(), Minutes = g.Sum(x => x.DurationSeconds) / 60 })
            .OrderByDescending(x => x.Minutes).ThenByDescending(x => x.Count)
            .Take(8).ToList();
        int maxMin = groups.Count > 0 ? Math.Max(1, groups.Max(x => x.Minutes)) : 1;
        foreach (var g in groups)
        {
            var name = string.IsNullOrEmpty(g.Id) ? "未分类" : (_projects.FirstOrDefault(p => p.Id == g.Id)?.Name ?? "未分类");
            DashProjectsHost.Children.Add(MakeProjectRow(name, ProjectBrush(g.Id), g.Count, g.Minutes, (double)g.Minutes / maxMin));
        }
        if (groups.Count == 0)
            DashProjectsHost.Children.Add(new TextBlock { Text = "暂无会议数据", FontSize = 12, Foreground = Res("BrushTextMuted", "#999") });
    }

    private FrameworkElement MakeStatCard(string icon, string value, string label)
    {
        var border = new Border
        {
            Background = Res("BrushSurface", "#ffffff"),
            BorderBrush = Res("BrushBorderSubtle", "#eeeeee"),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(10),
            Padding = new Thickness(10, 8, 10, 8),
            Margin = new Thickness(0, 0, 8, 8),
            Width = 130
        };
        var sp = new StackPanel();
        sp.Children.Add(new TextBlock { Text = $"{icon} {value}", FontSize = 17, FontWeight = FontWeights.SemiBold, Foreground = Res("BrushTextPrimary", "#222222") });
        sp.Children.Add(new TextBlock { Text = label, FontSize = 11, Margin = new Thickness(0, 2, 0, 0), Foreground = Res("BrushTextSecondary", "#666666") });
        border.Child = sp;
        return border;
    }

    private FrameworkElement MakeProjectRow(string name, Brush color, int count, int minutes, double frac)
    {
        var panel = new StackPanel { Margin = new Thickness(2, 0, 2, 8) };
        var head = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 0, 0, 3) };
        head.Children.Add(new Border { Width = 8, Height = 8, CornerRadius = new CornerRadius(2), Background = color, Margin = new Thickness(0, 0, 6, 0), VerticalAlignment = VerticalAlignment.Center });
        head.Children.Add(new TextBlock { Text = name, FontSize = 11.5, Foreground = Res("BrushTextPrimary", "#222222"), VerticalAlignment = VerticalAlignment.Center });
        head.Children.Add(new TextBlock { Text = $"  {count} 场 · {minutes} 分钟", FontSize = 10.5, Foreground = Res("BrushTextMuted", "#999999"), VerticalAlignment = VerticalAlignment.Center });
        panel.Children.Add(head);

        var grid = new Grid { Height = 8 };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(Math.Max(0.02, frac), GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(Math.Max(0.0001, 1 - frac), GridUnitType.Star) });
        var bar = new Border { CornerRadius = new CornerRadius(4), Background = color };
        Grid.SetColumn(bar, 0);
        grid.Children.Add(bar);
        var track = new Border { Height = 8, CornerRadius = new CornerRadius(4), Background = Res("BrushSurfaceMuted", "#eeeeee"), Child = grid };
        panel.Children.Add(track);
        return panel;
    }

    private Brush Res(string key, string fallback)
    {
        if (TryFindResource(key) is Brush b) return b;
        try { return (Brush)new BrushConverter().ConvertFromString(fallback)!; }
        catch { return Brushes.Gray; }
    }

    // ═══════════════ Phase 6: 跨会议检索 / AI 问答 ═══════════════

    private string GetMeetingText(MeetingRecord m)
    {
        try
        {
            if (!string.IsNullOrWhiteSpace(m.MarkdownPath) && File.Exists(m.MarkdownPath))
                return File.ReadAllText(m.MarkdownPath, Encoding.UTF8);
        }
        catch { }
        var sb = new StringBuilder();
        if (!string.IsNullOrWhiteSpace(m.SummaryMarkdown)) sb.AppendLine(m.SummaryMarkdown);
        if (!string.IsNullOrWhiteSpace(m.QuickNotes)) sb.AppendLine(m.QuickNotes);
        return sb.ToString();
    }

    private static string ExtractSnippet(string text, string kw)
    {
        var idx = text.IndexOf(kw, StringComparison.OrdinalIgnoreCase);
        if (idx < 0) return "";
        var start = Math.Max(0, idx - 30);
        var len = Math.Min(text.Length - start, kw.Length + 60);
        var s = text.Substring(start, len).Replace("\r", " ").Replace("\n", " ").Trim();
        return (start > 0 ? "…" : "") + s + "…";
    }

    private void BtnDashKeyword_OnClick(object sender, RoutedEventArgs e)
    {
        if (_store == null) return;
        var kw = DashSearchBox.Text.Trim();
        if (string.IsNullOrWhiteSpace(kw)) { DashSearchResult.Text = "请输入检索关键词。"; return; }
        List<MeetingRecord> meetings;
        try { meetings = _store.LoadMeetings(); } catch { meetings = new List<MeetingRecord>(); }
        var sb = new StringBuilder();
        int hits = 0;
        foreach (var m in meetings.OrderByDescending(x => x.StartTime))
        {
            var text = GetMeetingText(m);
            if (text.IndexOf(kw, StringComparison.OrdinalIgnoreCase) < 0) continue;
            hits++;
            var projName = _projects.FirstOrDefault(p => p.Id == m.ProjectId)?.Name;
            sb.AppendLine($"● {m.StartTime:yyyy-MM-dd} {m.Title}" + (string.IsNullOrWhiteSpace(projName) ? "" : $"  ·{projName}"));
            var snippet = ExtractSnippet(text, kw);
            if (!string.IsNullOrWhiteSpace(snippet)) sb.AppendLine("   " + snippet);
            sb.AppendLine();
        }
        DashSearchResult.Text = hits == 0 ? $"未找到包含「{kw}」的会议。" : $"命中 {hits} 场会议：\n\n" + sb.ToString();
    }

    private async void BtnDashAsk_OnClick(object sender, RoutedEventArgs e)
    {
        if (_store == null) return;
        var q = DashSearchBox.Text.Trim();
        if (string.IsNullOrWhiteSpace(q)) { DashSearchResult.Text = "请输入要询问的问题。"; return; }
        var cfg = App.Config.Load();
        if (string.IsNullOrWhiteSpace(cfg.ApiKey)) { DashSearchResult.Text = "请先在设置中配置 API 密钥。"; return; }

        List<MeetingRecord> meetings;
        try { meetings = _store.LoadMeetings(); } catch { meetings = new List<MeetingRecord>(); }
        var ctx = new StringBuilder();
        foreach (var m in meetings.OrderByDescending(x => x.StartTime))
        {
            var text = GetMeetingText(m);
            if (string.IsNullOrWhiteSpace(text)) continue;
            var projName = _projects.FirstOrDefault(p => p.Id == m.ProjectId)?.Name ?? "无项目";
            ctx.AppendLine($"=== {m.StartTime:yyyy-MM-dd} {m.Title}（{projName}）===");
            ctx.AppendLine(text.Length > 1500 ? text.Substring(0, 1500) : text);
            ctx.AppendLine();
            if (ctx.Length > 12000) break;
        }
        if (ctx.Length == 0) { DashSearchResult.Text = "会议库为空，无法回答。"; return; }

        BtnDashAsk.IsEnabled = false; BtnDashAsk.Content = "思考中...";
        DashSearchResult.Text = "�� 正在分析会议记录…";
        try
        {
            var client = new OpenAiApiClient(cfg);
            var system = "你是会议知识助手。仅依据用户提供的会议记录回答问题，引用相关会议的日期与标题。若记录中没有答案，请明确说明。";
            var prompt = $"以下是历史会议记录：\n\n{ctx}\n\n请回答：{q}";
            var result = await client.CallAsyncLong(prompt, system);
            DashSearchResult.Text = result.Success ? (result.Result ?? "") : $"查询失败：{result.Error}";
        }
        catch (Exception ex) { DashSearchResult.Text = $"查询失败：{ex.Message}"; }
        finally { BtnDashAsk.IsEnabled = true; BtnDashAsk.Content = "🤖 AI 问答"; }
    }

    // ═══════════════ Phase 6: 会后邮件 / 行动项入待办 / 会前准备 ═══════════════

    private void BtnLibEmail_OnClick(object sender, RoutedEventArgs e)
    {
        var rec = _selectedLibMeeting;
        if (rec == null) { MessageBox.Show("请先在左侧选择一场会议。", "提示", MessageBoxButton.OK, MessageBoxImage.Information); return; }
        var content = GetMeetingText(rec);
        if (string.IsNullOrWhiteSpace(content)) content = rec.SummaryMarkdown;
        if (string.IsNullOrWhiteSpace(content)) { MessageBox.Show("该会议暂无纪要内容可用于撰写邮件。", "提示", MessageBoxButton.OK, MessageBoxImage.Warning); return; }
        var subject = $"会议纪要 - {rec.Title}（{rec.StartTime:yyyy-MM-dd}）";
        var points = "请基于以下会议纪要，撰写一封发送给与会者的会后纪要邮件，包含主要结论与后续行动项：\n\n" + content;
        MeetingEmailHandoff.Request(subject, points);
        (Application.Current.MainWindow as MainWindow)?.ShowAndSwitch(AppPage.Email);
    }

    private async void BtnLibSyncTasks_OnClick(object sender, RoutedEventArgs e)
    {
        var rec = _selectedLibMeeting;
        if (rec == null) { MessageBox.Show("请先在左侧选择一场会议。", "提示", MessageBoxButton.OK, MessageBoxImage.Information); return; }
        var cfg = App.Config.Load();
        var content = GetMeetingText(rec);
        if (string.IsNullOrWhiteSpace(content)) { MessageBox.Show("该会议暂无内容可抽取行动项。", "提示", MessageBoxButton.OK, MessageBoxImage.Warning); return; }

        BtnLibSyncTasks.IsEnabled = false; BtnLibSyncTasks.Content = "抽取中...";
        try
        {
            List<(string Task, string Owner, DateTime? Due)> items;
            if (!string.IsNullOrWhiteSpace(cfg.ApiKey))
                items = await ExtractActionItemsAsync(content, cfg);
            else
                items = ParseActionItemsHeuristic(content);

            if (items.Count == 0) { MessageBox.Show("未识别到行动项。", "提示", MessageBoxButton.OK, MessageBoxImage.Information); return; }

            var preview = string.Join("\n", items.Select(i => $"• {i.Task}" + (string.IsNullOrWhiteSpace(i.Owner) ? "" : $"（{i.Owner}）") + (i.Due.HasValue ? $" ⏰{i.Due:MM-dd}" : "")));
            if (MessageBox.Show($"识别到 {items.Count} 条行动项，写入待办（ZenTask）？\n\n{preview}", "确认", MessageBoxButton.YesNo, MessageBoxImage.Question) != MessageBoxResult.Yes)
                return;

            var store = new ZenTaskStore(cfg.NotesRootPath);
            var projName = _projects.FirstOrDefault(p => p.Id == rec.ProjectId)?.Name;
            foreach (var it in items)
                store.AddTask(new ZenTaskAddRequest
                {
                    Title = it.Task,
                    Project = projName,
                    Source = "Meeting",
                    Notes = $"来自会议：{rec.Title}（{rec.StartTime:yyyy-MM-dd}）" + (string.IsNullOrWhiteSpace(it.Owner) ? "" : $"\n负责人：{it.Owner}"),
                    DueDate = it.Due
                });

            foreach (var it in items)
                rec.ActionItems.Add(new MeetingActionItem { Task = it.Task, Owner = it.Owner ?? "", DueDate = it.Due, SyncedToTodo = true });
            try { _store?.UpsertMeeting(rec); } catch { }

            MessageBox.Show($"已写入 {items.Count} 条行动项到待办（ZenTask）。", "完成", MessageBoxButton.OK, MessageBoxImage.Information);
        }
        catch (Exception ex) { MessageBox.Show($"抽取失败：{ex.Message}", "错误", MessageBoxButton.OK, MessageBoxImage.Error); }
        finally { BtnLibSyncTasks.IsEnabled = true; BtnLibSyncTasks.Content = "✅ 行动项入待办"; }
    }

    private async Task<List<(string Task, string Owner, DateTime? Due)>> ExtractActionItemsAsync(string content, AppConfig cfg)
    {
        var client = new OpenAiApiClient(cfg);
        var system = "你是会议行动项抽取助手。从会议记录中提取所有待办/行动项。";
        var prompt = "请从下面的会议记录中提取行动项，每行一条，严格使用格式：任务描述||负责人||截止日期(YYYY-MM-DD，没有就留空)。只输出行动项，不要其它说明。\n\n" + content;
        var result = await client.CallAsyncLong(prompt, system);
        var list = new List<(string, string, DateTime?)>();
        if (!result.Success || string.IsNullOrWhiteSpace(result.Result)) return list;
        foreach (var rawLine in result.Result.Split('\n'))
        {
            var line = rawLine.Trim().TrimStart('-', '*', '•', ' ');
            if (string.IsNullOrWhiteSpace(line)) continue;
            var parts = line.Split(new[] { "||" }, StringSplitOptions.None);
            var task = parts[0].Trim();
            if (string.IsNullOrWhiteSpace(task)) continue;
            var owner = parts.Length > 1 ? parts[1].Trim() : "";
            DateTime? due = null;
            if (parts.Length > 2 && DateTime.TryParse(parts[2].Trim(), out var d)) due = d;
            list.Add((task, owner, due));
        }
        return list;
    }

    private static List<(string Task, string Owner, DateTime? Due)> ParseActionItemsHeuristic(string content)
    {
        var list = new List<(string, string, DateTime?)>();
        foreach (var rawLine in content.Split('\n'))
        {
            var line = rawLine.Trim();
            if (!line.StartsWith("|") || !line.Contains("|")) continue;
            var cells = line.Trim('|').Split('|').Select(c => c.Trim()).ToArray();
            if (cells.Length < 1) continue;
            var task = cells[0];
            if (string.IsNullOrWhiteSpace(task) || task.Contains("---") || task == "任务" || task == "行动项" || task == "待办") continue;
            var owner = cells.Length > 1 ? cells[1] : "";
            DateTime? due = null;
            if (cells.Length > 2 && DateTime.TryParse(cells[2], out var d)) due = d;
            list.Add((task, owner, due));
        }
        return list;
    }

    private async void BtnPrepPack_OnClick(object sender, RoutedEventArgs e)
    {
        if (_store == null) return;
        var cfg = App.Config.Load();
        if (string.IsNullOrWhiteSpace(cfg.ApiKey)) { MessageBox.Show("请先在设置中配置 API 密钥。", "提示", MessageBoxButton.OK, MessageBoxImage.Warning); return; }
        var projectId = (ProjectCombo.SelectedItem as ComboBoxItem)?.Tag?.ToString() ?? "";

        List<MeetingRecord> meetings;
        try { meetings = _store.LoadMeetings(); } catch { meetings = new List<MeetingRecord>(); }
        var related = (string.IsNullOrEmpty(projectId) ? meetings : meetings.Where(m => m.ProjectId == projectId))
            .Where(m => m.Status != MeetingStatus.Planned)
            .OrderByDescending(m => m.StartTime).Take(3).ToList();

        if (related.Count == 0) { MessageBox.Show("没有可参考的历史会议（请先选择项目并保存过往会议）。", "提示", MessageBoxButton.OK, MessageBoxImage.Information); return; }

        var ctx = new StringBuilder();
        foreach (var m in related)
        {
            ctx.AppendLine($"=== {m.StartTime:yyyy-MM-dd} {m.Title} ===");
            var text = GetMeetingText(m);
            ctx.AppendLine(text.Length > 1800 ? text.Substring(0, 1800) : text);
            var open = m.ActionItems.Where(a => !a.Done).ToList();
            if (open.Count > 0)
                ctx.AppendLine("未完成行动项：" + string.Join("；", open.Select(a => a.Task)));
            ctx.AppendLine();
        }

        BtnPrepPack.IsEnabled = false; BtnPrepPack.Content = "生成中...";
        try
        {
            var client = new OpenAiApiClient(cfg);
            var system = "你是会议筹备助手。根据历史会议记录，为下一次会议生成简洁的议程草稿。";
            var prompt = $"参考以下最近的会议记录，生成下一次会议的议程草稿。要求：聚焦上期未决事项与延续话题，每行一个议程要点，5-8 条，不要编号，不要多余解释。\n\n{ctx}";
            var result = await client.CallAsyncLong(prompt, system);
            if (result.Success && !string.IsNullOrWhiteSpace(result.Result))
            {
                var existing = AgendaBox.Text.Trim();
                AgendaBox.Text = string.IsNullOrWhiteSpace(existing) ? result.Result.Trim() : existing + "\n" + result.Result.Trim();
                HubTabs.SelectedIndex = 0;
            }
            else MessageBox.Show($"生成失败：{result.Error}", "错误", MessageBoxButton.OK, MessageBoxImage.Error);
        }
        catch (Exception ex) { MessageBox.Show($"生成失败：{ex.Message}", "错误", MessageBoxButton.OK, MessageBoxImage.Error); }
        finally { BtnPrepPack.IsEnabled = true; BtnPrepPack.Content = "🧭 AI 会前准备"; }
    }

    // ═══════════════ Markdown rendering helper ═══════════════

    private async Task RenderMdAsync(WebView2 web, string? markdown)
    {
        await web.EnsureCoreWebView2Async(null).ConfigureAwait(true);
        var bodyHtml = string.IsNullOrWhiteSpace(markdown)
            ? "<p style=\"color:#9ca3af;font-size:13px;padding:16px\">(暂无内容)</p>"
            : MarkdownHtml.ToHtmlBody(markdown);
        web.NavigateToString(MarkdownHtml.WrapFullDocument(bodyHtml));
    }
}
