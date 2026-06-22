using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using DesktopAssistant.Models;

namespace DesktopAssistant.Services;

/// <summary>会议中心 Web 内嵌页后端：状态管理与业务操作。</summary>
public sealed class MeetingHubService
{
    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private MeetingStore? _store;
    private List<MeetingTemplate> _templates = new();
    private List<MeetingProject> _projects = new();
    private List<MeetingSeries> _series = new();

    private string _activeNav = "workbench";
    private bool _isBusy;
    private string? _lastToast;
    private string? _lastError;

    private WorkbenchDto _workbench = new();
    private string _libSearch = "";
    private bool _libGrouped;
    private bool _libShowArchived;
    private string? _libSelectedId;
    private bool _libEditMode;
    private string _libEditText = "";

    private string _actFilter = "all";
    private string _actProjectId = "";
    private string? _actSelectedKey;

    private string _decSearch = "";
    private string _decProjectId = "";
    private string? _decSelectedKey;

    private DateTime _calMonth = new(DateTime.Now.Year, DateTime.Now.Month, 1);
    private DateTime? _calSelectedDate = DateTime.Today;

    private string? _editingTemplateId;
    private TemplateFormDto _templateForm = new();

    private string? _editingSeriesId;
    private SeriesFormDto _seriesForm = new();
    private string _seriesPreview = "";

    private string _dashSearchResult = "";

    public void Initialize()
    {
        try
        {
            var cfg = App.Config.Load();
            _store = new MeetingStore(cfg.NotesRootPath);
            _store.MigrateLegacyMarkdown();
            _templates = _store.LoadTemplates();
            _projects = _store.LoadProjects();
            _series = _store.LoadSeries();
        }
        catch (Exception ex)
        {
            _lastError = $"加载会议数据失败：{ex.Message}";
            _templates = new List<MeetingTemplate>();
            _projects = new List<MeetingProject>();
            _series = new List<MeetingSeries>();
        }

        NewWorkbench();
        _lastToast = null;
        _lastError = null;
    }

    public object BuildWebState()
    {
        var meetings = SafeLoadMeetings();
        var wb = _workbench;
        var saved = !string.IsNullOrWhiteSpace(wb.MeetingId)
                    && meetings.Any(m => m.Id == wb.MeetingId);

        return new
        {
            activeNav = _activeNav,
            busy = _isBusy,
            toast = _lastToast,
            error = _lastError,
            version = "v2.6.0",
            templates = _templates.Select(ToWebTemplate),
            projects = _projects.Select(ToWebProject),
            workbench = new
            {
                meetingId = wb.MeetingId,
                title = wb.Title,
                status = wb.Status,
                templateId = wb.TemplateId,
                projectId = wb.ProjectId,
                startTime = wb.StartTime,
                endTime = wb.EndTime,
                tags = wb.Tags,
                agendaItems = wb.AgendaItems,
                quickNotes = wb.QuickNotes,
                attendees = wb.Attendees,
                actionItems = wb.ActionItems,
                decisions = wb.Decisions,
                summaryMarkdown = wb.SummaryMarkdown,
                seriesId = wb.SeriesId,
                hint = saved ? $"编辑中 · {StatusLabel(wb.Status)}" : $"新会议 · {StatusLabel(wb.Status)}",
                saved,
            },
            library = BuildLibraryState(meetings),
            actions = BuildActionsState(meetings),
            decisions = BuildDecisionsState(meetings),
            calendar = BuildCalendarState(meetings),
            routines = BuildRoutinesState(),
            templateForm = _templateForm,
            editingTemplateId = _editingTemplateId,
            stats = BuildStatsState(meetings),
            dashSearchResult = _dashSearchResult,
        };
    }

    public void ClearTransientMessages()
    {
        _lastToast = null;
        _lastError = null;
    }

    public async Task HandleAsync(HubWebMessage msg)
    {
        ClearTransientMessages();
        if (msg.Type == null) return;

        switch (msg.Type)
        {
            case "setTab":
                _activeNav = msg.Nav ?? "workbench";
                break;
            case "setWorkbench":
                if (msg.Workbench != null) _workbench = msg.Workbench;
                break;
            case "newMeeting":
                NewWorkbench();
                _lastToast = "已创建新会议工作台";
                break;
            case "applyTemplate":
                ApplyTemplate(msg.TemplateId);
                break;
            case "saveMeeting":
                SaveMeeting();
                break;
            case "generateSummary":
                await GenerateSummaryAsync();
                break;
            case "aiPrep":
                await AiPrepAsync();
                break;
            case "copyDraft":
                CopyDraft();
                break;
            case "clearWorkbench":
                NewWorkbench();
                _lastToast = "工作台已清空";
                break;
            case "syncZenTaskWorkbench":
                SyncZenTaskWorkbench();
                break;
            case "openMeeting":
                OpenMeeting(msg.MeetingId);
                break;
            case "libSearch":
                _libSearch = msg.Value?.Trim() ?? "";
                break;
            case "libSetGrouped":
                _libGrouped = msg.Enabled;
                break;
            case "libSetShowArchived":
                _libShowArchived = msg.Enabled;
                break;
            case "libSelect":
                _libSelectedId = msg.MeetingId;
                _libEditMode = false;
                break;
            case "libEditStart":
                StartLibEdit();
                break;
            case "libEditCancel":
                _libEditMode = false;
                break;
            case "libEditSave":
                SaveLibEdit(msg.Value);
                break;
            case "libDelete":
                DeleteLibMeeting();
                break;
            case "libArchive":
                ArchiveLibMeeting();
                break;
            case "libEmail":
                LibEmail();
                break;
            case "libSyncTasks":
                await LibSyncTasksAsync();
                break;
            case "actSetFilter":
                _actFilter = msg.Filter ?? "all";
                _actProjectId = msg.ProjectId ?? "";
                break;
            case "actSelect":
                _actSelectedKey = msg.Key;
                break;
            case "actSync":
                ActSyncOne();
                break;
            case "actSyncAll":
                ActSyncAll();
                break;
            case "actMarkDone":
                ActMarkDone();
                break;
            case "actOpenMeeting":
                ActOpenMeeting();
                break;
            case "decSetFilter":
                _decSearch = msg.Value?.Trim() ?? "";
                _decProjectId = msg.ProjectId ?? "";
                break;
            case "decSelect":
                _decSelectedKey = msg.Key;
                break;
            case "decDelete":
                DecDelete();
                break;
            case "decOpenMeeting":
                DecOpenMeeting();
                break;
            case "tplSelect":
                SelectTemplate(msg.TemplateId);
                break;
            case "tplNew":
                ResetTemplateForm();
                break;
            case "tplSave":
                SaveTemplate(msg.Template);
                break;
            case "tplDelete":
                DeleteTemplate();
                break;
            case "seriesSelect":
                SelectSeries(msg.SeriesId);
                break;
            case "seriesNew":
                ResetSeriesForm();
                break;
            case "seriesSave":
                SaveSeries(msg.Series);
                break;
            case "seriesDelete":
                DeleteSeries();
                break;
            case "seriesPreview":
                PreviewSeries(msg.Series);
                break;
            case "seriesStart":
                StartFromSeries();
                break;
            case "calPrev":
                _calMonth = _calMonth.AddMonths(-1);
                break;
            case "calNext":
                _calMonth = _calMonth.AddMonths(1);
                break;
            case "calToday":
                _calMonth = new DateTime(DateTime.Now.Year, DateTime.Now.Month, 1);
                _calSelectedDate = DateTime.Today;
                break;
            case "calSelectDay":
                if (DateTime.TryParse(msg.Value, out var d)) _calSelectedDate = d.Date;
                break;
            case "calSchedule":
                ScheduleMeeting(msg.Title, msg.Value);
                break;
            case "addProject":
                AddProject(msg.Value);
                break;
            case "dashSearch":
                DashSearch(msg.Value);
                break;
            case "dashAsk":
                await DashAskAsync(msg.Value);
                break;
        }
    }

