using System.Globalization;
using System.Text;

namespace DanceMonkey.Cli;

/// <summary>
/// 终端列宽估算（CJK 等宽字符计为 2），用于截断长标题，避免表格/列对齐错位。
/// </summary>
internal static class TerminalDisplayWidth
{
    /// <summary>估算字符串在等宽终端中占用的列数。</summary>
    public static int GetDisplayWidth(string? s)
    {
        if (string.IsNullOrEmpty(s)) return 0;
        int w = 0;
        foreach (var rune in s.EnumerateRunes())
            w += GetRuneWidth(rune);
        return w;
    }

    /// <summary>超过 <paramref name="maxCols"/> 时截断并在末尾加省略号（占 1 列的 ASCII … 用三个点代替以兼容宽度）。</summary>
    public static string TruncateToDisplayWidth(string? text, int maxCols)
    {
        if (string.IsNullOrEmpty(text) || maxCols <= 0) return "";
        if (GetDisplayWidth(text) <= maxCols) return text;

        const string ellipsis = "...";
        int ell = GetDisplayWidth(ellipsis);
        int budget = maxCols - ell;
        if (budget <= 0) return ellipsis[..Math.Min(maxCols, ellipsis.Length)];

        var sb = new StringBuilder();
        int used = 0;
        foreach (var rune in text.EnumerateRunes())
        {
            int rw = GetRuneWidth(rune);
            if (used + rw > budget) break;
            sb.Append(rune.ToString());
            used += rw;
        }

        return sb + ellipsis;
    }

    /// <summary>单码点显示宽度（简化版 East Asian Width，覆盖中日韩与全角区）。</summary>
    private static int GetRuneWidth(Rune r)
    {
        int v = r.Value;

        // 控制字符与组合用宽度 0（避免宽度膨胀）
        var cat = Rune.GetUnicodeCategory(r);
        if (cat is UnicodeCategory.NonSpacingMark or UnicodeCategory.EnclosingMark or UnicodeCategory.Format)
            return 0;

        if (v < 0x20) return 0;
        if (v == 0x7F) return 0;

        // 常见宽字符区（与 wcwidth 行为接近，足够用于 CLI 对齐）
        if (v is >= 0x1100 and <= 0x115F) return 2; // Hangul Jamo
        if (v is >= 0x2329 and <= 0x232A) return 2;
        if (v is >= 0x2E80 and <= 0xA4C6) return 2; // CJK 等
        if (v is >= 0xAC00 and <= 0xD7A3) return 2; // Hangul syllables
        if (v is >= 0xF900 and <= 0xFAFF) return 2;
        if (v is >= 0xFE10 and <= 0xFE19) return 2;
        if (v is >= 0xFE30 and <= 0xFE6B) return 2;
        if (v is >= 0xFF01 and <= 0xFF60) return 2; // Fullwidth ASCII
        if (v is >= 0xFFE0 and <= 0xFFE6) return 2;
        if (v is >= 0x20000 and <= 0x2FFFD) return 2;
        if (v is >= 0x30000 and <= 0x3FFFD) return 2;

        // 其余 BMP 多为半宽（含拉丁、数字）
        return 1;
    }
}
