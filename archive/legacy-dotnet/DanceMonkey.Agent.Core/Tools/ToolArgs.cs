using System.Text.Json;

namespace DanceMonkey.Agent.Core.Tools;

/// <summary>工具参数读取辅助（避免每个工具都写一遍 TryGetProperty 样板）。</summary>
public static class ToolArgs
{
    public static string GetString(JsonElement args, string key, string fallback = "")
    {
        if (args.ValueKind != JsonValueKind.Object) return fallback;
        if (!args.TryGetProperty(key, out var v)) return fallback;
        return v.ValueKind switch
        {
            JsonValueKind.String => v.GetString() ?? fallback,
            JsonValueKind.Number => v.ToString(),
            JsonValueKind.True or JsonValueKind.False => v.GetBoolean().ToString(),
            _ => fallback,
        };
    }

    public static int GetInt(JsonElement args, string key, int fallback)
    {
        if (args.ValueKind != JsonValueKind.Object) return fallback;
        if (!args.TryGetProperty(key, out var v)) return fallback;
        return v.ValueKind switch
        {
            JsonValueKind.Number when v.TryGetInt32(out var i) => i,
            JsonValueKind.String when int.TryParse(v.GetString(), out var i) => i,
            _ => fallback,
        };
    }

    public static bool GetBool(JsonElement args, string key, bool fallback)
    {
        if (args.ValueKind != JsonValueKind.Object) return fallback;
        if (!args.TryGetProperty(key, out var v)) return fallback;
        return v.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            JsonValueKind.String when bool.TryParse(v.GetString(), out var b) => b,
            _ => fallback,
        };
    }
}
