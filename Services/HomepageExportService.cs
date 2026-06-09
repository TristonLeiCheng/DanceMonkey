using System.Text;
using DesktopAssistant.Models;

namespace DesktopAssistant.Services;

/// <summary>
/// Renders a <see cref="HomepageConfig"/> into a self-contained HTML page
/// using one of three built-in templates: "simple", "lively", "business".
/// All media URLs reference /media/... so the HTTP server can serve them.
/// </summary>
public sealed class HomepageExportService
{
    public string RenderHomepageHtml(HomepageConfig config)
    {
        var template = config.TemplateId?.ToLowerInvariant() switch
        {
            "lively"   => TemplateId.Lively,
            "simple"   => TemplateId.Simple,
            _          => TemplateId.Business,
        };

        var modules = config.Modules
            .Where(m => m.Enabled)
            .OrderBy(m => m.Order)
            .ToList();

        var sb = new StringBuilder();
        AppendHead(sb, config, template);
        sb.AppendLine("<body>");
        AppendPageWrapper(sb, config, modules, template);
        sb.AppendLine("</body></html>");
        return sb.ToString();
    }

    // ─── Head ────────────────────────────────────────────────────────────────

    private static void AppendHead(StringBuilder sb, HomepageConfig config, TemplateId t)
    {
        var title = HtmlEncode(config.Profile.DisplayName.Length > 0
            ? config.Profile.DisplayName + " 的主页"
            : "个人主页");

        sb.AppendLine($"""
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>{title}</title>
<style>
{GetCss(t)}
</style>
</head>
""");
    }

    // ─── Page body ───────────────────────────────────────────────────────────

    private static void AppendPageWrapper(StringBuilder sb, HomepageConfig config,
        List<HomepageModule> modules, TemplateId t)
    {
        sb.AppendLine("<div class=\"page-wrapper\">");
        sb.AppendLine("<main class=\"main-content\">");

        foreach (var module in modules)
        {
            switch (module.Type)
            {
                case HomepageModuleType.ProfileHeader:
                    AppendProfileHeader(sb, config, t);
                    break;
                case HomepageModuleType.SocialLinks:
                    AppendSocialLinks(sb, config.Profile.SocialLinks);
                    break;
                case HomepageModuleType.Albums:
                    AppendAlbums(sb, config.Albums);
                    break;
                case HomepageModuleType.Videos:
                    AppendVideos(sb, config.Videos);
                    break;
                case HomepageModuleType.SharedFiles:
                    AppendSharedFiles(sb, config.SharedFiles, t);
                    break;
                case HomepageModuleType.TextBlock:
                    AppendTextBlock(sb, module.ConfigJson);
                    break;
            }
        }

        sb.AppendLine("</main>");
        AppendFooter(sb, config);
        sb.AppendLine("</div>");
    }

    // ─── Modules ─────────────────────────────────────────────────────────────

    private static void AppendProfileHeader(StringBuilder sb, HomepageConfig config, TemplateId template)
    {
        var profile = config.Profile;
        var avatarHtml = !string.IsNullOrWhiteSpace(profile.AvatarFilename)
            ? $"<img class=\"avatar\" src=\"/media/avatars/{HtmlEncode(profile.AvatarFilename)}\" alt=\"头像\"/>"
            : "<div class=\"avatar avatar-placeholder\">👤</div>";

        var nameHtml    = HtmlEncode(profile.DisplayName);
        var taglineHtml = HtmlEncode(profile.Tagline);
        var bioHtml     = HtmlEncode(profile.Bio).Replace("\n", "<br/>");

        if (template == TemplateId.Business)
        {
            sb.AppendLine($"""
<section class="section profile-header">
  <div class="profile-cover"></div>
  <div class="profile-body">
    <div class="profile-avatar-wrap">{avatarHtml}</div>
    <div class="profile-info">
      {(nameHtml.Length > 0 ? $"<h1 class=\"profile-name\">{nameHtml}</h1>" : "")}
      {(taglineHtml.Length > 0 ? $"<p class=\"profile-tagline\">{taglineHtml}</p>" : "")}
      {(bioHtml.Length > 0 ? $"<p class=\"profile-bio\">{bioHtml}</p>" : "")}
    </div>
  </div>
  <div class="profile-info-bar">
    <div class="info-chip"><span class="info-chip-label">社交</span><span class="info-chip-value">{profile.SocialLinks.Count}</span></div>
    <div class="info-chip"><span class="info-chip-label">相册</span><span class="info-chip-value">{config.Albums.Count}</span></div>
    <div class="info-chip"><span class="info-chip-label">视频</span><span class="info-chip-value">{config.Videos.Count}</span></div>
    <div class="info-chip"><span class="info-chip-label">资源</span><span class="info-chip-value">{config.SharedFiles.Count}</span></div>
  </div>
</section>
""");
        }
        else
        {
            sb.AppendLine($"""
<section class="section profile-header">
  <div class="profile-inner">
    {avatarHtml}
    <div class="profile-text">
      {(nameHtml.Length > 0 ? $"<h1 class=\"profile-name\">{nameHtml}</h1>" : "")}
      {(taglineHtml.Length > 0 ? $"<p class=\"profile-tagline\">{taglineHtml}</p>" : "")}
      {(bioHtml.Length > 0 ? $"<p class=\"profile-bio\">{bioHtml}</p>" : "")}
    </div>
  </div>
</section>
""");
        }
    }