    // ─── Workbench ───

    private void NewWorkbench()
    {
        _workbench = new WorkbenchDto
        {
            Title = "会议记录",
            Status = MeetingStatus.InProgress,
            StartTime = DateTime.Now.ToString("yyyy-MM-dd HH:mm"),
            TemplateId = _templates.FirstOrDefault()?.Id ?? "",
        };
        _lastError = null;
    }

    private void ApplyTemplate(string? templateId)
    {
        var tpl = _templates.FirstOrDefault(t => t.Id == templateId);
        if (tpl == null) return;
        _workbench.TemplateId = tpl.Id;
        if (tpl.AgendaTemplate.Count > 0)
            _workbench.AgendaItems = tpl.AgendaTemplate.ToList();
        if (string.IsNullOrWhiteSpace(_workbench.Title) || _workbench.Title == "会议记录")
            _workbench.Title = $"{tpl.Name} {DateTime.Now:MM-dd}";
        if (string.IsNullOrWhiteSpace(_workbench.Tags) && tpl.DefaultTags.Count > 0)
            _workbench.Tags = string.Join(", ", tpl.DefaultTags);
    }

    private MeetingRecord BuildRecordFromWorkbench()
    {
        var rec = string.IsNullOrWhiteSpace(_workbench.MeetingId)
            ? new MeetingRecord()
            : SafeLoadMeetings().FirstOrDefault(m => m.Id == _workbench.MeetingId) ?? new MeetingRecord { Id = _workbench.MeetingId };

        rec.Title = string.IsNullOrWhiteSpace(_workbench.Title) ? "会议记录" : _workbench.Title.Trim();
        rec.ProjectId = _workbench.ProjectId ?? "";
        rec.TemplateId = _workbench.TemplateId ?? "";
        rec.Status = _workbench.Status ?? MeetingStatus.InProgress;
        rec.StartTime = ParseDateTimeOr(_workbench.StartTime, DateTime.Now);
        rec.EndTime = ParseNullableDateTime(_workbench.EndTime);
        if (rec.EndTime.HasValue)
            rec.DurationSeconds = Math.Max(0, (int)(rec.EndTime.Value - rec.StartTime).TotalSeconds);
        rec.AgendaItems = _workbench.AgendaItems?.Where(s => !string.IsNullOrWhiteSpace(s)).ToList() ?? new();
        rec.QuickNotes = _workbench.QuickNotes?.Trim() ?? "";
        rec.SummaryMarkdown = _workbench.SummaryMarkdown ?? "";
        rec.Attendees = _workbench.Attendees?.Select(a => new MeetingAttendee { Name = a.Name, Role = a.Role }).ToList() ?? new();
        rec.ActionItems = _workbench.ActionItems?.Select(ToMeetingAction).ToList() ?? new();
        rec.DecisionItems = _workbench.Decisions?.Select(ToMeetingDecision).ToList() ?? new();
        rec.SeriesId = _workbench.SeriesId ?? "";
        MeetingStore.NormalizeRecord(rec);
        rec.Tags = SplitTags(_workbench.Tags);
        if (rec.Tags.Count == 0)
        {
            var tpl = _templates.FirstOrDefault(t => t.Id == rec.TemplateId);
            if (tpl?.DefaultTags.Count > 0) rec.Tags = new List<string>(tpl.DefaultTags);
        }
        return rec;
    }

    private void LoadWorkbenchFromRecord(MeetingRecord rec)
    {
        MeetingStore.NormalizeRecord(rec);
        _workbench = new WorkbenchDto
        {
            MeetingId = rec.Id,
            Title = rec.Title,
            Status = rec.Status,
            TemplateId = rec.TemplateId,
            ProjectId = rec.ProjectId,
            StartTime = rec.StartTime.ToString("yyyy-MM-dd HH:mm"),
            EndTime = rec.EndTime?.ToString("yyyy-MM-dd HH:mm") ?? "",
            Tags = string.Join(", ", rec.Tags),
            AgendaItems = rec.AgendaItems.ToList(),
            QuickNotes = rec.QuickNotes,
            Attendees = rec.Attendees.Select(a => new AttendeeDto { Name = a.Name, Role = a.Role }).ToList(),
            ActionItems = rec.ActionItems.Select(CloneAction).ToList(),
            Decisions = rec.DecisionItems.Select(CloneDecision).ToList(),
            SummaryMarkdown = rec.SummaryMarkdown,
            SeriesId = rec.SeriesId,
        };
        _activeNav = "workbench";
    }

    private void SaveMeeting()
    {
        if (_store == null) { _lastError = "存储未初始化"; return; }
        if (!HasWorkbenchContent())
        {
            _lastError = "没有可保存的内容";
            return;
        }
        try
        {
            var rec = BuildRecordFromWorkbench();
            _store.ExportMarkdown(rec, null);
            _store.UpsertMeeting(rec);
            _workbench.MeetingId = rec.Id;
            _lastToast = $"已保存：{rec.Title}";
        }
        catch (Exception ex) { _lastError = $"保存失败：{ex.Message}"; }
    }

    private async Task GenerateSummaryAsync()
    {
        if (_isBusy) return;
        var transcript = BuildTranscript();
        if (string.IsNullOrWhiteSpace(transcript))
        {
            _lastError = "没有可整理的内容（议程或手记）";
            return;
        }
        _isBusy = true;
        try
        {
            var cfg = App.Config.Load();
            var svc = new MeetingSummaryService(cfg);
            var tpl = _templates.FirstOrDefault(t => t.Id == _workbench.TemplateId);
            var promptOverride = string.IsNullOrWhiteSpace(tpl?.SummaryPromptOverride) ? null : tpl!.SummaryPromptOverride;
            var result = await svc.GenerateSummaryAsync(transcript, promptOverride);
            if (result.Success && !string.IsNullOrWhiteSpace(result.Result))
            {
                _workbench.SummaryMarkdown = result.Result;
                ApplyExtractedFromSummary(result.Result);
                _lastToast = "纪要已生成";
            }
            else _lastError = result.Error ?? "摘要生成失败";
        }
        catch (Exception ex) { _lastError = $"摘要生成失败：{ex.Message}"; }
        finally { _isBusy = false; }
    }

    private async Task AiPrepAsync()
    {
        if (_store == null || _isBusy) return;
        var cfg = App.Config.Load();
        if (string.IsNullOrWhiteSpace(cfg.ApiKey))
        {
            var tpl = _templates.FirstOrDefault(t => t.Id == _workbench.TemplateId);
            if (tpl?.AgendaTemplate.Count > 0)
            {
                _workbench.AgendaItems = tpl.AgendaTemplate.Select((a, i) => $"【AI】{i + 1}. {a}").ToList();
                _lastToast = $"已根据模板「{tpl.Name}」生成议程";
            }
            else _lastError = "请先在设置中配置 API 密钥，或选择含议程的模板";
            return;
        }
        _isBusy = true;
        try
        {
            var projectId = _workbench.ProjectId ?? "";
            var meetings = SafeLoadMeetings();
            var related = (string.IsNullOrEmpty(projectId) ? meetings : meetings.Where(m => m.ProjectId == projectId))
                .Where(m => m.Status != MeetingStatus.Planned)
                .OrderByDescending(m => m.StartTime).Take(3).ToList();
            if (related.Count == 0)
            {
                _lastError = "没有可参考的历史会议";
                return;
            }
            var ctx = new StringBuilder();
            foreach (var m in related)
            {
                ctx.AppendLine($"=== {m.StartTime:yyyy-MM-dd} {m.Title} ===");
                var text = GetMeetingText(m);
                ctx.AppendLine(text.Length > 1800 ? text[..1800] : text);
                var open = m.ActionItems.Where(a => !a.Done).ToList();
                if (open.Count > 0) ctx.AppendLine("未完成行动项：" + string.Join("；", open.Select(a => a.Task)));
                ctx.AppendLine();
            }
            var client = new OpenAiApiClient(cfg);
            var prompt = $"参考以下最近的会议记录，生成下一次会议的议程草稿。要求：聚焦上期未决事项与延续话题，每行一个议程要点，5-8 条，带序号。\n\n{ctx}";
            var result = await client.CallAsyncLong(prompt, "你是会议筹备助手。根据历史会议记录，为下一次会议生成简洁的议程草稿。");
            if (result.Success && !string.IsNullOrWhiteSpace(result.Result))
            {
                _workbench.AgendaItems = SplitLines(result.Result);
                _lastToast = "AI 会前准备已完成";
            }
            else _lastError = result.Error ?? "生成失败";
        }
        catch (Exception ex) { _lastError = $"生成失败：{ex.Message}"; }
        finally { _isBusy = false; }
    }

