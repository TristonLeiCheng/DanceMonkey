using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using DesktopAssistant.Models;
using DesktopAssistant.Services;
using MediaBrush = System.Windows.Media.Brush;
using MediaColor = System.Windows.Media.Color;

namespace DesktopAssistant.Views;

/// <summary>
/// 桌面中心快速访问弹窗，从 Dock 按钮唤起。
/// 支持类别 Tab 切换，点击任意快捷方式后自动关闭。
/// </summary>
public partial class QuickAccessPopup : Window
{
    // ─── Entry model (mirrors QuickAccessView.Entry) ───
    private sealed class Entry
    {
        public string        Name        { get; init; } = "";
        public string        Path        { get; init; } = "";
        public string        Category    { get; init; } = "local";
        public string        Description { get; init; } = "";
        public int           ClickCount  { get; set;  } = 0;
        public bool          IsCustom    { get; init; } = false;
        public QuickLinkItem? Source     { get; init; }

        public string Icon => Category switch
        {
            "network"    => "\U0001f5a7",
            "onedrive"   => "\u2601",
            "sharepoint" => "\U0001f517",
            "web"        => "\U0001f310",
            _            => "\U0001f4c1"
        };

        public string Subtitle =>
            !string.IsNullOrWhiteSpace(Description) ? Description : Path;
    }

    // ─── Tab definitions ───
    private static readonly (string Key, string LangKey)[] TabDefs =
    {
        ("all",        "QuickAccess.TabAll"),
        ("local",      "QuickAccess.TabLocal"),
        ("network",    "QuickAccess.TabNetwork"),
        ("onedrive",   "QuickAccess.TabOneDrive"),
        ("sharepoint", "QuickAccess.TabSharePoint"),
        ("web",        "QuickAccess.TabWeb"),
    };

    private string      _activeTab = "all";
    private string      _search    = "";
    private List<Entry> _entries   = new();
    private bool        _closing   = false;   // guard against double-Close

    // ====================================================
    public QuickAccessPopup()
    {
        InitializeComponent();
        BuildTabs();
        Loaded += (_, _) =>
        {
            LoadEntries();
            RebuildTiles();
            ApplyThemeColor();
            SearchPlaceholder.Visibility = Visibility.Visible;
        };
    }

    // ====================================================
    //  Theme: inherit Dock's current card colour
    // ====================================================
    private void ApplyThemeColor()
    {
        try
        {
            var cfg   = App.Config.Load();
            var theme = (cfg.DockTheme ?? "ocean").Trim().ToLowerInvariant();

            // Map theme key → card RGB (same table as DockWindow)
            var (r, g, b) = theme switch
            {
                "aurora"   => (0x16, 0x4E, 0x45),
                "sunset"   => (0x5E, 0x34, 0x2A),
                "grape"    => (0x3E, 0x34, 0x68),
                "graphite" => (0x2A, 0x2E, 0x35),
                "noirpro"  => (0x12, 0x14, 0x17),
                _          => (0x1A, 0x3A, 0x5C)   // ocean (default)
            };

            CardBg.Color   = MediaColor.FromRgb((byte)r, (byte)g, (byte)b);
            CardBg.Opacity = 0.96;
        }
        catch { /* fallback to XAML default */ }
    }

    // ====================================================
    //  Tabs
    // ====================================================
    private void BuildTabs()
    {
        TabStrip.Children.Clear();
        bool first = true;
        foreach (var (key, langKey) in TabDefs)
        {
            var rb = new RadioButton
            {
                Content   = L(langKey),
                GroupName = "PopupTab",
                Tag       = key,
                IsChecked = first,
                Style     = (Style)FindResource("PopupTabBtn"),
                Margin    = new Thickness(2, 0, 2, 0)
            };
            rb.Checked += Tab_Checked;
            TabStrip.Children.Add(rb);
            first = false;
        }
    }

    private void Tab_Checked(object sender, RoutedEventArgs e)
    {
        if (sender is RadioButton { Tag: string key })
        {
            _activeTab = key;
            RebuildTiles();
        }
    }

    // ====================================================
    //  Data
    // ====================================================
    private void LoadEntries()
    {
        _entries = new List<Entry>();

        foreach (var (name, path, _) in QuickAccessPaths.DetectLocalFolders())
            _entries.Add(new Entry { Name = name, Path = path, Category = "local" });

        foreach (var (name, path, _) in QuickAccessPaths.DetectOneDriveFolders())
            _entries.Add(new Entry { Name = name, Path = path, Category = "onedrive" });

        foreach (var (name, path, _) in QuickAccessPaths.DetectNetworkDrives())
            _entries.Add(new Entry { Name = name, Path = path, Category = "network" });

        foreach (var link in App.Config.Load().QuickLinks)
        {
            _entries.Add(new Entry
            {
                Name        = link.Name,
                Path        = link.Path,
                Category    = link.Category,
                Description = link.Description,
                ClickCount  = link.ClickCount,
                IsCustom    = true,
                Source      = link
            });
        }
    }

