using System.Windows;
using DesktopAssistant.Services;

namespace DesktopAssistant.Views;

public partial class QuickNoteWindow : Window
{
    private readonly NoteService _notes;

    public QuickNoteWindow(NoteService notes)
    {
        _notes = notes;
        InitializeComponent();
        BodyBox.Focus();
    }

    private void Save_OnClick(object sender, RoutedEventArgs e)
    {
        try
        {
            var path = _notes.SaveQuickCapture(BodyBox.Text);
            MessageBox.Show($"已保存：\n{path}", "成功", MessageBoxButton.OK, MessageBoxImage.Information);
            DialogResult = true;
            Close();
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, "保存失败", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void Cancel_OnClick(object sender, RoutedEventArgs e)
    {
        Close();
    }
}
