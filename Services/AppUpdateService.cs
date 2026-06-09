using System.Diagnostics;
using System.IO.Compression;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using DesktopAssistant.Models;

namespace DesktopAssistant.Services;

public sealed class AppUpdateService
{
    private static readonly HttpClient Http = new()
    {
        Timeout = TimeSpan.FromMinutes(10)
    };

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public async Task<AppUpdateCheckResult> CheckForUpdateAsync(string manifestSource, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(manifestSource))
            throw new InvalidOperationException("在线升级清单 URL 不能为空。");

        var json = await ReadTextAsync(manifestSource, cancellationToken).ConfigureAwait(false);
        var manifest = JsonSerializer.Deserialize<AppUpdateManifest>(json, JsonOptions)
                       ?? throw new InvalidOperationException("升级清单格式无效。");

        if (string.IsNullOrWhiteSpace(manifest.Version))
            throw new InvalidOperationException("升级清单缺少 version 字段。");
        if (string.IsNullOrWhiteSpace(manifest.PackageUrl))
            throw new InvalidOperationException("升级清单缺少 packageUrl 字段。");

        manifest.PackageUrl = ResolvePackageSource(manifestSource, manifest.PackageUrl);
        manifest.EntryExe = string.IsNullOrWhiteSpace(manifest.EntryExe) ? "DanceMonkey.exe" : manifest.EntryExe.Trim();

        var currentVersionText = AppVersionService.GetCurrentVersionText();
        var currentVersion = AppVersionService.TryParseVersion(currentVersionText);
        var latestVersion = AppVersionService.TryParseVersion(manifest.Version);

        var isUpdateAvailable = latestVersion != null && currentVersion != null
            ? latestVersion > currentVersion
            : !string.Equals(currentVersionText, manifest.Version, StringComparison.OrdinalIgnoreCase);