    private static void AppendSocialLinks(StringBuilder sb, List<HomepageSocialLink> links)
    {
        if (links.Count == 0) return;

        sb.AppendLine("<section class=\"section social-links\">");
        sb.AppendLine("<div class=\"social-links-inner\">");
        foreach (var link in links)
        {
            var icon = GetSocialIcon(link.Platform);
            var text = HtmlEncode(!string.IsNullOrWhiteSpace(link.DisplayText) ? link.DisplayText : link.Platform);
            var href = HtmlAttrEncode(link.Url);
            sb.AppendLine($"<a class=\"social-link\" href=\"{href}\" target=\"_blank\" rel=\"noopener\">{icon} {text}</a>");
        }
        sb.AppendLine("</div></section>");
    }

    private static void AppendAlbums(StringBuilder sb, List<HomepageAlbum> albums)
    {
        if (albums.Count == 0) return;

        sb.AppendLine("<section class=\"section albums\">");
        sb.AppendLine("<h2 class=\"section-title\">📷 相册</h2>");
        foreach (var album in albums)
        {
            sb.AppendLine($"<div class=\"album\">");
            sb.AppendLine($"<h3 class=\"album-title\">{HtmlEncode(album.Title)}</h3>");
            if (!string.IsNullOrWhiteSpace(album.Description))
                sb.AppendLine($"<p class=\"album-desc\">{HtmlEncode(album.Description)}</p>");

            if (album.Photos.Count > 0)
            {
                var displayPhotos = album.CoverPhotoId == null
                    ? album.Photos
                    : album.Photos
                        .OrderByDescending(photo => string.Equals(photo.Id, album.CoverPhotoId, StringComparison.Ordinal))
                        .ToList();

                sb.AppendLine("<div class=\"photo-grid\">");
                foreach (var photo in displayPhotos)
                {
                    var src     = $"/media/albums/{HtmlAttrEncode(album.Id)}/{HtmlAttrEncode(photo.Filename)}";
                    var caption = HtmlAttrEncode(photo.Caption);
                    sb.AppendLine($"<figure class=\"photo-item\">");
                    sb.AppendLine($"  <a href=\"{src}\" target=\"_blank\">");
                    sb.AppendLine($"    <img src=\"{src}\" alt=\"{caption}\" loading=\"lazy\"/>");
                    sb.AppendLine($"  </a>");
                    if (!string.IsNullOrWhiteSpace(photo.Caption))
                        sb.AppendLine($"  <figcaption>{HtmlEncode(photo.Caption)}</figcaption>");
                    sb.AppendLine("</figure>");
                }
                sb.AppendLine("</div>");
            }
            else
            {
                sb.AppendLine("<p class=\"empty-hint\">暂无照片</p>");
            }
            sb.AppendLine("</div>");
        }
        sb.AppendLine("</section>");
    }

