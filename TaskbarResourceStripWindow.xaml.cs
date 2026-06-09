using System.Windows;

namespace DesktopAssistant;

public partial class TaskbarResourceStripWindow : Window
{
    private bool _restoringState;

    public TaskbarResourceStripWindow()
    {
        InitializeComponent();
    }

    public void UpdateDisplay(string up, string down, string cpu, string mem)
    {
        UpText.Text = $"↑ {up}";
        DownText.Text = $"↓ {down}";
        CpuText.Text = $"⚙ CPU {cpu}";
        MemText.Text = $"▦ RAM {mem}";
    }

    private void Window_OnMouseLeftButtonDown(object sender, System.Windows.Input.MouseButtonEventArgs e)
    {
        try { DragMove(); } catch { }
    }

    protected override void OnStateChanged(EventArgs e)
    {
        base.OnStateChanged(e);
        if (_restoringState || WindowState == WindowState.Normal)
            return;

        // 某些任务栏交互会把该浮条错误切到最小化；这里强制拉回。
        _restoringState = true;
        try
        {
            WindowState = WindowState.Normal;
            if (!IsVisible)
                Show();
            Topmost = false;
            Topmost = true;
        }
        finally
        {
            _restoringState = false;
        }
    }
}
