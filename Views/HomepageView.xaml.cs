using System.IO;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Controls;
using DesktopAssistant.Models;
using DesktopAssistant.Services;
using Microsoft.Win32;
using Microsoft.Web.WebView2.Core;

namespace DesktopAssistant.Views;

public partial class HomepageView : UserControl
{
    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNameCaseInsensitive = true,
        WriteIndented = false,
    };

    private readonly PersonalHomepageService  _storage  = new();
    private readonly HomepageExportService    _exporter = new();
    private readonly HomepageHttpServerService _server;

    private bool _webReady;
    private HomepageConfig _config = new();

    public HomepageView()
    {
        InitializeComponent();
        _server = new HomepageHttpServerService(_storage, _exporter);

        Loaded += async (_, _) =>
        {
            await EnsureWebAsync();
        };
        if (Application.Current != null)
            Application.Current.Exit += (_, _) => _server.Dispose();
    }

    // ─── WebView2 init ───────────────────────────────────────────────────────

    private async Task EnsureWebAsync()
    {
        if (_webReady) return;

        await HomepageWeb.EnsureCoreWebView2Async(null);

        HomepageWeb.CoreWebView2.Settings.IsScriptEnabled           = true;
        HomepageWeb.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
        HomepageWeb.CoreWebView2.WebMessageReceived += OnWebMessageReceived;

        var htmlPath = Path.Combine(AppContext.BaseDirectory, "Assets", "homepage-editor.html");
        var uri = new Uri(htmlPath).AbsoluteUri;
        HomepageWeb.Source = new Uri(uri);

        _webReady = true;

        HomepageWeb.CoreWebView2.NavigationCompleted += async (_, _) =>
        {
            _config = NormalizeConfig(_storage.LoadConfig());
            await PushStateAsync();
        };
    }

    // ─── JS → C# message handling ────────────────────────────────────────────

    private void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            var json = e.TryGetWebMessageAsString();
            if (string.IsNullOrWhiteSpace(json)) return;

            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            var type = root.TryGetProperty("type", out var t) ? t.GetString() : null;

            switch (type)
            {
                case "get_state":
                    _ = PushStateAsync();
                    break;

                case "save_config":
                    HandleSaveConfig(root);
                    break;

                case "ai_chat":
                    HandleAiChat(root);
                    break;

                case "open_file_picker":
                    HandleOpenFilePicker(root);
                    break;

                case "upload_media":
                    HandleUploadMedia(root);
                    break;

                case "server_start":
                    HandleServerStart();
                    break;

                case "server_stop":
                    HandleServerStop();
                    break;

                case "delete_item":
                    HandleDeleteItem(root);
                    break;

                case "open_browser":
                    HandleOpenBrowser(root);
                    break;
            }
        }
        catch (Exception ex)
        {
            _ = ExecuteScriptSafeAsync($"HomepageEditor.onError({JsonEscape(ex.Message)})");
        }
    }

    // ─── Handlers ────────────────────────────────────────────────────────────

    private void HandleSaveConfig(JsonElement root)
    {
        if (!root.TryGetProperty("config", out var configEl)) return;
        var updated = JsonSerializer.Deserialize<HomepageConfig>(configEl.GetRawText(), JsonOpts);
        if (updated == null) return;
        _config = NormalizeConfig(updated);
        _storage.SaveConfig(_config);
    }

    private void HandleAiChat(JsonElement root)
    {
        var message = root.TryGetProperty("message", out var m) ? m.GetString() ?? "" : "";
        if (string.IsNullOrWhiteSpace(message)) return;

        _ = Task.Run(async () =>
        {
            try
            {
                var cfg = App.Config.Load();
                var client = new OpenAiApiClient(cfg);

                var configJson = JsonSerializer.Serialize(_config, new JsonSerializerOptions { WriteIndented = false });

                var systemPrompt = """
你是一个个人主页设计助手，帮助用户通过对话创建和修改个人主页。
目标风格偏向 Yammer / 企业内部门户式个人主页：专业、克制、信息清晰，强调个人简介、成果展示、文件共享和多媒体模块。

你的任务规则：
1. 如果用户明确要求修改主页，请输出中文说明，并在末尾给出完整的 <homepage_config>...</homepage_config> JSON。
2. JSON 必须是完整配置，不是增量 patch。
3. 必须保留已有媒体文件名、已有 id、已有未被用户要求删除的数据。
4. 不要编造本地文件路径，不要伪造上传结果；如果用户要求加照片/视频/文件，但尚未上传，只能先创建空模块或说明需要上传。
5. templateId 只能是 simple、lively、business 之一。
6. modules.type 只能是 ProfileHeader、SocialLinks、Albums、Videos、SharedFiles、TextBlock。
7. profile、modules、albums、videos、sharedFiles、profile.socialLinks 都必须存在，不能为 null。
8. TextBlock 的 configJson 必须是形如 {"title":"...","content":"..."} 的 JSON 字符串。
9. 相册封面使用 coverPhotoId，若有照片则应优先保留现有 coverPhotoId；若新建相册且没有封面，可设为第一张照片 id 或 null。
10. 回复说明文字使用中文，简洁直接，避免夸张、花哨或娱乐化措辞。

如果用户只是聊天、提问或想法还不够具体，不要输出 <homepage_config> 标签。

当前配置（JSON）：
""" + configJson;

                await ExecuteScriptSafeAsync($"HomepageEditor.onAiStart()");

                var result = await client.CallAsync(
                    message,
                    systemPrompt,
                    maxTokens: 4000,
                    temperature: 0.7);

                if (!result.Success)
                {
                    await ExecuteScriptSafeAsync($"HomepageEditor.onAiError({JsonEscape(result.Error ?? "AI 请求失败")})");
                    return;
                }

                var reply = result.Result ?? "";

                // Extract config block if present
                var match = Regex.Match(reply,
                    @"<homepage_config>([\s\S]*?)</homepage_config>",
                    RegexOptions.IgnoreCase);

                string? updatedConfigJson = null;
                if (match.Success)
                {
                    updatedConfigJson = match.Groups[1].Value.Trim();
                    // Remove the config block from the reply text shown to user
                    reply = reply[..match.Index].TrimEnd() +
                            (match.Index + match.Length < reply.Length
                                ? "\n\n*[主页配置已更新]*\n\n" + reply[(match.Index + match.Length)..].TrimStart()
                                : "\n\n*[主页配置已更新]*");
                }

                await ExecuteScriptSafeAsync($"HomepageEditor.onAiDone({JsonEscape(reply)})");

                if (updatedConfigJson != null)
                {
                    try
                    {
                        var newConfig = JsonSerializer.Deserialize<HomepageConfig>(updatedConfigJson, JsonOpts);
                        if (newConfig != null)
                        {
                            _config = NormalizeConfig(newConfig);
                            _storage.SaveConfig(_config);
                            await PushStateAsync();
                        }
                    }
                    catch
                    {
                        // Ignore malformed config from AI
                    }
                }
            }
            catch (Exception ex)
            {
                await ExecuteScriptSafeAsync($"HomepageEditor.onAiError({JsonEscape(ex.Message)})");
            }
        });
    }

    private void HandleOpenFilePicker(JsonElement root)
    {
        var mediaType = root.TryGetProperty("mediaType", out var mt) ? mt.GetString() ?? "photo" : "photo";

        Dispatcher.Invoke(() =>
        {
            var dlg = new OpenFileDialog();
            switch (mediaType)
            {
                case "photo":
                    dlg.Filter = "图片文件|*.jpg;*.jpeg;*.png;*.gif;*.webp;*.bmp|所有文件|*.*";
                    dlg.Multiselect = true;
                    break;
                case "video":
                    dlg.Filter = "视频文件|*.mp4;*.webm;*.mov;*.avi;*.mkv|所有文件|*.*";
                    break;
                case "thumbnail":
                    dlg.Filter = "图片文件|*.jpg;*.jpeg;*.png;*.gif;*.webp|所有文件|*.*";
                    break;
                case "avatar":
                    dlg.Filter = "图片文件|*.jpg;*.jpeg;*.png;*.gif;*.webp|所有文件|*.*";
                    break;
                default:
                    dlg.Filter = "所有文件|*.*";
                    break;
            }

            if (dlg.ShowDialog() != true) return;

            if (mediaType == "photo" && dlg.FileNames.Length > 1)
            {
                // Return all selected photos
                var pathsJson = JsonSerializer.Serialize(dlg.FileNames);
                _ = ExecuteScriptSafeAsync($"HomepageEditor.onFilesSelected({JsonEscape(mediaType)},{pathsJson})");
            }
            else
            {
                _ = ExecuteScriptSafeAsync($"HomepageEditor.onFileSelected({JsonEscape(mediaType)},{JsonEscape(dlg.FileName)})");
            }
        });
    }

    private void HandleUploadMedia(JsonElement root)
    {
        var mediaType  = root.TryGetProperty("mediaType",  out var mt)  ? mt.GetString()  ?? "" : "";
        var sourcePath = root.TryGetProperty("sourcePath", out var sp)  ? sp.GetString()  ?? "" : "";
        var albumId    = root.TryGetProperty("albumId",    out var aid) ? aid.GetString() ?? "" : "";
        var videoId    = root.TryGetProperty("videoId",    out var vid) ? vid.GetString() ?? "" : "";

        if (!File.Exists(sourcePath))
        {
            _ = ExecuteScriptSafeAsync($"HomepageEditor.onError({JsonEscape("文件不存在: " + sourcePath)})");
            return;
        }

        try
        {
            string storedFilename;
            switch (mediaType)
            {
                case "avatar":
                    storedFilename = _storage.SaveAvatarFile(sourcePath);
                    _ = ExecuteScriptSafeAsync(
                        $"HomepageEditor.onUploadComplete({JsonEscape(mediaType)},{JsonEscape(storedFilename)},null,null)");
                    break;

                case "photo":
                    if (string.IsNullOrWhiteSpace(albumId))
                    {
                        _ = ExecuteScriptSafeAsync($"HomepageEditor.onError({JsonEscape("上传照片需指定相册 ID")})");
                        return;
                    }
                    storedFilename = _storage.SaveAlbumPhoto(albumId, sourcePath);
                    _ = ExecuteScriptSafeAsync(
                        $"HomepageEditor.onUploadComplete({JsonEscape(mediaType)},{JsonEscape(storedFilename)},{JsonEscape(albumId)},null)");
                    break;

                case "video":
                    if (string.IsNullOrWhiteSpace(videoId))
                    {
                        _ = ExecuteScriptSafeAsync($"HomepageEditor.onError({JsonEscape("上传视频需指定视频 ID")})");
                        return;
                    }
                    storedFilename = _storage.SaveVideoFile(videoId, sourcePath);
                    _ = ExecuteScriptSafeAsync(
                        $"HomepageEditor.onUploadComplete({JsonEscape(mediaType)},{JsonEscape(storedFilename)},null,{JsonEscape(videoId)})");
                    break;

                case "thumbnail":
                    if (string.IsNullOrWhiteSpace(videoId))
                    {
                        _ = ExecuteScriptSafeAsync($"HomepageEditor.onError({JsonEscape("上传封面需指定视频 ID")})");
                        return;
                    }
                    storedFilename = _storage.SaveVideoThumbnail(videoId, sourcePath);
                    _ = ExecuteScriptSafeAsync(
                        $"HomepageEditor.onUploadComplete({JsonEscape("thumbnail")},{JsonEscape(storedFilename)},null,{JsonEscape(videoId)})");
                    break;

                case "file":
                    storedFilename = _storage.SaveSharedFile(sourcePath);
                    var fileSize = new FileInfo(sourcePath).Length;
                    _ = ExecuteScriptSafeAsync(
                        $"HomepageEditor.onUploadComplete({JsonEscape(mediaType)},{JsonEscape(storedFilename)},null,null,{fileSize})");
                    break;

                default:
                    _ = ExecuteScriptSafeAsync($"HomepageEditor.onError({JsonEscape("未知媒体类型: " + mediaType)})");
                    break;
            }
        }
        catch (Exception ex)
        {
            _ = ExecuteScriptSafeAsync($"HomepageEditor.onError({JsonEscape(ex.Message)})");
        }
    }

    private void HandleServerStart()
    {
        var (ok, error) = _server.Start(_config.ServerPort);
        if (ok)
        {
            _config.LastPublished = DateTime.Now;
            _storage.SaveConfig(_config);
            _ = ExecuteScriptSafeAsync(
                $"HomepageEditor.onServerStatus(true,{JsonEscape(_server.LocalUrl)},{JsonEscape(_server.LanUrl)},{(_server.IsLanMode ? "true" : "false")})");
        }
        else
        {
            _ = ExecuteScriptSafeAsync(
                $"HomepageEditor.onServerStatus(false,null,null,false,{JsonEscape(error ?? "启动失败")})");
        }
    }

    private void HandleServerStop()
    {
        _server.Stop();
        _ = ExecuteScriptSafeAsync("HomepageEditor.onServerStatus(false,null,null,false)");
    }

    private void HandleDeleteItem(JsonElement root)
    {
        var itemType = root.TryGetProperty("itemType", out var it) ? it.GetString() ?? "" : "";
        var id       = root.TryGetProperty("id",       out var i)  ? i.GetString()  ?? "" : "";
        var albumId  = root.TryGetProperty("albumId",  out var aid) ? aid.GetString() ?? "" : "";

        switch (itemType)
        {
            case "album":
                _storage.DeleteAlbumDirectory(id);
                break;
            case "photo":
                _storage.DeleteAlbumPhoto(albumId, id);
                break;
            case "video":
                _storage.DeleteVideoDirectory(id);
                break;
            case "sharedFile":
                _storage.DeleteSharedFile(id);
                break;
        }
    }

    private static void HandleOpenBrowser(JsonElement root)
    {
        var url = root.TryGetProperty("url", out var u) ? u.GetString() : null;
        if (!string.IsNullOrWhiteSpace(url))
        {
            try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(url) { UseShellExecute = true }); }
            catch { /* ignore */ }
        }
    }

    // ─── Push state to JS ────────────────────────────────────────────────────

    private async Task PushStateAsync()
    {
        if (!_webReady) return;

        var configJson    = JsonSerializer.Serialize(_config, new JsonSerializerOptions { WriteIndented = false });
        var serverRunning = _server.IsRunning;
        var localUrl      = _server.LocalUrl;
        var lanUrl        = _server.LanUrl;
        var isLan         = _server.IsLanMode;

        var script = $"HomepageEditor.receiveState({configJson},{(serverRunning ? "true" : "false")},{JsonEscape(localUrl)},{JsonEscape(lanUrl)},{(isLan ? "true" : "false")})";
        await ExecuteScriptSafeAsync(script);
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    private async Task ExecuteScriptSafeAsync(string script)
    {
        try
        {
            if (!_webReady) return;
            await Dispatcher.InvokeAsync(async () =>
            {
                try
                {
                    await HomepageWeb.ExecuteScriptAsync(script);
                }
                catch { /* WebView may not be ready */ }
            });
        }
        catch { /* ignore */ }
    }

    private static string JsonEscape(string? s)
    {
        if (s == null) return "null";
        return JsonSerializer.Serialize(s);
    }

    // ─── Public lifecycle ────────────────────────────────────────────────────

    public void OnNavigatedTo()
    {
        _config = NormalizeConfig(_storage.LoadConfig());
        _ = PushStateAsync();
    }

    private static HomepageConfig NormalizeConfig(HomepageConfig? config)
    {
        var normalized = config ?? new HomepageConfig();

        normalized.Profile ??= new HomepageProfile();
        normalized.Profile.SocialLinks ??= new List<HomepageSocialLink>();
        normalized.Albums ??= new List<HomepageAlbum>();
        normalized.Videos ??= new List<HomepageVideo>();
        normalized.SharedFiles ??= new List<HomepageSharedFile>();
        normalized.Modules = NormalizeModules(normalized.Modules);

        normalized.TemplateId = normalized.TemplateId?.Trim().ToLowerInvariant() switch
        {
            "lively" => "lively",
            "business" => "business",
            _ => "simple"
        };

        if (normalized.ServerPort is < 1024 or > 65535)
            normalized.ServerPort = 8765;

        foreach (var album in normalized.Albums)
        {
            album.Id = string.IsNullOrWhiteSpace(album.Id) ? Guid.NewGuid().ToString("N") : album.Id;
            album.Title = album.Title ?? "新相册";
            album.Description ??= "";
            album.Photos ??= new List<HomepagePhoto>();

            foreach (var photo in album.Photos)
            {
                photo.Id = string.IsNullOrWhiteSpace(photo.Id) ? Guid.NewGuid().ToString("N") : photo.Id;
                photo.Filename ??= "";
                photo.Caption ??= "";
            }

            if (!string.IsNullOrWhiteSpace(album.CoverPhotoId) && album.Photos.All(photo => !string.Equals(photo.Id, album.CoverPhotoId, StringComparison.Ordinal)))
                album.CoverPhotoId = album.Photos.FirstOrDefault()?.Id;
        }

        foreach (var video in normalized.Videos)
        {
            video.Id = string.IsNullOrWhiteSpace(video.Id) ? Guid.NewGuid().ToString("N") : video.Id;
            video.Filename ??= "";
            video.ThumbnailFilename ??= "";
            video.Title ??= "";
            video.Description ??= "";
        }

        foreach (var file in normalized.SharedFiles)
        {
            file.Id = string.IsNullOrWhiteSpace(file.Id) ? Guid.NewGuid().ToString("N") : file.Id;
            file.Filename ??= "";
            file.DisplayName ??= "";
            file.Description ??= "";
            if (file.FileSize < 0)
                file.FileSize = 0;
        }

        return normalized;
    }

    private static List<HomepageModule> NormalizeModules(List<HomepageModule>? modules)
    {
        var defaults = new HomepageConfig().Modules;
        var normalized = modules ?? new List<HomepageModule>();

        foreach (var module in normalized)
        {
            module.Id = string.IsNullOrWhiteSpace(module.Id) ? Guid.NewGuid().ToString("N") : module.Id;
            module.ConfigJson = string.IsNullOrWhiteSpace(module.ConfigJson) ? "{}" : module.ConfigJson;
        }

        foreach (var fallback in defaults)
        {
            if (normalized.All(module => module.Type != fallback.Type))
            {
                normalized.Add(new HomepageModule
                {
                    Type = fallback.Type,
                    Order = fallback.Order,
                    Enabled = fallback.Enabled,
                    ConfigJson = fallback.ConfigJson,
                });
            }
        }

        return normalized
            .OrderBy(module => module.Order)
            .Select((module, index) =>
            {
                module.Order = index;
                return module;
            })
            .ToList();
    }
}