    private static void AppendVideos(StringBuilder sb, List<HomepageVideo> videos)
    {
        if (videos.Count == 0) return;

        sb.AppendLine("<section class=\"section videos\">");
        sb.AppendLine("<h2 class=\"section-title\">🎬 视频</h2>");
        sb.AppendLine("<div class=\"video-grid\">");
        foreach (var video in videos)
        {
            var src = $"/media/videos/{HtmlAttrEncode(video.Id)}/{HtmlAttrEncode(video.Filename)}";
            sb.AppendLine("<div class=\"video-item\">");
            sb.AppendLine($"  <video controls preload=\"metadata\" poster=\"{(string.IsNullOrWhiteSpace(video.ThumbnailFilename) ? "" : $"/media/videos/{HtmlAttrEncode(video.Id)}/{HtmlAttrEncode(video.ThumbnailFilename)}")}\">");
            sb.AppendLine($"    <source src=\"{src}\"/>");
            sb.AppendLine("    您的浏览器不支持 video 标签。");
            sb.AppendLine("  </video>");
            if (!string.IsNullOrWhiteSpace(video.Title))
                sb.AppendLine($"  <p class=\"video-title\">{HtmlEncode(video.Title)}</p>");
            if (!string.IsNullOrWhiteSpace(video.Description))
                sb.AppendLine($"  <p class=\"video-desc\">{HtmlEncode(video.Description)}</p>");
            sb.AppendLine("</div>");
        }
        sb.AppendLine("</div></section>");
    }

    private static void AppendSharedFiles(StringBuilder sb, List<HomepageSharedFile> files, TemplateId template)
    {
        if (files.Count == 0) return;

        if (template == TemplateId.Business)
        {
            sb.AppendLine("<section class=\"section shared-files\">");
            sb.AppendLine("<h2 class=\"section-title\">📎 资源下载</h2>");
            sb.AppendLine("<div class=\"resource-grid\">");
            foreach (var f in files)
            {
                var href = $"/media/files/{HtmlAttrEncode(f.Filename)}";
                var name = HtmlEncode(!string.IsNullOrWhiteSpace(f.DisplayName) ? f.DisplayName : f.Filename);
                var size = FormatFileSize(f.FileSize);
                var icon = GetFileIcon(f.Filename);
                var descHtml = !string.IsNullOrWhiteSpace(f.Description)
                    ? $"<div class=\"resource-desc\">{HtmlEncode(f.Description)}</div>"
                    : "";
                sb.AppendLine($"""
  <div class="resource-card">
    <div class="resource-icon">{icon}</div>
    <a href="{href}" download class="resource-name">{name}</a>
    {descHtml}
    <div class="resource-meta">{size}</div>
    <a href="{href}" download class="resource-download">↓ 下载文件</a>
  </div>
""");
            }
            sb.AppendLine("</div></section>");
        }
        else
        {
            sb.AppendLine("<section class=\"section shared-files\">");
            sb.AppendLine("<h2 class=\"section-title\">📎 共享文件</h2>");
            sb.AppendLine("<ul class=\"file-list\">");
            foreach (var f in files)
            {
                var href = $"/media/files/{HtmlAttrEncode(f.Filename)}";
                var name = HtmlEncode(!string.IsNullOrWhiteSpace(f.DisplayName) ? f.DisplayName : f.Filename);
                var size = FormatFileSize(f.FileSize);
                sb.AppendLine($"<li class=\"file-item\">");
                sb.AppendLine($"  <a href=\"{href}\" download>{name}</a>");
                sb.AppendLine($"  <span class=\"file-meta\">{size}</span>");
                if (!string.IsNullOrWhiteSpace(f.Description))
                    sb.AppendLine($"  <span class=\"file-desc\"> — {HtmlEncode(f.Description)}</span>");
                sb.AppendLine("</li>");
            }
            sb.AppendLine("</ul></section>");
        }
    }

    private static void AppendTextBlock(StringBuilder sb, string configJson)
    {
        try
        {
            var doc = System.Text.Json.JsonDocument.Parse(configJson);
            var title   = doc.RootElement.TryGetProperty("title",   out var t) ? t.GetString() ?? "" : "";
            var content = doc.RootElement.TryGetProperty("content", out var c) ? c.GetString() ?? "" : "";
            if (string.IsNullOrWhiteSpace(content)) return;

            sb.AppendLine("<section class=\"section text-block\">");
            if (!string.IsNullOrWhiteSpace(title))
                sb.AppendLine($"<h2 class=\"section-title\">{HtmlEncode(title)}</h2>");
            sb.AppendLine($"<div class=\"text-content\">{HtmlEncode(content).Replace("\n", "<br/>")}</div>");
            sb.AppendLine("</section>");
        }
        catch { /* ignore malformed configJson */ }
    }

