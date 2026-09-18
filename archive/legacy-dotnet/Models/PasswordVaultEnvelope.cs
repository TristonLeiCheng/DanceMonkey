using System.Text.Json.Serialization;

namespace DesktopAssistant.Models;

/// <summary>磁盘上的加密封装（Base64 字段）。</summary>
public sealed class PasswordVaultEnvelope
{
    [JsonPropertyName("version")]
    public int Version { get; set; } = 1;

    [JsonPropertyName("salt")]
    public string SaltBase64 { get; set; } = "";

    [JsonPropertyName("nonce")]
    public string NonceBase64 { get; set; } = "";

    /// <summary>AES-GCM：密文 + Tag 拼接后的二进制。</summary>
    [JsonPropertyName("ciphertext")]
    public string CiphertextBase64 { get; set; } = "";
}
