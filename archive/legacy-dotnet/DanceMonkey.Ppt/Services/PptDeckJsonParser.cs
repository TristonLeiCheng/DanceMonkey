using System.Text.Json;
using System.Text.RegularExpressions;
using DanceMonkey.Ppt.Models;

namespace DanceMonkey.Ppt.Services;

/// <summary>
/// 把 LLM 返回的 JSON 文本解析为 <see cref="PptDeck"/>。
/// 同时支持：
/// <list type="bullet">
///   <item>P2 新 schema：deckTitle / subtitle / sections[].slides[].layoutHint/bullets/speakerNotes/media[]</item>
///   <item>P1 旧 schema：deckTitle / slides[].title/bullets （自动包装为单章节）</item>
/// </list>
/// 不做严格校验：缺失字段以默认值兜底，避免单字段差异导致整体失败。
/// </summary>
internal static class PptDeckJsonParser
{
    /// <summary>解析；失败时返回 false 并填充 <paramref name="error"/>。</summary>
    public static bool TryParse(string raw, out PptDeck? deck, out string? error)
    {
        deck = null;
        error = null;

        var json = ExtractJsonObject(raw);
        if (string.IsNullOrWhiteSpace(json))
        {
            error = "无法从模型回复中识别 JSON。";
            return false;
        }

        JsonDocument? doc = null;
        try
        {
            doc = JsonDocument.Parse(json);
        }
        catch (Exception ex)
        {
            error = $"JSON 解析失败：{ex.Message}";
            return false;
        }

        try
        {
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                error = "JSON 根节点必须是对象。";
                return false;
            }

            // 新 schema 的特征：存在非空 sections 数组
            if (TryReadArray(root, "sections", out var sectionsEl) && sectionsEl.GetArrayLength() > 0)
            {
                deck = ParseModernDeck(root, sectionsEl);
                return ValidateDeck(deck, out error);
            }

            // 旧 schema：存在 slides 数组
            if (TryReadArray(root, "slides", out var slidesEl) && slidesEl.GetArrayLength() > 0)
            {
                deck = ParseLegacyDeck(root, slidesEl);
                return ValidateDeck(deck, out error);
            }

            error = "JSON 中缺少 sections 或 slides 数组。";
            return false;
        }
        catch (Exception ex)
        {
            error = $"反序列化失败：{ex.Message}";
            return false;
        }
        finally
        {
            doc.Dispose();
        }
    }

    private static bool ValidateDeck(PptDeck? deck, out string? error)
    {
        if (deck == null || deck.Sections.Count == 0 || deck.EnumerateSlides().FirstOrDefault() == null)
        {
            error = "解析得到的 Deck 没有任何内容页。";
            return false;
        }
        error = null;
        return true;
    }

    // ── 新 schema 解析 ─────────────────────────────────────────────────

    private static PptDeck ParseModernDeck(JsonElement root, JsonElement sectionsEl)
    {
        var deck = new PptDeck
        {
            Title = ReadString(root, "deckTitle") ?? ReadString(root, "title"),
            Subtitle = ReadString(root, "subtitle"),
            Audience = ReadString(root, "audience"),
            Purpose = ReadString(root, "purpose"),
            Author = ReadString(root, "author"),
        };

        foreach (var sEl in sectionsEl.EnumerateArray())
        {
            if (sEl.ValueKind != JsonValueKind.Object) continue;

            var section = new PptSection
            {
                Title = ReadString(sEl, "title"),
                Summary = ReadString(sEl, "summary"),
            };

            if (TryReadArray(sEl, "slides", out var slidesEl))
            {
                foreach (var sl in slidesEl.EnumerateArray())
                {
                    if (sl.ValueKind != JsonValueKind.Object) continue;
                    section.Slides.Add(ParseSlide(sl));
                }
            }

            if (section.Slides.Count > 0)
                deck.Sections.Add(section);
        }

        return deck;
    }

    private static PptSlide ParseSlide(JsonElement slideEl)
    {
        var slide = new PptSlide
        {
            Title = ReadString(slideEl, "title"),
            Subtitle = ReadString(slideEl, "subtitle"),
            SpeakerNotes = ReadString(slideEl, "speakerNotes"),
            KeyMessage = ReadString(slideEl, "keyMessage"),
            VisualSuggestion = ReadString(slideEl, "visualSuggestion"),
            LayoutHint = ParseLayoutHint(ReadString(slideEl, "layoutHint")),
        };

        if (TryReadArray(slideEl, "bullets", out var bulletsEl))
        {
            foreach (var b in bulletsEl.EnumerateArray())
            {
                if (b.ValueKind == JsonValueKind.String)
                {
                    var s = b.GetString();
                    if (!string.IsNullOrWhiteSpace(s)) slide.Bullets.Add(s.Trim());
                }
            }
        }

        if (TryReadArray(slideEl, "rightBullets", out var rightEl))
        {
            foreach (var b in rightEl.EnumerateArray())
            {
                if (b.ValueKind == JsonValueKind.String)
                {
                    var s = b.GetString();
                    if (!string.IsNullOrWhiteSpace(s)) slide.RightBullets.Add(s.Trim());
                }
            }
        }

        if (TryReadArray(slideEl, "paragraphs", out var parasEl))
        {
            foreach (var p in parasEl.EnumerateArray())
            {
                if (p.ValueKind == JsonValueKind.String)
                {
                    var s = p.GetString();
                    if (!string.IsNullOrWhiteSpace(s)) slide.Paragraphs.Add(s.Trim());
                }
            }
        }

        // media 数组（P2 schema 已声明，P3+ 渲染器会用；这里先解析进来）
        if (TryReadArray(slideEl, "media", out var mediaEl))
        {
            foreach (var m in mediaEl.EnumerateArray())
            {
                if (m.ValueKind != JsonValueKind.Object) continue;
                var kind = ReadString(m, "kind")?.ToLowerInvariant();
                slide.Media.Add(new PptMedia
                {
                    Kind = kind switch
                    {
                        "table" => PptMediaKind.Table,
                        "chart" => PptMediaKind.Chart,
                        _ => PptMediaKind.Image,
                    },
                    Source = ReadString(m, "source"),
                    Caption = ReadString(m, "caption"),
                });
            }
        }

        // 当 twoColumn 版式但右栏为空时，若 rightBullets 已填则保持；否则尝试自动降级
        if (slide.LayoutHint == PptLayoutHint.TwoColumn && slide.RightBullets.Count == 0)
            slide.LayoutHint = PptLayoutHint.Bullets;

        return slide;
    }

    // ── 旧 schema 解析（P1 兼容） ────────────────────────────────────

    private static PptDeck ParseLegacyDeck(JsonElement root, JsonElement slidesEl)
    {
        var deckTitle = ReadString(root, "deckTitle") ?? "演示文稿";
        var deck = new PptDeck { Title = deckTitle };

        var section = new PptSection { Title = deckTitle };
        foreach (var sl in slidesEl.EnumerateArray())
        {
            if (sl.ValueKind != JsonValueKind.Object) continue;
            var title = ReadString(sl, "title");
            var bullets = new List<string>();
            if (TryReadArray(sl, "bullets", out var bs))
            {
                foreach (var b in bs.EnumerateArray())
                {
                    if (b.ValueKind == JsonValueKind.String)
                    {
                        var t = b.GetString();
                        if (!string.IsNullOrWhiteSpace(t)) bullets.Add(t.Trim());
                    }
                }
            }
            section.Slides.Add(PptSlide.FromLegacy(title, bullets));
        }

        deck.Sections.Add(section);
        return deck;
    }

    // ── 工具 ─────────────────────────────────────────────────────────

    private static PptLayoutHint ParseLayoutHint(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return PptLayoutHint.Bullets;
        return value.Trim().ToLowerInvariant() switch
        {
            "title" => PptLayoutHint.Title,
            "section" => PptLayoutHint.Section,
            "bullets" => PptLayoutHint.Bullets,
            "two-column" or "twocolumn" => PptLayoutHint.TwoColumn,
            "image-right" or "imageright" => PptLayoutHint.ImageRight,
            "table" => PptLayoutHint.Table,
            "quote" => PptLayoutHint.Quote,
            "ending" => PptLayoutHint.Ending,
            _ => PptLayoutHint.Bullets,
        };
    }

    private static string? ReadString(JsonElement obj, string name)
    {
        if (!obj.TryGetProperty(name, out var p)) return null;
        return p.ValueKind == JsonValueKind.String ? p.GetString() : null;
    }

    private static bool TryReadArray(JsonElement obj, string name, out JsonElement arr)
    {
        if (obj.TryGetProperty(name, out var p) && p.ValueKind == JsonValueKind.Array)
        {
            arr = p;
            return true;
        }
        arr = default;
        return false;
    }

    private static string ExtractJsonObject(string raw)
    {
        var t = raw.Trim();
        var fence = Regex.Match(t, @"```(?:json)?\s*([\s\S]*?)```", RegexOptions.IgnoreCase);
        if (fence.Success)
            t = fence.Groups[1].Value.Trim();

        var start = t.IndexOf('{');
        var end = t.LastIndexOf('}');
        if (start < 0 || end <= start)
            return string.Empty;
        return t.Substring(start, end - start + 1);
    }
}
