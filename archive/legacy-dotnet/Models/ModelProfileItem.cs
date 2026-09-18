using System.Text.Json.Serialization;

namespace DesktopAssistant.Models;

public sealed class ModelProfileItem
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    [JsonPropertyName("model")]
    public string Model { get; set; } = "";

    [JsonIgnore]
    public string DisplayName =>
        string.IsNullOrWhiteSpace(Name) || string.Equals(Name.Trim(), Model.Trim(), StringComparison.OrdinalIgnoreCase)
            ? Model.Trim()
            : $"{Name.Trim()} · {Model.Trim()}";
}
