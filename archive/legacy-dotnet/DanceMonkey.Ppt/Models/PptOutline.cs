namespace DanceMonkey.Ppt.Models;

/// <summary>旧版 AI 返回的演示大纲 JSON（deckTitle + slides[].title/bullets）。</summary>
public sealed class PptOutline
{
    public string? DeckTitle { get; set; }
    public List<PptSlideOutline>? Slides { get; set; }
}

public sealed class PptSlideOutline
{
    public string? Title { get; set; }
    public List<string>? Bullets { get; set; }
}