    private void CopyDraft()
    {
        var sb = new StringBuilder();
        if (!string.IsNullOrWhiteSpace(_workbench.SummaryMarkdown))
        {
            sb.AppendLine("## 会议纪要").AppendLine().AppendLine(_workbench.SummaryMarkdown).AppendLine();
        }
        if (_workbench.AgendaItems?.Count > 0)
        {
            sb.AppendLine("## 议程").AppendLine().AppendLine(string.Join("\n", _workbench.AgendaItems)).AppendLine();
        }
        if (!string.IsNullOrWhiteSpace(_workbench.QuickNotes))
        {
            sb.AppendLine("## 会上手记").AppendLine().AppendLine(_workbench.QuickNotes);
        }
        _lastToast = string.IsNullOrWhiteSpace(sb.ToString()) ? "暂无内容可复制" : "内容已复制到剪贴板";
        if (!string.IsNullOrWhiteSpace(sb.ToString()))
        {
            try { System.Windows.Clipboard.SetText(sb.ToString().Trim()); } catch { }
        }
    }

    private void SyncZenTaskWorkbench()
    {
        if (_workbench.ActionItems == null || _workbench.ActionItems.Count == 0)
        {
            _lastError = "当前会议暂无行动项";
            return;
        }
        var rec = BuildRecordFromWorkbench();
        var synced = 0;
        foreach (var item in _workbench.ActionItems.Where(a => !a.Done && !a.SyncedToTodo))
        {
            if (SyncToZenTask(rec, item)) synced++;
        }
        if (_store != null && synced > 0)
        {
            rec.ActionItems = _workbench.ActionItems.Select(ToMeetingAction).ToList();
            _store.UpsertMeeting(rec);
            _workbench.MeetingId = rec.Id;
        }
        _lastToast = synced > 0 ? $"已同步 {synced} 条到 ZenTask" : "没有需要同步的行动项";
    }

    private void OpenMeeting(string? id)
    {
        if (string.IsNullOrWhiteSpace(id)) return;
        var rec = SafeLoadMeetings().FirstOrDefault(m => m.Id == id);
        if (rec != null)
        {
            LoadWorkbenchFromRecord(rec);
            _lastToast = $"已打开：{rec.Title}";
        }
    }

    // ─── Library ───

    private object BuildLibraryState(List<MeetingRecord> meetings)
    {
        var filtered = FilterMeetings(meetings);
        var selected = string.IsNullOrWhiteSpace(_libSelectedId)
            ? null
            : meetings.FirstOrDefault(m => m.Id == _libSelectedId);

        string? detailMarkdown = null;
        if (selected != null)
            detailMarkdown = _libEditMode ? _libEditText : BuildLibDetailMarkdown(selected);

        var groups = _libGrouped
            ? filtered.GroupBy(m => m.ProjectId ?? "")
                .Select(g => new
                {
                    projectId = g.Key,
                    projectName = string.IsNullOrEmpty(g.Key)
                        ? "未分类"
                        : (_projects.FirstOrDefault(p => p.Id == g.Key)?.Name ?? "未分类"),
                    meetings = g.OrderByDescending(x => x.StartTime).Select(ToWebMeetingSummary),
                })
                .OrderBy(g => g.projectName == "未分类" ? "zzz" : g.projectName)
                .ToList()
            : null;

        return new
        {
            search = _libSearch,
            grouped = _libGrouped,
            showArchived = _libShowArchived,
            selectedId = _libSelectedId,
            editMode = _libEditMode,
            editText = _libEditText,
            stats = $"会议 {filtered.Count} 场 · 项目 {_projects.Count} 个",
            meetings = _libGrouped ? null : filtered.Select(ToWebMeetingSummary),
            groups,
            detail = selected == null ? null : new
            {
                id = selected.Id,
                title = selected.Title,
                markdown = detailMarkdown,
            },
        };
    }

    private void StartLibEdit()
    {
        var rec = SafeLoadMeetings().FirstOrDefault(m => m.Id == _libSelectedId);
        if (rec == null) return;
        _libEditMode = true;
        _libEditText = string.IsNullOrWhiteSpace(rec.SummaryMarkdown) ? GetMeetingText(rec) : rec.SummaryMarkdown;
    }

    private void SaveLibEdit(string? text)
    {
        if (_store == null || string.IsNullOrWhiteSpace(_libSelectedId)) return;
        var rec = SafeLoadMeetings().FirstOrDefault(m => m.Id == _libSelectedId);
        if (rec == null) return;
        rec.SummaryMarkdown = text?.Trim() ?? "";
        try
        {
            _store.ExportMarkdown(rec, null);
            _store.UpsertMeeting(rec);
            _libEditMode = false;
            _lastToast = "纪要已保存";
        }
        catch (Exception ex) { _lastError = $"保存失败：{ex.Message}"; }
    }

    private void DeleteLibMeeting()
    {
        if (_store == null || string.IsNullOrWhiteSpace(_libSelectedId)) return;
        try
        {
            if (_workbench.MeetingId == _libSelectedId) NewWorkbench();
            _store.DeleteMeeting(_libSelectedId);
            _libSelectedId = null;
            _lastToast = "会议已删除";
        }
        catch (Exception ex) { _lastError = $"删除失败：{ex.Message}"; }
    }

    private void ArchiveLibMeeting()
    {
        if (_store == null || string.IsNullOrWhiteSpace(_libSelectedId)) return;
        var rec = SafeLoadMeetings().FirstOrDefault(m => m.Id == _libSelectedId);
        if (rec == null) return;
        try
        {
            var archived = _store.ArchiveMeeting(rec);
            if (_workbench.MeetingId == archived.Id)
                _workbench.Status = MeetingStatus.Archived;
            if (!_libShowArchived) _libSelectedId = null;
            _lastToast = "会议已归档";
        }
        catch (Exception ex) { _lastError = $"归档失败：{ex.Message}"; }
    }

    private void LibEmail()
    {
        var rec = SafeLoadMeetings().FirstOrDefault(m => m.Id == _libSelectedId);
        if (rec == null) { _lastError = "请先选择会议"; return; }
        var content = GetMeetingText(rec);
        if (string.IsNullOrWhiteSpace(content)) content = rec.SummaryMarkdown;
        if (string.IsNullOrWhiteSpace(content)) { _lastError = "该会议暂无纪要内容"; return; }
        var subject = $"会议纪要 - {rec.Title}（{rec.StartTime:yyyy-MM-dd}）";
        var points = "请基于以下会议纪要，撰写一封发送给与会者的会后纪要邮件，包含主要结论与后续行动项：\n\n" + content;
        MeetingEmailHandoff.Request(subject, points);
        _lastToast = "已转至邮件助手";
    }

