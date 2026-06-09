using System.Windows;

namespace DesktopAssistant.Views;

public partial class PromptDialog : Window
{
    public string? ResultText { get; private set; }

    public PromptDialog(string title, string label, string defaultValue = "")
    {
        InitializeComponent();
        Title = title;
        LabelText.Text = label;
        InputBox.Text = defaultValue;
    }

    private void Ok_OnClick(object sender, RoutedEventArgs e)
    {
        ResultText = InputBox.Text;
        DialogResult = true;
        Close();
    }

    private void Cancel_OnClick(object sender, RoutedEventArgs e)
    {
        DialogResult = false;
        Close();
    }
}
