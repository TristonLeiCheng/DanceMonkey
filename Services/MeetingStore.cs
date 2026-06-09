using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using DesktopAssistant.Models;

namespace DesktopAssistant.Services;

/// <summary>
/// 会议中心数据读写。会议/系列/项目/模板均以 JSON envelope 存于
/// &lt;NotesRoot&gt;/Meetings/_hub/ 下，沿用原子写与 SchemaVersion。
/// 人类可读的 Markdown 纪要仍导出到 Meetings/yyyy/MM/。
/// </summary>
public sealed class MeetingStore
{
    private const int SchemaVersion = 1;

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        WriteIndented = true,
        PropertyNameCaseInsensitive = true,
        ReadCommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly string _root;
    private readonly string _hubDir;
    private readonly string _meetingsFile;
    private readonly string _seriesFile;
    private readonly string _projectsFile;
    private readonly string _templatesFile;

    public MeetingStore(string? notesRootPath)
    {
        _root = NoteService.ResolveRoot(notesRootPath);
        _hubDir = Path.Combine(_root, "Meetings", "_hub");
        Directory.CreateDirectory(_hubDir);
        _meetingsFile = Path.Combine(_hubDir, "meetings.json");
        _seriesFile = Path.Combine(_hubDir, "series.json");
        _projectsFile = Path.Combine(_hubDir, "projects.json");
        _templatesFile = Path.Combine(_hubDir, "templates.json");
    }

    public string MeetingsRoot => Path.Combine(_root, "Meetings");

    // ═══════════════ Load ═══════════════

    public List<MeetingRecord> LoadMeetings() => LoadList<MeetingRecord>(_meetingsFile);
    public List<MeetingSeries> LoadSeries() => LoadList<MeetingSeries>(_seriesFile);
    public List<MeetingProject> LoadProjects() => LoadList<MeetingProject>(_projectsFile);

    public List<MeetingTemplate> LoadTemplates()
    {
        var list = LoadList<MeetingTemplate>(_templatesFile);
        if (list.Count == 0)
        {
            list = BuildBuiltInTemplates();
            SaveTemplates(list);
        }
        return list;
    }

    private static List<T> LoadList<T>(string file)
    {
        if (!File.Exists(file))
            return new List<T>();
        try
        {
            var json = File.ReadAllText(file, Encoding.UTF8);
            var env = JsonSerializer.Deserialize<StoreEnvelope<T>>(json, JsonOpts);
            if (env?.Items != null)
                return env.Items;
            return JsonSerializer.Deserialize<List<T>>(json, JsonOpts) ?? new List<T>();
        }
        catch
        {
            return new List<T>();
        }
    }

    // ═══════════════ Save ═══════════════

    public void SaveMeetings(IReadOnlyList<MeetingRecord> items) => SaveList(_meetingsFile, items);
    public void SaveSeries(IReadOnlyList<MeetingSeries> items) => SaveList(_seriesFile, items);
    public void SaveProjects(IReadOnlyList<MeetingProject> items) => SaveList(_projectsFile, items);
    public void SaveTemplates(IReadOnlyList<MeetingTemplate> items) => SaveList(_templatesFile, items);

    private static void SaveList<T>(string file, IReadOnlyList<T> items)
    {
        var env = new StoreEnvelope<T> { SchemaVersion = SchemaVersion, Items = items.ToList() };
        var json = JsonSerializer.Serialize(env, JsonOpts);
        AtomicWrite(file, json);
    }

    public MeetingRecord UpsertMeeting(MeetingRecord record)
    {
        record.UpdatedAt = DateTime.Now;
        var all = LoadMeetings();
        var idx = all.FindIndex(m => m.Id == record.Id);
        if (idx >= 0)
            all[idx] = record;
        else
            all.Insert(0, record);
        SaveMeetings(all);
        return record;
    }

    public void DeleteMeeting(string id)
    {
        var all = LoadMeetings();
        all.RemoveAll(m => m.Id == id);
        SaveMeetings(all);
    }

    public MeetingProject UpsertProject(MeetingProject project)
    {
        var all = LoadProjects();
        var idx = all.FindIndex(p => p.Id == project.Id);
        if (idx >= 0)
            all[idx] = project;
        else
            all.Add(project);
        SaveProjects(all);
        return project;
    }