    private async Task LibSyncTasksAsync()
    {
        if (_store == null) return;
        var rec = SafeLoadMeetings().FirstOrDefault(m => m.Id == _libSelectedId);
        if (rec == null) { _lastError = "请先选择会议"; return; }
        var content = GetMeetingText(rec);
        if (string.IsNullOrWhiteSpace(content)) { _lastError = "该会议暂无内容可抽取"; return; }
        _isBusy = true;
        try
        {
            var cfg = App.Config.Load();
            var items = !string.IsNullOrWhiteSpace(cfg.ApiKey)
                ? await ExtractActionItemsAsync(content, cfg)
                : ParseActionItemsHeuristic(content);
            if (items.Count == 0) { _lastError = "未识别到行动项"; return; }
            var synced = 0;
            foreach (var it in items)
            {
                var existing = rec.ActionItems.FirstOrDefault(a => string.Equals(a.Task, it.Task, StringComparison.OrdinalIgnoreCase));
                if (existing != null)
                {
                    if (!existing.SyncedToTodo && SyncToZenTask(rec, existing)) synced++;
                    continue;
                }
                var action = new MeetingActionItem { Task = it.Task, Owner = it.Owner ?? "", DueDate = it.Due };
                if (SyncToZenTask(rec, action)) synced++;
                rec.ActionItems.Add(action);
            }
            foreach (var d in ParseDecisionsHeuristic(content))
            {
                if (!rec.DecisionItems.Any(x => string.Equals(x.Content, d, StringComparison.OrdinalIgnoreCase)))
                    rec.DecisionItems.Add(new MeetingDecision { Content = d });
            }
            MeetingStore.NormalizeRecord(rec);
            if (_workbench.MeetingId == rec.Id)
            {
                _workbench.ActionItems = rec.ActionItems.Select(CloneAction).ToList();
                _workbench.Decisions = rec.DecisionItems.Select(CloneDecision).ToList();
            }
            _store.ExportMarkdown(rec, null);
            _store.UpsertMeeting(rec);
            _lastToast = $"已处理 {items.Count} 条行动项，同步 ZenTask {synced} 条";
        }
        catch (Exception ex) { _lastError = $"抽取失败：{ex.Message}"; }
        finally { _isBusy = false; }
    }

    // ─── Actions / Decisions tabs ───

    private object BuildActionsState(List<MeetingRecord> meetings)
    {
        var rows = new List<object>();
        foreach (var m in meetings.OrderByDescending(x => x.StartTime))
        {
            if (m.Status == MeetingStatus.Archived) continue;
            MeetingStore.NormalizeRecord(m);
            if (!string.IsNullOrEmpty(_actProjectId) && m.ProjectId != _actProjectId) continue;
            foreach (var item in m.ActionItems)
            {
                if (_actFilter == "open" && item.Done) continue;
                if (_actFilter == "done" && !item.Done) continue;
                if (_actFilter == "unsynced" && item.SyncedToTodo) continue;
                var key = $"{m.Id}:{item.Id}";
                rows.Add(new
                {
                    key,
                    meetingId = m.Id,
                    meetingLabel = $"{m.StartTime:MM-dd} {m.Title}",
                    task = item.Task,
                    owner = string.IsNullOrWhiteSpace(item.Owner) ? "—" : item.Owner,
                    due = item.DueDate?.ToString("yyyy-MM-dd") ?? "—",
                    done = item.Done,
                    synced = item.SyncedToTodo,
                });
            }
        }
        var unsynced = CountUnsyncedActions(meetings);
        return new
        {
            filter = _actFilter,
            projectId = _actProjectId,
            selectedKey = _actSelectedKey,
            stats = $"共 {rows.Count} 条 · 未同步 {unsynced} 条",
            rows,
        };
    }

    private object BuildDecisionsState(List<MeetingRecord> meetings)
    {
        var rows = new List<object>();
        foreach (var m in meetings.OrderByDescending(x => x.StartTime))
        {
            if (m.Status == MeetingStatus.Archived) continue;
            MeetingStore.NormalizeRecord(m);
            if (!string.IsNullOrEmpty(_decProjectId) && m.ProjectId != _decProjectId) continue;
            var projName = _projects.FirstOrDefault(p => p.Id == m.ProjectId)?.Name ?? "未分类";
            foreach (var item in m.DecisionItems)
            {
                if (!string.IsNullOrWhiteSpace(_decSearch)
                    && !item.Content.Contains(_decSearch, StringComparison.OrdinalIgnoreCase)
                    && !m.Title.Contains(_decSearch, StringComparison.OrdinalIgnoreCase))
                    continue;
                rows.Add(new
                {
                    key = $"{m.Id}:{item.Id}",
                    meetingId = m.Id,
                    dateLabel = m.StartTime.ToString("yyyy-MM-dd"),
                    meetingTitle = m.Title,
                    projectName = projName,
                    content = item.Content,
                    owner = string.IsNullOrWhiteSpace(item.Owner) ? "—" : item.Owner,
                });
            }
        }
        return new
        {
            search = _decSearch,
            projectId = _decProjectId,
            selectedKey = _decSelectedKey,
            stats = $"共 {rows.Count} 条决策",
            rows,
        };
    }

    private void ActSyncOne()
    {
        var row = FindActionRow(_actSelectedKey);
        if (row == null) { _lastError = "请先选择行动项"; return; }
        var meeting = row.Value.Meeting;
        var item = row.Value.Item;
        if (item.SyncedToTodo) { _lastToast = "该行动项已同步"; return; }
        if (SyncToZenTask(meeting, item))
        {
            PersistMeeting(meeting);
            _lastToast = "已同步到 ZenTask";
        }
    }

    private void ActSyncAll()
    {
        if (_store == null) return;
        var synced = 0;
        foreach (var m in SafeLoadMeetings())
        {
            MeetingStore.NormalizeRecord(m);
            var changed = false;
            foreach (var item in m.ActionItems.Where(a => !a.SyncedToTodo && !a.Done))
            {
                if (SyncToZenTask(m, item)) { synced++; changed = true; }
            }
            if (changed) PersistMeeting(m);
        }
        _lastToast = synced > 0 ? $"已批量同步 {synced} 条" : "没有未同步的行动项";
    }

    private void ActMarkDone()
    {
        var row = FindActionRow(_actSelectedKey);
        if (row == null) { _lastError = "请先选择行动项"; return; }
        row.Value.Item.Done = true;
        PersistMeeting(row.Value.Meeting);
        _lastToast = "已标记完成";
    }

    private void ActOpenMeeting()
    {
        var row = FindActionRow(_actSelectedKey);
        if (row == null) { _lastError = "请先选择行动项"; return; }
        LoadWorkbenchFromRecord(row.Value.Meeting);
    }

    private void DecDelete()
    {
        var row = FindDecisionRow(_decSelectedKey);
        if (row == null) { _lastError = "请先选择决策"; return; }
        row.Value.Meeting.DecisionItems.RemoveAll(d => d.Id == row.Value.Item.Id);
        PersistMeeting(row.Value.Meeting);
        _lastToast = "决策已删除";
    }

    private void DecOpenMeeting()
    {
        var row = FindDecisionRow(_decSelectedKey);
        if (row == null) { _lastError = "请先选择决策"; return; }
        LoadWorkbenchFromRecord(row.Value.Meeting);
    }

    // ─── Calendar ───

