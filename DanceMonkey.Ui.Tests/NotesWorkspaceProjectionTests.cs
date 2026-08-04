using DesktopAssistant.Services;
using Xunit;

namespace DanceMonkey.Ui.Tests;

public sealed class NotesWorkspaceProjectionTests
{
    [Fact]
    public void TakeRecentVisibleNotes_ExcludesHistoryBackupsAndOrdersByLastWrite()
    {
        var notes = new[]
        {
            Note("C:\\NoteVault\\.history\\daily.md", "daily.md", "2026-07-27T12:00:00Z"),
            Note("C:\\NoteVault\\projects\\plan.md", "plan.md", "2026-07-27T11:00:00Z"),
            Note("C:\\NoteVault\\ideas.md", "ideas.md", "2026-07-27T10:00:00Z"),
            Note("C:\\NoteVault\\archive\\.history\\old.md", "old.md", "2026-07-27T09:00:00Z")
        };

        var recent = NotesWorkspaceProjection.TakeRecentVisibleNotes(notes, 2);

        Assert.Equal(new[] { "plan.md", "ideas.md" }, recent.Select(note => note.FileName));
    }

    [Fact]
    public void ExtractOutline_UsesExactCharacterOffsetsForLfMarkdown()
    {
        const string markdown = "# Start\ntext\n## Next\nmore\n";

        var outline = NotesWorkspaceProjection.ExtractOutline(markdown);

        Assert.Collection(
            outline,
            first =>
            {
                Assert.Equal("Start", first.Title);
                Assert.Equal(0, first.CharacterIndex);
                Assert.Equal(1, first.Level);
            },
            second =>
            {
                Assert.Equal("Next", second.Title);
                Assert.Equal(markdown.IndexOf("## Next", StringComparison.Ordinal), second.CharacterIndex);
                Assert.Equal(2, second.Level);
            });
    }

    private static NoteFileInfo Note(string fullPath, string fileName, string lastWriteUtc) => new()
    {
        FullPath = fullPath,
        FileName = fileName,
        LastWriteUtc = DateTime.Parse(lastWriteUtc, null, System.Globalization.DateTimeStyles.AdjustToUniversal)
    };
}