    private static void AppendFooter(StringBuilder sb, HomepageConfig config)
    {
        var year = DateTime.Now.Year;
        var name = HtmlEncode(config.Profile.DisplayName.Length > 0 ? config.Profile.DisplayName : "");
        sb.AppendLine($"""
<footer class="page-footer">
  <p>© {year} {name} · 由 DanceMonkey 个人主页生成</p>
</footer>
""");
    }

    // ─── CSS templates ───────────────────────────────────────────────────────

    private static string GetCss(TemplateId t) => t switch
    {
        TemplateId.Lively   => LivelyCss,
        TemplateId.Business => BusinessCss,
        _                   => SimpleCss,
    };

    private const string SimpleCss = """
*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
       background: #f5f7fa; color: #333; line-height: 1.7; }
.page-wrapper { max-width: 900px; margin: 0 auto; padding: 32px 20px 60px; }
.main-content { display: flex; flex-direction: column; gap: 40px; }
.section { background: #fff; border-radius: 14px; padding: 28px 32px;
           box-shadow: 0 2px 12px rgba(0,0,0,.07); }
.section-title { font-size: 1.2rem; font-weight: 700; margin: 0 0 18px;
                 color: #222; border-bottom: 2px solid #eef; padding-bottom: 10px; }
.profile-inner { display: flex; align-items: center; gap: 28px; flex-wrap: wrap; }
.avatar { width: 96px; height: 96px; border-radius: 50%; object-fit: cover;
          border: 3px solid #e8edf3; flex-shrink: 0; }
.avatar-placeholder { display: flex; align-items: center; justify-content: center;
                       background: #eef2fb; font-size: 42px; width: 96px; height: 96px;
                       border-radius: 50%; flex-shrink: 0; }
.profile-name { font-size: 1.8rem; margin: 0 0 6px; color: #111; }
.profile-tagline { font-size: 1.05rem; color: #5a7699; margin: 0 0 8px; font-style: italic; }
.profile-bio { margin: 0; color: #555; font-size: 0.97rem; }
.social-links-inner { display: flex; flex-wrap: wrap; gap: 10px; }
.social-link { display: inline-flex; align-items: center; gap: 6px; padding: 7px 16px;
               border-radius: 20px; background: #f0f4ff; color: #3a5fc8;
               text-decoration: none; font-size: 0.9rem; transition: background .2s; }
.social-link:hover { background: #dce6ff; }
.photo-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px,1fr)); gap: 12px; }
.photo-item { margin: 0; }
.photo-item img { width: 100%; height: 150px; object-fit: cover; border-radius: 8px;
                  display: block; transition: transform .2s; }
.photo-item img:hover { transform: scale(1.03); }
.photo-item figcaption { font-size: 0.78rem; color: #888; margin-top: 4px; text-align: center; }
.album { margin-bottom: 28px; }
.album-title { font-size: 1.05rem; font-weight: 600; margin: 0 0 4px; }
.album-desc { font-size: 0.88rem; color: #888; margin: 0 0 12px; }
.empty-hint { color: #bbb; font-size: 0.9rem; }
.video-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px,1fr)); gap: 20px; }
.video-item video { width: 100%; border-radius: 10px; background: #000; display: block; }
.video-title { font-weight: 600; margin: 8px 0 2px; font-size: 0.97rem; }
.video-desc { color: #777; font-size: 0.85rem; margin: 0; }
.file-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 10px; }
.file-item { display: flex; align-items: center; gap: 10px; padding: 10px 14px;
             background: #f8faff; border-radius: 8px; flex-wrap: wrap; }
.file-item a { color: #2a5bd7; text-decoration: none; font-weight: 500; }
.file-item a:hover { text-decoration: underline; }
.file-meta { color: #aaa; font-size: 0.8rem; }
.file-desc { color: #888; font-size: 0.85rem; }
.text-content { color: #444; font-size: 0.97rem; }
.page-footer { text-align: center; color: #bbb; font-size: 0.8rem; margin-top: 48px; }
""";