    private object BuildCalendarState(List<MeetingRecord> meetings)
    {
        var byDay = meetings.GroupBy(m => m.StartTime.Date)
            .ToDictionary(g => g.Key, g => g.OrderBy(m => m.StartTime).ToList());
        var cells = new List<object>();
        var offset = ((int)_calMonth.DayOfWeek + 6) % 7;
        var gridStart = _calMonth.AddDays(-offset);
        for (var i = 0; i < 42; i++)
        {
            var date = gridStart.AddDays(i);
            byDay.TryGetValue(date.Date, out var dayMeetings);
            cells.Add(new
            {
                date = date.ToString("yyyy-MM-dd"),
                day = date.Day,
                inMonth = date.Month == _calMonth.Month && date.Year == _calMonth.Year,
                isToday = date.Date == DateTime.Today,
                isSelected = _calSelectedDate.HasValue && date.Date == _calSelectedDate.Value.Date,
                count = dayMeetings?.Count ?? 0,
                titles = dayMeetings?.Take(3).Select(m => m.Title).ToList() ?? new List<string>(),
            });
        }
        var sel = _calSelectedDate ?? DateTime.Today;
        var dayList = meetings.Where(m => m.StartTime.Date == sel.Date)
            .OrderBy(m => m.StartTime)
            .Select(ToWebMeetingSummary)
            .ToList();
        return new
        {
            monthLabel = $"{_calMonth.Year} 年 {_calMonth.Month} 月",
            monthCount = meetings.Count(m => m.StartTime.Year == _calMonth.Year && m.StartTime.Month == _calMonth.Month),
            selectedDate = sel.ToString("yyyy-MM-dd"),
            dayTitle = $"{sel:M月d日} · {dayList.Count} 场",
            cells,
            dayMeetings = dayList,
        };
    }

    private void ScheduleMeeting(string? title, string? dateStr)
    {
        if (_store == null) return;
        var date = DateTime.TryParse(dateStr, out var d) ? d.Date : DateTime.Today;
        var t = string.IsNullOrWhiteSpace(title) ? $"会议 {date:MM-dd}" : title.Trim();
        var rec = new MeetingRecord
        {
            Title = t,
            StartTime = date.AddHours(9),
            Status = MeetingStatus.Planned,
        };
        _store.UpsertMeeting(rec);
        _calSelectedDate = date;
        _lastToast = $"已排会：{t}";
    }

    // ─── Routines / Templates ───

    private object BuildRoutinesState()
    {
        return new
        {
            list = _series.OrderBy(s => s.Name).Select(s => new
            {
                id = s.Id,
                name = s.Name,
                active = s.Active,
                recurrence = RecurrenceLabel(s.Recurrence),
            }),
            form = _seriesForm,
            editingId = _editingSeriesId,
            preview = _seriesPreview,
        };
    }

    private void SelectTemplate(string? id)
    {
        var tpl = _templates.FirstOrDefault(t => t.Id == id);
        if (tpl == null) return;
        _editingTemplateId = tpl.Id;
        _templateForm = new TemplateFormDto
        {
            Name = tpl.Name,
            Category = tpl.Category,
            AgendaText = string.Join("\n", tpl.AgendaTemplate),
            Prompt = tpl.SummaryPromptOverride,
            BuiltIn = tpl.BuiltIn,
            Meta = $"默认时长 {tpl.DefaultDurationMinutes} 分钟" + (tpl.BuiltIn ? " · 内置" : " · 自定义"),
        };
    }

    private void ResetTemplateForm()
    {
        _editingTemplateId = null;
        _templateForm = new TemplateFormDto { Meta = "自定义模板可编辑、删除" };
    }

    private void SaveTemplate(TemplateFormDto? form)
    {
        if (_store == null || form == null) return;
        if (string.IsNullOrWhiteSpace(form.Name)) { _lastError = "请输入模板名称"; return; }
        MeetingTemplate target;
        if (!string.IsNullOrWhiteSpace(_editingTemplateId))
            target = _templates.FirstOrDefault(t => t.Id == _editingTemplateId) ?? new MeetingTemplate { Id = _editingTemplateId };
        else
        {
            target = new MeetingTemplate { BuiltIn = false };
            _templates.Add(target);
            _editingTemplateId = target.Id;
        }
        target.Name = form.Name.Trim();
        target.Category = form.Category?.Trim() ?? "";
        target.AgendaTemplate = SplitLines(form.AgendaText);
        target.SummaryPromptOverride = form.Prompt?.Trim() ?? "";
        _store.SaveTemplates(_templates);
        _templates = _store.LoadTemplates();
        SelectTemplate(_editingTemplateId);
        _lastToast = "模板已保存";
    }

    private void DeleteTemplate()
    {
        if (_store == null || string.IsNullOrWhiteSpace(_editingTemplateId)) return;
        var tpl = _templates.FirstOrDefault(t => t.Id == _editingTemplateId);
        if (tpl == null) return;
        if (tpl.BuiltIn) { _lastError = "内置模板不可删除"; return; }
        _store.DeleteTemplate(tpl.Id);
        _templates = _store.LoadTemplates();
        ResetTemplateForm();
        _lastToast = "模板已删除";
    }

    private void SelectSeries(string? id)
    {
        var s = _series.FirstOrDefault(x => x.Id == id);
        if (s == null) return;
        _editingSeriesId = s.Id;
        _seriesForm = SeriesFormDto.FromSeries(s);
        PreviewSeries(_seriesForm);
    }

    private void ResetSeriesForm()
    {
        _editingSeriesId = null;
        _seriesForm = new SeriesFormDto();
        _seriesPreview = "下次发生：保存或预览后显示";
    }

    private void SaveSeries(SeriesFormDto? form)
    {
        if (_store == null || form == null) return;
        if (string.IsNullOrWhiteSpace(form.Name)) { _lastError = "请输入例会名称"; return; }
        var s = string.IsNullOrWhiteSpace(_editingSeriesId)
            ? new MeetingSeries()
            : _series.FirstOrDefault(x => x.Id == _editingSeriesId) ?? new MeetingSeries { Id = _editingSeriesId };
        form.ApplyTo(s);
        if (_series.All(x => x.Id != s.Id)) _series.Add(s);
        _store.SaveSeries(_series);
        _editingSeriesId = s.Id;
        PreviewSeries(_seriesForm);
        _lastToast = "例会已保存";
    }

    private void DeleteSeries()
    {
        if (_store == null || string.IsNullOrWhiteSpace(_editingSeriesId)) return;
        _series.RemoveAll(x => x.Id == _editingSeriesId);
        _store.SaveSeries(_series);
        ResetSeriesForm();
        _lastToast = "例会已删除";
    }

    private void PreviewSeries(SeriesFormDto? form)
    {
        if (form == null) return;
        var s = new MeetingSeries();
        form.ApplyTo(s);
        try
        {
            var occ = MeetingStore.NextOccurrences(s, DateTime.Now, 3);
            _seriesPreview = occ.Count == 0
                ? "下次发生：（无匹配）"
                : "下次发生：\n" + string.Join("\n", occ.Select(o => $"· {o:yyyy-MM-dd ddd HH:mm}"));
        }
        catch (Exception ex) { _seriesPreview = $"预览失败：{ex.Message}"; }
    }

    private void StartFromSeries()
    {
        var s = string.IsNullOrWhiteSpace(_editingSeriesId)
            ? null
            : _series.FirstOrDefault(x => x.Id == _editingSeriesId);
        if (s == null) return;
        NewWorkbench();
        _workbench.TemplateId = s.TemplateId;
        _workbench.ProjectId = s.ProjectId;
        _workbench.Title = $"{s.Name} {DateTime.Now:MM-dd}";
        _workbench.SeriesId = s.Id;
        if (s.DefaultAgenda.Count > 0) _workbench.AgendaItems = s.DefaultAgenda.ToList();
        if (s.DefaultAttendees.Count > 0)
            _workbench.Attendees = s.DefaultAttendees.Select(a => new AttendeeDto { Name = a.Name, Role = a.Role }).ToList();
        _activeNav = "workbench";
        _lastToast = $"已从例会「{s.Name}」启动";
    }

    // ─── Stats ───

