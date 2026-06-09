using System.Windows;
using System.Windows.Controls;

namespace DesktopAssistant.Views;

public sealed class ChangeMasterPasswordWindow : Window
{
    private readonly PasswordBox _old = new() { Margin = new Thickness(0, 0, 0, 10) };
    private readonly PasswordBox _new1 = new() { Margin = new Thickness(0, 0, 0, 10) };
    private readonly PasswordBox _new2 = new() { Margin = new Thickness(0, 0, 0, 10) };

    public string? OldPassword { get; private set; }
    public string? NewPassword { get; private set; }

    public ChangeMasterPasswordWindow()
    {
        Title = "更改主密码";
        Width = 400;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        Background = System.Windows.Media.Brushes.White;

        var root = new StackPanel { Margin = new Thickness(20) };
        root.Children.Add(new TextBlock { Text = "当前主密码", FontSize = 11, Margin = new Thickness(0, 0, 0, 4) });
        root.Children.Add(_old);
        root.Children.Add(new TextBlock { Text = "新主密码", FontSize = 11, Margin = new Thickness(0, 0, 0, 4) });
        root.Children.Add(_new1);
        root.Children.Add(new TextBlock { Text = "确认新主密码", FontSize = 11, Margin = new Thickness(0, 0, 0, 4) });
        root.Children.Add(_new2);

        var row = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 16, 0, 0) };
        var ok = new Button { Content = "确定", Width = 96, Padding = new Thickness(12, 8, 12, 8), Margin = new Thickness(0, 0, 8, 0) };
        var cancel = new Button { Content = "取消", Width = 96, Padding = new Thickness(12, 8, 12, 8) };
        ok.Click += (_, _) =>
        {
            if (_new1.Password != _new2.Password)
            {
                MessageBox.Show("两次输入的新主密码不一致。", Title, MessageBoxButton.OK, MessageBoxImage.Warning);
                return;
            }

            if (string.IsNullOrEmpty(_new1.Password))
            {
                MessageBox.Show("新主密码不能为空。", Title, MessageBoxButton.OK, MessageBoxImage.Warning);
                return;
            }

            OldPassword = _old.Password;
            NewPassword = _new1.Password;
            DialogResult = true;
            Close();
        };
        cancel.Click += (_, _) => { DialogResult = false; Close(); };
        row.Children.Add(ok);
        row.Children.Add(cancel);
        root.Children.Add(row);
        Content = root;
    }
}
