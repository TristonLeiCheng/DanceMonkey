using System.Text.Json;
using System.Text.Json.Serialization;

namespace DesktopAssistant.Services;

public sealed class ZenTaskFileEnvelope<TTask>
{
    public int SchemaVersion { get; set; }
    public List<TTask> Items { get; set; } = new();

    [JsonExtensionData]
    public Dictionary<string, JsonElement>? AdditionalProperties { get; set; }
}

public static class ZenTaskFileFormat
{
    /// <summary>
    /// Parses envelope or legacy array JSON. Object envelopes retain explicit positive schema
    /// versions; missing or non-positive versions are normalized to defaultSchemaVersion.
    /// </summary>
    public static ZenTaskFileEnvelope<TTask> Deserialize<TTask>(
        string json,
        JsonSerializerOptions options,
        int defaultSchemaVersion)
    {
        using var document = JsonDocument.Parse(
            json,
            new JsonDocumentOptions
            {
                CommentHandling = options.ReadCommentHandling,
                AllowTrailingCommas = options.AllowTrailingCommas
            });

        if (document.RootElement.ValueKind == JsonValueKind.Object)
        {
            var envelope = JsonSerializer.Deserialize<ZenTaskFileEnvelope<TTask>>(json, options)
                ?? throw new JsonException("Task store envelope cannot be null.");
            envelope.Items ??= new List<TTask>();
            if (envelope.SchemaVersion <= 0)
                envelope.SchemaVersion = defaultSchemaVersion;
            return envelope;
        }

        if (document.RootElement.ValueKind == JsonValueKind.Array)
        {
            var items = JsonSerializer.Deserialize<List<TTask>>(json, options) ?? new List<TTask>();
            return new ZenTaskFileEnvelope<TTask>
            {
                SchemaVersion = defaultSchemaVersion,
                Items = items
            };
        }

        throw new JsonException("Task store root must be an object or array.");
    }

    public static string Serialize<TTask>(
        ZenTaskFileEnvelope<TTask> envelope,
        JsonSerializerOptions options) =>
        JsonSerializer.Serialize(envelope, options);
}

public static class ZenTaskMergeHelper
{
    /// <summary>
    /// Three-way merge policy: independent changes compose; for same-task changes the later
    /// UpdatedAt wins and local wins exact ties. A changed task wins over a concurrent deletion.
    /// </summary>
    public static IReadOnlyList<TTask> Merge<TTask>(
        IReadOnlyList<TTask> baseline,
        IReadOnlyList<TTask> local,
        IReadOnlyList<TTask> remote,
        Func<TTask, string> idSelector,
        Func<TTask, DateTime> updatedAtSelector,
        Func<TTask, TTask, bool> equivalent)
        where TTask : class
    {
        var baselineById = Index(baseline, idSelector);
        var localById = Index(local, idSelector);
        var remoteById = Index(remote, idSelector);
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var merged = new List<TTask>();

        foreach (var remoteTask in remote)
        {
            var id = idSelector(remoteTask);
            if (!seen.Add(id))
                continue;

            baselineById.TryGetValue(id, out var baselineTask);
            localById.TryGetValue(id, out var localTask);
            var resolved = Resolve(
                baselineTask,
                localTask,
                remoteTask,
                updatedAtSelector,
                equivalent);
            if (resolved != null)
                merged.Add(resolved);
        }

        foreach (var localTask in local)
        {
            var id = idSelector(localTask);
            if (!seen.Add(id))
                continue;

            baselineById.TryGetValue(id, out var baselineTask);
            remoteById.TryGetValue(id, out var remoteTask);
            var resolved = Resolve(
                baselineTask,
                localTask,
                remoteTask,
                updatedAtSelector,
                equivalent);
            if (resolved != null)
                merged.Add(resolved);
        }

        return merged;
    }

    public static void MergeIntoLatestEnvelope<TTask>(
        ZenTaskFileEnvelope<TTask> latest,
        IReadOnlyList<TTask> baseline,
        IReadOnlyList<TTask> local,
        Func<TTask, string> idSelector,
        Func<TTask, DateTime> updatedAtSelector,
        Func<TTask, TTask, bool> equivalent)
        where TTask : class
    {
        latest.Items = Merge(
            baseline,
            local,
            latest.Items,
            idSelector,
            updatedAtSelector,
            equivalent).ToList();
    }

    private static Dictionary<string, TTask> Index<TTask>(
        IReadOnlyList<TTask> tasks,
        Func<TTask, string> idSelector)
        where TTask : class
    {
        var index = new Dictionary<string, TTask>(StringComparer.OrdinalIgnoreCase);
        foreach (var task in tasks)
        {
            var id = idSelector(task);
            if (!index.TryAdd(id, task))
                throw new InvalidDataException($"Duplicate task ID '{id}'.");
        }

        return index;
    }

    private static TTask? Resolve<TTask>(
        TTask? baseline,
        TTask? local,
        TTask? remote,
        Func<TTask, DateTime> updatedAtSelector,
        Func<TTask, TTask, bool> equivalent)
        where TTask : class
    {
        if (local == null)
        {
            if (remote == null)
                return null;
            return baseline == null || !equivalent(remote, baseline) ? remote : null;
        }

        if (remote == null)
            return baseline == null || !equivalent(local, baseline) ? local : null;

        if (baseline == null)
            return ResolveConflict(local, remote, updatedAtSelector, equivalent);

        var localChanged = !equivalent(local, baseline);
        var remoteChanged = !equivalent(remote, baseline);
        if (!localChanged)
            return remote;
        if (!remoteChanged)
            return local;

        return ResolveConflict(local, remote, updatedAtSelector, equivalent);
    }

    private static TTask ResolveConflict<TTask>(
        TTask local,
        TTask remote,
        Func<TTask, DateTime> updatedAtSelector,
        Func<TTask, TTask, bool> equivalent)
    {
        if (equivalent(local, remote))
            return remote;

        return updatedAtSelector(local) >= updatedAtSelector(remote) ? local : remote;
    }
}
