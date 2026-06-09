namespace DesktopAssistant.Services;

/// <summary>会议中心 → AiChat「写邮件」模式的内容交接（一键会后邮件）。</summary>
public static class MeetingEmailHandoff
{
    public static string? Subject { get; private set; }
    public static string? Points { get; private set; }

    public static void Request(string subject, string points)
    {
        Subject = subject;
        Points = points;
    }

    public static bool TryConsume(out string subject, out string points)
    {
        subject = Subject ?? "";
        points = Points ?? "";
        var had = !string.IsNullOrWhiteSpace(Subject) || !string.IsNullOrWhiteSpace(Points);
        Subject = null;
        Points = null;
        return had;
    }
}