    private const string LivelyCss = """
*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; font-family: "Segoe UI", Helvetica, Arial, sans-serif;
       background: linear-gradient(135deg,#fce4ff 0%,#e0f0ff 50%,#fff9e6 100%);
       min-height: 100vh; color: #333; line-height: 1.7; }
.page-wrapper { max-width: 960px; margin: 0 auto; padding: 36px 20px 80px; }
.main-content { display: flex; flex-direction: column; gap: 36px; }
.section { background: rgba(255,255,255,.85); backdrop-filter: blur(12px);
           border-radius: 20px; padding: 30px 36px;
           box-shadow: 0 4px 24px rgba(160,100,220,.1); border: 1px solid rgba(255,255,255,.7); }
.section-title { font-size: 1.2rem; font-weight: 800; margin: 0 0 18px;
                 background: linear-gradient(90deg,#c050ff,#4090ff);
                 -webkit-background-clip: text; -webkit-text-fill-color: transparent;
                 border-bottom: 2px solid #f0e0ff; padding-bottom: 10px; }
.profile-inner { display: flex; align-items: center; gap: 32px; flex-wrap: wrap; }
.avatar { width: 108px; height: 108px; border-radius: 50%; object-fit: cover;
          border: 4px solid #fff; box-shadow: 0 0 0 4px #d480ff; flex-shrink: 0; }
.avatar-placeholder { display: flex; align-items: center; justify-content: center;
                       background: linear-gradient(135deg,#f3b0ff,#a0c8ff);
                       font-size: 46px; width: 108px; height: 108px;
                       border-radius: 50%; flex-shrink: 0; }
.profile-name { font-size: 2rem; margin: 0 0 6px; font-weight: 900;
                background: linear-gradient(90deg,#cc00ff,#2266ff);
                -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
.profile-tagline { font-size: 1.05rem; color: #aa44cc; margin: 0 0 10px; }
.profile-bio { margin: 0; color: #555; font-size: 0.97rem; }
.social-links-inner { display: flex; flex-wrap: wrap; gap: 10px; }
.social-link { display: inline-flex; align-items: center; gap: 6px; padding: 8px 18px;
               border-radius: 24px;
               background: linear-gradient(90deg,#f0c0ff,#c0d8ff);
               color: #7020aa; text-decoration: none; font-size: 0.9rem;
               transition: transform .2s, box-shadow .2s; font-weight: 600; }
.social-link:hover { transform: translateY(-2px); box-shadow: 0 4px 14px rgba(180,80,240,.25); }
.photo-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px,1fr)); gap: 12px; }
.photo-item { margin: 0; }
.photo-item img { width: 100%; height: 150px; object-fit: cover; border-radius: 14px;
                  display: block; transition: transform .25s, box-shadow .25s; }
.photo-item img:hover { transform: scale(1.05) rotate(-1deg); box-shadow: 0 8px 20px rgba(180,80,240,.2); }
.photo-item figcaption { font-size: 0.78rem; color: #bb66dd; margin-top: 4px; text-align: center; }
.album { margin-bottom: 28px; }
.album-title { font-size: 1.05rem; font-weight: 700; margin: 0 0 4px; color: #aa22cc; }
.album-desc { font-size: 0.88rem; color: #cc88ee; margin: 0 0 12px; }
.empty-hint { color: #ccc; font-size: 0.9rem; }
.video-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px,1fr)); gap: 20px; }
.video-item video { width: 100%; border-radius: 14px; background: #000; display: block; }
.video-title { font-weight: 700; margin: 8px 0 2px; color: #9922bb; }
.video-desc { color: #aa77cc; font-size: 0.85rem; margin: 0; }
.file-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 10px; }
.file-item { display: flex; align-items: center; gap: 10px; padding: 10px 16px;
             background: rgba(220,180,255,.15); border-radius: 12px; flex-wrap: wrap;
             border: 1px solid rgba(200,140,255,.3); }
.file-item a { color: #8822dd; text-decoration: none; font-weight: 600; }
.file-item a:hover { text-decoration: underline; }
.file-meta { color: #cc99ee; font-size: 0.8rem; }
.file-desc { color: #aa77cc; font-size: 0.85rem; }
.text-content { color: #555; font-size: 0.97rem; }
.page-footer { text-align: center; color: #cc99ee; font-size: 0.8rem; margin-top: 48px; }
""";

