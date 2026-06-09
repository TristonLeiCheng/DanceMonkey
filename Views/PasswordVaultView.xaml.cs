using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Data;
using System.Windows.Input;
using System.Windows.Threading;
using DesktopAssistant.Models;
using DesktopAssistant.Services;

namespace DesktopAssistant.Views;

public partial class PasswordVaultView : UserControl
{
    private PasswordVaultService? _service;
    private ICollectionView? _entryView;
    private string? _selectedGroupFilter;
    private DateTime _lastActivityUtc = DateTime.UtcNow;
    private readonly DispatcherTimer _idleTimer = new() { Interval = TimeSpan.FromSeconds(1) };
    private bool _suppressAutoLockEvents;

    public PasswordVaultView()
    {
        InitializeComponent();
        InitAutoLockCombo();
        _idleTimer.Tick += IdleTimer_Tick;
        Loaded += (_, _) => EnsureService();
    }

    public void OnNavigatedTo()
    {
        EnsureService();
        RefreshChrome();
    }

    private void EnsureService()
    {
        var cfg = App.Config.Load();
        var root = NoteService.ResolveRoot(cfg.NotesRootPath);
        var path = Path.Combine(root, "Journal", "password-vault.dm");
        _service = new PasswordVaultService(path);
        RefreshChrome();
    }

    private void InitAutoLockCombo()
    {
        ComboAutoLock.Items.Clear();
        void Add(string label, int minutes)
        {
            ComboAutoLock.Items.Add(new ComboBoxItem { Content = label, Tag = minutes });
        }

        Add("关闭", 0);
        Add("1 分钟", 1);
        Add("3 分钟", 3);
        Add("5 分钟", 5);
        Add("10 分钟", 10);
        Add("15 分钟", 15);
        Add("30 分钟", 30);
    }

    private void SyncAutoLockComboFromConfig()
    {
        _suppressAutoLockEvents = true;
        try
        {
            var m = App.Config.Load().PasswordVaultAutoLockMinutes;
            ComboBoxItem? best = null;
            foreach (ComboBoxItem it in ComboAutoLock.Items)
            {
                if (it.Tag is int tag && tag == m)
                {
                    best = it;
                    break;
                }
            }

            ComboAutoLock.SelectedItem = best ?? ComboAutoLock.Items.Cast<ComboBoxItem>().FirstOrDefault(i => i.Tag is int t && t == 5);
        }
        finally
        {
            _suppressAutoLockEvents = false;
        }
    }

