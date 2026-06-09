namespace DesktopAssistant.Services;

public sealed class RenamePreviewRow
{
    public required string OldFullPath { get; init; }
    public required string OldName { get; init; }
    public required string NewName { get; init; }
    public required string DirectoryName { get; init; }
    public string NewFullPath => Path.Combine(DirectoryName, NewName);
}

/// <summary>同一文件夹内批量重命名：前缀/后缀、文件名中查找替换、可选序号。</summary>
public static class BatchRenameService
{
    /// <summary>
    /// 生成预览。<paramref name="filesOrdered"/> 顺序即序号递增顺序。
    /// 无序号：<c>新主名 = prefix + stem(可替换) + suffix</c>。
    /// 有序号：<c>prefix + 序号 + "_" + stem(可替换) + suffix</c>；若前后缀皆空则 <c>序号_stem</c>。
    /// </summary>
    public static IReadOnlyList<RenamePreviewRow> Preview(
        IReadOnlyList<string> filesOrdered,
        string directory,
        string prefix,
        string suffix,
        string findInName,
        string replaceInName,
        bool addIndex,
        int indexDigits,
        int startIndex)
    {
        if (filesOrdered.Count == 0)
            return Array.Empty<RenamePreviewRow>();

        var dir = Path.GetFullPath(directory);
        var list = new List<RenamePreviewRow>(filesOrdered.Count);
        var n = startIndex;
        var width = Math.Clamp(indexDigits, 1, 9);
        foreach (var full in filesOrdered)
        {
            var name = Path.GetFileName(full);
            if (name == null) continue;
            var stem = Path.GetFileNameWithoutExtension(name);
            var ext = Path.GetExtension(name);

            if (!string.IsNullOrEmpty(findInName))
                stem = stem.Replace(findInName, replaceInName ?? "", StringComparison.Ordinal);

            string newStem;
            if (addIndex)
            {
                var fmt = width <= 1 ? "D1" : $"D{width}";
                var idxStr = n.ToString(fmt);
                newStem = string.IsNullOrEmpty(prefix) && string.IsNullOrEmpty(suffix)
                    ? $"{idxStr}_{stem}"
                    : $"{prefix}{idxStr}_{stem}{suffix}";
                n++;
            }
            else
            {
                newStem = $"{prefix}{stem}{suffix}";
            }

            var newName = newStem + ext;
            list.Add(new RenamePreviewRow
            {
                OldFullPath = full,
                OldName = name,
                NewName = newName,
                DirectoryName = dir
            });
        }

        return list;
    }

    /// <summary>执行重命名。若目标已存在则跳过该行并记入 errors。</summary>
    public static void Apply(IReadOnlyList<RenamePreviewRow> rows, out List<string> errors)
    {
        errors = new List<string>();
        foreach (var row in rows)
        {
            if (string.Equals(row.OldFullPath, row.NewFullPath, StringComparison.OrdinalIgnoreCase))
                continue;

            if (File.Exists(row.NewFullPath))
            {
                errors.Add($"已存在，跳过：{row.NewName}");
                continue;
            }

            try
            {
                File.Move(row.OldFullPath, row.NewFullPath);
            }
            catch (Exception ex)
            {
                errors.Add($"{row.OldName} → {row.NewName}：{ex.Message}");
            }
        }
    }
}