    // ═══════════════ Markdown export ═══════════════

    /// <summary>把会议导出为人类可读 Markdown，返回文件路径并回写到 record.MarkdownPath。</summary>
    public string ExportMarkdown(MeetingRecord record, string? timestampedTranscript)
    {
        var subDir = Path.Combine(MeetingsRoot, record.StartTime.ToString("yyyy"), record.StartTime.ToString("MM"));
        Directory.CreateDirectory(subDir);
        var safeTitle = SanitizeFileName(string.IsNullOrWhiteSpace(record.Title) ? "会议记录" : record.Title);
        var fileName = $"{record.StartTime:yyyy-MM-dd_HHmm}_{safeTitle}.md";
        var path = Path.Combine(subDir, fileName);

        var sb = new StringBuilder();
        sb.AppendLine("---");
        sb.AppendLine($"title: {record.Title}");
        sb.AppendLine($"date: {record.StartTime:yyyy-MM-dd HH:mm}");
        sb.AppendLine("type: meeting");
        if (record.Tags.Count > 0)
            sb.AppendLine($"tags: {string.Join(", ", record.Tags)}");
        sb.AppendLine("---");
        sb.AppendLine();
        sb.AppendLine($"# {record.Title}");
        sb.AppendLine();

        if (record.Attendees.Count > 0)
        {
            sb.AppendLine($"**参会人**：{string.Join("、", record.Attendees.Select(a => string.IsNullOrWhiteSpace(a.Role) ? a.Name : $"{a.Name}（{a.Role}）"))}");
            sb.AppendLine();
        }

        if (record.AgendaItems.Count > 0)
        {
            sb.AppendLine("## 议程");
            sb.AppendLine();
            foreach (var item in record.AgendaItems)
                sb.AppendLine($"- {item}");
            sb.AppendLine();
        }

        if (!string.IsNullOrWhiteSpace(record.SummaryMarkdown))
        {
            sb.AppendLine("## 会议纪要");
            sb.AppendLine();
            sb.AppendLine(record.SummaryMarkdown);
            sb.AppendLine();
        }

        if (record.Decisions.Count > 0)
        {
            sb.AppendLine("## 决策记录");
            sb.AppendLine();
            foreach (var d in record.Decisions)
                sb.AppendLine($"- {d}");
            sb.AppendLine();
        }

        if (record.ActionItems.Count > 0)
        {
            sb.AppendLine("## 行动项");
            sb.AppendLine();
            sb.AppendLine("| 任务 | 负责人 | 截止 | 状态 |");
            sb.AppendLine("|------|--------|------|------|");
            foreach (var a in record.ActionItems)
            {
                var due = a.DueDate?.ToString("yyyy-MM-dd") ?? "待确认";
                var st = a.Done ? "已完成" : "进行中";
                sb.AppendLine($"| {a.Task} | {(string.IsNullOrWhiteSpace(a.Owner) ? "待确认" : a.Owner)} | {due} | {st} |");
            }
            sb.AppendLine();
        }

        if (!string.IsNullOrWhiteSpace(record.QuickNotes))
        {
            sb.AppendLine("## 会上手记");
            sb.AppendLine();
            sb.AppendLine(record.QuickNotes);
            sb.AppendLine();
        }

        if (!string.IsNullOrWhiteSpace(timestampedTranscript))
        {
            sb.AppendLine("## 会议记录（转写）");
            sb.AppendLine();
            sb.AppendLine(timestampedTranscript);
        }

        File.WriteAllText(path, sb.ToString(), Encoding.UTF8);
        record.MarkdownPath = path;
        return path;
    }

    // ═══════════════ Legacy migration ═══════════════