    private void ComboAutoLock_OnSelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_suppressAutoLockEvents)
            return;
        if (ComboAutoLock.SelectedItem is not ComboBoxItem it || it.Tag is not int minutes)
            return;
        var cfg = App.Config.Load();
        cfg.PasswordVaultAutoLockMinutes = minutes;
        App.Config.Save(cfg);
        BumpActivity();
    }

    private void IdleTimer_Tick(object? sender, EventArgs e)
    {
        if (_service?.IsUnlocked != true)
            return;
        var mins = App.Config.Load().PasswordVaultAutoLockMinutes;
        if (mins <= 0)
            return;
        if ((DateTime.UtcNow - _lastActivityUtc).TotalMinutes >= mins)
        {
            _idleTimer.Stop();
            _service.Lock();
            RefreshChrome();
        }
    }

    private void BumpActivity() => _lastActivityUtc = DateTime.UtcNow;

    private void VaultPanel_OnActivity(object sender, RoutedEventArgs e) => BumpActivity();

    private void RefreshChrome()
    {
        if (_service == null)
            return;

        var exists = _service.VaultFileExists;
        var unlocked = _service.IsUnlocked;

        LblConfirm.Visibility = exists ? Visibility.Collapsed : Visibility.Visible;
        PwdConfirm.Visibility = exists ? Visibility.Collapsed : Visibility.Visible;
        BtnUnlock.Content = exists ? "解锁" : "创建密码库";
        LockTitle.Text = "密码库";
        LockSubtitle.Text = exists
            ? "输入主密码以解锁本地加密库"
            : "首次使用请设置主密码（将创建本地加密文件）";
        LockHint.Text =
            "数据文件保存在笔记目录 Journal\\password-vault.dm，使用 PBKDF2 + AES-256-GCM。请牢记主密码，丢失后无法恢复。";

        if (unlocked)
        {
            LockPanel.Visibility = Visibility.Collapsed;
            VaultPanel.Visibility = Visibility.Visible;
            SetupUnlockedView();
            SyncAutoLockComboFromConfig();
            BumpActivity();
            _idleTimer.Start();
        }
        else
        {
            _idleTimer.Stop();
            LockPanel.Visibility = Visibility.Visible;
            VaultPanel.Visibility = Visibility.Collapsed;
            PwdMaster.Password = "";
            PwdConfirm.Password = "";
        }
    }

    private void SetupUnlockedView()
    {
        if (_service == null)
            return;

        _entryView = CollectionViewSource.GetDefaultView(_service.Entries);
        _entryView.Filter = FilterEntry;
        EntriesGrid.ItemsSource = _entryView;
        RefreshGroupList();
    }

    private bool FilterEntry(object obj)
    {
        if (obj is not PasswordVaultEntry en)
            return false;
        if (_selectedGroupFilter == null)
            return true;
        return string.Equals((en.Group ?? "").Trim(), _selectedGroupFilter, StringComparison.OrdinalIgnoreCase);
    }

    private void RefreshGroupList()
    {
        if (_service == null)
            return;

        var keep = GroupListBox.SelectedItem as string;
        GroupListBox.Items.Clear();
        GroupListBox.Items.Add("（全部）");
        foreach (var g in _service.GroupNames)
            GroupListBox.Items.Add(g);

        if (keep != null && GroupListBox.Items.Contains(keep))
            GroupListBox.SelectedItem = keep;
        else
            GroupListBox.SelectedIndex = 0;

        if (GroupListBox.SelectedItem is string s && s != "（全部）")
            _selectedGroupFilter = s;
        else
            _selectedGroupFilter = null;
    }

    private void GroupListBox_OnSelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_service?.IsUnlocked != true)
            return;
        if (GroupListBox.SelectedItem is string s && s != "（全部）")
            _selectedGroupFilter = s;
        else
            _selectedGroupFilter = null;
        _entryView?.Refresh();
    }

    private void BtnUnlock_OnClick(object sender, RoutedEventArgs e)
    {
        if (_service == null)
            return;
        var owner = Window.GetWindow(this);

        try
        {
            if (_service.VaultFileExists)
            {
                _service.Unlock(PwdMaster.Password);
            }
            else
            {
                if (PwdMaster.Password != PwdConfirm.Password)
                {
                    MessageBox.Show(owner, "两次输入的主密码不一致。", "密码库", MessageBoxButton.OK, MessageBoxImage.Warning);
                    return;
                }

                if (string.IsNullOrEmpty(PwdMaster.Password))
                {
                    MessageBox.Show(owner, "请设置主密码。", "密码库", MessageBoxButton.OK, MessageBoxImage.Warning);
                    return;
                }

                _service.CreateVault(PwdMaster.Password);
            }

            RefreshChrome();
        }
        catch (UnauthorizedAccessException ex)
        {
            MessageBox.Show(owner, ex.Message, "密码库", MessageBoxButton.OK, MessageBoxImage.Error);
        }
        catch (Exception ex)
        {
            MessageBox.Show(owner, ex.Message, "密码库", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void BtnLock_OnClick(object sender, RoutedEventArgs e)
    {
        _service?.Lock();
        RefreshChrome();
    }

    private void BtnAdd_OnClick(object sender, RoutedEventArgs e)
    {
        if (_service == null || !_service.IsUnlocked)
            return;
        var owner = Window.GetWindow(this);
        var def = _selectedGroupFilter ?? _service.GroupNames.FirstOrDefault() ?? PasswordVaultService.DefaultGroupName;
        var dlg = new PasswordEntryEditWindow(null, _service.GroupNames.ToList(), def) { Owner = owner };
        if (dlg.ShowDialog() != true || dlg.Result == null)
            return;
        _service.AddOrUpdate(dlg.Result);
        try
        {
            _service.Save();
        }
        catch (Exception ex)
        {
            MessageBox.Show(owner, $"保存失败：{ex.Message}", "密码库", MessageBoxButton.OK, MessageBoxImage.Error);
            return;
        }

        RefreshGroupList();
        _entryView?.Refresh();
    }

    private void BtnEdit_OnClick(object sender, RoutedEventArgs e) => EditSelected();

    private void EntriesGrid_OnMouseDoubleClick(object sender, MouseButtonEventArgs e) => EditSelected();

    private void EditSelected()
    {
        if (_service == null || !_service.IsUnlocked)
            return;
        if (EntriesGrid.SelectedItem is not PasswordVaultEntry entry)
            return;
        var owner = Window.GetWindow(this);
        var copy = new PasswordVaultEntry
        {
            Id = entry.Id,
            Title = entry.Title,
            SystemName = entry.SystemName,
            SystemLevel = entry.SystemLevel,
            Username = entry.Username,
            Password = entry.Password,
            Url = entry.Url,
            Notes = entry.Notes,
            Group = entry.Group
        };
        var dlg = new PasswordEntryEditWindow(copy, _service.GroupNames.ToList(), copy.Group) { Owner = owner };
        if (dlg.ShowDialog() != true || dlg.Result == null)
            return;
        _service.AddOrUpdate(dlg.Result);
        try
        {
            _service.Save();
        }
        catch (Exception ex)
        {
            MessageBox.Show(owner, $"保存失败：{ex.Message}", "密码库", MessageBoxButton.OK, MessageBoxImage.Error);
            return;
        }

        RefreshGroupList();
        _entryView?.Refresh();
    }

    private void BtnDelete_OnClick(object sender, RoutedEventArgs e)
    {
        if (_service == null || !_service.IsUnlocked)
            return;
        if (EntriesGrid.SelectedItem is not PasswordVaultEntry entry)
            return;
        var owner = Window.GetWindow(this);
        if (MessageBox.Show(owner, $"删除「{entry.Title}」？", "确认", MessageBoxButton.YesNo, MessageBoxImage.Question) !=
            MessageBoxResult.Yes)
            return;
        _service.Remove(entry.Id);
        try
        {
            _service.Save();
        }
        catch (Exception ex)
        {
            MessageBox.Show(owner, $"保存失败：{ex.Message}", "密码库", MessageBoxButton.OK, MessageBoxImage.Error);
        }

        _entryView?.Refresh();
    }

    private void BtnCopy_OnClick(object sender, RoutedEventArgs e)
    {
        if (EntriesGrid.SelectedItem is not PasswordVaultEntry entry)
            return;
        try
        {
            Clipboard.SetText(entry.Password ?? "");
        }
        catch
        {
            /* ignore */
        }

        BumpActivity();
    }

    private void BtnChangeMaster_OnClick(object sender, RoutedEventArgs e)
    {
        if (_service == null || !_service.IsUnlocked)
            return;
        var owner = Window.GetWindow(this);
        var dlg = new ChangeMasterPasswordWindow { Owner = owner };
        if (dlg.ShowDialog() != true || dlg.OldPassword == null || dlg.NewPassword == null)
            return;
        try
        {
            _service.ChangeMasterPassword(dlg.OldPassword, dlg.NewPassword);
            MessageBox.Show(owner, "主密码已更新。", "密码库", MessageBoxButton.OK, MessageBoxImage.Information);
        }
        catch (Exception ex)
        {
            MessageBox.Show(owner, ex.Message, "密码库", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void BtnNewGroup_OnClick(object sender, RoutedEventArgs e)
    {
        if (_service == null || !_service.IsUnlocked)
            return;
        var owner = Window.GetWindow(this);
        var dlg = new PromptDialog("新建分组", "分组名称", "") { Owner = owner };
        if (dlg.ShowDialog() != true)
            return;
        try
        {
            _service.AddGroup(dlg.ResultText?.Trim() ?? "");
            RefreshGroupList();
            _entryView?.Refresh();
        }
        catch (Exception ex)
        {
            MessageBox.Show(owner, ex.Message, "密码库", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void BtnRenameGroup_OnClick(object sender, RoutedEventArgs e)
    {
        if (_service == null || !_service.IsUnlocked)
            return;
        if (GroupListBox.SelectedItem is not string sel || sel == "（全部）")
        {
            MessageBox.Show(Window.GetWindow(this), "请先选择一个分组（不能是「全部」）。", "密码库", MessageBoxButton.OK,
                MessageBoxImage.Information);
            return;
        }

        var owner = Window.GetWindow(this);
        var dlg = new PromptDialog("重命名分组", "新名称", sel) { Owner = owner };
        if (dlg.ShowDialog() != true)
            return;
        try
        {
            _service.RenameGroup(sel, dlg.ResultText?.Trim() ?? "");
            RefreshGroupList();
            _entryView?.Refresh();
        }
        catch (Exception ex)
        {
            MessageBox.Show(owner, ex.Message, "密码库", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void BtnDeleteGroup_OnClick(object sender, RoutedEventArgs e)
    {
        if (_service == null || !_service.IsUnlocked)
            return;
        if (GroupListBox.SelectedItem is not string sel || sel == "（全部）")
        {
            MessageBox.Show(Window.GetWindow(this), "请先选择一个要删除的分组。", "密码库", MessageBoxButton.OK,
                MessageBoxImage.Information);
            return;
        }

        var owner = Window.GetWindow(this);
        if (MessageBox.Show(owner,
                $"删除分组「{sel}」？其中的条目将移到其他分组。",
                "确认",
                MessageBoxButton.YesNo,
                MessageBoxImage.Question) != MessageBoxResult.Yes)
            return;
        try
        {
            _service.RemoveGroup(sel);
            RefreshGroupList();
            _entryView?.Refresh();
        }
        catch (Exception ex)
        {
            MessageBox.Show(owner, ex.Message, "密码库", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }
}
