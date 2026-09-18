using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using DesktopAssistant.Models;
using DesktopAssistant.Services;
using MediaBrush = System.Windows.Media.Brush;
using MediaBrushes = System.Windows.Media.Brushes;
using MediaColor = System.Windows.Media.Color;

namespace DesktopAssistant.Views;

public partial class QuickAccessView : UserControl
{
    public event Action<string, string>? CreateFolderSyncRequested;

    // ===================================================
    //  Inner entry model (unifies auto-detected + custom)
    // ===================================================
    private sealed class Entry
    {
        public string        Name        { get; init; } = "";
        public string        Path        { get; init; } = "";
        public string        Category    { get; init; } = "local";
        public string        Description { get; init; } = "";
        public string        Group       { get; init; } = "";
        public int           ClickCount  { get; set;  } = 0;
        public bool          IsCustom    { get; init; } = false;
        public bool          Pinned      { get; set;  } = false;
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

    // Tab definitions
    private static readonly (string Key, string LangKey)[] TabDefs =
    {
        ("all",        "QuickAccess.TabAll"),
        ("freq",       "QuickAccess.TabFreq"),
        ("local",      "QuickAccess.TabLocal"),
        ("network",    "QuickAccess.TabNetwork"),
        ("onedrive",   "QuickAccess.TabOneDrive"),
        ("sharepoint", "QuickAccess.TabSharePoint"),
        ("web",        "QuickAccess.TabWeb"),
    };

    // State
    private string      _activeTab  = "all";
    private string      _sortMode   = "freq";
    private string      _search     = "";
    private List<Entry> _allEntries = new();
    private bool        _loaded     = false;

    // ====================================================
    //  Construction
    // ====================================================
    public QuickAccessView()
    {
        InitializeComponent();
        BuildTabs();
        Loaded += (_, _) =>
        {
            _loaded = true;
            SearchPlaceholder.Visibility = Visibility.Visible;
            Refresh();
        };
    }

