namespace DesktopAssistant.Models;

public sealed class SpeechToTextOptions
{
    public string WhisperExePath { get; set; } = "";
    public string ModelPath { get; set; } = "";
    public string Language { get; set; } = "zh";
    public int Threads { get; set; } = 4;
    public bool AutoPunctuation { get; set; } = true;
    public int TimeoutSeconds { get; set; } = 240;
}

public sealed class SpeechToTextResult
{
    public bool Success { get; init; }
    public string Text { get; init; } = "";
    public string Error { get; init; } = "";
    public TimeSpan Elapsed { get; init; }
}
