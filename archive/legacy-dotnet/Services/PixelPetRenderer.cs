using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using MediaColor = System.Windows.Media.Color;

namespace DesktopAssistant.Services;

/// <summary>
/// 像素风格桌面宠物渲染器：用 WriteableBitmap 实时绘制 32x32 像素精灵，
/// 通过程序化图元组合出更精细的像素宠物，而不是依赖低分辨率静态模板。
/// </summary>
public sealed class PixelPetRenderer
{
    public const int SpriteSize = 32;
    private const int Dpi = 96;
    private const double FrameInterval = 0.42;

    private readonly WriteableBitmap _bitmap;
    private readonly DispatcherTimer _timer;
    private readonly int _stride;
    private readonly byte[] _buffer;

    private string _animal = "cat";
    private string _mood = "normal";
    private int _frame;

    public BitmapSource Bitmap => _bitmap;

    public PixelPetRenderer()
    {
        _bitmap = new WriteableBitmap(SpriteSize, SpriteSize, Dpi, Dpi, PixelFormats.Bgra32, null);
        _stride = SpriteSize * 4;
        _buffer = new byte[SpriteSize * _stride];
        _timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(FrameInterval) };
        _timer.Tick += (_, _) => AdvanceFrame();
    }

    public void SetAnimal(string animal)
    {
        _animal = NormalizeAnimal(animal);
        Render();
    }

    public void SetMood(string mood)
    {
        _mood = NormalizeMood(mood);
        Render();
    }

    public void Start()
    {
        Render();
        _timer.Start();
    }

    public void Stop() => _timer.Stop();

    public static BitmapSource CreatePreview(string animal, string mood = "normal")
    {
        var renderer = new PixelPetRenderer();
        renderer.SetAnimal(animal);
        renderer.SetMood(mood);
        renderer.Stop();
        return renderer.Bitmap;
    }

    private void AdvanceFrame()
    {
        _frame = (_frame + 1) % 4;
        Render();
    }

    private void Render()
    {
        Clear();
        var palette = GetPalette(_animal);

        DrawShadow(C(0x80, 0x00, 0x00, 0x00));

        switch (_animal)
        {
            case "cat":
                DrawCat(palette);
                break;
            case "dog":
                DrawDog(palette);
                break;
            case "rabbit":
                DrawRabbit(palette);
                break;
            case "fox":
                DrawFox(palette);
                break;
            case "goose":
                DrawGoose(palette);
                break;
            case "cockroach":
                DrawCockroach(palette);
                break;
            case "mosquito":
                DrawMosquito(palette);
                break;
            case "capybara":
                DrawCapybara(palette);
                break;
            case "frog":
                DrawFrog(palette);
                break;
            case "penguin":
                DrawPenguin(palette);
                break;
            case "turtle":
                DrawTurtle(palette);
                break;
            case "hedgehog":
                DrawHedgehog(palette);
                break;
            default:
                DrawHuman(palette);
                break;
        }

        DrawLifeStateAccessory(palette);

        if (_mood == "sleepy")
            DrawSleepBubble();

        Commit();
    }

    private void DrawShadow(MediaColor color)
    {
        int shadowShift = _frame % 2 == 0 ? 0 : 1;
        FillEllipse(8, 26 + shadowShift, 16, 4, color);
    }

    private void DrawCat(Palette p)
    {
        int bob = _mood == "happy" && _frame % 2 == 1 ? -1 : 0;
        int tailY = _frame % 2 == 0 ? 11 : 13;
        FillTail(23, tailY + bob, _frame % 2 == 0 ? 4 : 2, 8, p.Mid, p.Outline);

        FillEllipse(7, 14 + bob, 16, 10, p.Mid);
        StrokeEllipse(7, 14 + bob, 16, 10, p.Outline);
        FillEllipse(10, 8 + bob, 10, 9, p.Mid);
        StrokeEllipse(10, 8 + bob, 10, 9, p.Outline);

        FillTriangleUp(11, 8 + bob, 3, 4, p.Mid);
        FillTriangleUp(17, 8 + bob, 3, 4, p.Mid);
        StrokeTriangleUp(11, 8 + bob, 3, 4, p.Outline);
        StrokeTriangleUp(17, 8 + bob, 3, 4, p.Outline);
        FillTriangleUp(12, 10 + bob, 1, 2, p.Accent);
        FillTriangleUp(18, 10 + bob, 1, 2, p.Accent);

        FillEllipse(11, 17 + bob, 3, 2, p.Light);
        FillEllipse(16, 17 + bob, 3, 2, p.Light);
        DrawFace(13, 12 + bob, 4, p, FaceKind.Cat);
        DrawBodyHighlights(10, 17 + bob, 10, 5, p);
        DrawPaws(10, 22 + bob, p.Outline, p.Light);
        DrawCatStripes(9, 14 + bob, p.Detail);
    }

    private void DrawDog(Palette p)
    {
        int bob = _mood == "happy" && _frame % 2 == 1 ? -1 : 0;
        int tailY = _frame % 2 == 0 ? 15 : 11;
        FillTail(23, tailY + bob, _frame % 2 == 0 ? 5 : 3, 7, p.Detail, p.Outline);

        FillEllipse(7, 15 + bob, 16, 10, p.Mid);
        StrokeEllipse(7, 15 + bob, 16, 10, p.Outline);
        FillEllipse(9, 8 + bob, 12, 10, p.Mid);
        StrokeEllipse(9, 8 + bob, 12, 10, p.Outline);

        FillRoundedRect(7, 10 + bob, 4, 7, p.Detail);
        FillRoundedRect(19, 10 + bob, 4, 7, p.Detail);
        StrokeRoundedRect(7, 10 + bob, 4, 7, p.Outline);
        StrokeRoundedRect(19, 10 + bob, 4, 7, p.Outline);

        FillEllipse(11, 17 + bob, 8, 5, p.Light);
        DrawFace(13, 12 + bob, 4, p, FaceKind.Dog);
        FillRect(12, 16 + bob, 4, 2, p.Nose);
        if (_frame == 2 && _mood != "sleepy")
        {
            FillRect(13, 18 + bob, 2, 3, p.Accent);
        }
        DrawPaws(10, 23 + bob, p.Outline, p.Light);
        FillRect(10, 14 + bob, 2, 1, p.Highlight);
        FillRect(18, 14 + bob, 2, 1, p.Highlight);
        FillRect(12, 20 + bob, 6, 1, p.Collar);
    }

    private void DrawRabbit(Palette p)
    {
        int bob = _frame % 2 == 0 ? 0 : -1;
        int earShift = _frame % 3 == 0 ? 0 : 1;

        FillRoundedRect(10, 2 + bob, 4, 11 - earShift, p.Mid);
        FillRoundedRect(17, 2 + bob + earShift, 4, 11 - earShift, p.Mid);
        StrokeRoundedRect(10, 2 + bob, 4, 11 - earShift, p.Outline);
        StrokeRoundedRect(17, 2 + bob + earShift, 4, 11 - earShift, p.Outline);
        FillRoundedRect(11, 4 + bob, 2, 7 - earShift, p.Accent);
        FillRoundedRect(18, 4 + bob + earShift, 2, 7 - earShift, p.Accent);

        FillEllipse(9, 10 + bob, 14, 10, p.Mid);
        StrokeEllipse(9, 10 + bob, 14, 10, p.Outline);
        FillEllipse(8, 16 + bob, 16, 9, p.Mid);
        StrokeEllipse(8, 16 + bob, 16, 9, p.Outline);
        FillEllipse(12, 18 + bob, 8, 4, p.Light);

        DrawFace(13, 13 + bob, 4, p, FaceKind.Rabbit);
        DrawPaws(10, 23 + bob, p.Outline, p.Light);
        FillEllipse(21, 19 + bob, 3, 3, p.Light);
        StrokeEllipse(21, 19 + bob, 3, 3, p.Outline);
    }

    private void DrawFox(Palette p)
    {
        int bob = _mood == "happy" && _frame % 2 == 1 ? -1 : 0;
        int tailY = _frame % 2 == 0 ? 12 : 14;
        FillTail(22, tailY + bob, _frame % 2 == 0 ? 6 : 3, 9, p.Mid, p.Outline);
        FillRect(26, tailY + 6 + bob, 3, 2, p.Light);

        FillEllipse(8, 15 + bob, 15, 9, p.Mid);
        StrokeEllipse(8, 15 + bob, 15, 9, p.Outline);
        FillEllipse(10, 8 + bob, 11, 9, p.Mid);
        StrokeEllipse(10, 8 + bob, 11, 9, p.Outline);

        FillTriangleUp(11, 7 + bob, 3, 4, p.Mid);
        FillTriangleUp(18, 7 + bob, 3, 4, p.Mid);
        StrokeTriangleUp(11, 7 + bob, 3, 4, p.Outline);
        StrokeTriangleUp(18, 7 + bob, 3, 4, p.Outline);

        FillTriangleDown(13, 15 + bob, 5, 4, p.Light);
        StrokeTriangleDown(13, 15 + bob, 5, 4, p.Outline);
        DrawFace(13, 11 + bob, 4, p, FaceKind.Fox);
        DrawPaws(10, 23 + bob, p.Outline, p.Light);
    }

    private void DrawHuman(Palette p)
    {
        int bob = _frame % 2 == 0 ? 0 : -1;
        FillEllipse(10, 7 + bob, 12, 11, p.Skin);
        StrokeEllipse(10, 7 + bob, 12, 11, p.Outline);
        FillRect(9, 7 + bob, 14, 4, p.Hair);
        FillRect(10, 10 + bob, 2, 3, p.Hair);
        FillRect(20, 10 + bob, 2, 3, p.Hair);

        DrawFace(13, 11 + bob, 4, p, FaceKind.Human);
        FillRoundedRect(10, 18 + bob, 12, 8, p.Clothes);
        StrokeRoundedRect(10, 18 + bob, 12, 8, p.Outline);
        FillRect(9, 19 + bob, _frame % 3 == 0 ? 4 : 2, 5, p.Skin);
        FillRect(21, 19 + bob, _frame % 3 == 0 ? 2 : 4, 5, p.Skin);
        FillRect(12, 26 + bob, 3, 4, p.Pants);
        FillRect(17, 26 + bob, 3, 4, p.Pants);
        FillRect(12, 30 + bob, 3, 1, p.Outline);
        FillRect(17, 30 + bob, 3, 1, p.Outline);
        FillRect(13, 20 + bob, 6, 1, p.Highlight);
    }

    private void DrawGoose(Palette p)
    {
        int bob = _frame % 2 == 0 ? 0 : -1;
        int neckLean = _frame == 1 ? 2 : _frame == 2 ? -1 : 0;
        int wingLift = _frame == 3 ? -2 : 0;

        FillEllipse(8, 17 + bob, 16, 9, p.Mid);
        StrokeEllipse(8, 17 + bob, 16, 9, p.Outline);
        FillRoundedRect(15 + neckLean, 8 + bob, 4, 10, p.Mid);
        StrokeRoundedRect(15 + neckLean, 8 + bob, 4, 10, p.Outline);
        FillEllipse(13 + neckLean, 5 + bob, 8, 7, p.Mid);
        StrokeEllipse(13 + neckLean, 5 + bob, 8, 7, p.Outline);
        FillEllipse(9, 15 + bob + wingLift, 7, 5, p.Highlight);
        StrokeEllipse(9, 15 + bob + wingLift, 7, 5, p.Outline);
        FillRect(20 + neckLean, 8 + bob, 5, 2, p.Accent);
        FillRect(24 + neckLean, 8 + bob, 1, 1, p.Detail);
        FillEllipse(11, 19 + bob, 7, 4, p.Light);
        FillRect(10, 24 + bob, 2, 5, p.Accent);
        FillRect(19, 24 + bob, 2, 5, p.Accent);
        FillRect(9, 29 + bob, 4, 1, p.Outline);
        FillRect(18, 29 + bob, 4, 1, p.Outline);
        DrawFace(15 + neckLean, 7 + bob, 2, p, FaceKind.Goose);
    }

    private void DrawCockroach(Palette p)
    {
        int scuttle = _frame == 0 ? 0 : _frame == 1 ? 2 : _frame == 2 ? 1 : -1;
        int lean = _frame == 3 ? -1 : 0;

        FillEllipse(10 + scuttle, 8 + lean, 12, 17, p.Mid);
        StrokeEllipse(10 + scuttle, 8 + lean, 12, 17, p.Outline);
        FillEllipse(11 + scuttle, 10 + lean, 10, 7, p.Detail);
        FillRect(15 + scuttle, 10, 1, 13, p.Highlight);
        FillEllipse(12 + scuttle, 23, 8, 4, p.Light);

        DrawAntenna(13 + scuttle, 8 + lean, -3, _frame % 2 == 0 ? -4 : -5, p.Outline);
        DrawAntenna(19 + scuttle, 8 + lean, 3, _frame % 2 == 0 ? -4 : -5, p.Outline);
        DrawInsectLegs(10 + scuttle, 14 + lean, p.Outline);
        DrawFace(14 + scuttle, 12 + lean, 3, p, FaceKind.Cockroach);
    }

    private void DrawMosquito(Palette p)
    {
        int bob = _frame % 2 == 0 ? 0 : -1;
        int wingLift = _frame == 0 ? 0 : _frame == 1 ? -3 : _frame == 2 ? -1 : -4;
        int proboscisShift = _frame == 2 ? 1 : 0;

        FillEllipse(13, 13 + bob, 6, 11, p.Mid);
        StrokeEllipse(13, 13 + bob, 6, 11, p.Outline);
        FillEllipse(12, 9 + bob, 8, 6, p.Detail);
        StrokeEllipse(12, 9 + bob, 8, 6, p.Outline);
        FillEllipse(8, 9 + bob + wingLift, 7, 4, p.Light);
        FillEllipse(17, 9 + bob + wingLift, 7, 4, p.Light);
        StrokeEllipse(8, 9 + bob + wingLift, 7, 4, p.Outline);
        StrokeEllipse(17, 9 + bob + wingLift, 7, 4, p.Outline);
        FillRect(15, 24 + bob, 1, 5, p.Outline);
        DrawProboscis(16 + proboscisShift, 11 + bob, p.Accent);
        DrawMosquitoLegs(13, 18 + bob, p.Outline);
        DrawFace(13, 10 + bob, 4, p, FaceKind.Mosquito);
    }

    private void DrawCapybara(Palette p)
    {
        int bob = _mood == "happy" && _frame % 2 == 1 ? -1 : 0;
        int headShift = _frame == 1 ? 1 : _frame == 3 ? -1 : 0;
        FillEllipse(7, 14 + bob, 17, 10, p.Mid);
        StrokeEllipse(7, 14 + bob, 17, 10, p.Outline);
        FillEllipse(13 + headShift, 9 + bob, 10, 8, p.Mid);
        StrokeEllipse(13 + headShift, 9 + bob, 10, 8, p.Outline);
        FillRoundedRect(13 + headShift, 8 + bob, 3, 3, p.Detail);
        FillRoundedRect(19 + headShift, 8 + bob, 3, 3, p.Detail);
        StrokeRoundedRect(13 + headShift, 8 + bob, 3, 3, p.Outline);
        StrokeRoundedRect(19 + headShift, 8 + bob, 3, 3, p.Outline);
        FillEllipse(11, 18 + bob, 9, 4, p.Light);
        FillRect(8, 23 + bob, 3, 4, p.Detail);
        FillRect(18, 23 + bob, 3, 4, p.Detail);
        FillRect(8, 27 + bob, 3, 1, p.Outline);
        FillRect(18, 27 + bob, 3, 1, p.Outline);
        DrawFace(15 + headShift, 12 + bob, 3, p, FaceKind.Capybara);
    }

    private void DrawFrog(Palette p)
    {
        int hop = _frame == 1 ? -2 : 0;
        FillEllipse(8, 15 + hop, 16, 10, p.Mid);
        StrokeEllipse(8, 15 + hop, 16, 10, p.Outline);
        FillEllipse(10, 10 + hop, 12, 8, p.Mid);
        StrokeEllipse(10, 10 + hop, 12, 8, p.Outline);
        FillEllipse(10, 7 + hop, 4, 4, p.Highlight);
        FillEllipse(18, 7 + hop, 4, 4, p.Highlight);
        StrokeEllipse(10, 7 + hop, 4, 4, p.Outline);
        StrokeEllipse(18, 7 + hop, 4, 4, p.Outline);
        DrawFace(12, 11 + hop, 6, p, FaceKind.Frog);
        FillRect(9, 23 + hop, 3, 4, p.Detail);
        FillRect(20, 23 + hop, 3, 4, p.Detail);
        FillRect(7, 24 + hop, 2, 2, p.Highlight);
        FillRect(23, 24 + hop, 2, 2, p.Highlight);
    }

    private void DrawPenguin(Palette p)
    {
        int sway = _frame == 1 ? 1 : _frame == 3 ? -1 : 0;
        FillEllipse(9 + sway, 10, 14, 17, p.Mid);
        StrokeEllipse(9 + sway, 10, 14, 17, p.Outline);
        FillEllipse(12 + sway, 14, 8, 10, p.Light);
        FillEllipse(11 + sway, 6, 10, 8, p.Detail);
        StrokeEllipse(11 + sway, 6, 10, 8, p.Outline);
        DrawFace(13 + sway, 10, 4, p, FaceKind.Penguin);
        FillTriangleDown(20 + sway, 11, 4, 3, p.Accent);
        FillRect(8 + sway, 16, 2, 7, p.Detail);
        FillRect(22 + sway, 16, 2, 7, p.Detail);
        FillRect(12 + sway, 27, 3, 2, p.Accent);
        FillRect(17 + sway, 27, 3, 2, p.Accent);
    }

    private void DrawTurtle(Palette p)
    {
        int headOut = _frame == 1 || _frame == 2 ? 2 : 0;
        FillEllipse(8, 15, 16, 10, p.Mid);
        StrokeEllipse(8, 15, 16, 10, p.Outline);
        FillEllipse(10, 17, 12, 6, p.Detail);
        FillEllipse(21, 17, 5 + headOut, 4, p.Light);
        StrokeEllipse(21, 17, 5 + headOut, 4, p.Outline);
        FillEllipse(7, 17, 3, 3, p.Light);
        FillEllipse(10, 23, 4, 3, p.Light);
        FillEllipse(18, 23, 4, 3, p.Light);
        DrawFace(22, 18, 1, p, FaceKind.Turtle);
        FillRect(13, 19, 6, 1, p.Highlight);
        FillRect(12, 21, 8, 1, p.Highlight);
    }

    private void DrawHedgehog(Palette p)
    {
        int curl = _frame == 2 ? -1 : 0;
        FillEllipse(8, 13 + curl, 16, 11, p.Detail);
        StrokeEllipse(8, 13 + curl, 16, 11, p.Outline);
        for (int i = 0; i < 6; i++)
            FillTriangleUp(8 + i * 3, 10 + (i % 2 == 0 ? 0 : 1) + curl, 3, 4, p.Highlight);
        FillEllipse(13, 16 + curl, 11, 7, p.Light);
        StrokeEllipse(13, 16 + curl, 11, 7, p.Outline);
        DrawFace(16, 17 + curl, 3, p, FaceKind.Hedgehog);
        FillRect(11, 23 + curl, 2, 3, p.Accent);
        FillRect(19, 23 + curl, 2, 3, p.Accent);
    }

    private void DrawFace(int x, int y, int spacing, Palette p, FaceKind kind)
    {
        switch (_mood)
        {
            case "sleepy":
                FillRect(x, y, 2, 1, p.Outline);
                FillRect(x + spacing, y, 2, 1, p.Outline);
                break;
            case "happy":
                FillRect(x, y, 2, 1, p.Outline);
                FillRect(x + spacing, y, 2, 1, p.Outline);
                FillRect(x + 1, y + 3, 4, 1, p.Accent);
                break;
            case "bored":
                FillRect(x, y, 2, 1, p.Outline);
                FillRect(x + spacing, y, 2, 1, p.Outline);
                FillRect(x + 1, y + 3, 4, 1, p.Detail);
                break;
            default:
                FillRect(x, y, 2, 2, p.Eye);
                FillRect(x + spacing, y, 2, 2, p.Eye);
                FillRect(x + 1, y + 3, 3, 1, p.Accent);
                break;
        }

        if (_mood == "happy" && kind is FaceKind.Cat or FaceKind.Rabbit or FaceKind.Human)
        {
            FillRect(x - 1, y + 2, 1, 1, p.Accent);
            FillRect(x + spacing + 2, y + 2, 1, 1, p.Accent);
        }
    }

    private void DrawBodyHighlights(int x, int y, int width, int height, Palette p)
    {
        FillRect(x + 1, y + 1, width - 2, height / 2, p.Light);
        FillRect(x + 2, y + 2, width - 5, 1, p.Highlight);
    }

    private void DrawPaws(int x, int y, MediaColor outline, MediaColor fill)
    {
        FillRoundedRect(x, y, 4, 3, fill);
        FillRoundedRect(x + 8, y, 4, 3, fill);
        StrokeRoundedRect(x, y, 4, 3, outline);
        StrokeRoundedRect(x + 8, y, 4, 3, outline);
    }

    private void DrawCatStripes(int x, int y, MediaColor stripe)
    {
        FillRect(x + 2, y + 2, 2, 1, stripe);
        FillRect(x + 7, y + 1, 2, 1, stripe);
        FillRect(x + 4, y + 5, 2, 1, stripe);
    }

    private void DrawSleepBubble()
    {
        int shift = _frame % 2;
        FillRect(22, 4 - shift, 2, 1, C(0xFF, 0xFF, 0xFF, 0xFF));
        FillRect(24, 2 - shift, 3, 1, C(0xFF, 0xFF, 0xFF, 0xFF));
        FillRect(24, 3 - shift, 1, 1, C(0xFF, 0xFF, 0xFF, 0xFF));
        FillRect(26, 1 - shift, 2, 1, C(0xFF, 0xFF, 0xFF, 0xFF));
    }

    private void DrawLifeStateAccessory(Palette p)
    {
        switch (_mood)
        {
            case "eating":
                DrawFoodBowl(p);
                break;
            case "working":
                DrawLaptop(p);
                break;
            case "reading":
                DrawBook(p);
                break;
            case "exercising":
                DrawExerciseMarks(p);
                break;
            case "relaxing":
                DrawRelaxCup(p);
                break;
        }
    }

    private void DrawFoodBowl(Palette p)
    {
        FillEllipse(20, 24, 9, 4, C(0xFF, 0xE8, 0x6A, 0x6A));
        StrokeEllipse(20, 24, 9, 4, p.Outline);
        FillRect(22, 23, 2, 1, C(0xFF, 0xFF, 0xD1, 0x66));
        FillRect(25, 23, 2, 1, C(0xFF, 0xFF, 0xD1, 0x66));
        FillRect(24, 22 + (_frame % 2), 1, 1, C(0xFF, 0xFF, 0xF2, 0xB0));
    }

    private void DrawLaptop(Palette p)
    {
        FillRoundedRect(18, 20, 11, 7, C(0xFF, 0x38, 0x4A, 0x5E));
        StrokeRoundedRect(18, 20, 11, 7, p.Outline);
        FillRect(20, 22, 7, 3, C(0xFF, 0x9B, 0xD8, 0xFF));
        FillRect(17, 27, 13, 2, C(0xFF, 0x5B, 0x67, 0x78));
        FillRect(21 + (_frame % 3), 23, 2, 1, C(0xFF, 0xFF, 0xFF, 0xFF));
    }

    private void DrawBook(Palette p)
    {
        FillRoundedRect(18, 22, 6, 6, C(0xFF, 0xFF, 0xF1, 0xB8));
        FillRoundedRect(24, 22, 6, 6, C(0xFF, 0xFF, 0xE5, 0x8A));
        StrokeRoundedRect(18, 22, 12, 6, p.Outline);
        FillRect(24, 22, 1, 6, p.Outline);
        FillRect(20, 24, 3, 1, C(0xFF, 0xA0, 0x79, 0x3A));
        FillRect(26, 24, 2 + (_frame % 2), 1, C(0xFF, 0xA0, 0x79, 0x3A));
    }

    private void DrawExerciseMarks(Palette p)
    {
        var sweat = C(0xFF, 0x6E, 0xD6, 0xFF);
        FillEllipse(23, 5 + (_frame % 2), 2, 3, sweat);
        StrokeEllipse(23, 5 + (_frame % 2), 2, 3, p.Outline);
        FillRect(24, 23, 6, 2, C(0xFF, 0x72, 0xE0, 0x98));
        FillRect(22, 22, 2, 4, C(0xFF, 0x72, 0xE0, 0x98));
        FillRect(30, 22, 2, 4, C(0xFF, 0x72, 0xE0, 0x98));
        SetPixel(26, 8, C(0xFF, 0xFF, 0xF0, 0x6A));
        SetPixel(27, 7, C(0xFF, 0xFF, 0xF0, 0x6A));
        SetPixel(28, 8, C(0xFF, 0xFF, 0xF0, 0x6A));
    }

    private void DrawRelaxCup(Palette p)
    {
        FillRoundedRect(21, 23, 7, 5, C(0xFF, 0xD7, 0xF8, 0xD7));
        StrokeRoundedRect(21, 23, 7, 5, p.Outline);
        StrokeEllipse(27, 24, 3, 3, p.Outline);
        FillRect(22, 22, 5, 1, C(0xFF, 0x87, 0xC7, 0x8A));
        int steam = _frame % 2;
        SetPixel(23, 19 - steam, C(0xCC, 0xFF, 0xFF, 0xFF));
        SetPixel(25, 18 + steam, C(0xCC, 0xFF, 0xFF, 0xFF));
        SetPixel(27, 19 - steam, C(0xCC, 0xFF, 0xFF, 0xFF));
    }

    private Palette GetPalette(string animal)
    {
        return animal switch
        {
            "cat" => new Palette(
                Outline: C(0xFF, 0x78, 0x45, 0x24),
                Mid: C(0xFF, 0xF4, 0xA4, 0x60),
                Light: C(0xFF, 0xF9, 0xD2, 0xA0),
                Highlight: C(0xFF, 0xFF, 0xE8, 0xC7),
                Accent: C(0xFF, 0xFF, 0xB6, 0xC1),
                Detail: C(0xFF, 0xD6, 0x78, 0x33),
                Eye: C(0xFF, 0x20, 0x20, 0x20),
                Nose: C(0xFF, 0x6A, 0x42, 0x30),
                Collar: C(0xFF, 0x9B, 0x60, 0x36),
                Skin: C(0x00, 0x00, 0x00, 0x00),
                Hair: C(0x00, 0x00, 0x00, 0x00),
                Clothes: C(0x00, 0x00, 0x00, 0x00),
                Pants: C(0x00, 0x00, 0x00, 0x00)),
            "dog" => new Palette(
                Outline: C(0xFF, 0x67, 0x49, 0x2B),
                Mid: C(0xFF, 0xD2, 0xA6, 0x79),
                Light: C(0xFF, 0xE9, 0xCC, 0xA3),
                Highlight: C(0xFF, 0xF6, 0xE3, 0xC9),
                Accent: C(0xFF, 0xFF, 0x73, 0x96),
                Detail: C(0xFF, 0xB6, 0x86, 0x58),
                Eye: C(0xFF, 0x20, 0x20, 0x20),
                Nose: C(0xFF, 0x2E, 0x20, 0x18),
                Collar: C(0xFF, 0xCC, 0x3B, 0x3B),
                Skin: C(0x00, 0x00, 0x00, 0x00),
                Hair: C(0x00, 0x00, 0x00, 0x00),
                Clothes: C(0x00, 0x00, 0x00, 0x00),
                Pants: C(0x00, 0x00, 0x00, 0x00)),
            "rabbit" => new Palette(
                Outline: C(0xFF, 0xB8, 0xB8, 0xB8),
                Mid: C(0xFF, 0xF5, 0xF5, 0xF5),
                Light: C(0xFF, 0xFF, 0xFF, 0xFF),
                Highlight: C(0xFF, 0xFF, 0xFF, 0xFF),
                Accent: C(0xFF, 0xFF, 0xCB, 0xDC),
                Detail: C(0xFF, 0xE7, 0xE7, 0xE7),
                Eye: C(0xFF, 0x20, 0x20, 0x20),
                Nose: C(0xFF, 0xF8, 0x9C, 0xAE),
                Collar: C(0x00, 0x00, 0x00, 0x00),
                Skin: C(0x00, 0x00, 0x00, 0x00),
                Hair: C(0x00, 0x00, 0x00, 0x00),
                Clothes: C(0x00, 0x00, 0x00, 0x00),
                Pants: C(0x00, 0x00, 0x00, 0x00)),
            "fox" => new Palette(
                Outline: C(0xFF, 0xA0, 0x42, 0x10),
                Mid: C(0xFF, 0xE8, 0x6B, 0x2A),
                Light: C(0xFF, 0xFF, 0xED, 0xDE),
                Highlight: C(0xFF, 0xFF, 0xD2, 0xA1),
                Accent: C(0xFF, 0xFF, 0xC6, 0x85),
                Detail: C(0xFF, 0xD6, 0x5F, 0x21),
                Eye: C(0xFF, 0x20, 0x20, 0x20),
                Nose: C(0xFF, 0x2E, 0x20, 0x18),
                Collar: C(0x00, 0x00, 0x00, 0x00),
                Skin: C(0x00, 0x00, 0x00, 0x00),
                Hair: C(0x00, 0x00, 0x00, 0x00),
                Clothes: C(0x00, 0x00, 0x00, 0x00),
                Pants: C(0x00, 0x00, 0x00, 0x00)),
            "goose" => new Palette(
                Outline: C(0xFF, 0x6F, 0x7C, 0x89),
                Mid: C(0xFF, 0xF5, 0xF7, 0xFA),
                Light: C(0xFF, 0xFF, 0xFF, 0xFF),
                Highlight: C(0xFF, 0xE4, 0xEC, 0xF4),
                Accent: C(0xFF, 0xF0, 0x9C, 0x33),
                Detail: C(0xFF, 0xD9, 0x7F, 0x1D),
                Eye: C(0xFF, 0x20, 0x20, 0x20),
                Nose: C(0xFF, 0xD9, 0x7F, 0x1D),
                Collar: C(0x00, 0x00, 0x00, 0x00),
                Skin: C(0x00, 0x00, 0x00, 0x00),
                Hair: C(0x00, 0x00, 0x00, 0x00),
                Clothes: C(0x00, 0x00, 0x00, 0x00),
                Pants: C(0x00, 0x00, 0x00, 0x00)),
            "cockroach" => new Palette(
                Outline: C(0xFF, 0x43, 0x24, 0x17),
                Mid: C(0xFF, 0x78, 0x46, 0x29),
                Light: C(0xFF, 0x9A, 0x63, 0x3C),
                Highlight: C(0xFF, 0xB2, 0x7C, 0x4D),
                Accent: C(0xFF, 0xA0, 0x6E, 0x3F),
                Detail: C(0xFF, 0x5D, 0x33, 0x20),
                Eye: C(0xFF, 0x20, 0x20, 0x20),
                Nose: C(0xFF, 0x43, 0x24, 0x17),
                Collar: C(0x00, 0x00, 0x00, 0x00),
                Skin: C(0x00, 0x00, 0x00, 0x00),
                Hair: C(0x00, 0x00, 0x00, 0x00),
                Clothes: C(0x00, 0x00, 0x00, 0x00),
                Pants: C(0x00, 0x00, 0x00, 0x00)),
            "mosquito" => new Palette(
                Outline: C(0xFF, 0x37, 0x3A, 0x47),
                Mid: C(0xFF, 0x58, 0x5C, 0x72),
                Light: C(0x66, 0xE8, 0xF2, 0xFF),
                Highlight: C(0xFF, 0x8A, 0x8F, 0xA8),
                Accent: C(0xFF, 0xD7, 0x4F, 0x66),
                Detail: C(0xFF, 0x4A, 0x4F, 0x63),
                Eye: C(0xFF, 0x20, 0x20, 0x20),
                Nose: C(0xFF, 0x37, 0x3A, 0x47),
                Collar: C(0x00, 0x00, 0x00, 0x00),
                Skin: C(0x00, 0x00, 0x00, 0x00),
                Hair: C(0x00, 0x00, 0x00, 0x00),
                Clothes: C(0x00, 0x00, 0x00, 0x00),
                Pants: C(0x00, 0x00, 0x00, 0x00)),
            "capybara" => new Palette(
                Outline: C(0xFF, 0x67, 0x48, 0x2E),
                Mid: C(0xFF, 0xA7, 0x78, 0x4E),
                Light: C(0xFF, 0xC4, 0x98, 0x6C),
                Highlight: C(0xFF, 0xD7, 0xB1, 0x8D),
                Accent: C(0xFF, 0x6C, 0x51, 0x44),
                Detail: C(0xFF, 0x8A, 0x60, 0x3A),
                Eye: C(0xFF, 0x20, 0x20, 0x20),
                Nose: C(0xFF, 0x5A, 0x3C, 0x2A),
                Collar: C(0x00, 0x00, 0x00, 0x00),
                Skin: C(0x00, 0x00, 0x00, 0x00),
                Hair: C(0x00, 0x00, 0x00, 0x00),
                Clothes: C(0x00, 0x00, 0x00, 0x00),
                Pants: C(0x00, 0x00, 0x00, 0x00)),
            "frog" => new Palette(
                Outline: C(0xFF, 0x3C, 0x6D, 0x26),
                Mid: C(0xFF, 0x72, 0xB7, 0x45),
                Light: C(0xFF, 0xA9, 0xD9, 0x72),
                Highlight: C(0xFF, 0xD8, 0xF1, 0xA8),
                Accent: C(0xFF, 0xF0, 0xC1, 0x8A),
                Detail: C(0xFF, 0x4E, 0x8A, 0x30),
                Eye: C(0xFF, 0x20, 0x20, 0x20),
                Nose: C(0xFF, 0x6B, 0x9D, 0x3A),
                Collar: C(0x00, 0x00, 0x00, 0x00),
                Skin: C(0x00, 0x00, 0x00, 0x00),
                Hair: C(0x00, 0x00, 0x00, 0x00),
                Clothes: C(0x00, 0x00, 0x00, 0x00),
                Pants: C(0x00, 0x00, 0x00, 0x00)),
            "penguin" => new Palette(
                Outline: C(0xFF, 0x2D, 0x37, 0x49),
                Mid: C(0xFF, 0x43, 0x4F, 0x66),
                Light: C(0xFF, 0xF6, 0xF8, 0xFB),
                Highlight: C(0xFF, 0xD9, 0xE1, 0xEF),
                Accent: C(0xFF, 0xF0, 0xA8, 0x2F),
                Detail: C(0xFF, 0x1F, 0x26, 0x33),
                Eye: C(0xFF, 0x20, 0x20, 0x20),
                Nose: C(0xFF, 0xF0, 0xA8, 0x2F),
                Collar: C(0x00, 0x00, 0x00, 0x00),
                Skin: C(0x00, 0x00, 0x00, 0x00),
                Hair: C(0x00, 0x00, 0x00, 0x00),
                Clothes: C(0x00, 0x00, 0x00, 0x00),
                Pants: C(0x00, 0x00, 0x00, 0x00)),
            "turtle" => new Palette(
                Outline: C(0xFF, 0x4F, 0x57, 0x2A),
                Mid: C(0xFF, 0x6F, 0x87, 0x3A),
                Light: C(0xFF, 0xA6, 0xBF, 0x7A),
                Highlight: C(0xFF, 0xB1, 0x6E, 0x41),
                Accent: C(0xFF, 0xC8, 0xD8, 0x94),
                Detail: C(0xFF, 0x7D, 0x4F, 0x2D),
                Eye: C(0xFF, 0x20, 0x20, 0x20),
                Nose: C(0xFF, 0x4F, 0x57, 0x2A),
                Collar: C(0x00, 0x00, 0x00, 0x00),
                Skin: C(0x00, 0x00, 0x00, 0x00),
                Hair: C(0x00, 0x00, 0x00, 0x00),
                Clothes: C(0x00, 0x00, 0x00, 0x00),
                Pants: C(0x00, 0x00, 0x00, 0x00)),
            "hedgehog" => new Palette(
                Outline: C(0xFF, 0x5A, 0x45, 0x35),
                Mid: C(0xFF, 0x8E, 0x6D, 0x52),
                Light: C(0xFF, 0xD8, 0xBE, 0x9F),
                Highlight: C(0xFF, 0xB3, 0x8A, 0x67),
                Accent: C(0xFF, 0x9E, 0x76, 0x57),
                Detail: C(0xFF, 0x6C, 0x54, 0x41),
                Eye: C(0xFF, 0x20, 0x20, 0x20),
                Nose: C(0xFF, 0x3A, 0x2D, 0x25),
                Collar: C(0x00, 0x00, 0x00, 0x00),
                Skin: C(0x00, 0x00, 0x00, 0x00),
                Hair: C(0x00, 0x00, 0x00, 0x00),
                Clothes: C(0x00, 0x00, 0x00, 0x00),
                Pants: C(0x00, 0x00, 0x00, 0x00)),
            _ => new Palette(
                Outline: C(0xFF, 0x6C, 0x51, 0x44),
                Mid: C(0xFF, 0xFF, 0xE0, 0xBD),
                Light: C(0xFF, 0xFF, 0xED, 0xD2),
                Highlight: C(0xFF, 0x9B, 0xB5, 0xFF),
                Accent: C(0xFF, 0xE5, 0x8A, 0x8A),
                Detail: C(0xFF, 0x4A, 0x55, 0x68),
                Eye: C(0xFF, 0x20, 0x20, 0x20),
                Nose: C(0xFF, 0xB7, 0x7E, 0x6A),
                Collar: C(0x00, 0x00, 0x00, 0x00),
                Skin: C(0xFF, 0xFF, 0xE0, 0xBD),
                Hair: C(0xFF, 0x3A, 0x33, 0x28),
                Clothes: C(0xFF, 0x6C, 0x8B, 0xE8),
                Pants: C(0xFF, 0x4A, 0x55, 0x68))
        };
    }

    private static string NormalizeAnimal(string animal)
    {
        var key = string.IsNullOrWhiteSpace(animal) ? "cat" : animal.Trim().ToLowerInvariant();
        return key is "cat" or "dog" or "rabbit" or "fox" or "human" or "goose" or "cockroach" or "mosquito" or "capybara" or "frog" or "penguin" or "turtle" or "hedgehog"
            ? key
            : "cat";
    }

    private static string NormalizeMood(string mood)
    {
        var key = string.IsNullOrWhiteSpace(mood) ? "normal" : mood.Trim().ToLowerInvariant();
        return key is "happy" or "bored" or "sleepy" or "eating" or "working" or "reading" or "exercising" or "relaxing"
            ? key
            : "normal";
    }

    private void Clear() => Array.Clear(_buffer, 0, _buffer.Length);

    private void Commit()
    {
        _bitmap.Lock();
        _bitmap.WritePixels(new Int32Rect(0, 0, SpriteSize, SpriteSize), _buffer, _stride, 0);
        _bitmap.Unlock();
    }

    private void SetPixel(int x, int y, MediaColor color)
    {
        if ((uint)x >= SpriteSize || (uint)y >= SpriteSize || color.A == 0)
            return;

        int index = y * _stride + x * 4;
        _buffer[index] = color.B;
        _buffer[index + 1] = color.G;
        _buffer[index + 2] = color.R;
        _buffer[index + 3] = color.A;
    }

    private void FillRect(int x, int y, int width, int height, MediaColor color)
    {
        for (int py = y; py < y + height; py++)
            for (int px = x; px < x + width; px++)
                SetPixel(px, py, color);
    }

    private void FillRoundedRect(int x, int y, int width, int height, MediaColor color)
    {
        for (int py = 0; py < height; py++)
        {
            for (int px = 0; px < width; px++)
            {
                bool corner = (px == 0 || px == width - 1) && (py == 0 || py == height - 1);
                if (!corner)
                    SetPixel(x + px, y + py, color);
            }
        }
    }

    private void StrokeRoundedRect(int x, int y, int width, int height, MediaColor color)
    {
        for (int px = 1; px < width - 1; px++)
        {
            SetPixel(x + px, y, color);
            SetPixel(x + px, y + height - 1, color);
        }

        for (int py = 1; py < height - 1; py++)
        {
            SetPixel(x, y + py, color);
            SetPixel(x + width - 1, y + py, color);
        }
    }

    private void FillEllipse(int x, int y, int width, int height, MediaColor color)
    {
        double rx = width / 2.0;
        double ry = height / 2.0;
        double cx = x + rx;
        double cy = y + ry;

        for (int py = y; py < y + height; py++)
        {
            for (int px = x; px < x + width; px++)
            {
                double dx = (px + 0.5 - cx) / rx;
                double dy = (py + 0.5 - cy) / ry;
                if (dx * dx + dy * dy <= 1.0)
                    SetPixel(px, py, color);
            }
        }
    }

    private void StrokeEllipse(int x, int y, int width, int height, MediaColor color)
    {
        double rx = width / 2.0;
        double ry = height / 2.0;
        double cx = x + rx;
        double cy = y + ry;

        for (int py = y; py < y + height; py++)
        {
            for (int px = x; px < x + width; px++)
            {
                double dx = (px + 0.5 - cx) / rx;
                double dy = (py + 0.5 - cy) / ry;
                double d = dx * dx + dy * dy;
                if (d <= 1.08 && d >= 0.7)
                    SetPixel(px, py, color);
            }
        }
    }

    private void FillTriangleUp(int x, int y, int width, int height, MediaColor color)
    {
        for (int row = 0; row < height; row++)
        {
            int w = Math.Max(1, width - row);
            int offset = row / 2;
            FillRect(x + offset, y + row, w, 1, color);
        }
    }

    private void StrokeTriangleUp(int x, int y, int width, int height, MediaColor color)
    {
        for (int row = 0; row < height; row++)
        {
            int w = Math.Max(1, width - row);
            int offset = row / 2;
            SetPixel(x + offset, y + row, color);
            SetPixel(x + offset + w - 1, y + row, color);
        }
    }

    private void FillTriangleDown(int x, int y, int width, int height, MediaColor color)
    {
        for (int row = 0; row < height; row++)
        {
            int w = Math.Max(1, width - row);
            int offset = row / 2;
            FillRect(x + offset, y + row, w, 1, color);
        }
    }

    private void StrokeTriangleDown(int x, int y, int width, int height, MediaColor color)
    {
        for (int row = 0; row < height; row++)
        {
            int w = Math.Max(1, width - row);
            int offset = row / 2;
            SetPixel(x + offset, y + row, color);
            SetPixel(x + offset + w - 1, y + row, color);
        }
    }

    private void FillTail(int x, int y, int width, int height, MediaColor fill, MediaColor outline)
    {
        FillRoundedRect(x, y, width, height, fill);
        StrokeRoundedRect(x, y, width, height, outline);
    }

    private void DrawAntenna(int x, int y, int dx, int dy, MediaColor color)
    {
        for (int i = 0; i < 4; i++)
            SetPixel(x + dx * i / 3, y + dy * i / 3, color);
    }

    private void DrawInsectLegs(int x, int y, MediaColor color)
    {
        for (int i = 0; i < 3; i++)
        {
            SetPixel(x - 1, y + i * 3, color);
            SetPixel(x - 2, y + i * 3 + 1, color);
            SetPixel(x + 12, y + i * 3, color);
            SetPixel(x + 13, y + i * 3 + 1, color);
        }
    }

    private void DrawProboscis(int x, int y, MediaColor color)
    {
        SetPixel(x + 4, y + 1, color);
        SetPixel(x + 5, y + 1, color);
        SetPixel(x + 6, y + 1, color);
    }

    private void DrawMosquitoLegs(int x, int y, MediaColor color)
    {
        SetPixel(x - 2, y + 1, color);
        SetPixel(x - 3, y + 2, color);
        SetPixel(x + 8, y + 1, color);
        SetPixel(x + 9, y + 2, color);
        SetPixel(x - 1, y + 4, color);
        SetPixel(x - 2, y + 5, color);
        SetPixel(x + 7, y + 4, color);
        SetPixel(x + 8, y + 5, color);
    }

    private static MediaColor C(byte a, byte r, byte g, byte b) => MediaColor.FromArgb(a, r, g, b);

    private enum FaceKind
    {
        Cat,
        Dog,
        Rabbit,
        Fox,
        Goose,
        Cockroach,
        Mosquito,
        Capybara,
        Frog,
        Penguin,
        Turtle,
        Hedgehog,
        Human,
    }

    private sealed record Palette(
        MediaColor Outline,
        MediaColor Mid,
        MediaColor Light,
        MediaColor Highlight,
        MediaColor Accent,
        MediaColor Detail,
        MediaColor Eye,
        MediaColor Nose,
        MediaColor Collar,
        MediaColor Skin,
        MediaColor Hair,
        MediaColor Clothes,
        MediaColor Pants);
}
