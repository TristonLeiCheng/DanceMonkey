using System.Runtime.InteropServices;
using Microsoft.Win32;
using DesktopAssistant.Models;

namespace DesktopAssistant.Services;

/// <summary>
/// 通过定时回写 Internet Settings 实现“强制代理”，用于对抗组策略周期性覆盖。
/// </summary>
public sealed class ProxyEnforcementService : IDisposable
{
    private const string InternetSettingsPath = @"Software\Microsoft\Windows\CurrentVersion\Internet Settings";
    private const int InternetOptionSettingsChanged = 39;
    private const int InternetOptionRefresh = 37;

    private readonly object _sync = new();
    private Timer? _timer;
    private AppConfig _activeConfig = ConfigService.DefaultConfig();

    [DllImport("wininet.dll", SetLastError = true)]
    private static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);

    public void StartOrUpdate(AppConfig config)
    {
        lock (_sync)
        {
            _activeConfig = config.Clone();
            _timer?.Dispose();
            _timer = null;

            if (!_activeConfig.ProxyForceEnabled)
                return;

            ApplyProxy(_activeConfig);

            var minutes = Math.Clamp(_activeConfig.ProxyRefreshMinutes, 1, 60);
            var period = TimeSpan.FromMinutes(minutes);
            _timer = new Timer(_ =>
            {
                try
                {
                    lock (_sync)
                    {
                        if (_activeConfig.ProxyForceEnabled)
                            ApplyProxy(_activeConfig);
                    }
                }
                catch
                {
                    // 避免后台定时器异常导致进程崩溃
                }
            }, null, period, period);
        }
    }

    public bool ApplyNow(AppConfig config, out string? error)
    {
        try
        {
            ApplyProxy(config);
            error = null;
            return true;
        }
        catch (Exception ex)
        {
            error = ex.Message;
            return false;
        }
    }

    public void Stop()
    {
        lock (_sync)
        {
            _timer?.Dispose();
            _timer = null;
        }
    }

    private static void ApplyProxy(AppConfig config)
    {
        using var key = Registry.CurrentUser.OpenSubKey(InternetSettingsPath, writable: true)
                        ?? throw new InvalidOperationException("无法打开系统网络代理设置注册表。");

        var mode = (config.ProxyForceMode ?? "manual").Trim().ToLowerInvariant();
        if (mode == "pac")
        {
            var pac = (config.ProxyPacUrl ?? "").Trim();
            if (!Uri.TryCreate(pac, UriKind.Absolute, out var pacUri) ||
                (pacUri.Scheme != Uri.UriSchemeHttp && pacUri.Scheme != Uri.UriSchemeHttps))
            {
                throw new InvalidOperationException("PAC 地址无效，请填写 http/https 开头的完整地址。");
            }

            key.SetValue("ProxyEnable", 0, RegistryValueKind.DWord);
            key.SetValue("AutoDetect", 0, RegistryValueKind.DWord);
            key.SetValue("AutoConfigURL", pac, RegistryValueKind.String);
        }
        else
        {
            var host = (config.ProxyServer ?? "").Trim();
            if (string.IsNullOrWhiteSpace(host))
                throw new InvalidOperationException("手动代理地址不能为空。");

            var port = config.ProxyPort;
            if (port is < 1 or > 65535)
                throw new InvalidOperationException("手动代理端口必须在 1-65535 之间。");

            key.SetValue("AutoConfigURL", "", RegistryValueKind.String);
            key.SetValue("AutoDetect", 0, RegistryValueKind.DWord);
            key.SetValue("ProxyEnable", 1, RegistryValueKind.DWord);
            key.SetValue("ProxyServer", $"{host}:{port}", RegistryValueKind.String);
            key.SetValue("ProxyOverride", (config.ProxyBypass ?? "").Trim(), RegistryValueKind.String);
        }

        // 通知系统立即刷新代理配置，避免等待系统自行生效。
        InternetSetOption(IntPtr.Zero, InternetOptionSettingsChanged, IntPtr.Zero, 0);
        InternetSetOption(IntPtr.Zero, InternetOptionRefresh, IntPtr.Zero, 0);
    }

    public void Dispose()
    {
        Stop();
        GC.SuppressFinalize(this);
    }
}
