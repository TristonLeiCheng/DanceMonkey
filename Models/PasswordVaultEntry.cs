using System.Text.Json.Serialization;

namespace DesktopAssistant.Models;

/// <summary>单条密码条目（仅解密后驻留内存）。</summary>
public sealed class PasswordVaultEntry
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    [JsonPropertyName("title")]
    public string Title { get; set; } = "";

    /// <summary>业务/应用系统名称（如 ERP、AD）。</summary>
    [JsonPropertyName("systemName")]
    public string SystemName { get; set; } = "";

    /// <summary>系统级别：P（生产）/ Q（预发）/ D（开发），空表示未指定。</summary>
    [JsonPropertyName("systemLevel")]
    public string SystemLevel { get; set; } = "";

    [JsonPropertyName("username")]
    public string Username { get; set; } = "";

    [JsonPropertyName("password")]
    public string Password { get; set; } = "";

    [JsonPropertyName("url")]
    public string Url { get; set; } = "";

    [JsonPropertyName("notes")]
    public string Notes { get; set; } = "";

    /// <summary>分组（KeePass 风格，预留）。</summary>
    [JsonPropertyName("group")]
    public string Group { get; set; } = "常规";

    [JsonIgnore]
    public string PasswordMask =>
        string.IsNullOrEmpty(Password) ? "—" : new string('●', Math.Min(16, Password.Length));

    /// <summary>表格展示：P/Q/D 或 —</summary>
    [JsonIgnore]
    public string SystemLevelDisplay
    {
        get
        {
            var n = NormalizeSystemLevel(SystemLevel);
            return string.IsNullOrEmpty(n) ? "—" : n;
        }
    }

    /// <summary>仅允许 P / Q / D，其余视为未指定。</summary>
    public static string NormalizeSystemLevel(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
            return "";
        var t = value.Trim().ToUpperInvariant();
        return t is "P" or "Q" or "D" ? t : "";
    }
}