    /// <summary>扫描旧版散落的 Meetings/yyyy/MM/*.md，为未索引者建立 MeetingRecord 索引。返回新增条数。</summary>
    public int MigrateLegacyMarkdown()
    {
        if (!Directory.Exists(MeetingsRoot))
            return 0;

        var meetings = LoadMeetings();
        var known = new HashSet<string>(
            meetings.Where(m => !string.IsNullOrWhiteSpace(m.MarkdownPath))
                    .Select(m => m.MarkdownPath),
            StringComparer.OrdinalIgnoreCase);

        var added = 0;
        IEnumerable<string> files;
        try
        {
            files = Directory.EnumerateFiles(MeetingsRoot, "*.md", SearchOption.AllDirectories)
                .Where(f => !f.Contains($"{Path.DirectorySeparatorChar}_hub{Path.DirectorySeparatorChar}", StringComparison.OrdinalIgnoreCase));
        }
        catch
        {
            return 0;
        }

        foreach (var file in files)
        {
            if (known.Contains(file))
                continue;
            try
            {
                var (title, date) = ParseFrontmatter(file);
                var rec = new MeetingRecord
                {
                    Title = string.IsNullOrWhiteSpace(title) ? Path.GetFileNameWithoutExtension(file) : title,
                    StartTime = date ?? File.GetCreationTime(file),
                    Status = MeetingStatus.Completed,
                    MarkdownPath = file,
                    CreatedAt = File.GetCreationTime(file),
                    UpdatedAt = File.GetLastWriteTime(file),
                };
                meetings.Add(rec);
                added++;
            }
            catch
            {
                // 单个文件解析失败不影响整体
            }
        }

        if (added > 0)
        {
            meetings = meetings.OrderByDescending(m => m.StartTime).ToList();
            SaveMeetings(meetings);
        }
        return added;
    }

    private static (string? title, DateTime? date) ParseFrontmatter(string file)
    {
        string? title = null;
        DateTime? date = null;
        var lines = File.ReadLines(file).Take(12);
        var inFront = false;
        foreach (var raw in lines)
        {
            var line = raw.Trim();
            if (line == "---")
            {
                if (!inFront) { inFront = true; continue; }
                break;
            }
            if (!inFront)
                continue;
            if (line.StartsWith("title:", StringComparison.OrdinalIgnoreCase))
                title = line.Substring(6).Trim();
            else if (line.StartsWith("date:", StringComparison.OrdinalIgnoreCase))
            {
                var v = line.Substring(5).Trim();
                if (DateTime.TryParse(v, CultureInfo.InvariantCulture, DateTimeStyles.None, out var d))
                    date = d;
            }
        }
        return (title, date);
    }

    // ═══════════════ Recurrence ═══════════════

    /// <summary>计算某系列从 from 起的接下来 count 个发生时间。</summary>
    public static List<DateTime> NextOccurrences(MeetingSeries series, DateTime from, int count)
    {
        var result = new List<DateTime>();
        if (series.Recurrence == null || count <= 0)
            return result;

        var r = series.Recurrence;
        var interval = Math.Max(1, r.Interval);
        var anchor = series.CreatedAt.Date;
        var cursor = from.Date;
        var guard = 0;

        while (result.Count < count && guard < 800)
        {
            guard++;
            var match = r.Type switch
            {
                RecurrenceType.Daily => (cursor - anchor).Days % interval == 0,
                RecurrenceType.Weekday => cursor.DayOfWeek != DayOfWeek.Saturday && cursor.DayOfWeek != DayOfWeek.Sunday,
                RecurrenceType.Weekly => WeekMatch(r, anchor, cursor, interval),
                RecurrenceType.BiWeekly => WeekMatch(r, anchor, cursor, 2),
                RecurrenceType.Monthly => cursor.Day == Math.Min(r.DayOfMonth, DateTime.DaysInMonth(cursor.Year, cursor.Month))
                                          && MonthMatch(anchor, cursor, interval),
                _ => false
            };

            if (match)
            {
                var occ = cursor.AddHours(r.Hour).AddMinutes(r.Minute);
                if (occ >= from)
                    result.Add(occ);
            }
            cursor = cursor.AddDays(1);
        }
        return result;
    }

    private static bool WeekMatch(MeetingRecurrence r, DateTime anchor, DateTime cursor, int interval)
    {
        if (r.DaysOfWeek.Count > 0 && !r.DaysOfWeek.Contains((int)cursor.DayOfWeek))
            return false;
        var weeks = (int)Math.Floor((cursor - StartOfWeek(anchor)).TotalDays / 7);
        return weeks % interval == 0;
    }