        private const string BusinessCss = """
*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; font-family: "Segoe UI Variable", "Segoe UI", "Microsoft YaHei", Arial, sans-serif;
       background: #f3f5f8; color: #182230; line-height: 1.7; }
.page-wrapper { max-width: 1120px; margin: 0 auto; padding: 28px 20px 72px; }
.main-content { display: flex; flex-direction: column; gap: 20px; }
.section { background: #fff; border-radius: 12px; padding: 24px 28px;
           box-shadow: 0 2px 10px rgba(15,23,42,.06), 0 1px 3px rgba(15,23,42,.04);
           border: 1px solid rgba(15,23,42,.06); }
/* Profile banner – Yammer enterprise cover */
.profile-header { padding: 0; overflow: hidden; }
.profile-cover { height: 140px; background: linear-gradient(135deg,#0a66c2 0%,#1e88e5 55%,#5ab3ff 100%); }
.profile-body { display: flex; gap: 20px; padding: 0 28px 20px; align-items: flex-end; flex-wrap: wrap; }
.profile-avatar-wrap { margin-top: -48px; flex-shrink: 0; }
.avatar { width: 96px; height: 96px; border-radius: 50%; object-fit: cover;
          border: 4px solid #fff; box-shadow: 0 4px 14px rgba(10,102,194,.2); }
.avatar-placeholder { display: flex; align-items: center; justify-content: center;
                      width: 96px; height: 96px; border-radius: 50%;
                      background: linear-gradient(180deg,#edf4fb 0%,#dfeaf8 100%);
                      color: #0a66c2; font-size: 40px; border: 4px solid #fff;
                      box-shadow: 0 4px 14px rgba(10,102,194,.2); }
.profile-info { flex: 1; min-width: 220px; padding-top: 12px; }
.profile-name { font-size: 1.8rem; margin: 0 0 4px; font-weight: 800; letter-spacing: -.03em; color: #16283d; }
.profile-tagline { font-size: 1rem; color: #0a66c2; margin: 0 0 8px; font-weight: 600; }
.profile-bio { margin: 0; color: #425466; font-size: .93rem; max-width: 680px; line-height: 1.65; }
/* Info summary bar */
.profile-info-bar { display: flex; border-top: 1px solid #e8edf5; padding: 0 28px;
                    background: #fafcff; flex-wrap: wrap; }
.info-chip { display: flex; flex-direction: column; padding: 12px 24px 12px 0;
             border-right: 1px solid #e8edf5; gap: 1px; }
.info-chip:last-child { border-right: 0; }
.info-chip-label { font-size: .7rem; font-weight: 700; color: #7a90a8;
                   text-transform: uppercase; letter-spacing: .07em; }
.info-chip-value { font-size: .9rem; font-weight: 800; color: #16283d; }
/* Section titles */
.section-title { font-size: .78rem; font-weight: 800; margin: 0 0 16px; color: #0f3d75;
                 border-bottom: 1px solid #e6edf6; padding-bottom: 10px;
                 text-transform: uppercase; letter-spacing: .09em; }
/* Social links */
.social-links { padding: 16px 28px; }
.social-links-inner { display: flex; flex-wrap: wrap; gap: 8px; }
.social-link { display: inline-flex; align-items: center; gap: 6px; padding: 7px 14px;
               border: 1px solid #d8e4f2; border-radius: 999px; background: #f7fbff;
               color: #0a66c2; text-decoration: none; font-size: .84rem; font-weight: 600; transition: .15s; }
.social-link:hover { background: #eaf3ff; border-color: #a8cef0; }
/* Albums */
.album { background: #fff; border: 1px solid #e7edf5; border-radius: 10px; padding: 16px; margin-bottom: 16px; }
.album:last-child { margin-bottom: 0; }
.album-title { font-size: .97rem; font-weight: 700; margin: 0 0 4px; color: #1b3657; }
.album-desc { font-size: .84rem; color: #6b7d90; margin: 0 0 12px; }
.empty-hint { color: #8da0b4; font-size: .88rem; }
.photo-grid { display: grid; grid-template-columns: repeat(auto-fill,minmax(185px,1fr)); gap: 10px; }
.photo-item { margin: 0; background: #f9fbfd; border-radius: 10px; overflow: hidden;
              border: 1px solid #edf2f7; transition: box-shadow .2s; }
.photo-item:hover { box-shadow: 0 4px 14px rgba(10,102,194,.1); }
.photo-item img { width: 100%; height: 155px; object-fit: cover; display: block; transition: transform .25s; }
.photo-item:hover img { transform: scale(1.04); }
.photo-item figcaption { font-size: .75rem; color: #607286; padding: 8px 10px 10px; }
/* Videos */
.video-grid { display: grid; grid-template-columns: repeat(auto-fill,minmax(300px,1fr)); gap: 16px; }
.video-item { background: #fff; border: 1px solid #e7edf5; border-radius: 10px; overflow: hidden; }
.video-item video { width: 100%; display: block; background: #000; }
.video-title { font-weight: 700; margin: 0; padding: 10px 14px 3px; color: #183b67; font-size: .95rem; }
.video-desc { color: #66788b; font-size: .84rem; margin: 0; padding: 0 14px 12px; }
/* Resource cards */
.resource-grid { display: grid; grid-template-columns: repeat(auto-fill,minmax(260px,1fr)); gap: 14px; }
.resource-card { background: #fff; border: 1px solid #e5edf7; border-radius: 10px;
                 padding: 16px 18px; display: flex; flex-direction: column; gap: 8px;
                 transition: box-shadow .18s, border-color .18s; }
.resource-card:hover { box-shadow: 0 4px 16px rgba(10,102,194,.1); border-color: #b8d4ef; }
.resource-icon { font-size: 26px; line-height: 1; }
.resource-name { font-weight: 700; color: #183b67; font-size: .93rem; text-decoration: none; word-break: break-all; }
.resource-name:hover { color: #0a66c2; text-decoration: underline; }
.resource-desc { font-size: .83rem; color: #66788b; }
.resource-meta { font-size: .74rem; color: #7f92a8; }
.resource-download { display: inline-flex; align-items: center; gap: 5px; padding: 6px 12px;
                     background: #eaf3ff; color: #0a66c2; border: 1px solid #c9e0f6;
                     border-radius: 6px; font-size: .82rem; font-weight: 700;
                     text-decoration: none; transition: .15s; width: fit-content; margin-top: 2px; }
.resource-download:hover { background: #d3e8fc; }
/* Text block */
.text-block { background: linear-gradient(180deg,#ffffff 0%,#fbfcfe 100%); }
.text-content { color: #314154; font-size: .95rem; }
/* Footer */
.page-footer { text-align: center; color: #8fa0b3; font-size: .78rem; margin-top: 38px;
               border-top: 1px solid #dce5ef; padding: 18px 20px; }
@media (max-width: 760px) {
    .profile-cover { height: 100px; }
    .profile-body { flex-direction: column; align-items: flex-start; padding: 0 16px 16px; }
    .profile-avatar-wrap { margin-top: -40px; }
    .profile-info-bar { padding: 0 16px; }
    .info-chip { padding: 10px 16px 10px 0; }
    .resource-grid { grid-template-columns: 1fr; }
    .social-links { padding: 12px 16px; }
}
""";

