using System.Globalization;
using PdfSharpCore.Pdf;
using PdfSharpCore.Pdf.IO;

namespace DesktopAssistant.Services;

public static class PdfToolsService
{
    public static void Merge(IReadOnlyList<string> inputPaths, string outputPath)
    {
        if (inputPaths.Count == 0)
            throw new ArgumentException("请至少选择一个 PDF 文件。");

        var output = new PdfDocument();
        try
        {
            foreach (var path in inputPaths)
            {
                if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
                    throw new FileNotFoundException($"文件不存在：{path}");

                var input = PdfReader.Open(path, PdfDocumentOpenMode.Import);
                try
                {
                    for (var i = 0; i < input.PageCount; i++)
                        output.AddPage(input.Pages[i]);
                }
                finally
                {
                    input.Close();
                }
            }

            output.Save(outputPath);
        }
        finally
        {
            output.Close();
        }
    }

    /// <summary>每一页保存为单独的 PDF。</summary>
    public static void SplitEachPage(string inputPath, string outputDirectory, string fileNamePrefix)
    {
        if (!File.Exists(inputPath))
            throw new FileNotFoundException(inputPath);

        Directory.CreateDirectory(outputDirectory);
        var prefix = string.IsNullOrWhiteSpace(fileNamePrefix)
            ? Path.GetFileNameWithoutExtension(inputPath)
            : fileNamePrefix.Trim();

        var src = PdfReader.Open(inputPath, PdfDocumentOpenMode.Import);
        try
        {
            var n = src.PageCount;
            for (var i = 0; i < n; i++)
            {
                var outDoc = new PdfDocument();
                try
                {
                    outDoc.AddPage(src.Pages[i]);
                    var name = $"{prefix}_p{(i + 1).ToString("D3", CultureInfo.InvariantCulture)}.pdf";
                    outDoc.Save(Path.Combine(outputDirectory, name));
                }
                finally
                {
                    outDoc.Close();
                }
            }
        }
        finally
        {
            src.Close();
        }
    }

    /// <summary>
    /// 按页码范围拆成多个文件。ranges 示例：<c>1-3,5,7-9</c>（1 起始，含端点）。
    /// 每个连续区间生成一个 PDF。
    /// </summary>
    public static void SplitByRanges(string inputPath, string outputDirectory, string ranges, string fileNamePrefix)
    {
        if (!File.Exists(inputPath))
            throw new FileNotFoundException(inputPath);

        var intervals = ParsePageRanges(ranges, out var maxPage);
        if (intervals.Count == 0)
            throw new ArgumentException("请输入有效的页码范围，例如：1-3,5,8-10");

        Directory.CreateDirectory(outputDirectory);
        var prefix = string.IsNullOrWhiteSpace(fileNamePrefix)
            ? Path.GetFileNameWithoutExtension(inputPath)
            : fileNamePrefix.Trim();

        var src = PdfReader.Open(inputPath, PdfDocumentOpenMode.Import);
        try
        {
            var pageCount = src.PageCount;
            if (maxPage > pageCount)
                throw new ArgumentException($"页码超出文档页数（共 {pageCount} 页）。");

            for (var p = 0; p < intervals.Count; p++)
            {
                var (from, to) = intervals[p];
                var outDoc = new PdfDocument();
                try
                {
                    for (var pageNum = from; pageNum <= to; pageNum++)
                        outDoc.AddPage(src.Pages[pageNum - 1]);

                    var label = from == to ? $"{from}" : $"{from}-{to}";
                    var name = $"{prefix}_part{p + 1}_{label}.pdf";
                    outDoc.Save(Path.Combine(outputDirectory, name));
                }
                finally
                {
                    outDoc.Close();
                }
            }
        }
        finally
        {
            src.Close();
        }
    }

    public static int GetPageCount(string inputPath)
    {
        if (!File.Exists(inputPath))
            throw new FileNotFoundException(inputPath);
        var src = PdfReader.Open(inputPath, PdfDocumentOpenMode.Import);
        try
        {
            return src.PageCount;
        }
        finally
        {
            src.Close();
        }
    }

    /// <summary>解析区间列表，返回 1-based 闭区间；maxPage 为出现的最大页码。</summary>
    private static List<(int From, int To)> ParsePageRanges(string ranges, out int maxPage)
    {
        maxPage = 0;
        var list = new List<(int, int)>();
        foreach (var raw in ranges.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            if (string.IsNullOrEmpty(raw))
                continue;
            if (raw.Contains('-', StringComparison.Ordinal))
            {
                var parts = raw.Split('-', 2);
                if (parts.Length != 2 ||
                    !int.TryParse(parts[0].Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var a) ||
                    !int.TryParse(parts[1].Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var b))
                    throw new ArgumentException($"无法解析范围：{raw}");
                if (a > b)
                    (a, b) = (b, a);
                if (a < 1)
                    throw new ArgumentException("页码须 ≥ 1");
                list.Add((a, b));
                maxPage = Math.Max(maxPage, b);
            }
            else
            {
                if (!int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out var n))
                    throw new ArgumentException($"无法解析页码：{raw}");
                if (n < 1)
                    throw new ArgumentException("页码须 ≥ 1");
                list.Add((n, n));
                maxPage = Math.Max(maxPage, n);
            }
        }

        return list;
    }
}