    private static bool MonthMatch(DateTime anchor, DateTime cursor, int interval)
    {
        var months = (cursor.Year - anchor.Year) * 12 + (cursor.Month - anchor.Month);
        return months % interval == 0;
    }

    private static DateTime StartOfWeek(DateTime d)
    {
        var diff = (7 + (int)d.DayOfWeek) % 7;
        return d.AddDays(-diff).Date;
    }

    // ═══════════════ Built-in templates ═══════════════

    private static List<MeetingTemplate> BuildBuiltInTemplates() => new()
    {
        new MeetingTemplate
        {
            Name = "每日站会", Icon = "🧍", Category = "敏捷", BuiltIn = true, DefaultDurationMinutes = 15,
            AgendaTemplate = new() { "昨日完成", "今日计划", "阻碍与风险" },
            StructuredSections = new() { "进展", "阻碍", "行动项" },
            DefaultTags = new() { "站会" },
        },
        new MeetingTemplate
        {
            Name = "周会例会", Icon = "🔁", Category = "例会", BuiltIn = true, DefaultDurationMinutes = 60,
            AgendaTemplate = new() { "上周回顾", "本周计划", "风险与依赖", "其他事项" },
            StructuredSections = new() { "进展", "决策", "风险", "行动项" },
            DefaultTags = new() { "周会" },
        },
        new MeetingTemplate
        {
            Name = "需求评审", Icon = "📋", Category = "评审", BuiltIn = true, DefaultDurationMinutes = 90,
            AgendaTemplate = new() { "需求背景", "方案讲解", "质疑与讨论", "结论与排期" },
            StructuredSections = new() { "需求要点", "争议点", "决策", "行动项" },
            DefaultTags = new() { "评审" },
        },
        new MeetingTemplate
        {
            Name = "项目复盘", Icon = "🔍", Category = "复盘", BuiltIn = true, DefaultDurationMinutes = 60,
            AgendaTemplate = new() { "目标回顾", "做得好的", "待改进的", "改进行动" },
            StructuredSections = new() { "亮点", "问题", "根因", "改进项" },
            DefaultTags = new() { "复盘" },
        },
        new MeetingTemplate
        {
            Name = "一对一", Icon = "👥", Category = "1:1", BuiltIn = true, DefaultDurationMinutes = 30,
            AgendaTemplate = new() { "近期状态", "困难与支持", "成长与反馈", "下一步" },
            StructuredSections = new() { "要点", "承诺", "行动项" },
            DefaultTags = new() { "1on1" },
        },
        new MeetingTemplate
        {
            Name = "客户沟通", Icon = "🤝", Category = "客户", BuiltIn = true, DefaultDurationMinutes = 45,
            AgendaTemplate = new() { "客户诉求", "方案对齐", "商务事项", "后续安排" },
            StructuredSections = new() { "客户诉求", "承诺", "风险", "行动项" },
            DefaultTags = new() { "客户" },
        },
        new MeetingTemplate
        {
            Name = "头脑风暴", Icon = "💡", Category = "创意", BuiltIn = true, DefaultDurationMinutes = 60,
            AgendaTemplate = new() { "议题界定", "自由发散", "归类筛选", "落地评估" },
            StructuredSections = new() { "点子", "优选", "行动项" },
            DefaultTags = new() { "头脑风暴" },
        },
    };

    // ═══════════════ helpers ═══════════════

    private static void AtomicWrite(string path, string content)
    {
        var dir = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(dir))
            Directory.CreateDirectory(dir);
        var tmp = path + ".tmp";
        File.WriteAllText(tmp, content, new UTF8Encoding(false));
        if (File.Exists(path))
            File.Replace(tmp, path, null);
        else
            File.Move(tmp, path);
    }

    private static string SanitizeFileName(string name)
    {
        var invalid = Path.GetInvalidFileNameChars();
        var sb = new StringBuilder(name.Length);
        foreach (var c in name)
            sb.Append(invalid.Contains(c) ? '_' : c);
        var result = sb.ToString().Trim();
        return string.IsNullOrWhiteSpace(result) ? "会议记录" : result;
    }

    private sealed class StoreEnvelope<T>
    {
        public int SchemaVersion { get; set; }
        public List<T> Items { get; set; } = new();
    }
}