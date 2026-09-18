using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using DesktopAssistant.Services;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace DesktopAssistant;

/// <summary>
/// 全屏半透明遮罩：先拖出初始选区，再移动/缩放矩形，最后在工具栏执行截图或 AI/OCR 等。
/// </summary>
public sealed class RegionCaptureForm : Form
{
    public enum CaptureMode
    {
        Region,
        Scrolling
    }

    private enum Phase
    {
        Selecting,
        Adjusting
    }

    private enum HitKind
    {
        None,
        Move,
        Nw,
        N,
        Ne,
        E,
        Se,
        S,
        Sw,
        W
    }

    private const int MinSize = 4;
    private const int HandleHalf = 5;
    private const int ScrollWheelDelta = 120;
    // 加深遮罩，提升屏幕内容与选区边界的对比度。
    private const int DimAlphaSelecting = 100;
    private const int DimAlphaAdjusting = 140;

    private readonly Action<string> _onSaved;
    private readonly Action? _onCancel;
    private readonly Action<string>? _onAiFromPath;
    private readonly Action<string>? _onOcrFromPath;
    private readonly CaptureMode _mode;
    private readonly string? _notesRootPath;
    private Bitmap? _desktopSnapshot;

    private Phase _phase = Phase.Selecting;
    private Point _anchor;
    private Point _current;
    private bool _dragging;
    private Rectangle _selClient;

    private HitKind _activeHit = HitKind.None;
    private Point _adjustStartMouse;
    private Rectangle _adjustStartRect;

    private FlowLayoutPanel? _toolbar;

    public RegionCaptureForm(
        Action<string> onSaved,
        Action? onCancel = null,
        Action<string>? onAiFromPath = null,
        Action<string>? onOcrFromPath = null,
        CaptureMode mode = CaptureMode.Region,
        string? notesRootPath = null)
    {
        _onSaved = onSaved;
        _onCancel = onCancel;
        _onAiFromPath = onAiFromPath;
        _onOcrFromPath = onOcrFromPath;
        _mode = mode;
        _notesRootPath = notesRootPath;

        FormBorderStyle = FormBorderStyle.None;
        TopMost = true;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        DoubleBuffered = true;
        Cursor = Cursors.Cross;

        var vs = SystemInformation.VirtualScreen;
        Bounds = vs;
        Location = new Point(vs.Left, vs.Top);
        Size = new Size(vs.Width, vs.Height);
        CaptureDesktopSnapshot();

        KeyDown += (_, e) =>
        {
            if (e.KeyCode == Keys.Escape)
                Cancel();
        };
    }

    private void Cancel()
    {
        _onCancel?.Invoke();
        Close();
    }

    private void CaptureDesktopSnapshot()
    {
        _desktopSnapshot?.Dispose();
        var bmp = new Bitmap(Math.Max(1, Width), Math.Max(1, Height), PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(bmp))
        {
            g.CopyFromScreen(Left, Top, 0, 0, bmp.Size, CopyPixelOperation.SourceCopy);
        }

        _desktopSnapshot = bmp;
    }

    protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
    {
        if (keyData == Keys.Enter && _phase == Phase.Adjusting)
        {
            if (_mode == CaptureMode.Scrolling)
                RunScrollCapture();
            else
                CompleteAndClose();
            return true;
        }

        return base.ProcessCmdKey(ref msg, keyData);
    }

    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        LayoutToolbar();
    }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        base.OnMouseDown(e);
        if (_toolbar?.Bounds.Contains(e.Location) == true)
            return;

        if (_phase == Phase.Selecting)
        {
            if (e.Button == MouseButtons.Left)
            {
                _dragging = true;
                _anchor = e.Location;
                _current = e.Location;
                _selClient = Rectangle.Empty;
                Invalidate();
            }
            else if (e.Button == MouseButtons.Right)
            {
                Cancel();
            }

            return;
        }

        if (e.Button != MouseButtons.Left)
            return;

        var hit = HitTest(e.Location);
        if (hit == HitKind.None)
            return;

        _activeHit = hit;
        _adjustStartMouse = e.Location;
        _adjustStartRect = _selClient;
        _dragging = true;
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        base.OnMouseMove(e);
        if (_phase == Phase.Selecting)
        {
            if (!_dragging)
                return;
            _current = e.Location;
            _selClient = NormalizeRect(_anchor, _current);
            Invalidate();
            return;
        }

        if (_dragging && _activeHit != HitKind.None)
        {
            ApplyResizeOrMove(e.Location);
            return;
        }

        UpdateHoverCursor(e.Location);
    }

    protected override void OnMouseUp(MouseEventArgs e)
    {
        base.OnMouseUp(e);
        if (_phase == Phase.Selecting)
        {
            if (e.Button != MouseButtons.Left || !_dragging)
                return;
            _dragging = false;
            _current = e.Location;
            _selClient = NormalizeRect(_anchor, _current);
            Invalidate();

            if (_selClient.Width < MinSize || _selClient.Height < MinSize)
            {
                Cancel();
                return;
            }

            _phase = Phase.Adjusting;
            EnsureToolbar();
            LayoutToolbar();
            Cursor = Cursors.Default;
            Invalidate();
            return;
        }

        if (e.Button == MouseButtons.Left && _dragging)
        {
            _dragging = false;
            _activeHit = HitKind.None;
            Cursor = Cursors.Default;
        }
    }

    private void EnsureToolbar()
    {
        if (_toolbar != null)
            return;

        _toolbar = new FlowLayoutPanel
        {
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            WrapContents = false,
            FlowDirection = FlowDirection.LeftToRight,
            Padding = new Padding(6, 4, 6, 4),
            BackColor = Color.FromArgb(245, 45, 45, 48)
        };

        void AddButton(string text, EventHandler click)
        {
            var b = new Button
            {
                Text = text,
                AutoSize = true,
                FlatStyle = FlatStyle.Flat,
                Margin = new Padding(3),
                UseVisualStyleBackColor = false,
                BackColor = Color.FromArgb(255, 60, 60, 63),
                ForeColor = Color.White,
                Font = new Font(Font.FontFamily, 8.5f),
                Cursor = Cursors.Hand
            };
            b.FlatAppearance.BorderColor = Color.FromArgb(100, 255, 255, 255);
            b.Click += click;
            _toolbar.Controls.Add(b);
        }

        if (_mode == CaptureMode.Scrolling)
        {
            AddButton("开始滚动截屏", (_, _) => RunScrollCapture());
        }
        else
        {
            AddButton("完成截图", (_, _) => CompleteAndClose());
            AddButton("AI", (_, _) => RunAi());
            AddButton("OCR", (_, _) => RunOcr());
            AddButton("复制", (_, _) => CopyOnly());
        }
        AddButton("取消", (_, _) => Cancel());

        Controls.Add(_toolbar);
        _toolbar.BringToFront();
    }

    private void LayoutToolbar()
    {
        if (_toolbar == null)
            return;

        _toolbar.PerformLayout();
        var tw = _toolbar.Width;
        var th = _toolbar.Height;
        const int margin = 8;
        var yBelow = _selClient.Bottom + margin;
        var x = _selClient.X + (_selClient.Width - tw) / 2;
        if (yBelow + th > ClientRectangle.Bottom - 4)
            yBelow = _selClient.Y - margin - th;

        x = Math.Clamp(x, 4, Math.Max(4, ClientRectangle.Width - tw - 4));
        yBelow = Math.Clamp(yBelow, 4, Math.Max(4, ClientRectangle.Height - th - 4));
        _toolbar.Location = new Point(x, yBelow);
        _toolbar.BringToFront();
    }

    private void UpdateHoverCursor(Point p)
    {
        if (_phase != Phase.Adjusting)
            return;

        Cursor = HitTest(p) switch
        {
            HitKind.Nw or HitKind.Se => Cursors.SizeNWSE,
            HitKind.Ne or HitKind.Sw => Cursors.SizeNESW,
            HitKind.N or HitKind.S => Cursors.SizeNS,
            HitKind.E or HitKind.W => Cursors.SizeWE,
            HitKind.Move => Cursors.SizeAll,
            _ => Cursors.Cross
        };
    }

    private HitKind HitTest(Point p)
    {
        var r = _selClient;
        if (r.Width < MinSize || r.Height < MinSize)
            return HitKind.None;

        var h = HandleHalf;
        var cx = r.X + r.Width / 2;
        var cy = r.Y + r.Height / 2;

        if (Rect(r.Left - h, r.Top - h, 2 * h, 2 * h).Contains(p))
            return HitKind.Nw;
        if (Rect(cx - h, r.Top - h, 2 * h, 2 * h).Contains(p))
            return HitKind.N;
        if (Rect(r.Right - h, r.Top - h, 2 * h, 2 * h).Contains(p))
            return HitKind.Ne;
        if (Rect(r.Right - h, cy - h, 2 * h, 2 * h).Contains(p))
            return HitKind.E;
        if (Rect(r.Right - h, r.Bottom - h, 2 * h, 2 * h).Contains(p))
            return HitKind.Se;
        if (Rect(cx - h, r.Bottom - h, 2 * h, 2 * h).Contains(p))
            return HitKind.S;
        if (Rect(r.Left - h, r.Bottom - h, 2 * h, 2 * h).Contains(p))
            return HitKind.Sw;
        if (Rect(r.Left - h, cy - h, 2 * h, 2 * h).Contains(p))
            return HitKind.W;

        return r.Contains(p) ? HitKind.Move : HitKind.None;
    }

    private static Rectangle Rect(int x, int y, int w, int h) => new(x, y, w, h);

    private void ApplyResizeOrMove(Point p)
    {
        var dx = p.X - _adjustStartMouse.X;
        var dy = p.Y - _adjustStartMouse.Y;
        var r = _adjustStartRect;
        Rectangle next = _activeHit switch
        {
            HitKind.Move => new Rectangle(r.X + dx, r.Y + dy, r.Width, r.Height),
            HitKind.Nw => new Rectangle(r.X + dx, r.Y + dy, r.Width - dx, r.Height - dy),
            HitKind.N => new Rectangle(r.X, r.Y + dy, r.Width, r.Height - dy),
            HitKind.Ne => new Rectangle(r.X, r.Y + dy, r.Width + dx, r.Height - dy),
            HitKind.E => new Rectangle(r.X, r.Y, r.Width + dx, r.Height),
            HitKind.Se => new Rectangle(r.X, r.Y, r.Width + dx, r.Height + dy),
            HitKind.S => new Rectangle(r.X, r.Y, r.Width, r.Height + dy),
            HitKind.Sw => new Rectangle(r.X + dx, r.Y, r.Width - dx, r.Height + dy),
            HitKind.W => new Rectangle(r.X + dx, r.Y, r.Width - dx, r.Height),
            _ => r
        };

        next = NormalizeRectSize(next);
        _selClient = ClampRect(next);
        LayoutToolbar();
        Invalidate();
    }

    private static Rectangle NormalizeRectSize(Rectangle r)
    {
        var x = r.X;
        var y = r.Y;
        var w = r.Width;
        var h = r.Height;
        if (w < 0)
        {
            x += w;
            w = -w;
        }

        if (h < 0)
        {
            y += h;
            h = -h;
        }

        return new Rectangle(x, y, w, h);
    }

    private Rectangle ClampRect(Rectangle r)
    {
        var c = ClientRectangle;
        if (r.Width < MinSize)
            r.Width = MinSize;
        if (r.Height < MinSize)
            r.Height = MinSize;

        if (r.X < c.Left)
        {
            r.Width -= c.Left - r.X;
            r.X = c.Left;
        }

        if (r.Y < c.Top)
        {
            r.Height -= c.Top - r.Y;
            r.Y = c.Top;
        }

        if (r.Right > c.Right)
            r.Width = c.Right - r.X;
        if (r.Bottom > c.Bottom)
            r.Height = c.Bottom - r.Y;

        if (r.Width < MinSize)
            r.Width = MinSize;
        if (r.Height < MinSize)
            r.Height = MinSize;
        if (r.Right > c.Right)
            r.X = c.Right - r.Width;
        if (r.Bottom > c.Bottom)
            r.Y = c.Bottom - r.Height;
        return r;
    }

    private Bitmap? CaptureScreenRect(Rectangle clientRect)
    {
        if (clientRect.Width < MinSize || clientRect.Height < MinSize)
            return null;

        var topLeft = PointToScreen(new Point(clientRect.Left, clientRect.Top));
        var bmp = new Bitmap(clientRect.Width, clientRect.Height, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(bmp))
        {
            g.CopyFromScreen(topLeft.X, topLeft.Y, 0, 0, clientRect.Size, CopyPixelOperation.SourceCopy);
        }

        return bmp;
    }

    private void WithHiddenOverlay(Action work, bool restoreAfter = true)
    {
        Visible = false;
        Application.DoEvents();
        System.Threading.Thread.Sleep(50);
        try
        {
            work();
        }
        finally
        {
            if (restoreAfter && !IsDisposed && _phase == Phase.Adjusting)
                Visible = true;
        }
    }

    private void CompleteAndClose()
    {
        Visible = false;
        Application.DoEvents();
        System.Threading.Thread.Sleep(60);

        try
        {
            using var bmp = CaptureScreenRect(_selClient);
            if (bmp == null)
                return;

            var path = ScreenshotHelper.SavePngAndClipboard(bmp, "DanceMonkey_region", _notesRootPath);
            if (path != null)
                _onSaved(path);
        }
        finally
        {
            Close();
        }
    }

    private void CopyOnly()
    {
        WithHiddenOverlay(() =>
        {
            using var bmp = CaptureScreenRect(_selClient);
            if (bmp == null)
                return;

            using var clip = new Bitmap(bmp);
            Clipboard.SetImage(clip);
        }, restoreAfter: false);

        Close();
    }

    private void RunScrollCapture()
    {
        string? path = null;
        Exception? error = null;

        WithHiddenOverlay(() =>
        {
            try
            {
                path = CaptureScrollingRegionAndSave();
            }
            catch (Exception ex)
            {
                error = ex;
            }
        }, restoreAfter: false);

        try
        {
            if (error != null)
            {
                MessageBox.Show($"滚动截图失败：{error.Message}", "滚动截图", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            if (!string.IsNullOrEmpty(path))
                _onSaved(path);
        }
        finally
        {
            Close();
        }
    }

    private string? CaptureScrollingRegionAndSave()
    {
        using var first = CaptureScreenRect(_selClient);
        if (first == null)
            return null;

        var pieces = new List<Bitmap> { new Bitmap(first) };
        var previous = new Bitmap(first);
        try
        {
            var center = PointToScreen(new Point(_selClient.Left + _selClient.Width / 2, _selClient.Top + _selClient.Height / 2));
            MoveMouseTo(center);

            const int maxFrames = 60;
            const int wheelNotchesPerStep = 2;
            const int minAppendHeight = 4;
            var stagnantFrames = 0;

            for (var i = 0; i < maxFrames; i++)
            {
                ScrollMouseWheelDown(wheelNotchesPerStep);
                Application.DoEvents();
                System.Threading.Thread.Sleep(420);

                using var current = CaptureScreenRect(_selClient);
                if (current == null)
                    break;

                if (FramesNearlyIdentical(previous, current))
                {
                    stagnantFrames++;
                    if (stagnantFrames >= 3)
                        break;

                    continue;
                }

                var appendStart = FindAppendStart(previous, current);
                var appendHeight = current.Height - appendStart;
                if (appendHeight <= 0)
                {
                    stagnantFrames++;
                    if (stagnantFrames >= 3)
                        break;

                    continue;
                }

                if (appendHeight < minAppendHeight)
                {
                    // 单帧误判时不立即停止，继续滚动几次再决定是否到底。
                    stagnantFrames++;
                    if (stagnantFrames >= 3)
                        break;
                    continue;
                }

                stagnantFrames = 0;

                var tail = current.Clone(new Rectangle(0, appendStart, current.Width, appendHeight), PixelFormat.Format32bppArgb);
                pieces.Add(tail);

                previous.Dispose();
                previous = new Bitmap(current);
            }
        }
        finally
        {
            previous.Dispose();
        }

        using var merged = MergeVertical(pieces);
        foreach (var piece in pieces)
            piece.Dispose();

        return ScreenshotHelper.SavePngAndClipboard(merged, "DanceMonkey_scroll", _notesRootPath);
    }

    private static Bitmap MergeVertical(IReadOnlyList<Bitmap> pieces)
    {
        if (pieces.Count == 0)
            return new Bitmap(1, 1, PixelFormat.Format32bppArgb);

        var width = pieces[0].Width;
        var height = pieces.Sum(p => p.Height);
        var result = new Bitmap(width, Math.Max(1, height), PixelFormat.Format32bppArgb);
        using var g = Graphics.FromImage(result);
        g.Clear(Color.Transparent);

        var y = 0;
        foreach (var piece in pieces)
        {
            g.DrawImageUnscaled(piece, 0, y);
            y += piece.Height;
        }

        return result;
    }

    private static int FindAppendStart(Bitmap previous, Bitmap current)
    {
        var width = Math.Min(previous.Width, current.Width);
        var height = Math.Min(previous.Height, current.Height);
        if (width < 1 || height < 2)
            return 0;

        var minOverlap = Math.Max(20, height / 4);
        var maxOverlap = height - 1;
        var fallbackOverlap = 0;
        var fallbackScore = double.MaxValue;

        for (var overlap = maxOverlap; overlap >= minOverlap; overlap--)
        {
            var rowCount = Math.Clamp(overlap / 70, 6, 14);
            var matchedRows = 0;
            double totalDifference = 0;

            for (var rowIndex = 0; rowIndex < rowCount; rowIndex++)
            {
                var sampleOffset = GetSampleOffset(overlap, rowIndex, rowCount);
                var prevY = height - overlap + sampleOffset;
                var curY = sampleOffset;
                if (prevY < 0 || prevY >= height || curY < 0 || curY >= height)
                    continue;

                var rowDifference = GetAverageRowDifference(previous, current, prevY, curY, width);
                totalDifference += rowDifference;
                if (rowDifference <= 10.0)
                    matchedRows++;
            }

            var averageDifference = totalDifference / rowCount;
            if (averageDifference < fallbackScore)
            {
                fallbackScore = averageDifference;
                fallbackOverlap = overlap;
            }

            if (matchedRows >= rowCount - 1 && averageDifference <= 11.5)
                return overlap;
        }

        return fallbackScore <= 7.5 ? fallbackOverlap : 0;
    }

    private static int GetSampleOffset(int overlap, int index, int sampleCount)
    {
        if (overlap <= 1 || sampleCount <= 1)
            return 0;

        var usableHeight = overlap - 1;
        return (int)Math.Round(index * usableHeight / (double)(sampleCount - 1));
    }

    private static double GetAverageRowDifference(Bitmap a, Bitmap b, int aRow, int bRow, int width)
    {
        const int sampleColumns = 26;
        var startX = Math.Min(width - 1, Math.Max(0, width / 12));
        var endX = Math.Max(startX + 1, width - Math.Max(1, width / 12));
        var span = Math.Max(1, endX - startX);
        var step = Math.Max(1, span / sampleColumns);

        double totalDifference = 0;
        var samples = 0;

        for (var x = startX; x < endX; x += step)
        {
            var ca = a.GetPixel(x, aRow);
            var cb = b.GetPixel(x, bRow);
            totalDifference += (Math.Abs(ca.R - cb.R) + Math.Abs(ca.G - cb.G) + Math.Abs(ca.B - cb.B)) / 3.0;
            samples++;
        }

        return samples == 0 ? double.MaxValue : totalDifference / samples;
    }

    private static bool FramesNearlyIdentical(Bitmap previous, Bitmap current)
    {
        var width = Math.Min(previous.Width, current.Width);
        var height = Math.Min(previous.Height, current.Height);
        if (width < 1 || height < 1)
            return true;

        const int sampleCols = 20;
        const int sampleRows = 16;
        const int tolerance = 18;
        var stepX = Math.Max(1, width / sampleCols);
        var stepY = Math.Max(1, height / sampleRows);

        var mismatches = 0;
        var samples = 0;
        for (var y = 0; y < height; y += stepY)
        {
            for (var x = 0; x < width; x += stepX)
            {
                samples++;
                var a = previous.GetPixel(x, y);
                var b = current.GetPixel(x, y);
                if (Math.Abs(a.R - b.R) > tolerance ||
                    Math.Abs(a.G - b.G) > tolerance ||
                    Math.Abs(a.B - b.B) > tolerance)
                {
                    mismatches++;
                }
            }
        }

        return mismatches < Math.Max(4, samples / 40);
    }

    [DllImport("user32.dll")]
    private static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    private static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);

    private static void MoveMouseTo(Point p)
    {
        SetCursorPos(p.X, p.Y);
    }

    private static void ScrollMouseWheelDown(int notches)
    {
        const uint mouseeventfWheel = 0x0800;
        var delta = unchecked((uint)(-ScrollWheelDelta * Math.Max(1, notches)));
        mouse_event(mouseeventfWheel, 0, 0, delta, UIntPtr.Zero);
    }

    private void RunAi()
    {
        if (_onAiFromPath == null)
        {
            MessageBox.Show("当前未连接 AI 操作。", "框选截图", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        string? tmp = null;
        WithHiddenOverlay(() =>
        {
            using var bmp = CaptureScreenRect(_selClient);
            if (bmp == null)
                return;

            tmp = Path.Combine(Path.GetTempPath(), $"dm_region_ai_{Guid.NewGuid():N}.png");
            bmp.Save(tmp, ImageFormat.Png);
        }, restoreAfter: false);

        if (string.IsNullOrEmpty(tmp) || !File.Exists(tmp))
            return;

        try
        {
            _onAiFromPath.Invoke(tmp);
        }
        finally
        {
            // 不能立即删除：回调内实际分析是异步开始，立刻删文件会导致“图片文件不存在”。
            Close();
        }
    }

    private void RunOcr()
    {
        if (_onOcrFromPath == null)
        {
            MessageBox.Show("当前未连接 OCR 操作。", "框选截图", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        string? tmp = null;
        WithHiddenOverlay(() =>
        {
            using var bmp = CaptureScreenRect(_selClient);
            if (bmp == null)
                return;

            tmp = Path.Combine(Path.GetTempPath(), $"dm_region_ocr_{Guid.NewGuid():N}.png");
            bmp.Save(tmp, ImageFormat.Png);
        }, restoreAfter: false);

        if (string.IsNullOrEmpty(tmp) || !File.Exists(tmp))
            return;

        try
        {
            _onOcrFromPath.Invoke(tmp);
        }
        finally
        {
            // 不能立即删除：回调内实际识别是异步开始，立刻删文件会导致“图片文件不存在”。
            Close();
        }
    }

    private static void TryDeleteTempFile(string? path)
    {
        if (string.IsNullOrEmpty(path)) return;
        try { File.Delete(path); } catch { /* 忽略清理失败 */ }
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.None;

        if (_desktopSnapshot != null)
            g.DrawImageUnscaled(_desktopSnapshot, 0, 0);

        var dimAlpha = _phase == Phase.Selecting ? DimAlphaSelecting : DimAlphaAdjusting;
        using var dim = new SolidBrush(Color.FromArgb(dimAlpha, 0, 0, 0));
        var valid = _selClient.Width >= MinSize && _selClient.Height >= MinSize;
        if (!valid)
        {
            g.FillRectangle(dim, ClientRectangle);
            DrawHintOverlay(g);
            return;
        }

        using (var clip = new Region(ClientRectangle))
        {
            clip.Exclude(_selClient);
            g.FillRegion(dim, clip);
        }

        using var pen = new Pen(Color.White, _phase == Phase.Adjusting ? 2 : 1);
        g.DrawRectangle(pen, _selClient.X, _selClient.Y, _selClient.Width - 1, _selClient.Height - 1);

        if (_phase != Phase.Adjusting)
            return;

        using var handleBrush = new SolidBrush(Color.White);
        const int hs = 4;
        void H(int cx, int cy) =>
            g.FillRectangle(handleBrush, cx - hs / 2, cy - hs / 2, hs, hs);

        var r = _selClient;
        H(r.Left, r.Top);
        H(r.Left + r.Width / 2, r.Top);
        H(r.Right - 1, r.Top);
        H(r.Right - 1, r.Top + r.Height / 2);
        H(r.Right - 1, r.Bottom - 1);
        H(r.Left + r.Width / 2, r.Bottom - 1);
        H(r.Left, r.Bottom - 1);
        H(r.Left, r.Top + r.Height / 2);

        DrawHintOverlay(g);
    }

    private void DrawHintOverlay(Graphics g)
    {
        var hint = _mode == CaptureMode.Scrolling
            ? "左键拖动选择滚动区域  |  Enter 开始滚动截屏  |  Esc 取消"
            : "左键拖动选择区域  |  Enter 完成截图  |  Esc 取消";

        using var font = new Font(Font.FontFamily, 10.5f, FontStyle.Bold);
        var size = g.MeasureString(hint, font);
        var paddingX = 14;
        var paddingY = 8;
        var boxW = (int)Math.Ceiling(size.Width) + paddingX * 2;
        var boxH = (int)Math.Ceiling(size.Height) + paddingY * 2;
        var boxX = (ClientRectangle.Width - boxW) / 2;
        // 固定在顶部，避免遮挡屏幕底部文字内容。
        var boxY = 10;

        using var bg = new SolidBrush(Color.FromArgb(78, 28, 28, 30));
        using var border = new Pen(Color.FromArgb(130, 255, 255, 255), 1);
        using var text = new SolidBrush(Color.FromArgb(245, 255, 255, 255));

        g.FillRectangle(bg, boxX, boxY, boxW, boxH);
        g.DrawRectangle(border, boxX, boxY, boxW - 1, boxH - 1);
        g.DrawString(hint, font, text, boxX + paddingX, boxY + paddingY);
    }

    private static Rectangle NormalizeRect(Point a, Point b)
    {
        var x1 = Math.Min(a.X, b.X);
        var y1 = Math.Min(a.Y, b.Y);
        var x2 = Math.Max(a.X, b.X);
        var y2 = Math.Max(a.Y, b.Y);
        return new Rectangle(x1, y1, Math.Max(0, x2 - x1), Math.Max(0, y2 - y1));
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        _desktopSnapshot?.Dispose();
        _desktopSnapshot = null;
        base.OnFormClosed(e);
    }
}
