using System.Text.Json.Serialization;

namespace DesktopAssistant.Models;

public sealed class AppUpdateManifest
{
    [JsonPropertyName("version")]
    public string Version { get; set; } = "";

    [JsonPropertyName("packageUrl")]
    public string PackageUrl { get; set; } = "";

    [JsonPropertyName("sha256")]
    public string? Sha256 { get; set; }

    [JsonPropertyName("entryExe")]
    public string EntryExe { get; set; } = "DanceMonkey.exe";

    [JsonPropertyName("releaseNotes")]
    public string? ReleaseNotes { get; set; }
}

public sealed class AppUpdateCheckResult
{
    public bool IsUpdateAvailable { get; init; }
    public string CurrentVersionText { get; init; } = "0.0.0";
    public string LatestVersionText { get; init; } = "0.0.0";
    public string? Message { get; init; }
    public AppUpdateManifest? Manifest { get; init; }
}

public sealed class AppUpdateLaunchInfo
{
    public string ScriptPath { get; init; } = "";
    public string SourceDirectory { get; init; } = "";
    public string InstallDirectory { get; init; } = "";
    public string ExeName { get; init; } = "DanceMonkey.exe";
}