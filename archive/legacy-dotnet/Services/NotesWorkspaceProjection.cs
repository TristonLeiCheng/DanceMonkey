using System.Text.RegularExpressions;

namespace DesktopAssistant.Services;

public sealed record NoteOutlineEntry(string Title, int CharacterIndex, int Level);

public static class NotesWorkspaceProjection
{
    private static readonly Regex HeadingPattern = new(
        "(?m)^(#{1,6})[\\t ]+(.+?)[\\t ]*\\r?$",
        RegexOptions.Compiled);

    public static IReadOnlyList<NoteFileInfo> TakeRecentVisibleNotes(
        IEnumerable<NoteFileInfo> notes,
        int maximumCount = 5) =>
        notes
            .Where(note => !IsHistoryBackup(note.FullPath))
            .OrderByDescending(note => note.LastWriteUtc)
            .Take(Math.Max(0, maximumCount))
            .ToArray();

    public static IReadOnlyList<NoteOutlineEntry> ExtractOutline(string? markdown) =>
        HeadingPattern
            .Matches(markdown ?? string.Empty)
            .Select(match => new NoteOutlineEntry(
                match.Groups[2].Value.Trim(),
                match.Index,
                match.Groups[1].Value.Length))
            .ToArray();

    private static bool IsHistoryBackup(string fullPath) =>
        fullPath
            .Split(new[] { '\\', '/' }, StringSplitOptions.RemoveEmptyEntries)
            .Any(segment => string.Equals(segment, ".history", StringComparison.OrdinalIgnoreCase));
}