    // ─── Utility ─────────────────────────────────────────────────────────────

    private enum TemplateId { Simple, Lively, Business }

    private static string GetSocialIcon(string platform) => platform?.ToLowerInvariant() switch
    {
        "github"    => "🐙",
        "twitter" or "x" => "🐦",
        "微信" or "wechat"  => "💬",
        "微博" or "weibo"   => "🌐",
        "linkedin"  => "💼",
        "bilibili"  => "📺",
        "youtube"   => "▶",
        "instagram" => "📷",
        "email" or "邮件"  => "✉",
        _           => "🔗",
    };

    private static string GetFileIcon(string filename)
    {
        var ext = System.IO.Path.GetExtension(filename ?? "").ToLowerInvariant();
        return ext switch
        {
            ".pdf"  => "📄",
            ".doc" or ".docx" => "📝",
            ".xls" or ".xlsx" => "📊",
            ".ppt" or ".pptx" => "📑",
            ".zip" or ".rar" or ".7z" => "🗜",
            ".mp4" or ".avi" or ".mov" => "🎬",
            ".mp3" or ".wav" or ".flac" => "🎵",
            ".jpg" or ".jpeg" or ".png" or ".gif" => "🖼",
            ".txt" or ".md" => "📃",
            _ => "📎",
        };
    }

    private static string HtmlEncode(string s) =>
        System.Net.WebUtility.HtmlEncode(s ?? "");

    private static string HtmlAttrEncode(string s) =>
        Uri.EscapeDataString(s ?? "");

    private static string FormatFileSize(long bytes) => bytes switch
    {
        < 1024       => $"{bytes} B",
        < 1024*1024  => $"{bytes / 1024.0:F1} KB",
        _            => $"{bytes / (1024.0 * 1024):F1} MB",
    };
}
