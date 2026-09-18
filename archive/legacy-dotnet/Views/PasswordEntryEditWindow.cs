using System.Collections.Generic;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using DesktopAssistant.Models;
using DesktopAssistant.Services;

namespace DesktopAssistant.Views;

/// <summary>添加/编辑单条密码条目。</summary>
public sealed class PasswordEntryEditWindow : Window
{
    private readonly TextBox _title = new() { Margin = new Thickness(0, 0, 0, 8) };
    private readonly TextBox _systemName = new() { Margin = new Thickness(0, 0, 0, 8) };
    private readonly ComboBox _systemLevel = new() { Margin = new Thickness(0, 0, 0, 8) };
    private readonly ComboBox _group = new() { IsEditable = true, Margin = new Thickness(0, 0, 0, 8) };
    private readonly TextBox _user = new() { Margin = new Thickness(0, 0, 0, 8) };
    private readonly PasswordBox _pwd = new() { Margin = new Thickness(0, 0, 0, 8) };
    private readonly TextBox _url = new() { Margin = new Thickness(0, 0, 0, 8) };
    private readonly TextBox _notes = new() { Height = 80, TextWrapping = TextWrapping.Wrap, AcceptsReturn = true, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };

    public PasswordVaultEntry? Result { get; private set; }

    public PasswordEntryEditWindow(PasswordVaultEntry? existing, IReadOnlyList<string> groupNames, string? defaultGroupForNew)
    {
        Title = existing == null ? "新建条目" : "编辑条目";
        Width = 460;
        MinHeight = 500;
        SizeToContent = SizeToContent.Height;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        Background = System.Windows.Media.Brushes.White;

        _systemLevel.Items.Add(new ComboBoxItem { Content = "（未指定）", Tag = "" });
        foreach (var lv in new[] { "P", "Q", "D" })
            _systemLevel.Items.Add(new ComboBoxItem { Content = $"{lv}（{(lv == "P" ? "生产" : lv == "Q" ? "预发" : "开发")}）", Tag = lv });

        foreach (var g in groupNames.Distinct(StringComparer.OrdinalIgnoreCase).OrderBy(x => x, StringComparer.OrdinalIgnoreCase))
            _group.Items.Add(g);

        if (existing != null)
        {
            _title.Text = existing.Title;
            _systemName.Text = existing.SystemName;
            _user.Text = existing.Username;
            _pwd.Password = existing.Password;
            _url.Text = existing.Url;
            _notes.Text = existing.Notes;
            _group.Text = string.IsNullOrWhiteSpace(existing.Group) ? PasswordVaultService.DefaultGroupName : existing.Group;
            SelectSystemLevel(existing.SystemLevel);
        }
        else
        {
            var dg = string.IsNullOrWhiteSpace(defaultGroupForNew) ? PasswordVaultService.DefaultGroupName : defaultGroupForNew.Trim();
            _group.Text = dg;
            _systemLevel.SelectedIndex = 0;
        }

        var root = new StackPanel { Margin = new Thickness(20) };
        root.Children.Add(Lbl("标题"));
        root.Children.Add(_title);
        root.Children.Add(Lbl("系统名称"));
        root.Children.Add(_systemName);
        root.Children.Add(Lbl("系统级别（P=生产 Q=预发 D=开发）"));
        root.Children.Add(_systemLevel);
        root.Children.Add(Lbl("分组"));
        root.Children.Add(_group);
        root.Children.Add(Lbl("用户名"));
        root.Children.Add(_user);
        root.Children.Add(Lbl("密码"));
        root.Children.Add(_pwd);
        root.Children.Add(Lbl("网址"));
        root.Children.Add(_url);
        root.Children.Add(Lbl("备注"));
        root.Children.Add(_notes);

        var btns = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 16, 0, 0) };
        var ok = new Button { Content = "确定", Width = 100, Padding = new Thickness(16, 8, 16, 8) };
        var cancel = new Button { Content = "取消", Width = 100, Margin = new Thickness(8, 0, 0, 0), Padding = new Thickness(16, 8, 16, 8) };
        ok.Click += (_, _) =>
        {
            var id = existing?.Id ?? Guid.NewGuid().ToString("N");
            var grp = string.IsNullOrWhiteSpace(_group.Text) ? PasswordVaultService.DefaultGroupName : _group.Text.Trim();
            var levelRaw = _systemLevel.SelectedItem is ComboBoxItem cbi && cbi.Tag is string tag ? tag : "";
            var level = PasswordVaultEntry.NormalizeSystemLevel(levelRaw);

            Result = new PasswordVaultEntry
            {
                Id = id,
                Title = _title.Text.Trim(),
                SystemName = _systemName.Text.Trim(),
                SystemLevel = level,
                Group = grp,
                Username = _user.Text.Trim(),
                Password = _pwd.Password,
                Url = _url.Text.Trim(),
                Notes = _notes.Text.Trim()
            };
            if (string.IsNullOrEmpty(Result.Title))
            {
                MessageBox.Show("请填写标题。", Title, MessageBoxButton.OK, MessageBoxImage.Information);
                return;
            }

            DialogResult = true;
            Close();
        };
        cancel.Click += (_, _) => { DialogResult = false; Close(); };
        btns.Children.Add(ok);
        btns.Children.Add(cancel);
        root.Children.Add(btns);

        Content = root;
    }

    private void SelectSystemLevel(string? raw)
    {
        var n = PasswordVaultEntry.NormalizeSystemLevel(raw);
        foreach (ComboBoxItem item in _systemLevel.Items)
        {
            if (item.Tag is string s && s == n)
            {
                _systemLevel.SelectedItem = item;
                return;
            }
        }

        _systemLevel.SelectedIndex = 0;
    }

    private static TextBlock Lbl(string text) =>
        new() { Text = text, FontSize = 11, Foreground = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(0x6B, 0x70, 0x84)), Margin = new Thickness(0, 0, 0, 4) };
}
