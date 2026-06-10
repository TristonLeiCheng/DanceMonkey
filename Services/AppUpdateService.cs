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

    static AppUpdateService()
    {
        if (Http.DefaultRequestHeaders.UserAgent.Count == 0)
            Http.DefaultRequestHeaders.UserAgent.ParseAdd("DanceMonkey-Updater/1.0");
    }

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

        return BuildCheckResult(manifest);
    }

    public async Task<AppUpdateCheckResult> CheckForUpdateFromGitHubAsync(
        string repository,
        string? assetKeyword = null,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(repository))
            throw new InvalidOperationException("GitHub 仓库不能为空，请使用 owner/repo 格式。");

        var ownerRepo = ParseRepository(repository);
        var apiUrl = $"https://api.github.com/repos/{ownerRepo}/releases/latest";

        using var request = new HttpRequestMessage(HttpMethod.Get, apiUrl);
        request.Headers.Accept.ParseAdd("application/vnd.github+json");

        using var response = await Http.SendAsync(request, cancellationToken).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
            throw new InvalidOperationException($"无法获取 GitHub 最新发行版（HTTP {(int)response.StatusCode}）。请检查网络或仓库地址。");

        var json = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
        var manifest = BuildManifestFromGitHubRelease(json, assetKeyword);
        return BuildCheckResult(manifest);
    }

    private static AppUpdateCheckResult BuildCheckResult(AppUpdateManifest manifest)
    {
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
            Message = isUpdateAvailable
                ? $"发现新版本 v{manifest.Version}。"
                : $"当前已是最新版本 v{currentVersionText}。",
            Manifest = manifest
        };
    }

    private static AppUpdateManifest BuildManifestFromGitHubRelease(string json, string? assetKeyword)
    {
        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;

        var tag = root.TryGetProperty("tag_name", out var tagElement) ? tagElement.GetString() : null;
        if (string.IsNullOrWhiteSpace(tag))
            throw new InvalidOperationException("GitHub 发行版缺少 tag_name 字段。");

        var version = tag.TrimStart('v', 'V').Trim();

        var zipAssets = new List<(string Name, string Url)>();
        if (root.TryGetProperty("assets", out var assets) && assets.ValueKind == JsonValueKind.Array)
        {
            foreach (var asset in assets.EnumerateArray())
            {
                var name = asset.TryGetProperty("name", out var nameElement) ? nameElement.GetString() : null;
                var url = asset.TryGetProperty("browser_download_url", out var urlElement) ? urlElement.GetString() : null;
                if (string.IsNullOrWhiteSpace(name) || string.IsNullOrWhiteSpace(url))
                    continue;
                if (name.EndsWith(".zip", StringComparison.OrdinalIgnoreCase))
                    zipAssets.Add((name, url));
            }
        }

        if (zipAssets.Count == 0)
            throw new InvalidOperationException("GitHub 最新发行版中未找到可用的 .zip 升级包。");

        var packageUrl = zipAssets[0].Url;
        if (!string.IsNullOrWhiteSpace(assetKeyword))
        {
            var matched = zipAssets.FirstOrDefault(a => a.Name.Contains(assetKeyword, StringComparison.OrdinalIgnoreCase));
            if (string.IsNullOrWhiteSpace(matched.Url))
                throw new InvalidOperationException($"GitHub 最新发行版中未找到文件名包含 '{assetKeyword}' 的 .zip 升级包。");

            packageUrl = matched.Url;
        }

        var notes = root.TryGetProperty("body", out var bodyElement) ? bodyElement.GetString() : null;

        return new AppUpdateManifest
        {
            Version = version,
            PackageUrl = packageUrl,
            EntryExe = "DanceMonkey.exe",
            ReleaseNotes = notes
        };
    }

    private static string ParseRepository(string repository)
    {
        var value = repository.Trim();
        if (TryCreateHttpUri(value, out var uri) &&
            uri.Host.Contains("github.com", StringComparison.OrdinalIgnoreCase))
        {
            var segments = uri.AbsolutePath.Trim('/').Split('/', StringSplitOptions.RemoveEmptyEntries);
            if (segments.Length >= 2)
                return $"{segments[0]}/{segments[1]}";
        }

        return value.Trim('/');
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
        File.WriteAllText(scriptPath, BuildUpdaterScript(), new UTF8Encoding(encoderShouldEmitUTF8Identifier: true));

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

        var startInfo = new ProcessStartInfo
        {
            FileName = "powershell.exe",
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = Path.GetDirectoryName(launchInfo.ScriptPath) ?? AppContext.BaseDirectory
        };

        startInfo.ArgumentList.Add("-NoProfile");
        startInfo.ArgumentList.Add("-ExecutionPolicy");
        startInfo.ArgumentList.Add("Bypass");
        startInfo.ArgumentList.Add("-WindowStyle");
        startInfo.ArgumentList.Add("Hidden");
        startInfo.ArgumentList.Add("-File");
        startInfo.ArgumentList.Add(launchInfo.ScriptPath);
        startInfo.ArgumentList.Add("-SourceDir");
        startInfo.ArgumentList.Add(launchInfo.SourceDirectory);
        startInfo.ArgumentList.Add("-InstallDir");
        startInfo.ArgumentList.Add(launchInfo.InstallDirectory);
        startInfo.ArgumentList.Add("-ExeName");
        startInfo.ArgumentList.Add(launchInfo.ExeName);
        startInfo.ArgumentList.Add("-CurrentPid");
        startInfo.ArgumentList.Add(Environment.ProcessId.ToString());

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