    public void RefreshFromConfig() => Refresh();

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
                Tag       = key,
                IsChecked = first,
                GroupName = "QuickAccessTabs",
                Style     = (Style)FindResource("NavTabRadio"),
                Margin    = new Thickness(2, 0, 2, 0)
            };
            rb.Checked += Tab_Checked;
            TabStrip.Children.Add(rb);
            first = false;
        }
    }

    private void Tab_Checked(object sender, RoutedEventArgs e)
    {
        if (!_loaded) return;
        if (sender is not RadioButton { Tag: string key }) return;

        _activeTab = key;
        RebuildContent();
    }

    // ====================================================
    //  Data loading
    // ====================================================
    private void Refresh()
    {
        LoadEntries();
        RebuildContent();
    }

    private void LoadEntries()
    {
        _allEntries = new List<Entry>();

        foreach (var (name, path, _) in QuickAccessPaths.DetectLocalFolders())
            _allEntries.Add(new Entry { Name = name, Path = path, Category = "local" });

        foreach (var (name, path, _) in QuickAccessPaths.DetectOneDriveFolders())
            _allEntries.Add(new Entry { Name = name, Path = path, Category = "onedrive" });

        foreach (var (name, path, _) in QuickAccessPaths.DetectNetworkDrives())
            _allEntries.Add(new Entry { Name = name, Path = path, Category = "network" });

        var cfg = App.Config.Load();
        foreach (var link in cfg.QuickLinks)
        {
            _allEntries.Add(new Entry
            {
                Name        = link.Name,
                Path        = link.Path,
                Category    = link.Category,
                Description = link.Description,
                Group       = link.Group,
                ClickCount  = link.ClickCount,
                Pinned      = link.Pinned,
                IsCustom    = true,
                Source      = link
            });
        }
    }

    // ====================================================
    //  Search & sort events
    // ====================================================
    private void Search_TextChanged(object sender, TextChangedEventArgs e)
    {
        _search = SearchBox.Text;
        SearchPlaceholder.Visibility =
            string.IsNullOrEmpty(_search) ? Visibility.Visible : Visibility.Collapsed;
        if (_loaded) RebuildContent();
    }

    private void Sort_Changed(object sender, SelectionChangedEventArgs e)
    {
        _sortMode = (SortCombo.SelectedItem as ComboBoxItem)?.Tag as string ?? "freq";
        if (_loaded) RebuildContent();
    }

    // ====================================================
    //  Filter & sort helpers
    // ====================================================
    private List<Entry> FilterEntries()
    {
        IEnumerable<Entry> q = _allEntries;

        q = _activeTab switch
        {
            "all"  => q,
            "freq" => q.Where(e => e.ClickCount > 0),
            _      => q.Where(e => e.Category == _activeTab)
        };

        if (!string.IsNullOrWhiteSpace(_search))
        {
            var s = _search.Trim();
            q = q.Where(e =>
                e.Name.Contains(s, StringComparison.OrdinalIgnoreCase) ||
                e.Path.Contains(s, StringComparison.OrdinalIgnoreCase) ||
                e.Description.Contains(s, StringComparison.OrdinalIgnoreCase) ||
                e.Group.Contains(s, StringComparison.OrdinalIgnoreCase));
        }

        return q.ToList();
    }

    private List<Entry> SortEntries(List<Entry> entries) => _sortMode switch
    {
        "name"   => entries.OrderBy(e => !e.Pinned).ThenBy(e => e.Name).ToList(),
        "recent" => entries.OrderBy(e => !e.Pinned)
                           .ThenByDescending(e => e.Source?.LastClicked ?? DateTime.MinValue)
                           .ThenBy(e => e.Name).ToList(),
        _        => entries.OrderBy(e => !e.Pinned)
                           .ThenByDescending(e => e.ClickCount)
                           .ThenBy(e => e.Name).ToList()
    };

    // ====================================================
    //  Content area rebuild
    // ====================================================
    private void RebuildContent()
    {
        ContentPanel.Children.Clear();
        var filtered = FilterEntries();

        if (_activeTab == "all" && string.IsNullOrEmpty(_search))
            BuildAllTabContent(filtered);
        else if (_activeTab == "freq")
            BuildFreqTabContent(filtered);
        else
            BuildCategoryContent(filtered);
    }

    private void BuildAllTabContent(List<Entry> all)
    {
        // Top-8 frequent
        var frequent = all.Where(e => e.ClickCount > 0)
                          .OrderByDescending(e => e.ClickCount).Take(8).ToList();
        if (frequent.Count > 0)
            AddSection(L("QuickAccess.SectionFreq"), frequent, showBadge: true);

        // Per-category sections
        var cats = new[]
        {
            ("local",      L("QuickAccess.LocalFolders")),
            ("onedrive",   L("QuickAccess.OneDrive")),
            ("network",    L("QuickAccess.NetworkDrives")),
            ("sharepoint", L("QuickAccess.TabSharePoint")),
            ("web",        L("QuickAccess.TabWeb")),
        };
        foreach (var (cat, label) in cats)
        {
            var items = SortEntries(all.Where(e => e.Category == cat).ToList());
            if (items.Count > 0)
                AddSection(label, items, showBadge: false);
        }

        if (all.Count == 0)
            AddEmptyHint(L("QuickAccess.NoItems"));
    }

    private void BuildFreqTabContent(List<Entry> entries)
    {
        if (entries.Count == 0) { AddEmptyHint(L("QuickAccess.NoFreqItems")); return; }

        var sorted = entries.OrderBy(e => !e.Pinned)
                            .ThenByDescending(e => e.ClickCount)
                            .ThenBy(e => e.Name).ToList();
        AddSection(null, sorted, showBadge: true);
    }

    private void BuildCategoryContent(List<Entry> entries)
    {
        if (entries.Count == 0) { AddEmptyHint(L("QuickAccess.NoItems")); return; }

        var noGroup   = SortEntries(entries.Where(e => string.IsNullOrEmpty(e.Group)).ToList());
        var withGroup = entries.Where(e => !string.IsNullOrEmpty(e.Group))
                               .GroupBy(e => e.Group).OrderBy(g => g.Key);

        if (noGroup.Count > 0)
            AddSection(null, noGroup, showBadge: false);

        foreach (var grp in withGroup)
            AddSection("\U0001f4c2 " + grp.Key, SortEntries(grp.ToList()), showBadge: false);
    }

    // ====================================================
    //  Section builder
    // ====================================================
    private void AddSection(string? header, List<Entry> entries, bool showBadge)
    {
        var section = new StackPanel { Margin = new Thickness(0, 0, 0, 18) };

        if (header != null)
            section.Children.Add(new TextBlock
            {
                Text   = header,
                Style  = (Style)FindResource("UiSectionTitle"),
                Margin = new Thickness(2, 0, 0, 8)
            });

        var wrap = new WrapPanel { Orientation = Orientation.Horizontal };
        foreach (var entry in entries)
            wrap.Children.Add(MakeTile(entry, showBadge));

        section.Children.Add(wrap);
        ContentPanel.Children.Add(section);
    }

    private void AddEmptyHint(string text) =>
        ContentPanel.Children.Add(new TextBlock
        {
            Text   = text,
            Style  = (Style)FindResource("UiHint"),
            Margin = new Thickness(4, 20, 0, 0)
        });

    // ====================================================
    //  Tile factory
    // ====================================================

    private static MediaBrush GetCategoryCardBg(string category) => category switch
    {
        "network"    => new SolidColorBrush(MediaColor.FromRgb(0xF4, 0xF8, 0xFF)),
        "onedrive"   => new SolidColorBrush(MediaColor.FromRgb(0xF1, 0xF7, 0xFF)),
        "sharepoint" => new SolidColorBrush(MediaColor.FromRgb(0xF0, 0xFC, 0xFC)),
        "web"        => new SolidColorBrush(MediaColor.FromRgb(0xF3, 0xFB, 0xF2)),
        _            => new SolidColorBrush(MediaColor.FromRgb(0xFF, 0xF8, 0xEF)),
    };

    private static MediaBrush GetCategoryCardBorder(string category) => category switch
    {
        "network"    => new SolidColorBrush(MediaColor.FromRgb(0xD7, 0xE6, 0xFF)),
        "onedrive"   => new SolidColorBrush(MediaColor.FromRgb(0xD4, 0xE8, 0xFF)),
        "sharepoint" => new SolidColorBrush(MediaColor.FromRgb(0xC9, 0xEE, 0xEE)),
        "web"        => new SolidColorBrush(MediaColor.FromRgb(0xD7, 0xEF, 0xD4)),
        _            => new SolidColorBrush(MediaColor.FromRgb(0xF3, 0xE1, 0xC7)),
    };

    private static MediaBrush GetCategoryIconBg(string category) => category switch
    {
        "network"    => new SolidColorBrush(MediaColor.FromArgb(0x24, 0x29, 0x6A, 0xBF)),
        "onedrive"   => new SolidColorBrush(MediaColor.FromArgb(0x24, 0x06, 0x78, 0xD4)),
        "sharepoint" => new SolidColorBrush(MediaColor.FromArgb(0x24, 0x03, 0x8C, 0x8C)),
        "web"        => new SolidColorBrush(MediaColor.FromArgb(0x24, 0x10, 0x7C, 0x10)),
        _            => new SolidColorBrush(MediaColor.FromArgb(0x26, 0xA0, 0x72, 0x30)),
    };

    private static MediaBrush GetCategoryIconFg(string category) => category switch
    {
        "network"    => new SolidColorBrush(MediaColor.FromRgb(0x29, 0x6A, 0xBF)),
        "onedrive"   => new SolidColorBrush(MediaColor.FromRgb(0x06, 0x78, 0xD4)),
        "sharepoint" => new SolidColorBrush(MediaColor.FromRgb(0x03, 0x8C, 0x8C)),
        "web"        => new SolidColorBrush(MediaColor.FromRgb(0x10, 0x7C, 0x10)),
        _            => new SolidColorBrush(MediaColor.FromRgb(0xA0, 0x72, 0x30)),
    };

    private static Border MakeBadge(string text, MediaBrush foreground, MediaBrush background) => new()
    {
        Background   = background,
        CornerRadius = new CornerRadius(999),
        Padding      = new Thickness(7, 2, 7, 2),
        Margin       = new Thickness(0, 0, 0, 5),
        Child        = new TextBlock
        {
            Text              = text,
            FontSize          = 10,
            FontWeight        = FontWeights.SemiBold,
            Foreground        = foreground,
            VerticalAlignment = VerticalAlignment.Center
        }
    };

    private Button MakeTile(Entry entry, bool showBadge)
    {
        var btn = new Button
        {
            Width       = 244,
            MinHeight   = 84,
            Margin      = new Thickness(0, 0, 12, 12),
            Background  = GetCategoryCardBg(entry.Category),
            BorderBrush = GetCategoryCardBorder(entry.Category),
            Style       = (Style)FindResource("TileButton"),
            Tag         = entry,
            ToolTip     = entry.Path
        };

        var outer = new Grid();
        outer.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        outer.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        outer.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

        var iconCircle = new Border
        {
            Width             = 42,
            Height            = 42,
            CornerRadius      = new CornerRadius(14),
            Background        = GetCategoryIconBg(entry.Category),
            VerticalAlignment = VerticalAlignment.Center,
            Margin            = new Thickness(0, 0, 12, 0)
        };
        iconCircle.Child = new TextBlock
        {
            Text                = entry.Icon,
            FontSize            = 19,
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment   = VerticalAlignment.Center,
            Foreground          = GetCategoryIconFg(entry.Category)
        };
        Grid.SetColumn(iconCircle, 0);
        outer.Children.Add(iconCircle);

        var textStack = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
        textStack.Children.Add(new TextBlock
        {
            Text         = entry.Name,
            FontWeight   = FontWeights.SemiBold,
            FontSize     = 13.5,
            Foreground   = (MediaBrush)FindResource("BrushTextPrimary"),
            TextTrimming = TextTrimming.CharacterEllipsis,
            MaxWidth     = 154
        });
        textStack.Children.Add(new TextBlock
        {
            Text         = entry.Subtitle,
            Style        = (Style)FindResource("UiHint"),
            TextTrimming = TextTrimming.CharacterEllipsis,
            MaxWidth     = 154,
            Margin       = new Thickness(0, 3, 0, 0)
        });
        Grid.SetColumn(textStack, 1);
        outer.Children.Add(textStack);

        if (entry.Pinned || (showBadge && entry.ClickCount > 0))
        {
            var metaStack = new StackPanel
            {
                HorizontalAlignment = HorizontalAlignment.Right,
                VerticalAlignment   = VerticalAlignment.Top,
                Margin              = new Thickness(8, 0, 0, 0)
            };

            if (entry.Pinned)
            {
                metaStack.Children.Add(MakeBadge("\U0001f4cc",
                    (MediaBrush)FindResource("BrushAccent"),
                    new SolidColorBrush(MediaColor.FromArgb(0x16, 0x4F, 0x6E, 0xF7))));
            }

            if (showBadge && entry.ClickCount > 0)
            {
                metaStack.Children.Add(MakeBadge($"{entry.ClickCount}\u00D7",
                    (MediaBrush)FindResource("BrushAccent"),
                    new SolidColorBrush(MediaColor.FromArgb(0x18, 0x4F, 0x6E, 0xF7))));
            }

            Grid.SetColumn(metaStack, 2);
            outer.Children.Add(metaStack);
        }

        btn.Content = outer;

        if (entry.IsCustom || entry.Category is "local" or "network" or "onedrive")
        {
            var ctx = new ContextMenu();

            if (entry.Category is "local" or "network" or "onedrive")
            {
                var syncItem = new MenuItem { Header = "创建文件夹同步任务" };
                syncItem.Click += (_, _) => CreateFolderSyncRequested?.Invoke(entry.Path, entry.Name);
                ctx.Items.Add(syncItem);
            }

            if (entry.IsCustom)
            {
                if (ctx.Items.Count > 0)
                    ctx.Items.Add(new Separator());

                var editItem = new MenuItem { Header = L("QuickAccess.CtxEdit") };
                editItem.Click += (_, _) => EditEntry(entry);
                ctx.Items.Add(editItem);

                var pinItem = new MenuItem
                {
                    Header = entry.Pinned ? L("QuickAccess.CtxUnpin") : L("QuickAccess.CtxPin")
                };
                pinItem.Click += (_, _) => TogglePin(entry);
                ctx.Items.Add(pinItem);

                ctx.Items.Add(new Separator());

                var deleteItem = new MenuItem
                {
                    Header     = L("QuickAccess.CtxDelete"),
                    Foreground = MediaBrushes.Crimson
                };
                deleteItem.Click += (_, _) => DeleteEntry(entry);
                ctx.Items.Add(deleteItem);
            }

            btn.ContextMenu = ctx;
        }

        btn.Click += (_, _) => OpenEntry(entry);
        return btn;
    }

    // ====================================================
    //  Entry operations
    // ====================================================
    private void OpenEntry(Entry entry)
    {
        if (entry.IsCustom && entry.Source != null)
        {
            QuickAccessPaths.Open(entry.Source);
            IncrementClickCount(entry);
        }
        else
        {
            QuickAccessPaths.OpenInExplorer(entry.Path);
        }
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
            link.LastClicked       = DateTime.Now;
            App.Config.Save(cfg);
            entry.ClickCount       = link.ClickCount;
            entry.Source.ClickCount  = link.ClickCount;
            entry.Source.LastClicked = link.LastClicked;
        }
        catch { /* silent â€“ click tracking is non-critical */ }
    }

    private void EditEntry(Entry entry)
    {
        if (entry.Source == null) return;
        try
        {
            var owner = Window.GetWindow(this);
            var dlg   = new QuickLinkAddDialog(entry.Source);
            if (owner is { IsVisible: true }) dlg.Owner = owner;

            if (dlg.ShowDialog() == true && dlg.Result != null)
            {
                var cfg = App.Config.Load();
                var idx = cfg.QuickLinks.IndexOf(entry.Source);
                if (idx >= 0)
                {
                    dlg.Result.ClickCount  = entry.Source.ClickCount;
                    dlg.Result.LastClicked = entry.Source.LastClicked;
                    dlg.Result.Pinned      = entry.Source.Pinned;
                    cfg.QuickLinks[idx]    = dlg.Result;
                    App.Config.Save(cfg);
                    Refresh();
                }
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show($"ç¼–è¾‘å¤±è´¥ï¼š{ex.Message}", AppBranding.DisplayName,
                MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void TogglePin(Entry entry)
    {
        if (entry.Source == null) return;
        try
        {
            var cfg  = App.Config.Load();
            var link = cfg.QuickLinks.FirstOrDefault(x =>
                           x.Name == entry.Source.Name && x.Path == entry.Source.Path);
            if (link == null) return;
            link.Pinned = !link.Pinned;
            App.Config.Save(cfg);
            Refresh();
        }
        catch { }
    }

    private void DeleteEntry(Entry entry)
    {
        if (entry.Source == null) return;
        var result = MessageBox.Show(
            string.Format(L("QuickAccess.DeleteConfirm"), entry.Name),
            AppBranding.DisplayName, MessageBoxButton.YesNo, MessageBoxImage.Question);
        if (result != MessageBoxResult.Yes) return;
        try
        {
            var cfg = App.Config.Load();
            cfg.QuickLinks.Remove(entry.Source);
            App.Config.Save(cfg);
            Refresh();
        }
        catch (Exception ex)
        {
            MessageBox.Show($"åˆ é™¤å¤±è´¥ï¼š{ex.Message}", AppBranding.DisplayName,
                MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    // ====================================================
    //  Button event handlers
    // ====================================================
    private void RefreshLinks_OnClick(object sender, RoutedEventArgs e) => Refresh();

    private void AddLink_OnClick(object sender, RoutedEventArgs e)
    {
        try
        {
            var owner = Window.GetWindow(this);
            var dlg   = new QuickLinkAddDialog();
            if (owner is { IsVisible: true }) dlg.Owner = owner;

            if (dlg.ShowDialog() == true && dlg.Result != null)
            {
                var cfg = App.Config.Load();
                cfg.QuickLinks ??= new List<QuickLinkItem>();
                cfg.QuickLinks.Add(dlg.Result);

                if (!App.Config.Save(cfg))
                {
                    MessageBox.Show(L("QuickAccess.SaveFailed"), AppBranding.DisplayName,
                        MessageBoxButton.OK, MessageBoxImage.Warning);
                    return;
                }
                Refresh();
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show($"æ‰“å¼€\"æ·»åŠ å¿«æ·æ–¹å¼\"å¤±è´¥ï¼š{ex.Message}", AppBranding.DisplayName,
                MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private static string L(string key) => LocalizationManager.Get(key);

}
