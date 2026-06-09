using System.Collections.ObjectModel;
using System.Windows;

namespace DesktopAssistant.Services;

/// <summary>轻量剪贴板文本历史（轮询去重）。启用后由 App 层驱动 Tick。</summary>
public sealed class ClipboardHistoryService
{
    private readonly ObservableCollection<string> _items = new();
    private string? _lastSnapshot;
    public const int MaxItems = 30;

    public ReadOnlyObservableCollection<string> Items { get; }

    public ClipboardHistoryService()
    {
        Items = new ReadOnlyObservableCollection<string>(_items);
    }

    public void Clear()
    {
        Application.Current?.Dispatcher.Invoke(() =>
        {
            _items.Clear();
            _lastSnapshot = null;
        });
    }

    /// <summary>在 UI 线程调用。</summary>
    public void Tick()
    {
        try
        {
            if (!Clipboard.ContainsText()) return;
            var text = Clipboard.GetText();
            if (string.IsNullOrWhiteSpace(text)) return;
            if (text == _lastSnapshot) return;
            _lastSnapshot = text;

            var preview = text.Length > 500 ? text[..500] + "…" : text;
            _items.Insert(0, preview);
            while (_items.Count > MaxItems)
                _items.RemoveAt(_items.Count - 1);
        }
        catch
        {
            // clipboard busy
        }
    }

    public static void CopyToClipboard(string text)
    {
        try
        {
            Clipboard.SetText(text);
        }
        catch
        {
            // ignore
        }
    }
}
