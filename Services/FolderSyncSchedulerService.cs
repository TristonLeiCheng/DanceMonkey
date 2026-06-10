using System.Collections.Concurrent;
using System.Threading;
using DesktopAssistant.Models;

namespace DesktopAssistant.Services;

public sealed class FolderSyncSchedulerService : IDisposable
{
    private readonly ConfigService _configService;
    private readonly FolderSyncService _syncService = new();
    private readonly ConcurrentDictionary<string, byte> _runningProfiles = new(StringComparer.OrdinalIgnoreCase);
    private readonly Timer _timer;
    private bool _disposed;

    public FolderSyncSchedulerService(ConfigService configService)
    {
        _configService = configService;
        _timer = new Timer(_ => Tick(), null, TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(1));
    }

    public void RunNow() => Tick();

    private void Tick()
    {
        if (_disposed)
            return;

        AppConfig config;
        try
        {
            config = _configService.Load();
        }
        catch (Exception ex) when (IsRecoverableSyncException(ex))
        {
            StartupDiagnostics.Log("FolderSyncScheduler config load failed: " + ex.Message);
            return;
        }

        var now = DateTime.Now;
        foreach (var profile in config.FolderSyncProfiles.Where(ShouldRun))
        {
            var interval = Math.Clamp(profile.AutoSyncIntervalMinutes, 5, 1440);
            if (profile.LastRunAt.HasValue && now - profile.LastRunAt.Value < TimeSpan.FromMinutes(interval))
                continue;

            if (!_runningProfiles.TryAdd(profile.Id, 0))
                continue;

            ThreadPool.QueueUserWorkItem(_ => RunProfile(profile));
        }
    }

    private static bool ShouldRun(FolderSyncProfile profile) =>
        profile.Enabled &&
        profile.AutoSyncEnabled &&
        !string.IsNullOrWhiteSpace(profile.MasterPath) &&
        !string.IsNullOrWhiteSpace(profile.SlavePath);

    private void RunProfile(FolderSyncProfile profile)
    {
        try
        {
            var result = _syncService.Run(profile);
            profile.LastRunAt = DateTime.Now;
            profile.LastStatus = result.ErrorCount == 0
                ? "自动同步：" + result.Summary
                : $"自动同步：{result.Summary}；{result.ErrorCount} 个错误";
            TryUpdateProfileStatus(profile);
        }
        catch (Exception ex) when (IsRecoverableSyncException(ex))
        {
            profile.LastRunAt = DateTime.Now;
            profile.LastStatus = "自动同步失败：" + ex.Message;
            TryUpdateProfileStatus(profile);
        }
        finally
        {
            _runningProfiles.TryRemove(profile.Id, out _);
        }
    }

    private void UpdateProfileStatus(FolderSyncProfile updated)
    {
        var config = _configService.Load();
        var existing = config.FolderSyncProfiles.FirstOrDefault(p => p.Id == updated.Id);
        if (existing == null)
            return;

        existing.LastRunAt = updated.LastRunAt;
        existing.LastStatus = updated.LastStatus;
        _configService.Save(config);
    }

    private void TryUpdateProfileStatus(FolderSyncProfile updated)
    {
        try
        {
            UpdateProfileStatus(updated);
        }
        catch (Exception ex) when (IsRecoverableSyncException(ex))
        {
            StartupDiagnostics.Log("FolderSyncScheduler status update failed: " + ex.Message);
        }
    }

    private static bool IsRecoverableSyncException(Exception ex) =>
        ex is IOException or UnauthorizedAccessException or ArgumentException or InvalidOperationException or System.Text.Json.JsonException;

    public void Dispose()
    {
        _disposed = true;
        _timer.Dispose();
    }
}
