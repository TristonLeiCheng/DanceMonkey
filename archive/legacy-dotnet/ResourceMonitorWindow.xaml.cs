using System.Windows;

namespace DesktopAssistant;

public partial class ResourceMonitorWindow : Window
{
    private bool _miniMode;

    public ResourceMonitorWindow()
    {
        InitializeComponent();
    }

    public void UpdateSnapshot(double cpu, double mem, double disk, string netText)
    {
        CpuText.Text = $"CPU: {cpu:F0}%";
        MemText.Text = $"内存: {mem:F0}%";
        DiskText.Text = $"磁盘: {disk:F0}%";
        NetText.Text = netText;
        CpuBar.Value = cpu;
        MemBar.Value = mem;
        DiskBar.Value = disk;
    }

    public void SetMiniMode(bool miniMode)
    {
        _miniMode = miniMode;
        Width = _miniMode ? 250 : 330;
        Height = _miniMode ? 150 : 250;
        TitleText.Visibility = _miniMode ? Visibility.Collapsed : Visibility.Visible;
        CpuBar.Visibility = _miniMode ? Visibility.Collapsed : Visibility.Visible;
        MemBar.Visibility = _miniMode ? Visibility.Collapsed : Visibility.Visible;
        DiskBar.Visibility = _miniMode ? Visibility.Collapsed : Visibility.Visible;
    }

    private void Window_OnMouseLeftButtonDown(object sender, System.Windows.Input.MouseButtonEventArgs e)
    {
        try { DragMove(); } catch { }
    }
}
