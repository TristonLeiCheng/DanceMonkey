using System.Net.Http;
using Tesseract;

namespace DesktopAssistant.Services;

/// <summary>
/// 使用 Tesseract 离线 OCR（首次使用会从 GitHub 下载轻量 tessdata_fast，需能访问外网；也可手动放入 %LocalAppData%\DanceMonkey\tessdata）。
/// </summary>
public static class ScreenshotOcrService
{
    private static readonly HttpClient Http = new()
    {
        Timeout = TimeSpan.FromMinutes(2)
    };

    private static string TessDataDirectory =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DanceMonkey", "tessdata");

    public static async Task<string> RecognizeTextFromImageFileAsync(string imagePath,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(imagePath) || !File.Exists(imagePath))
            return "";

        await EnsureTessDataAsync(cancellationToken).ConfigureAwait(false);

        using var engine = new TesseractEngine(TessDataDirectory, "chi_sim+eng", EngineMode.Default);
        using var pix = Pix.LoadFromFile(imagePath);
        using var page = engine.Process(pix);
        return page.GetText().Trim();
    }

    private static async Task EnsureTessDataAsync(CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(TessDataDirectory);

        foreach (var fileName in new[] { "eng.traineddata", "chi_sim.traineddata" })
        {
            var dest = Path.Combine(TessDataDirectory, fileName);
            if (File.Exists(dest) && new FileInfo(dest).Length > 4096)
                continue;

            const string baseUrl = "https://github.com/tesseract-ocr/tessdata_fast/raw/main/";
            using var resp = await Http.GetAsync(baseUrl + fileName, HttpCompletionOption.ResponseHeadersRead, cancellationToken)
                .ConfigureAwait(false);
            resp.EnsureSuccessStatusCode();
            await using var fs = new FileStream(dest, FileMode.Create, FileAccess.Write, FileShare.None);
            await resp.Content.CopyToAsync(fs, cancellationToken).ConfigureAwait(false);
        }
    }
}