    private object BuildStatsState(List<MeetingRecord> meetings)
    {
        var now = DateTime.Now;
        var diff = (7 + (int)now.DayOfWeek - (int)DayOfWeek.Monday) % 7;
        var weekStart = now.Date.AddDays(-diff);
        var allItems = meetings.SelectMany(m => m.ActionItems).ToList();
        var doneItems = allItems.Count(a => a.Done);
        var rate = allItems.Count == 0 ? "—" : $"{doneItems * 100 / allItems.Count}%";
        var totalMin = meetings.Sum(m => m.DurationSeconds) / 60;

        var groups = meetings.GroupBy(m => m.ProjectId ?? "")
            .Select(g => new
            {
                name = string.IsNullOrEmpty(g.Key) ? "未分类" : (_projects.FirstOrDefault(p => p.Id == g.Key)?.Name ?? "未分类"),
                color = _projects.FirstOrDefault(p => p.Id == g.Key)?.Color ?? "#4F6EF7",
                count = g.Count(),
                minutes = g.Sum(x => x.DurationSeconds) / 60,
            })
            .OrderByDescending(x => x.minutes).Take(8).ToList();

        return new
        {
            cards = new[]
            {
                new { icon = "📋", value = meetings.Count.ToString(), label = "总会议数" },
                new { icon = "🗓", value = meetings.Count(m => m.StartTime.Date >= weekStart).ToString(), label = "本周会议" },
                new { icon = "⏱", value = totalMin >= 60 ? $"{totalMin / 60.0:0.#}h" : $"{totalMin}m", label = "累计时长" },
                new { icon = "📁", value = _projects.Count.ToString(), label = "项目数" },
                new { icon = "📅", value = meetings.Count(m => m.Status == MeetingStatus.Planned).ToString(), label = "计划中" },
                new { icon = "✅", value = rate, label = "行动项完成率" },
            },
            projects = groups,
        };
    }

    private void DashSearch(string? kw)
    {
        if (string.IsNullOrWhiteSpace(kw)) { _dashSearchResult = "请输入检索关键词"; return; }
        var meetings = SafeLoadMeetings();
        var sb = new StringBuilder();
        var hits = 0;
        foreach (var m in meetings.OrderByDescending(x => x.StartTime))
        {
            var text = GetMeetingText(m);
            if (text.IndexOf(kw, StringComparison.OrdinalIgnoreCase) < 0) continue;
            hits++;
            var projName = _projects.FirstOrDefault(p => p.Id == m.ProjectId)?.Name;
            sb.AppendLine($"● {m.StartTime:yyyy-MM-dd} {m.Title}" + (string.IsNullOrWhiteSpace(projName) ? "" : $"  ·{projName}"));
            sb.AppendLine();
        }
        _dashSearchResult = hits == 0 ? $"未找到包含「{kw}」的会议" : $"命中 {hits} 场会议：\n\n{sb}";
    }

    private async Task DashAskAsync(string? q)
    {
        if (string.IsNullOrWhiteSpace(q)) { _dashSearchResult = "请输入问题"; return; }
        var cfg = App.Config.Load();
        if (string.IsNullOrWhiteSpace(cfg.ApiKey)) { _dashSearchResult = "请先在设置中配置 API 密钥"; return; }
        _isBusy = true;
        _dashSearchResult = "正在分析会议记录…";
        try
        {
            var meetings = SafeLoadMeetings();
            var ctx = new StringBuilder();
            foreach (var m in meetings.OrderByDescending(x => x.StartTime))
            {
                var text = GetMeetingText(m);
                if (string.IsNullOrWhiteSpace(text)) continue;
                var projName = _projects.FirstOrDefault(p => p.Id == m.ProjectId)?.Name ?? "无项目";
                ctx.AppendLine($"=== {m.StartTime:yyyy-MM-dd} {m.Title}（{projName}）===");
                ctx.AppendLine(text.Length > 1500 ? text[..1500] : text);
                ctx.AppendLine();
                if (ctx.Length > 12000) break;
            }
            if (ctx.Length == 0) { _dashSearchResult = "会议库为空"; return; }
            var client = new OpenAiApiClient(cfg);
            var result = await client.CallAsyncLong(
                $"以下是历史会议记录：\n\n{ctx}\n\n请回答：{q}",
                "你是会议知识助手。仅依据用户提供的会议记录回答问题。");
            _dashSearchResult = result.Success ? (result.Result ?? "") : $"查询失败：{result.Error}";
        }
        catch (Exception ex) { _dashSearchResult = $"查询失败：{ex.Message}"; }
        finally { _isBusy = false; }
    }

    private void AddProject(string? name)
    {
        if (_store == null) return;
        var n = name?.Trim() ?? "";
        if (string.IsNullOrWhiteSpace(n)) { _lastError = "请输入项目名称"; return; }
        _store.UpsertProject(new MeetingProject { Name = n });
        _projects = _store.LoadProjects();
        _lastToast = $"已添加项目：{n}";
    }

    // ─── Helpers ───

    private List<MeetingRecord> SafeLoadMeetings()
    {
        try { return _store?.LoadMeetings() ?? new List<MeetingRecord>(); }
        catch { return new List<MeetingRecord>(); }
    }

    private List<MeetingRecord> FilterMeetings(List<MeetingRecord> meetings)
    {
        var filtered = meetings.AsEnumerable();
        if (!_libShowArchived) filtered = filtered.Where(m => m.Status != MeetingStatus.Archived);
        if (!string.IsNullOrWhiteSpace(_libSearch))
        {
            var kw = _libSearch;
            filtered = filtered.Where(m => MeetingMatchesSearch(m, kw));
        }
        return filtered.OrderByDescending(m => m.StartTime).ToList();
    }

    private bool MeetingMatchesSearch(MeetingRecord m, string kw) =>
        m.Title.Contains(kw, StringComparison.OrdinalIgnoreCase)
        || m.Tags.Any(t => t.Contains(kw, StringComparison.OrdinalIgnoreCase))
        || m.Attendees.Any(a => a.Name.Contains(kw, StringComparison.OrdinalIgnoreCase))
        || m.AgendaItems.Any(a => a.Contains(kw, StringComparison.OrdinalIgnoreCase))
        || m.QuickNotes.Contains(kw, StringComparison.OrdinalIgnoreCase)
        || GetMeetingText(m).Contains(kw, StringComparison.OrdinalIgnoreCase);

    private string BuildLibDetailMarkdown(MeetingRecord rec)
    {
        var sb = new StringBuilder();
        var projName = _projects.FirstOrDefault(p => p.Id == rec.ProjectId)?.Name;
        sb.AppendLine($"时间：{rec.StartTime:yyyy-MM-dd HH:mm}");
        if (rec.EndTime.HasValue) sb.AppendLine($"结束：{rec.EndTime:yyyy-MM-dd HH:mm}");
        sb.AppendLine($"状态：{StatusLabel(rec.Status)}");
        if (!string.IsNullOrWhiteSpace(projName)) sb.AppendLine($"项目：{projName}");
        if (rec.Tags.Count > 0) sb.AppendLine($"标签：{string.Join("、", rec.Tags)}");
        sb.AppendLine();
        if (!string.IsNullOrWhiteSpace(rec.MarkdownPath) && File.Exists(rec.MarkdownPath))
        {
            try { return File.ReadAllText(rec.MarkdownPath, Encoding.UTF8); }
            catch { /* fall through */ }
        }
        if (!string.IsNullOrWhiteSpace(rec.SummaryMarkdown))
        {
            sb.AppendLine("## 会议纪要").AppendLine().AppendLine(rec.SummaryMarkdown);
        }
        if (!string.IsNullOrWhiteSpace(rec.QuickNotes))
        {
            sb.AppendLine().AppendLine("## 会上手记").AppendLine().AppendLine(rec.QuickNotes);
        }
        return sb.ToString();
    }

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

    private bool HasWorkbenchContent() =>
        !string.IsNullOrWhiteSpace(_workbench.QuickNotes)
        || _workbench.AgendaItems?.Count > 0
        || !string.IsNullOrWhiteSpace(_workbench.SummaryMarkdown);

