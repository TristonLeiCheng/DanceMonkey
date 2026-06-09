using System.Text.Json;
using DesktopAssistant.Models;

namespace DesktopAssistant.Services;

/// <summary>
/// CRUD + file management for the personal homepage feature.
/// Storage root: %AppData%\DanceMonkey\Homepage\
/// </summary>
public sealed class PersonalHomepageService
{
    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        WriteIndented = true,
        PropertyNameCaseInsensitive = true,
    };

    // ─── Paths ───────────────────────────────────────────────────────────────

    public static string StorageRoot { get; } =
        Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "DanceMonkey", "Homepage");

    private static string ConfigPath => Path.Combine(StorageRoot, "config.json");
    private static string MediaRoot  => Path.Combine(StorageRoot, "media");

    public static string AvatarDir       => Path.Combine(MediaRoot, "avatars");
    public static string AlbumDir(string albumId) => Path.Combine(MediaRoot, "albums", albumId);
    public static string VideoDir(string videoId) => Path.Combine(MediaRoot, "videos", videoId);
    public static string FilesDir        => Path.Combine(MediaRoot, "files");

    // ─── Config I/O ──────────────────────────────────────────────────────────

    public HomepageConfig LoadConfig()
    {
        EnsureDirectories();
        if (!File.Exists(ConfigPath))
            return new HomepageConfig();

        try
        {
            var json = File.ReadAllText(ConfigPath);
            return JsonSerializer.Deserialize<HomepageConfig>(json, JsonOpts) ?? new HomepageConfig();
        }
        catch
        {
            return new HomepageConfig();
        }
    }

    public void SaveConfig(HomepageConfig config)
    {
        EnsureDirectories();
        var json = JsonSerializer.Serialize(config, JsonOpts);
        File.WriteAllText(ConfigPath, json);
    }

    // ─── Media file management ───────────────────────────────────────────────

    /// <summary>Copies a file into the avatar directory, returning the stored filename.</summary>
    public string SaveAvatarFile(string sourcePath)
    {
        Directory.CreateDirectory(AvatarDir);
        var ext = Path.GetExtension(sourcePath);
        var filename = $"avatar{ext}";
        var dest = Path.Combine(AvatarDir, filename);
        File.Copy(sourcePath, dest, overwrite: true);
        return filename;
    }

    /// <summary>Copies a photo into the album directory, returning the stored filename.</summary>
    public string SaveAlbumPhoto(string albumId, string sourcePath)
    {
        var dir = AlbumDir(albumId);
        Directory.CreateDirectory(dir);
        var ext = Path.GetExtension(sourcePath);
        var filename = $"{Guid.NewGuid():N}{ext}";
        File.Copy(sourcePath, Path.Combine(dir, filename));
        return filename;
    }

    /// <summary>Copies a video file, returning the stored filename.</summary>
    public string SaveVideoFile(string videoId, string sourcePath)
    {
        var dir = VideoDir(videoId);
        Directory.CreateDirectory(dir);
        var ext = Path.GetExtension(sourcePath);
        var filename = $"video{ext}";
        File.Copy(sourcePath, Path.Combine(dir, filename));
        return filename;
    }

    /// <summary>Copies a thumbnail image for a video, returning the stored filename.</summary>
    public string SaveVideoThumbnail(string videoId, string sourcePath)
    {
        var dir = VideoDir(videoId);
        Directory.CreateDirectory(dir);
        var ext = Path.GetExtension(sourcePath);
        var filename = $"thumb{ext}";
        File.Copy(sourcePath, Path.Combine(dir, filename), overwrite: true);
        return filename;
    }

    /// <summary>Copies an arbitrary file into the shared-files directory, returning the stored filename.</summary>
    public string SaveSharedFile(string sourcePath)
    {
        Directory.CreateDirectory(FilesDir);
        var ext = Path.GetExtension(sourcePath);
        var filename = $"{Guid.NewGuid():N}{ext}";
        File.Copy(sourcePath, Path.Combine(FilesDir, filename));
        return filename;
    }

    // ─── Delete helpers ───────────────────────────────────────────────────────

    public void DeleteAlbumDirectory(string albumId)
    {
        var dir = AlbumDir(albumId);
        if (Directory.Exists(dir))
            Directory.Delete(dir, recursive: true);
    }

    public void DeleteAlbumPhoto(string albumId, string filename)
    {
        var path = Path.Combine(AlbumDir(albumId), filename);
        if (File.Exists(path))
            File.Delete(path);
    }

    public void DeleteVideoDirectory(string videoId)
    {
        var dir = VideoDir(videoId);
        if (Directory.Exists(dir))
            Directory.Delete(dir, recursive: true);
    }

    public void DeleteSharedFile(string filename)
    {
        var path = Path.Combine(FilesDir, filename);
        if (File.Exists(path))
            File.Delete(path);
    }

    // ─── Full absolute path helpers (used by HTTP server) ────────────────────

    public static string? ResolveMediaPath(string relativePath)
    {
        // relativePath is like "avatars/avatar.jpg", "albums/{id}/xxx.jpg", "videos/{id}/video.mp4", "files/xxx.pdf"
        var full = Path.GetFullPath(Path.Combine(MediaRoot, relativePath));
        // Prevent path traversal: must stay under MediaRoot
        if (!full.StartsWith(Path.GetFullPath(MediaRoot), StringComparison.OrdinalIgnoreCase))
            return null;
        return File.Exists(full) ? full : null;
    }

    // ─── Private helpers ─────────────────────────────────────────────────────

    private static void EnsureDirectories()
    {
        Directory.CreateDirectory(StorageRoot);
        Directory.CreateDirectory(MediaRoot);
        Directory.CreateDirectory(AvatarDir);
        Directory.CreateDirectory(FilesDir);
    }
}
