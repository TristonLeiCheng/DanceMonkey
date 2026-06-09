using System.IO;
using System.Text.Json;
using System.Windows;
using DesktopAssistant.Models;
using DesktopAssistant.Views;

namespace DesktopAssistant.Services;

/// <summary>管理桌面便签窗口的打开列表与位置持久化。</summary>
public static class StickyNoteManager
{
    private static readonly object Gate = new();
    private static readonly List<StickyNoteWindow> OpenWindows = new();

    private static string StateFilePath =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "DanceMonkey",
            "sticky_notes.json");

    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };

    public static void Register(StickyNoteWindow window)
    {
        lock (Gate)
            OpenWindows.Add(window);
    }

    public static void Unregister(StickyNoteWindow window)
    {
        lock (Gate)
            OpenWindows.Remove(window);
    }

    public static void RestoreFromDisk(NoteService notes)
    {
        if (!File.Exists(StateFilePath))
            return;

        List<StickyNoteWindowState>? list;
        try
        {
            list = JsonSerializer.Deserialize<List<StickyNoteWindowState>>(File.ReadAllText(StateFilePath));
        }
        catch
        {
            return;
        }

        if (list == null || list.Count == 0)
            return;

        foreach (var s in list)
        {
            if (string.IsNullOrWhiteSpace(s.FilePath) || !File.Exists(s.FilePath))
                continue;
            if (!notes.IsUnderRoot(s.FilePath))
                continue;

            lock (Gate)
            {
                if (OpenWindows.Any(w => string.Equals(w.FilePath, s.FilePath, StringComparison.OrdinalIgnoreCase)))
                    continue;
            }

            var w = new StickyNoteWindow(s.FilePath, notes, s);
            w.Show();
        }
    }

    public static void SaveAllLayouts()
    {
        List<StickyNoteWindowState> list;
        lock (Gate)
            list = OpenWindows.Select(w => w.BuildState()).ToList();

        try
        {
            var dir = Path.GetDirectoryName(StateFilePath);
            if (!string.IsNullOrEmpty(dir))
                Directory.CreateDirectory(dir);
            File.WriteAllText(StateFilePath, JsonSerializer.Serialize(list, JsonOptions));
        }
        catch
        {
            // ignore
        }
    }

    public static void CloseAll()
    {
        StickyNoteWindow[] copy;
        lock (Gate)
            copy = OpenWindows.ToArray();

        foreach (var w in copy)
        {
            try
            {
                w.Close();
            }
            catch
            {
                // ignore
            }
        }
    }
}
