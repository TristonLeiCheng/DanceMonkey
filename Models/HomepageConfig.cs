using System.Text.Json.Serialization;

namespace DesktopAssistant.Models;

// ─── Enums ───────────────────────────────────────────────────────────────────

public enum HomepageModuleType
{
    ProfileHeader,
    Albums,
    Videos,
    SharedFiles,
    TextBlock,
    SocialLinks,
}

// ─── Sub-models ───────────────────────────────────────────────────────────────

public sealed class HomepageSocialLink
{
    [JsonPropertyName("platform")]
    public string Platform { get; set; } = "";   // e.g. "GitHub", "微信", "微博"

    [JsonPropertyName("url")]
    public string Url { get; set; } = "";

    [JsonPropertyName("displayText")]
    public string DisplayText { get; set; } = "";
}

public sealed class HomepagePhoto
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    [JsonPropertyName("filename")]
    public string Filename { get; set; } = "";   // relative to media/albums/{albumId}/

    [JsonPropertyName("caption")]
    public string Caption { get; set; } = "";

    [JsonPropertyName("dateTaken")]
    public DateTime? DateTaken { get; set; }
}

public sealed class HomepageAlbum
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    [JsonPropertyName("title")]
    public string Title { get; set; } = "新相册";

    [JsonPropertyName("description")]
    public string Description { get; set; } = "";

    [JsonPropertyName("coverPhotoId")]
    public string? CoverPhotoId { get; set; }

    [JsonPropertyName("photos")]
    public List<HomepagePhoto> Photos { get; set; } = new();

    [JsonPropertyName("createdAt")]
    public DateTime CreatedAt { get; set; } = DateTime.Now;
}

public sealed class HomepageVideo
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    [JsonPropertyName("filename")]
    public string Filename { get; set; } = "";   // relative to media/videos/{id}/

    [JsonPropertyName("thumbnailFilename")]
    public string ThumbnailFilename { get; set; } = "";

    [JsonPropertyName("title")]
    public string Title { get; set; } = "";

    [JsonPropertyName("description")]
    public string Description { get; set; } = "";

    [JsonPropertyName("addedAt")]
    public DateTime AddedAt { get; set; } = DateTime.Now;
}

public sealed class HomepageSharedFile
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    [JsonPropertyName("filename")]
    public string Filename { get; set; } = "";   // relative to media/files/

    [JsonPropertyName("displayName")]
    public string DisplayName { get; set; } = "";

    [JsonPropertyName("description")]
    public string Description { get; set; } = "";

    [JsonPropertyName("fileSize")]
    public long FileSize { get; set; }

    [JsonPropertyName("addedAt")]
    public DateTime AddedAt { get; set; } = DateTime.Now;
}

public sealed class HomepageModule
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    [JsonPropertyName("type")]
    [JsonConverter(typeof(JsonStringEnumConverter))]
    public HomepageModuleType Type { get; set; }

    [JsonPropertyName("order")]
    public int Order { get; set; }

    [JsonPropertyName("enabled")]
    public bool Enabled { get; set; } = true;

    /// <summary>Module-specific extra config, stored as raw JSON string for extensibility.</summary>
    [JsonPropertyName("configJson")]
    public string ConfigJson { get; set; } = "{}";
}

public sealed class HomepageProfile
{
    [JsonPropertyName("displayName")]
    public string DisplayName { get; set; } = "";

    [JsonPropertyName("tagline")]
    public string Tagline { get; set; } = "";

    [JsonPropertyName("bio")]
    public string Bio { get; set; } = "";

    [JsonPropertyName("avatarFilename")]
    public string AvatarFilename { get; set; } = "";   // relative to media/avatars/

    [JsonPropertyName("socialLinks")]
    public List<HomepageSocialLink> SocialLinks { get; set; } = new();
}

// ─── Root config ─────────────────────────────────────────────────────────────

public sealed class HomepageConfig
{
    [JsonPropertyName("profile")]
    public HomepageProfile Profile { get; set; } = new();

    [JsonPropertyName("templateId")]
    public string TemplateId { get; set; } = "business";   // "simple" | "lively" | "business"

    [JsonPropertyName("modules")]
    public List<HomepageModule> Modules { get; set; } = DefaultModules();

    [JsonPropertyName("albums")]
    public List<HomepageAlbum> Albums { get; set; } = new();

    [JsonPropertyName("videos")]
    public List<HomepageVideo> Videos { get; set; } = new();

    [JsonPropertyName("sharedFiles")]
    public List<HomepageSharedFile> SharedFiles { get; set; } = new();

    [JsonPropertyName("serverPort")]
    public int ServerPort { get; set; } = 8765;

    [JsonPropertyName("lastPublished")]
    public DateTime? LastPublished { get; set; }

    // ── Helper ───────────────────────────────────────────────────────────────

    private static List<HomepageModule> DefaultModules() =>
    [
        new() { Type = HomepageModuleType.ProfileHeader, Order = 0, Enabled = true },
        new() { Type = HomepageModuleType.SocialLinks,   Order = 1, Enabled = true },
        new() { Type = HomepageModuleType.Albums,        Order = 2, Enabled = true },
        new() { Type = HomepageModuleType.Videos,        Order = 3, Enabled = true },
        new() { Type = HomepageModuleType.SharedFiles,   Order = 4, Enabled = true },
        new() { Type = HomepageModuleType.TextBlock,     Order = 5, Enabled = false,
                ConfigJson = """{"title":"关于我","content":""}""" },
    ];
}