    // ====================================================
    //  Search
    // ====================================================
    private void SearchBox_TextChanged(object sender, TextChangedEventArgs e)
    {
        _search = SearchBox.Text;
        SearchPlaceholder.Visibility =
            string.IsNullOrEmpty(_search) ? Visibility.Visible : Visibility.Collapsed;
        RebuildTiles();
    }

    // ====================================================
    //  Tile rebuild
    // ====================================================
    private void RebuildTiles()
    {
        ContentPanel.Children.Clear();

        IEnumerable<Entry> q = _entries;
        if (_activeTab != "all")
            q = q.Where(e => e.Category == _activeTab);

        if (!string.IsNullOrWhiteSpace(_search))
        {
            var s = _search.Trim();
            q = q.Where(e =>
                e.Name.Contains(s, StringComparison.OrdinalIgnoreCase) ||
                e.Path.Contains(s, StringComparison.OrdinalIgnoreCase) ||
                e.Description.Contains(s, StringComparison.OrdinalIgnoreCase));
        }

        // Sort: pinned custom first, then by click count desc, then name
        var sorted = q
            .OrderByDescending(e => e.IsCustom && (e.Source?.Pinned == true))
            .ThenByDescending(e => e.ClickCount)
            .ThenBy(e => e.Name)
            .ToList();

        if (sorted.Count == 0)
        {
            ContentPanel.Children.Add(new TextBlock
            {
                Text       = L("QuickAccess.NoItems"),
                Foreground = new SolidColorBrush(MediaColor.FromArgb(0x90, 0xFF, 0xFF, 0xFF)),
                FontSize   = 13,
                Margin     = new Thickness(4, 16, 0, 0)
            });
            return;
        }

        foreach (var entry in sorted)
            ContentPanel.Children.Add(MakeTile(entry));
    }

    private static MediaBrush GetCategoryCardBg(string category) => category switch
    {
        "network"    => new SolidColorBrush(MediaColor.FromArgb(0x22, 0x70, 0xA8, 0xFF)),
        "onedrive"   => new SolidColorBrush(MediaColor.FromArgb(0x22, 0x40, 0xA0, 0xFF)),
        "sharepoint" => new SolidColorBrush(MediaColor.FromArgb(0x22, 0x00, 0xC8, 0xC8)),
        "web"        => new SolidColorBrush(MediaColor.FromArgb(0x22, 0x66, 0xD1, 0x7A)),
        _            => new SolidColorBrush(MediaColor.FromArgb(0x20, 0xFF, 0xC0, 0x78)),
    };

    private static MediaBrush GetCategoryCardBorder(string category) => category switch
    {
        "network"    => new SolidColorBrush(MediaColor.FromArgb(0x44, 0x9E, 0xC3, 0xFF)),
        "onedrive"   => new SolidColorBrush(MediaColor.FromArgb(0x44, 0x7D, 0xBD, 0xFF)),
        "sharepoint" => new SolidColorBrush(MediaColor.FromArgb(0x44, 0x4D, 0xDF, 0xDF)),
        "web"        => new SolidColorBrush(MediaColor.FromArgb(0x44, 0x84, 0xE4, 0x95)),
        _            => new SolidColorBrush(MediaColor.FromArgb(0x3E, 0xFF, 0xCD, 0x8C)),
    };

    private static MediaBrush GetCategoryIconBg(string category) => category switch
    {
        "network"    => new SolidColorBrush(MediaColor.FromArgb(0x38, 0x70, 0xA8, 0xFF)),
        "onedrive"   => new SolidColorBrush(MediaColor.FromArgb(0x38, 0x40, 0xA0, 0xFF)),
        "sharepoint" => new SolidColorBrush(MediaColor.FromArgb(0x38, 0x00, 0xC8, 0xC8)),
        "web"        => new SolidColorBrush(MediaColor.FromArgb(0x38, 0x66, 0xD1, 0x7A)),
        _            => new SolidColorBrush(MediaColor.FromArgb(0x36, 0xFF, 0xC0, 0x78)),
    };

