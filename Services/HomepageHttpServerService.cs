using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text;
using DesktopAssistant.Models;

namespace DesktopAssistant.Services;

/// <summary>
/// LAN-accessible HTTP server for the personal homepage feature.
///
/// Implementation note:
/// We deliberately use a raw <see cref="TcpListener"/> bound to <c>0.0.0.0</c> instead of
/// <see cref="HttpListener"/>. <c>HttpListener</c> sits on top of the http.sys kernel driver
/// and refuses to bind any non-localhost prefix unless either (a) the process is elevated,
/// or (b) a URL ACL has been registered via <c>netsh http add urlacl</c>. That requirement
/// makes "publish to LAN" effectively unavailable to ordinary users.
///
/// A user-mode <see cref="TcpListener"/> has no such restriction: any non-admin user can
/// bind a high port on every interface and the server is immediately reachable from other
/// devices on the LAN (subject only to Windows Firewall, which prompts the user once on
/// first launch).
/// </summary>
public sealed class HomepageHttpServerService : IDisposable
{
    private const string ServerHeader = "DanceMonkey/1.0";
    private const int    HeaderReadLimit = 32 * 1024;
    private const int    StreamCopyBuffer = 64 * 1024;

    private TcpListener?            _listener;
    private CancellationTokenSource? _cts;
    private Task?                    _acceptTask;

    private readonly PersonalHomepageService _storage;
    private readonly HomepageExportService   _exporter;

    public bool   IsRunning { get; private set; }
    public string LocalUrl  { get; private set; } = "";
    public string LanUrl    { get; private set; } = "";
    /// <summary>True if the server is bound to all interfaces (LAN-accessible).</summary>
    public bool   IsLanMode { get; private set; }

    public HomepageHttpServerService(PersonalHomepageService storage, HomepageExportService exporter)
    {
        _storage  = storage;
        _exporter = exporter;
    }

    // ─── Start / Stop ─────────────────────────────────────────────────────────

    /// <summary>
    /// Starts the HTTP server. Returns (success, errorMessage).
    /// Tries 0.0.0.0:port first (LAN access). Falls back to 127.0.0.1:port only if
    /// binding all interfaces fails (e.g. another process already owns the address).
    /// </summary>
    public (bool ok, string? error) Start(int port)
    {
        if (IsRunning) Stop();

        _cts = new CancellationTokenSource();

        // Primary: bind every interface so the server is reachable on the LAN.
        try
        {
            _listener = new TcpListener(IPAddress.Any, port);
            _listener.Server.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
            _listener.Start();
            IsLanMode = true;
        }
        catch (Exception)
        {
            try { _listener?.Stop(); } catch { /* ignore */ }
            _listener = null;

            // Fallback: localhost only. Used when 0.0.0.0:port is unavailable, e.g.
            // taken by another LAN-bound service or blocked by a third-party filter.
            try
            {
                _listener = new TcpListener(IPAddress.Loopback, port);
                _listener.Start();
                IsLanMode = false;
            }
            catch (Exception ex)
            {
                try { _listener?.Stop(); } catch { /* ignore */ }
                _listener = null;
                _cts.Dispose();
                _cts = null;
                return (false, $"无法启动服务器（端口 {port}）: {ex.Message}");
            }
        }

        LocalUrl = $"http://localhost:{port}";
        LanUrl   = IsLanMode
            ? $"http://{GetLocalIpAddress()}:{port}"
            : LocalUrl;
        IsRunning = true;

        var token = _cts.Token;
        _acceptTask = Task.Run(() => AcceptLoopAsync(token), token);
        return (true, null);
    }

    public void Stop()
    {
        try { _cts?.Cancel(); } catch { /* ignore */ }
        try { _listener?.Stop(); } catch { /* ignore */ }
        _listener  = null;
        IsRunning  = false;
        IsLanMode  = false;
        LocalUrl   = "";
        LanUrl     = "";
    }

    public void Dispose()
    {
        Stop();
        try { _cts?.Dispose(); } catch { /* ignore */ }
        _cts = null;
    }

    // ─── Accept loop ──────────────────────────────────────────────────────────

