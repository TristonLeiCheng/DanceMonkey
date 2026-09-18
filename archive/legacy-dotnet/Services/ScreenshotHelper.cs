using System.Drawing;
using System.Drawing.Imaging;
using System.IO;

namespace DesktopAssistant.Services;

/// <summary>
/// 将位图保存到「图片\Screenshots」并写入剪贴板。
/// </summary>
public static class ScreenshotHelper
{
    public static string ResolveScreenshotsDir(string? notesRootPath)
    {
        var root = NoteService.ResolveRoot(notesRootPath);
        return Path.Combine(root, "Inbox", "Screenshots");
    }

    /// <returns>保存的完整路径；失败返回 null。</returns>
    public static string? SavePngAndClipboard(Bitmap bmp, string fileNamePrefix, string? notesRootPath)
    {
        if (bmp.Width < 1 || bmp.Height < 1)
            return null;

        var screenshotsDir = ResolveScreenshotsDir(notesRootPath);
        Directory.CreateDirectory(screenshotsDir);
        var fileName = $"{fileNamePrefix}_{DateTime.Now:yyyyMMdd_HHmmss}.png";
        var fullPath = Path.Combine(screenshotsDir, fileName);

        bmp.Save(fullPath, ImageFormat.Png);

        using var clipCopy = new Bitmap(bmp);
        System.Windows.Forms.Clipboard.SetImage(clipCopy);

        return fullPath;
    }
}