    private static Border MakePopupBadge(string text) => new()
    {
        Background   = new SolidColorBrush(MediaColor.FromArgb(0x20, 0xFF, 0xFF, 0xFF)),
        CornerRadius = new CornerRadius(999),
        Padding      = new Thickness(6, 2, 6, 2),
        Margin       = new Thickness(0, 0, 0, 5),
        Child        = new TextBlock
        {
            Text       = text,
            FontSize   = 10,
            FontWeight = FontWeights.SemiBold,
            Foreground = new SolidColorBrush(MediaColor.FromArgb(0xDD, 0xFF, 0xFF, 0xFF))
        }
    };

    private Button MakeTile(Entry entry)
    {
        var btn = new Button
        {
            Style       = (Style)FindResource("PopupTileBtn"),
            Tag         = entry,
            ToolTip     = entry.Path,
            Margin      = new Thickness(0, 0, 8, 8),
            MinHeight   = 64,
            Background  = GetCategoryCardBg(entry.Category),
            BorderBrush = GetCategoryCardBorder(entry.Category)
        };

        var outer = new Grid();
        outer.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        outer.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        outer.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

        var iconCircle = new Border
        {
            Width             = 34,
            Height            = 34,
            CornerRadius      = new CornerRadius(11),
            Background        = GetCategoryIconBg(entry.Category),
            VerticalAlignment = VerticalAlignment.Center,
            Margin            = new Thickness(0, 0, 9, 0)
        };
        iconCircle.Child = new TextBlock
        {
            Text                = entry.Icon,
            FontSize            = 16,
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment   = VerticalAlignment.Center,
            Foreground          = new SolidColorBrush(MediaColor.FromArgb(0xF2, 0xFF, 0xFF, 0xFF))
        };
        Grid.SetColumn(iconCircle, 0);
        outer.Children.Add(iconCircle);

        var textSp = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
        textSp.Children.Add(new TextBlock
        {
            Text         = entry.Name,
            FontWeight   = FontWeights.SemiBold,
            FontSize     = 13,
            Foreground   = new SolidColorBrush(MediaColor.FromArgb(0xF2, 0xFF, 0xFF, 0xFF)),
            TextTrimming = TextTrimming.CharacterEllipsis,
            MaxWidth     = 96
        });
        textSp.Children.Add(new TextBlock
        {
            Text         = entry.Subtitle,
            FontSize     = 10.5,
            Foreground   = new SolidColorBrush(MediaColor.FromArgb(0x88, 0xFF, 0xFF, 0xFF)),
            TextTrimming = TextTrimming.CharacterEllipsis,
            MaxWidth     = 96,
            Margin       = new Thickness(0, 2, 0, 0)
        });
        Grid.SetColumn(textSp, 1);
        outer.Children.Add(textSp);

        if ((entry.Source?.Pinned == true) || entry.ClickCount > 0)
        {
            var metaStack = new StackPanel
            {
                VerticalAlignment   = VerticalAlignment.Top,
                HorizontalAlignment = HorizontalAlignment.Right,
                Margin              = new Thickness(6, 0, 0, 0)
            };

            if (entry.Source?.Pinned == true)
                metaStack.Children.Add(MakePopupBadge("\U0001f4cc"));
            if (entry.ClickCount > 0)
                metaStack.Children.Add(MakePopupBadge($"{entry.ClickCount}\u00D7"));

            Grid.SetColumn(metaStack, 2);
            outer.Children.Add(metaStack);
        }

        btn.Content = outer;
        btn.Click  += Tile_Click;
        return btn;
    }

    // ====================================================
    //  Open & close
    // ====================================================
    private void Tile_Click(object sender, RoutedEventArgs e)
    {
        if (sender is not Button { Tag: Entry entry }) return;

        // Open the target
        if (entry.IsCustom && entry.Source != null)
        {
            QuickAccessPaths.Open(entry.Source);
            IncrementClickCount(entry);
        }
        else
        {
            QuickAccessPaths.OpenInExplorer(entry.Path);
        }

        SafeClose();
    }

    private void IncrementClickCount(Entry entry)
    {
        if (entry.Source == null) return;
        try
        {
            var cfg  = App.Config.Load();
            var link = cfg.QuickLinks.FirstOrDefault(x =>
                           x.Name == entry.Source.Name && x.Path == entry.Source.Path);
            if (link == null) return;
            link.ClickCount++;
            link.LastClicked = DateTime.Now;
            App.Config.Save(cfg);
        }
        catch { /* non-critical */ }
    }

    private void BtnClose_OnClick(object sender, RoutedEventArgs e) => SafeClose();

    private void OnDeactivated(object sender, EventArgs e) => SafeClose();

    private void SafeClose()
    {
        if (_closing) return;
        _closing = true;
        Close();
    }

    private static string L(string key) => LocalizationManager.Get(key);
}