    private async Task AcceptLoopAsync(CancellationToken ct)
    {
        var listener = _listener;
        if (listener == null) return;

        while (!ct.IsCancellationRequested)
        {
            TcpClient client;
            try
            {
                client = await listener.AcceptTcpClientAsync(ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException) { break; }
            catch (ObjectDisposedException)    { break; }
            catch (SocketException)            { break; }
            catch                              { continue; }

            // Per-connection handler swallows its own errors; never crashes the loop.
            _ = Task.Run(() => HandleConnectionAsync(client, ct), ct);
        }
    }

    private async Task HandleConnectionAsync(TcpClient client, CancellationToken ct)
    {
        try
        {
            using var _ = client;
            client.NoDelay        = true;
            client.ReceiveTimeout = 8_000;
            client.SendTimeout    = 60_000;

            using var stream = client.GetStream();
            var head = await ReadRequestHeadAsync(stream, ct).ConfigureAwait(false);
            if (head == null) return;

            await DispatchAsync(stream, head.Value, ct).ConfigureAwait(false);
        }
        catch
        {
            // Connection-level failure (client disconnect, bad header, etc.). Ignore.
        }
    }

    // ─── Minimal HTTP/1.1 parser ─────────────────────────────────────────────

    private static async Task<RequestHead?> ReadRequestHeadAsync(NetworkStream stream, CancellationToken ct)
    {
        var ms  = new MemoryStream(2048);
        var buf = new byte[1024];

        while (ms.Length < HeaderReadLimit)
        {
            int read;
            try
            {
                read = await stream.ReadAsync(buf, ct).ConfigureAwait(false);
            }
            catch { return null; }
            if (read <= 0) break;

            ms.Write(buf, 0, read);

            // Look for end-of-header marker "\r\n\r\n".
            var arr = ms.GetBuffer();
            int len = (int)ms.Length;
            for (int i = 3; i < len; i++)
            {
                if (arr[i - 3] == (byte)'\r' && arr[i - 2] == (byte)'\n' &&
                    arr[i - 1] == (byte)'\r' && arr[i]     == (byte)'\n')
                {
                    var headText = Encoding.ASCII.GetString(arr, 0, i - 3);
                    return ParseHead(headText);
                }
            }
        }
        return null;
    }

    private static RequestHead? ParseHead(string headText)
    {
        var lines = headText.Split("\r\n", StringSplitOptions.None);
        if (lines.Length == 0) return null;

        var requestLine = lines[0];
        var parts = requestLine.Split(' ');
        if (parts.Length < 2) return null;

        var method  = parts[0];
        var rawPath = parts[1];

        var q       = rawPath.IndexOf('?');
        var rawOnly = q >= 0 ? rawPath[..q] : rawPath;
        string path;
        try   { path = Uri.UnescapeDataString(rawOnly); }
        catch { path = rawOnly; }

        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (int i = 1; i < lines.Length; i++)
        {
            var line = lines[i];
            var c    = line.IndexOf(':');
            if (c <= 0) continue;
            var key = line[..c].Trim();
            var val = line[(c + 1)..].Trim();
            if (key.Length > 0) headers[key] = val;
        }

        return new RequestHead(method, path, headers);
    }

    // ─── Routing ──────────────────────────────────────────────────────────────

    private async Task DispatchAsync(NetworkStream stream, RequestHead req, CancellationToken ct)
    {
        bool headOnly = string.Equals(req.Method, "HEAD", StringComparison.OrdinalIgnoreCase);

        if (!string.Equals(req.Method, "GET", StringComparison.OrdinalIgnoreCase) && !headOnly)
        {
            await WriteSimpleAsync(stream, 405, "Method Not Allowed",
                "text/plain; charset=utf-8",
                Encoding.UTF8.GetBytes("Method Not Allowed"),
                headOnly: false, ct).ConfigureAwait(false);
            return;
        }

        if (req.Path == "/" || req.Path.Equals("/index.html", StringComparison.OrdinalIgnoreCase))
        {
            byte[] body;
            try
            {
                var config = _storage.LoadConfig();
                var html   = _exporter.RenderHomepageHtml(config);
                body = Encoding.UTF8.GetBytes(html);
            }
            catch (Exception ex)
            {
                await WriteSimpleAsync(stream, 500, "Internal Server Error",
                    "text/plain; charset=utf-8",
                    Encoding.UTF8.GetBytes("加载主页失败: " + ex.Message),
                    headOnly: false, ct).ConfigureAwait(false);
                return;
            }

            await WriteSimpleAsync(stream, 200, "OK",
                "text/html; charset=utf-8", body, headOnly, ct).ConfigureAwait(false);
            return;
        }

        if (req.Path.StartsWith("/media/", StringComparison.OrdinalIgnoreCase))
        {
            var rel      = req.Path["/media/".Length..].Replace('/', Path.DirectorySeparatorChar);
            var fullPath = PersonalHomepageService.ResolveMediaPath(rel);
            if (fullPath == null)
            {
                await WriteSimpleAsync(stream, 404, "Not Found",
                    "text/plain; charset=utf-8",
                    Encoding.UTF8.GetBytes("Not Found"),
                    headOnly: false, ct).ConfigureAwait(false);
                return;
            }

            await ServeStaticFileAsync(stream, fullPath, req, headOnly, ct).ConfigureAwait(false);
            return;
        }

        await WriteSimpleAsync(stream, 404, "Not Found",
            "text/plain; charset=utf-8",
            Encoding.UTF8.GetBytes("Not Found"),
            headOnly: false, ct).ConfigureAwait(false);
    }

    // ─── Static file serving (with HTTP Range support) ────────────────────────

    private static async Task ServeStaticFileAsync(
        NetworkStream stream, string fullPath, RequestHead req, bool headOnly, CancellationToken ct)
    {
        FileInfo fi;
        try { fi = new FileInfo(fullPath); }
        catch
        {
            await WriteSimpleAsync(stream, 500, "Internal Server Error",
                "text/plain; charset=utf-8",
                Encoding.UTF8.GetBytes("无法访问文件"), false, ct).ConfigureAwait(false);
            return;
        }

        var ext         = Path.GetExtension(fullPath).ToLowerInvariant();
        var contentType = ResolveContentType(ext);

        long fileLen  = fi.Length;
        long start    = 0;
        long end      = fileLen > 0 ? fileLen - 1 : 0;
        bool isPartial = false;

        if (req.Headers.TryGetValue("Range", out var rangeHdr) && fileLen > 0)
        {
            const string prefix = "bytes=";
            if (rangeHdr.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            {
                var spec = rangeHdr[prefix.Length..];
                var dash = spec.IndexOf('-');
                if (dash >= 0)
                {
                    var sStart = spec[..dash];
                    var sEnd   = spec[(dash + 1)..];

                    if (long.TryParse(sStart, out var rs) && rs >= 0 && rs < fileLen)
                    {
                        start = rs;
                        if (!string.IsNullOrEmpty(sEnd) &&
                            long.TryParse(sEnd, out var re) && re >= start && re < fileLen)
                        {
                            end = re;
                        }
                        isPartial = true;
                    }
                    else if (string.IsNullOrEmpty(sStart) &&
                             long.TryParse(sEnd, out var suffix) && suffix > 0)
                    {
                        // "bytes=-N" form: the last N bytes.
                        var take = Math.Min(suffix, fileLen);
                        start    = fileLen - take;
                        end      = fileLen - 1;
                        isPartial = true;
                    }
                }
            }
        }

        long sendLength = fileLen == 0 ? 0 : (end - start + 1);

        var sb = new StringBuilder(384);
        sb.Append(isPartial ? "HTTP/1.1 206 Partial Content\r\n" : "HTTP/1.1 200 OK\r\n");
        if (isPartial)
            sb.Append("Content-Range: bytes ").Append(start).Append('-').Append(end).Append('/').Append(fileLen).Append("\r\n");
        sb.Append("Server: ").Append(ServerHeader).Append("\r\n");
        sb.Append("Connection: close\r\n");
        sb.Append("Accept-Ranges: bytes\r\n");
        sb.Append("Content-Type: ").Append(contentType).Append("\r\n");
        sb.Append("Content-Length: ").Append(sendLength).Append("\r\n");
        if (contentType == "application/octet-stream")
        {
            sb.Append("Content-Disposition: attachment; filename=\"")
              .Append(EscapeHeader(Path.GetFileName(fullPath))).Append("\"\r\n");
        }
        sb.Append("Cache-Control: no-cache\r\n");
        sb.Append("\r\n");

        var headBytes = Encoding.ASCII.GetBytes(sb.ToString());
        try { await stream.WriteAsync(headBytes, ct).ConfigureAwait(false); }
        catch { return; }

        if (headOnly || sendLength == 0)
        {
            try { await stream.FlushAsync(ct).ConfigureAwait(false); } catch { /* ignore */ }
            return;
        }

        try
        {
            await using var fs = new FileStream(
                fullPath, FileMode.Open, FileAccess.Read, FileShare.Read,
                bufferSize: StreamCopyBuffer, useAsync: true);

            if (start > 0) fs.Seek(start, SeekOrigin.Begin);

            var buf    = new byte[StreamCopyBuffer];
            long remain = sendLength;
            while (remain > 0)
            {
                int toRead = (int)Math.Min(buf.Length, remain);
                int read   = await fs.ReadAsync(buf.AsMemory(0, toRead), ct).ConfigureAwait(false);
                if (read <= 0) break;
                await stream.WriteAsync(buf.AsMemory(0, read), ct).ConfigureAwait(false);
                remain -= read;
            }
            await stream.FlushAsync(ct).ConfigureAwait(false);
        }
        catch
        {
            // Client disconnected mid-stream; nothing to do.
        }
    }

    // ─── Tiny response helper for in-memory bodies ────────────────────────────

    private static async Task WriteSimpleAsync(
        NetworkStream stream,
        int status, string statusText, string contentType, byte[] body,
        bool headOnly, CancellationToken ct)
    {
        var sb = new StringBuilder(256);
        sb.Append("HTTP/1.1 ").Append(status).Append(' ').Append(statusText).Append("\r\n");
        sb.Append("Server: ").Append(ServerHeader).Append("\r\n");
        sb.Append("Connection: close\r\n");
        sb.Append("Content-Type: ").Append(contentType).Append("\r\n");
        sb.Append("Content-Length: ").Append(body.Length).Append("\r\n");
        sb.Append("Cache-Control: no-cache\r\n");
        sb.Append("\r\n");

        var headBytes = Encoding.ASCII.GetBytes(sb.ToString());
        try
        {
            await stream.WriteAsync(headBytes, ct).ConfigureAwait(false);
            if (!headOnly && body.Length > 0)
                await stream.WriteAsync(body, ct).ConfigureAwait(false);
            await stream.FlushAsync(ct).ConfigureAwait(false);
        }
        catch
        {
            // ignore write errors caused by client disconnect
        }
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    private static string ResolveContentType(string ext) => ext switch
    {
        ".html" or ".htm" => "text/html; charset=utf-8",
        ".css"            => "text/css; charset=utf-8",
        ".js"             => "application/javascript; charset=utf-8",
        ".json"           => "application/json; charset=utf-8",
        ".jpg" or ".jpeg" => "image/jpeg",
        ".png"            => "image/png",
        ".gif"            => "image/gif",
        ".webp"           => "image/webp",
        ".bmp"            => "image/bmp",
        ".svg"            => "image/svg+xml",
        ".ico"            => "image/x-icon",
        ".mp4"            => "video/mp4",
        ".webm"           => "video/webm",
        ".mov"            => "video/quicktime",
        ".mkv"            => "video/x-matroska",
        ".m4v"            => "video/x-m4v",
        ".mp3"            => "audio/mpeg",
        ".wav"            => "audio/wav",
        ".pdf"            => "application/pdf",
        ".txt"            => "text/plain; charset=utf-8",
        _                 => "application/octet-stream",
    };

    private static string EscapeHeader(string value) => value.Replace("\"", "");

    private static string GetLocalIpAddress()
    {
        try
        {
            // Prefer non-loopback, non-tunnel IPv4 addresses on operational interfaces.
            // Order by interface type so wired/wireless adapters win over virtual ones.
            int Score(NetworkInterfaceType t) => t switch
            {
                NetworkInterfaceType.Ethernet      => 0,
                NetworkInterfaceType.GigabitEthernet => 0,
                NetworkInterfaceType.Wireless80211 => 1,
                _                                  => 5,
            };

            var candidates = new List<(int score, string addr)>();
            foreach (var ni in NetworkInterface.GetAllNetworkInterfaces())
            {
                if (ni.OperationalStatus != OperationalStatus.Up) continue;
                if (ni.NetworkInterfaceType is NetworkInterfaceType.Loopback or NetworkInterfaceType.Tunnel) continue;

                foreach (var addr in ni.GetIPProperties().UnicastAddresses)
                {
                    if (addr.Address.AddressFamily != AddressFamily.InterNetwork) continue;
                    if (IPAddress.IsLoopback(addr.Address)) continue;
                    candidates.Add((Score(ni.NetworkInterfaceType), addr.Address.ToString()));
                }
            }

            if (candidates.Count > 0)
            {
                candidates.Sort((a, b) => a.score.CompareTo(b.score));
                return candidates[0].addr;
            }
        }
        catch { /* fall through */ }
        return "localhost";
    }

    // ─── Types ────────────────────────────────────────────────────────────────

    private readonly record struct RequestHead(
        string Method,
        string Path,
        IReadOnlyDictionary<string, string> Headers);
}