    private string BuildTranscript()
    {
        var sb = new StringBuilder();
        if (_workbench.AgendaItems?.Count > 0)
        {
            sb.AppendLine("【会议议程】");
            sb.AppendLine(string.Join("\n", _workbench.AgendaItems));
            sb.AppendLine();
        }
        if (!string.IsNullOrWhiteSpace(_workbench.QuickNotes))
        {
            sb.AppendLine("【会上手记】");
            sb.AppendLine(_workbench.QuickNotes);
        }
        return sb.ToString().Trim();
    }

    private void ApplyExtractedFromSummary(string summary)
    {
        foreach (var (task, owner, due) in ParseActionItemsHeuristic(summary))
        {
            if (_workbench.ActionItems!.Any(a => string.Equals(a.Task, task, StringComparison.OrdinalIgnoreCase))) continue;
            _workbench.ActionItems.Add(new ActionItemDto
            {
                Task = task,
                Owner = owner,
                DueDate = due?.ToString("yyyy-MM-dd"),
            });
        }
        foreach (var decision in ParseDecisionsHeuristic(summary))
        {
            if (_workbench.Decisions!.Any(d => string.Equals(d.Content, decision, StringComparison.OrdinalIgnoreCase))) continue;
            _workbench.Decisions.Add(new DecisionDto { Content = decision });
        }
    }

    private bool SyncToZenTask(MeetingRecord meeting, ActionItemDto item)
    {
        if (item.SyncedToTodo && !string.IsNullOrWhiteSpace(item.ZenTaskId)) return false;
        if (string.IsNullOrWhiteSpace(item.Task)) return false;
        var zenId = CreateZenTask(meeting, item.Task, item.Owner, item.DueDate);
        if (zenId == null) return false;
        item.ZenTaskId = zenId;
        item.SyncedToTodo = true;
        return true;
    }

    private bool SyncToZenTask(MeetingRecord meeting, MeetingActionItem item)
    {
        if (item.SyncedToTodo && !string.IsNullOrWhiteSpace(item.ZenTaskId)) return false;
        if (string.IsNullOrWhiteSpace(item.Task)) return false;
        var zenId = CreateZenTask(meeting, item.Task, item.Owner, item.DueDate?.ToString("yyyy-MM-dd"));
        if (zenId == null) return false;
        item.ZenTaskId = zenId;
        item.SyncedToTodo = true;
        return true;
    }

    private string? CreateZenTask(MeetingRecord meeting, string task, string owner, string? dueStr)
    {
        var cfg = App.Config.Load();
        var store = new ZenTaskStore(cfg.NotesRootPath);
        var projName = _projects.FirstOrDefault(p => p.Id == meeting.ProjectId)?.Name;
        var zen = store.AddTask(new ZenTaskAddRequest
        {
            Title = task,
            Project = projName,
            Source = "Meeting",
            Notes = $"来自会议：{meeting.Title}（{meeting.StartTime:yyyy-MM-dd}）"
                    + (string.IsNullOrWhiteSpace(owner) ? "" : $"\n负责人：{owner}"),
            DueDate = ParseNullableDateTime(dueStr),
        });
        return zen.Id;
    }

    private void PersistMeeting(MeetingRecord rec)
    {
        if (_store == null) return;
        MeetingStore.NormalizeRecord(rec);
        _store.ExportMarkdown(rec, null);
        _store.UpsertMeeting(rec);
    }

    private int CountUnsyncedActions(List<MeetingRecord> meetings)
    {
        var n = 0;
        foreach (var m in meetings)
        {
            if (m.Status == MeetingStatus.Archived) continue;
            if (!string.IsNullOrEmpty(_actProjectId) && m.ProjectId != _actProjectId) continue;
            MeetingStore.NormalizeRecord(m);
            foreach (var item in m.ActionItems)
            {
                if (_actFilter == "open" && item.Done) continue;
                if (_actFilter == "done" && !item.Done) continue;
                if (_actFilter == "unsynced" && item.SyncedToTodo) continue;
                if (!item.SyncedToTodo && !item.Done) n++;
            }
        }
        return n;
    }

    private (MeetingRecord Meeting, MeetingActionItem Item)? FindActionRow(string? key)
    {
        if (string.IsNullOrWhiteSpace(key)) return null;
        var parts = key.Split(':', 2);
        if (parts.Length != 2) return null;
        var m = SafeLoadMeetings().FirstOrDefault(x => x.Id == parts[0]);
        if (m == null) return null;
        MeetingStore.NormalizeRecord(m);
        var item = m.ActionItems.FirstOrDefault(a => a.Id == parts[1]);
        return item == null ? null : (m, item);
    }

    private (MeetingRecord Meeting, MeetingDecision Item)? FindDecisionRow(string? key)
    {
        if (string.IsNullOrWhiteSpace(key)) return null;
        var parts = key.Split(':', 2);
        if (parts.Length != 2) return null;
        var m = SafeLoadMeetings().FirstOrDefault(x => x.Id == parts[0]);
        if (m == null) return null;
        var item = m.DecisionItems.FirstOrDefault(d => d.Id == parts[1]);
        return item == null ? null : (m, item);
    }

    private static object ToWebTemplate(MeetingTemplate t) => new
    {
        id = t.Id,
        name = t.Name,
        icon = t.Icon,
        category = t.Category,
        builtIn = t.BuiltIn,
        agendaTemplate = t.AgendaTemplate,
        defaultTags = t.DefaultTags,
    };

    private static object ToWebProject(MeetingProject p) => new { id = p.Id, name = p.Name, color = p.Color };

    private object ToWebMeetingSummary(MeetingRecord m)
    {
        var projName = _projects.FirstOrDefault(p => p.Id == m.ProjectId)?.Name;
        return new
        {
            id = m.Id,
            title = m.Title,
            startTime = m.StartTime.ToString("yyyy-MM-dd HH:mm"),
            status = m.Status,
            statusLabel = StatusLabel(m.Status),
            projectName = projName,
            tags = m.Tags,
        };
    }

    private static string StatusLabel(string status) => status switch
    {
        MeetingStatus.Planned => "计划中",
        MeetingStatus.InProgress => "进行中",
        MeetingStatus.Cancelled => "已取消",
        MeetingStatus.Archived => "已归档",
        _ => "已完成",
    };

    private static string RecurrenceLabel(MeetingRecurrence r)
    {
        var time = $"{r.Hour:D2}:{r.Minute:D2}";
        var wk = new[] { "日", "一", "二", "三", "四", "五", "六" };
        return r.Type switch
        {
            RecurrenceType.Daily => $"每天 {time}",
            RecurrenceType.Weekday => $"工作日 {time}",
            RecurrenceType.Monthly => $"每月{r.DayOfMonth}号 {time}",
            RecurrenceType.Weekly or RecurrenceType.BiWeekly => $"{(r.Type == RecurrenceType.BiWeekly ? "每两周" : "每周")} {time}",
            _ => time,
        };
    }

    private static MeetingActionItem ToMeetingAction(ActionItemDto a) => new()
    {
        Id = a.Id,
        Task = a.Task,
        Owner = a.Owner,
        DueDate = ParseNullableDateTimeStatic(a.DueDate),
        Done = a.Done,
        SyncedToTodo = a.SyncedToTodo,
        ZenTaskId = a.ZenTaskId,
    };

    private static MeetingDecision ToMeetingDecision(DecisionDto d) => new()
    {
        Id = d.Id,
        Content = d.Content,
        Owner = d.Owner,
    };

    private static DateTime? ParseNullableDateTimeStatic(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        if (DateTime.TryParse(text.Trim(), CultureInfo.CurrentCulture, DateTimeStyles.None, out var d)) return d;
        if (DateTime.TryParse(text.Trim(), CultureInfo.InvariantCulture, DateTimeStyles.None, out d)) return d;
        return null;
    }

