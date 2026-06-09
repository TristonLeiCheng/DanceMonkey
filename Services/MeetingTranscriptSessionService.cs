using System.Text;
using System.Text.Json;

namespace DesktopAssistant.Services;

/// <summary>
/// 会议转写会话管理。负责段落缓存、时间戳标注、临时落盘与恢复。
/// </summary>
public sealed class MeetingTranscriptSessionService
{
    public sealed record TranscriptSegment(int Index, DateTime Timestamp, string Text);

    private readonly List<TranscriptSegment> _segments = new();
    private readonly string _tempDir;
    private string? _tempFilePath;
    private DateTime _sessionStart;
    private bool _active;

    /// <summary>会话是否活跃。</summary>
    public bool IsActive => _active;

    /// <summary>当前所有已转写段落。</summary>
    public IReadOnlyList<TranscriptSegment> Segments => _segments;

    public MeetingTranscriptSessionService()
    {
        var appData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        _tempDir = Path.Combine(appData, "DanceMonkey", "MeetingTemp");
        Directory.CreateDirectory(_tempDir);
    }

    /// <summary>开始新会话。</summary>
    public void StartSession()
    {
        _segments.Clear();
        _sessionStart = DateTime.Now;
        _active = true;
        _tempFilePath = Path.Combine(_tempDir, $"meeting_{_sessionStart:yyyyMMdd_HHmmss}.tmp.json");
    }

    /// <summary>追加一段转写文本。</summary>
    public void AppendSegment(int index, string text)
    {
        if (!_active || string.IsNullOrWhiteSpace(text)) return;

        var seg = new TranscriptSegment(index, DateTime.Now, text.Trim());
        _segments.Add(seg);
        SaveTempToDisk();
    }

    /// <summary>获取全文拼接文本。</summary>
    public string GetFullTranscript()
    {
        var sb = new StringBuilder();
        foreach (var seg in _segments)
            sb.AppendLine(seg.Text);
        return sb.ToString().Trim();
    }

    /// <summary>获取带时间戳的全文。</summary>
    public string GetTimestampedTranscript()
    {
        var sb = new StringBuilder();
        foreach (var seg in _segments)
        {
            var offset = seg.Timestamp - _sessionStart;
            sb.AppendLine($"[{offset:hh\\:mm\\:ss}] {seg.Text}");
        }
        return sb.ToString().Trim();
    }

    /// <summary>结束会话。</summary>
    public void EndSession()
    {
        _active = false;
        SaveTempToDisk();
    }

    /// <summary>清空当前会话。</summary>
    public void Clear()
    {
        _segments.Clear();
        _active = false;
        TryDeleteTempFile();
    }

    /// <summary>
    /// 将会议记录保存为 Markdown 文件。
    /// </summary>
    /// <param name="savePath">目标 .md 文件完整路径。</param>
    /// <param name="title">会议标题。</param>
    /// <param name="summary">AI 生成的摘要（可选）。</param>
    public void SaveAsMarkdown(string savePath, string title, string? summary = null)
    {
        var dir = Path.GetDirectoryName(savePath);
        if (!string.IsNullOrEmpty(dir))
            Directory.CreateDirectory(dir);

        var sb = new StringBuilder();
        sb.AppendLine("---");
        sb.AppendLine($"title: {title}");
        sb.AppendLine($"date: {_sessionStart:yyyy-MM-dd HH:mm}");
        sb.AppendLine("type: meeting");
        sb.AppendLine("---");
        sb.AppendLine();
        sb.AppendLine($"# {title}");
        sb.AppendLine();

        if (!string.IsNullOrWhiteSpace(summary))
        {
            sb.AppendLine("## 会议摘要");
            sb.AppendLine();
            sb.AppendLine(summary);
            sb.AppendLine();
        }

        sb.AppendLine("## 会议记录");
        sb.AppendLine();
        sb.AppendLine(GetTimestampedTranscript());

        File.WriteAllText(savePath, sb.ToString(), Encoding.UTF8);
        TryDeleteTempFile();
    }

    /// <summary>生成默认保存路径。</summary>
    public string ResolveDefaultSavePath(string? meetingSaveDir, string? notesRoot, string title)
    {
        string baseDir;
        if (!string.IsNullOrWhiteSpace(meetingSaveDir))
            baseDir = meetingSaveDir;
        else if (!string.IsNullOrWhiteSpace(notesRoot))
            baseDir = Path.Combine(notesRoot, "Meetings");
        else
            baseDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "DanceMonkey", "Meetings");

        var subDir = Path.Combine(baseDir, _sessionStart.ToString("yyyy"), _sessionStart.ToString("MM"));
        Directory.CreateDirectory(subDir);

        var safeTitle = SanitizeFileName(title);
        var fileName = $"{_sessionStart:yyyy-MM-dd_HHmm}_{safeTitle}.md";
        return Path.Combine(subDir, fileName);
    }

    private void SaveTempToDisk()
    {
        if (string.IsNullOrEmpty(_tempFilePath)) return;
        try
        {
            var json = JsonSerializer.Serialize(_segments, new JsonSerializerOptions { WriteIndented = true });
            File.WriteAllText(_tempFilePath, json, Encoding.UTF8);
        }
        catch
        {
            // 临时文件写入失败不阻塞主流程
        }
    }

    private void TryDeleteTempFile()
    {
        try
        {
            if (!string.IsNullOrEmpty(_tempFilePath) && File.Exists(_tempFilePath))
                File.Delete(_tempFilePath);
        }
        catch { }
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
}