        return new AppUpdateCheckResult
        {
            IsUpdateAvailable = isUpdateAvailable,
            CurrentVersionText = currentVersionText,
            LatestVersionText = manifest.Version,
            Message = isUpdateAvailable ? $"发现新版本 v{manifest.Version}。" : $"当前已是最新版本 v{currentVersionText}。",
            Manifest = manifest
        };
    }

    public async Task<AppUpdateLaunchInfo> DownloadAndStageUpdateAsync(
        AppUpdateManifest manifest,
        IProgress<string>? progress = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(manifest);

        var updateRoot = Path.Combine(
            Path.GetTempPath(),
            "DanceMonkey",
            "updates",
            $"{DateTime.UtcNow:yyyyMMddHHmmss}-{SanitizeFileName(manifest.Version)}");
        Directory.CreateDirectory(updateRoot);

        var packagePath = Path.Combine(updateRoot, "package.zip");
        var extractRoot = Path.Combine(updateRoot, "payload");
        var scriptPath = Path.Combine(updateRoot, "apply-update.ps1");

        progress?.Report("正在下载更新包...");
        await CopySourceToFileAsync(manifest.PackageUrl, packagePath, cancellationToken).ConfigureAwait(false);

        if (!string.IsNullOrWhiteSpace(manifest.Sha256))
            ValidateSha256(packagePath, manifest.Sha256);

        progress?.Report("正在解压更新包...");
        ZipFile.ExtractToDirectory(packagePath, extractRoot);

        var payloadRoot = ResolvePayloadRoot(extractRoot, manifest.EntryExe);
        File.WriteAllText(scriptPath, BuildUpdaterScript(), new UTF8Encoding(false));

        return new AppUpdateLaunchInfo
        {
            ScriptPath = scriptPath,
            SourceDirectory = payloadRoot,
            InstallDirectory = AppContext.BaseDirectory,
            ExeName = Path.GetFileName(manifest.EntryExe)
        };
    }

    public void LaunchUpdaterAndRestart(AppUpdateLaunchInfo launchInfo)
    {
        ArgumentNullException.ThrowIfNull(launchInfo);

        var arguments = string.Join(" ",
            "-NoProfile",
            "-ExecutionPolicy", "Bypass",
            "-WindowStyle", "Hidden",
            "-File", QuoteArgument(launchInfo.ScriptPath),
            "-SourceDir", QuoteArgument(launchInfo.SourceDirectory),
            "-InstallDir", QuoteArgument(launchInfo.InstallDirectory),
            "-ExeName", QuoteArgument(launchInfo.ExeName),
            "-CurrentPid", Environment.ProcessId.ToString());

        var startInfo = new ProcessStartInfo
        {
            FileName = "powershell.exe",
            Arguments = arguments,
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = Path.GetDirectoryName(launchInfo.ScriptPath) ?? AppContext.BaseDirectory
        };

        _ = Process.Start(startInfo) ?? throw new InvalidOperationException("无法启动更新进程。");
    }

    private static async Task<string> ReadTextAsync(string source, CancellationToken cancellationToken)
    {
        if (TryCreateHttpUri(source, out var uri))
            return await Http.GetStringAsync(uri, cancellationToken).ConfigureAwait(false);

        var path = ResolveFilePath(source);
        if (!File.Exists(path))
            throw new FileNotFoundException("未找到升级清单文件。", path);

        return await File.ReadAllTextAsync(path, cancellationToken).ConfigureAwait(false);
    }

    private static async Task CopySourceToFileAsync(string source, string destinationPath, CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(destinationPath) ?? Path.GetTempPath());

        if (TryCreateHttpUri(source, out var uri))
        {
            using var response = await Http.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead, cancellationToken)
                .ConfigureAwait(false);
            response.EnsureSuccessStatusCode();
            await using var responseStream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
            await using var fileStream = File.Create(destinationPath);
            await responseStream.CopyToAsync(fileStream, cancellationToken).ConfigureAwait(false);
            return;
        }

        var path = ResolveFilePath(source);
        if (!File.Exists(path))
            throw new FileNotFoundException("未找到升级包文件。", path);

        File.Copy(path, destinationPath, overwrite: true);
    }

    private static string ResolvePackageSource(string manifestSource, string packageSource)
    {
        if (TryCreateHttpUri(packageSource, out var absoluteHttpUri))
            return absoluteHttpUri.ToString();

        if (Path.IsPathRooted(packageSource) || packageSource.StartsWith("\\\\", StringComparison.Ordinal))
            return packageSource;

        if (TryCreateHttpUri(manifestSource, out var manifestHttpUri))
            return new Uri(manifestHttpUri, packageSource).ToString();

        var manifestPath = ResolveFilePath(manifestSource);
        var manifestDir = Path.GetDirectoryName(manifestPath)
                          ?? throw new InvalidOperationException("无法解析升级清单所在目录。");
        return Path.GetFullPath(Path.Combine(manifestDir, packageSource));
    }

    private static string ResolveFilePath(string source)
    {
        if (Uri.TryCreate(source, UriKind.Absolute, out var fileUri) && fileUri.IsFile)
            return fileUri.LocalPath;

        return Path.GetFullPath(source);
    }

    private static bool TryCreateHttpUri(string source, out Uri uri)
    {
        if (Uri.TryCreate(source, UriKind.Absolute, out uri!) &&
            (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps))
            return true;

        uri = null!;
        return false;
    }

    private static void ValidateSha256(string filePath, string expectedHash)
    {
        using var sha = SHA256.Create();
        using var stream = File.OpenRead(filePath);
        var actualHash = Convert.ToHexString(sha.ComputeHash(stream));
        var normalizedExpected = expectedHash.Replace("-", string.Empty).Trim().ToUpperInvariant();
        if (!string.Equals(actualHash, normalizedExpected, StringComparison.Ordinal))
            throw new InvalidOperationException("升级包校验失败：SHA256 不匹配。");
    }

    private static string ResolvePayloadRoot(string extractRoot, string entryExe)
    {
        var entryName = Path.GetFileName(entryExe);
        var directCandidate = Path.Combine(extractRoot, entryName);
        if (File.Exists(directCandidate))
            return extractRoot;

        var nestedCandidate = Directory.EnumerateFiles(extractRoot, entryName, SearchOption.AllDirectories)
            .FirstOrDefault();
        if (nestedCandidate == null)
            throw new InvalidOperationException($"升级包中未找到入口文件 {entryName}。");

        return Path.GetDirectoryName(nestedCandidate)
               ?? throw new InvalidOperationException("无法定位升级包目录。");
    }

    private static string SanitizeFileName(string value)
    {
        var invalidChars = Path.GetInvalidFileNameChars();
        var builder = new StringBuilder(value.Length);
        foreach (var ch in value)
            builder.Append(invalidChars.Contains(ch) ? '_' : ch);
        return builder.ToString();
    }

    private static string QuoteArgument(string value) => $"\"{value.Replace("\"", "\\\"")}\"";

    private static string BuildUpdaterScript() =>
        "param(\n" +
        "    [string]$SourceDir,\n" +
        "    [string]$InstallDir,\n" +
        "    [string]$ExeName,\n" +
        "    [int]$CurrentPid\n" +
        ")\n" +
        "$ErrorActionPreference = 'Stop'\n" +
        "try {\n" +
        "    if ($CurrentPid -gt 0) {\n" +
        "        Wait-Process -Id $CurrentPid -ErrorAction SilentlyContinue\n" +
        "    }\n" +
        "    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null\n" +
        "    $copy = Start-Process -FilePath 'robocopy.exe' -ArgumentList @($SourceDir, $InstallDir, '/E', '/R:2', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP') -Wait -PassThru -NoNewWindow\n" +
        "    if ($copy.ExitCode -gt 7) {\n" +
        "        throw \"robocopy failed with exit code $($copy.ExitCode).\"\n" +
        "    }\n" +
        "    $mainExe = Join-Path $InstallDir $ExeName\n" +
        "    if (-not (Test-Path $mainExe)) {\n" +
        "        throw \"Updated executable not found: $mainExe\"\n" +
        "    }\n" +
        "    Start-Process -FilePath $mainExe -WorkingDirectory $InstallDir | Out-Null\n" +
        "}\n" +
        "catch {\n" +
        "    Add-Type -AssemblyName PresentationFramework\n" +
        "    [System.Windows.MessageBox]::Show(\"升级失败：$($_.Exception.Message)\", 'DanceMonkey 更新') | Out-Null\n" +
        "}\n";
}