    private static ActionItemDto CloneAction(MeetingActionItem a) => new()
    {
        Id = a.Id,
        Task = a.Task,
        Owner = a.Owner,
        DueDate = a.DueDate?.ToString("yyyy-MM-dd"),
        Done = a.Done,
        SyncedToTodo = a.SyncedToTodo,
        ZenTaskId = a.ZenTaskId,
    };

    private static DecisionDto CloneDecision(MeetingDecision d) => new()
    {
        Id = d.Id,
        Content = d.Content,
        Owner = d.Owner,
    };

    private static List<string> SplitLines(string? text) =>
        string.IsNullOrWhiteSpace(text) ? new() : text.Replace("\r\n", "\n").Split('\n').Select(l => l.Trim()).Where(l => l.Length > 0).ToList();

    private static List<string> SplitTags(string? text) =>
        string.IsNullOrWhiteSpace(text) ? new() : text.Split(new[] { ',', '，', ';', '；' }, StringSplitOptions.RemoveEmptyEntries).Select(t => t.Trim()).Where(t => t.Length > 0).Distinct().ToList();

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

    private static List<string> ParseDecisionsHeuristic(string content)
    {
        var list = new List<string>();
        var inSection = false;
        foreach (var raw in content.Replace("\r\n", "\n").Split('\n'))
        {
            var line = raw.Trim();
            if (line.StartsWith("## "))
            {
                inSection = line.Contains("决策", StringComparison.OrdinalIgnoreCase);
                continue;
            }
            if (!inSection || line.Length == 0) continue;
            if (line.StartsWith("|") || line.StartsWith("---")) continue;
            var item = line.TrimStart('-', '*', '•', ' ').Trim();
            if (item.Length > 0 && !item.Contains("无明确决策")) list.Add(item);
        }
        return list;
    }

    private static List<(string Task, string Owner, DateTime? Due)> ParseActionItemsHeuristic(string content)
    {
        var list = new List<(string, string, DateTime?)>();
        foreach (var rawLine in content.Split('\n'))
        {
            var line = rawLine.Trim();
            if (!line.StartsWith("|") || !line.Contains('|')) continue;
            var cells = line.Trim('|').Split('|').Select(c => c.Trim()).ToArray();
            if (cells.Length < 1) continue;
            var task = cells[0];
            if (string.IsNullOrWhiteSpace(task) || task.Contains("---") || task is "任务" or "行动项" or "待办") continue;
            var owner = cells.Length > 1 ? cells[1] : "";
            DateTime? due = cells.Length > 2 && DateTime.TryParse(cells[2], out var d) ? d : null;
            list.Add((task, owner, due));
        }
        return list;
    }

    private static async Task<List<(string Task, string Owner, DateTime? Due)>> ExtractActionItemsAsync(string content, AppConfig cfg)
    {
        var client = new OpenAiApiClient(cfg);
        var result = await client.CallAsyncLong(
            "请从下面的会议记录中提取行动项，每行一条，严格使用格式：任务描述||负责人||截止日期(YYYY-MM-DD，没有就留空)。\n\n" + content,
            "你是会议行动项抽取助手。");
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
            DateTime? due = parts.Length > 2 && DateTime.TryParse(parts[2].Trim(), out var d) ? d : null;
            list.Add((task, owner, due));
        }
        return list;
    }
}

// ─── DTOs ───

public sealed class HubWebMessage
{
    public string? Type { get; set; }
    public string? Nav { get; set; }
    public string? Value { get; set; }
    public string? MeetingId { get; set; }
    public string? TemplateId { get; set; }
    public string? SeriesId { get; set; }
    public string? ProjectId { get; set; }
    public string? Filter { get; set; }
    public string? Key { get; set; }
    public string? Title { get; set; }
    public bool Enabled { get; set; }
    public WorkbenchDto? Workbench { get; set; }
    public TemplateFormDto? Template { get; set; }
    public SeriesFormDto? Series { get; set; }
}

public sealed class WorkbenchDto
{
    public string? MeetingId { get; set; }
    public string Title { get; set; } = "会议记录";
    public string Status { get; set; } = MeetingStatus.InProgress;
    public string? TemplateId { get; set; }
    public string? ProjectId { get; set; }
    public string StartTime { get; set; } = "";
    public string? EndTime { get; set; }
    public string? Tags { get; set; }
    public List<string> AgendaItems { get; set; } = new();
    public string QuickNotes { get; set; } = "";
    public List<AttendeeDto> Attendees { get; set; } = new();
    public List<ActionItemDto> ActionItems { get; set; } = new();
    public List<DecisionDto> Decisions { get; set; } = new();
    public string? SummaryMarkdown { get; set; }
    public string? SeriesId { get; set; }
}

public sealed class AttendeeDto
{
    public string Name { get; set; } = "";
    public string Role { get; set; } = "";
}

public sealed class ActionItemDto
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Task { get; set; } = "";
    public string Owner { get; set; } = "";
    public string? DueDate { get; set; }
    public bool Done { get; set; }
    public bool SyncedToTodo { get; set; }
    public string? ZenTaskId { get; set; }
}

public sealed class DecisionDto
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Content { get; set; } = "";
    public string Owner { get; set; } = "";
}

public sealed class TemplateFormDto
{
    public string Name { get; set; } = "";
    public string? Category { get; set; }
    public string? AgendaText { get; set; }
    public string? Prompt { get; set; }
    public bool BuiltIn { get; set; }
    public string? Meta { get; set; }
}

public sealed class SeriesFormDto
{
    public string Name { get; set; } = "";
    public string ProjectId { get; set; } = "";
    public string TemplateId { get; set; } = "";
    public string RecurrenceType { get; set; } = "Weekly";
    public List<int> DaysOfWeek { get; set; } = new() { 1 };
    public int DayOfMonth { get; set; } = 1;
    public int Hour { get; set; } = 10;
    public int Minute { get; set; }
    public int DurationMinutes { get; set; } = 30;
    public int ReminderMinutes { get; set; } = 10;
    public string AgendaText { get; set; } = "";
    public bool Active { get; set; } = true;

    public static SeriesFormDto FromSeries(MeetingSeries s) => new()
    {
        Name = s.Name,
        ProjectId = s.ProjectId,
        TemplateId = s.TemplateId,
        RecurrenceType = s.Recurrence.Type,
        DaysOfWeek = s.Recurrence.DaysOfWeek.ToList(),
        DayOfMonth = s.Recurrence.DayOfMonth,
        Hour = s.Recurrence.Hour,
        Minute = s.Recurrence.Minute,
        DurationMinutes = s.Recurrence.DurationMinutes,
        ReminderMinutes = s.ReminderMinutesBefore,
        AgendaText = string.Join("\n", s.DefaultAgenda),
        Active = s.Active,
    };

    public void ApplyTo(MeetingSeries s)
    {
        s.Name = Name.Trim();
        s.ProjectId = ProjectId ?? "";
        s.TemplateId = TemplateId ?? "";
        s.Recurrence = new MeetingRecurrence
        {
            Type = RecurrenceType,
            Interval = RecurrenceType == Models.RecurrenceType.BiWeekly ? 2 : 1,
            DaysOfWeek = DaysOfWeek ?? new List<int>(),
            DayOfMonth = DayOfMonth,
            Hour = Hour,
            Minute = Minute,
            DurationMinutes = DurationMinutes,
        };
        s.ReminderMinutesBefore = ReminderMinutes;
        s.DefaultAgenda = string.IsNullOrWhiteSpace(AgendaText) ? new() : AgendaText.Replace("\r\n", "\n").Split('\n').Select(l => l.Trim()).Where(l => l.Length > 0).ToList();
        s.Active = Active;
    }
}
