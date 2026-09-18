using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using DesktopAssistant.Services;

namespace DesktopAssistant.Views;

public partial class DanceView : UserControl
{
    public event EventHandler? PetModeChanged;

    private string _selectedAnimal = "human";

    private static readonly string[] _animalKeys =
        ["human", "cat", "dog", "rabbit", "fox", "goose", "cockroach", "mosquito", "capybara", "frog", "penguin", "turtle", "hedgehog"];

    public DanceView()
    {
        InitializeComponent();
        Loaded += (_, _) => LoadFromDisk();
        InitializeAnimalPreviews();
    }

    public void LoadFromDisk()
    {
        var cfg = DesktopAssistant.App.Config.Load();
        PetModeCheck.IsChecked = cfg.PetModeEnabled;
        PetPreventSleepCheck.IsChecked = cfg.PetPreventSleepEnabled;
        _selectedAnimal = string.IsNullOrWhiteSpace(cfg.PetAnimal) ? "human" : cfg.PetAnimal;
        UpdateAnimalCardHighlight();
        SelectPetSize(cfg.PetDisplaySize);
    }

    // ─── 宠物保存 ───

    private void SavePetBtn_OnClick(object sender, RoutedEventArgs e)
    {
        var cfg = DesktopAssistant.App.Config.Load();
        cfg.PetModeEnabled = PetModeCheck.IsChecked == true;
        cfg.PetPreventSleepEnabled = PetPreventSleepCheck.IsChecked == true;
        cfg.PetAnimal = _selectedAnimal;
        cfg.PetDisplaySize = GetSelectedPetSize();
        if (DesktopAssistant.App.Config.Save(cfg))
        {
            PetModeChanged?.Invoke(this, EventArgs.Empty);
            ShowToast("宠物设置已保存。");
        }
        else
            MessageBox.Show("保存失败。", DesktopAssistant.AppBranding.DisplayName,
                MessageBoxButton.OK, MessageBoxImage.Error);
    }

    // ─── 动物卡片点击 ───

    private void AnimalCard_Click(object sender, System.Windows.Input.MouseButtonEventArgs e)
    {
        if (sender is Border card && card.Tag is string animal)
        {
            _selectedAnimal = animal;
            UpdateAnimalCardHighlight();
        }
    }

    private void UpdateAnimalCardHighlight()
    {
        var normalBg     = TryFindResource("BrushSurfaceMuted")   as System.Windows.Media.Brush ?? System.Windows.Media.Brushes.WhiteSmoke;
        var selectedBg   = TryFindResource("BrushAccentMuted")    as System.Windows.Media.Brush ?? System.Windows.Media.Brushes.LightBlue;
        var normalBorder = TryFindResource("BrushBorderSubtle")   as System.Windows.Media.Brush ?? System.Windows.Media.Brushes.LightGray;
        var selectedBorder = TryFindResource("BrushAccent")       as System.Windows.Media.Brush ?? System.Windows.Media.Brushes.RoyalBlue;

        Border?[] cards =
        [
            AnimalCard_human,
            AnimalCard_cat,
            AnimalCard_dog,
            AnimalCard_rabbit,
            AnimalCard_fox,
            AnimalCard_goose,
            AnimalCard_cockroach,
            AnimalCard_mosquito,
            AnimalCard_capybara,
            AnimalCard_frog,
            AnimalCard_penguin,
            AnimalCard_turtle,
            AnimalCard_hedgehog,
        ];
        for (int i = 0; i < cards.Length; i++)
        {
            var card = cards[i];
            if (card == null) continue;
            bool sel = string.Equals(_animalKeys[i], _selectedAnimal, StringComparison.OrdinalIgnoreCase);
            card.Background      = sel ? selectedBg   : normalBg;
            card.BorderBrush     = sel ? selectedBorder : normalBorder;
            card.BorderThickness = sel ? new Thickness(2.5) : new Thickness(2);
        }
    }

    private void InitializeAnimalPreviews()
    {
        SetAnimalPreview(AnimalPreview_human, "human");
        SetAnimalPreview(AnimalPreview_cat, "cat");
        SetAnimalPreview(AnimalPreview_dog, "dog");
        SetAnimalPreview(AnimalPreview_rabbit, "rabbit");
        SetAnimalPreview(AnimalPreview_fox, "fox");
        SetAnimalPreview(AnimalPreview_goose, "goose");
        SetAnimalPreview(AnimalPreview_cockroach, "cockroach");
        SetAnimalPreview(AnimalPreview_mosquito, "mosquito");
        SetAnimalPreview(AnimalPreview_capybara, "capybara");
        SetAnimalPreview(AnimalPreview_frog, "frog");
        SetAnimalPreview(AnimalPreview_penguin, "penguin");
        SetAnimalPreview(AnimalPreview_turtle, "turtle");
        SetAnimalPreview(AnimalPreview_hedgehog, "hedgehog");
    }

    private static void SetAnimalPreview(System.Windows.Controls.Image image, string animal)
    {
        var renderer = new PixelPetRenderer();
        renderer.SetAnimal(animal);
        renderer.SetMood("normal");
        renderer.Stop();
        image.Source = renderer.Bitmap;
        image.Tag = renderer;
    }


    // ─── 宠物尺寸 ───

    private int GetSelectedPetSize()
    {
        if (PetSize_Small.IsChecked == true)  return 48;
        if (PetSize_Large.IsChecked == true)  return 96;
        if (PetSize_XLarge.IsChecked == true) return 128;
        return 68; // 中（默认）
    }

    private void SelectPetSize(int size)
    {
        PetSize_Small.IsChecked  = size == 48;
        PetSize_Medium.IsChecked = size == 68 || (size != 48 && size != 96 && size != 128);
        PetSize_Large.IsChecked  = size == 96;
        PetSize_XLarge.IsChecked = size == 128;
    }

    private void ShowToast(string msg) =>
        MessageBox.Show(msg, DesktopAssistant.AppBranding.DisplayName,
            MessageBoxButton.OK, MessageBoxImage.Information);
}
