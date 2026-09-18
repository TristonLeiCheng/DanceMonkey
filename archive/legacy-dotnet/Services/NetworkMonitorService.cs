using System.Net.Http;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using DesktopAssistant.Models;

namespace DesktopAssistant.Services;

public sealed class NetworkAdapterRow
{
    public string Name { get; init; } = "";
    public string Type { get; init; } = "";
    public string Status { get; init; } = "";
    public string Ipv4 { get; init; } = "";
    public string Speed { get; init; } = "";

    public string TypeAndIp => $"{Type} · {Ipv4}";
    public string SpeedLine => $"速率 {Speed}";
}

public sealed class ProbeRow
{
    public string Title { get; init; } = "";
    public bool Ok { get; init; }
    public string Detail { get; init; } = "";
}

public static class NetworkMonitorService
{
    private static readonly HttpClient HttpProbe = new()
    {
        Timeout = TimeSpan.FromSeconds(8)
    };

    static NetworkMonitorService()
    {
        HttpProbe.DefaultRequestHeaders.UserAgent.ParseAdd("DanceMonkey/1.1");
    }

    public static bool GetIsNetworkAvailable() => NetworkInterface.GetIsNetworkAvailable();

    public static IReadOnlyList<NetworkAdapterRow> GetAdapters()
    {
        var list = new List<NetworkAdapterRow>();
        foreach (var ni in NetworkInterface.GetAllNetworkInterfaces())
        {
            if (ni.OperationalStatus != OperationalStatus.Up)
                continue;
            if (ni.NetworkInterfaceType == NetworkInterfaceType.Loopback)
                continue;

            var ips = ni.GetIPProperties().UnicastAddresses
                .Where(a => a.Address.AddressFamily == AddressFamily.InterNetwork)
                .Select(a => a.Address.ToString())
                .ToList();

            var speed = ni.Speed > 0 ? $"{ni.Speed / 1_000_000} Mbps" : "—";

            list.Add(new NetworkAdapterRow
            {
                Name = ni.Name,
                Type = ni.NetworkInterfaceType.ToString(),
                Status = ni.OperationalStatus.ToString(),
                Ipv4 = ips.Count > 0 ? string.Join(", ", ips) : "—",
                Speed = speed
            });
        }

        return list;
    }

    public static async Task<IReadOnlyList<ProbeRow>> RunProbesAsync(AppConfig? config, CancellationToken cancellationToken = default)
    {
        var results = new List<ProbeRow>();

        results.Add(await PingProbeAsync("互联网 DNS (1.1.1.1)", "1.1.1.1", cancellationToken).ConfigureAwait(false));
        results.Add(await PingProbeAsync("公共网关探测 (8.8.8.8)", "8.8.8.8", cancellationToken).ConfigureAwait(false));
        results.Add(await PingProbeAsync("拜耳聊天 (chat.int.bayer.com)", "chat.int.bayer.com", cancellationToken).ConfigureAwait(false));

        var apiUrl = ResolveApiProbeUrl(config);
        if (apiUrl != null)
            results.Add(await HttpGetProbeAsync("已配置 API 端点", apiUrl, cancellationToken).ConfigureAwait(false));
        else
            results.Add(await HttpGetProbeAsync("OpenAI API (默认)", "https://api.openai.com", cancellationToken).ConfigureAwait(false));

        results.Add(await HttpGetProbeAsync("连通性检测 (Microsoft)", "https://www.msftconnecttest.com/connecttest.txt", cancellationToken).ConfigureAwait(false));

        return results;
    }

    private static string? ResolveApiProbeUrl(AppConfig? config)
    {
        if (config == null || string.IsNullOrWhiteSpace(config.ApiEndpoint))
            return null;
        if (!Uri.TryCreate(config.ApiEndpoint.Trim(), UriKind.Absolute, out var u))
            return null;
        if (u.Scheme != Uri.UriSchemeHttp && u.Scheme != Uri.UriSchemeHttps)
            return null;
        return u.GetLeftPart(UriPartial.Authority);
    }

    private static async Task<ProbeRow> PingProbeAsync(string title, string host, CancellationToken cancellationToken)
    {
        try
        {
            using var ping = new Ping();
            var reply = await ping.SendPingAsync(host, 3000).WaitAsync(cancellationToken).ConfigureAwait(false);
            var ok = reply.Status == IPStatus.Success;
            var detail = ok
                ? $"{reply.RoundtripTime} ms"
                : reply.Status.ToString();
            return new ProbeRow { Title = title, Ok = ok, Detail = detail };
        }
        catch (Exception ex)
        {
            return new ProbeRow { Title = title, Ok = false, Detail = ex.Message };
        }
    }

    private static async Task<ProbeRow> HttpGetProbeAsync(string title, string url, CancellationToken cancellationToken)
    {
        try
        {
            var sw = System.Diagnostics.Stopwatch.StartNew();
            using var resp = await HttpProbe.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, cancellationToken)
                .ConfigureAwait(false);
            sw.Stop();
            var ok = (int)resp.StatusCode < 500;
            var detail = $"{(int)resp.StatusCode} {resp.ReasonPhrase} · {sw.ElapsedMilliseconds} ms";
            return new ProbeRow { Title = title, Ok = ok, Detail = detail };
        }
        catch (Exception ex)
        {
            return new ProbeRow { Title = title, Ok = false, Detail = ex.Message };
        }
    }
}
