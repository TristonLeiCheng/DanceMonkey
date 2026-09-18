using DanceMonkey.Ppt.Abstractions;
using DanceMonkey.Ppt.Services;
using DesktopAssistant.Models;

namespace DesktopAssistant.Services;

/// <summary>桌面端装配 <see cref="IPptModule"/>：复用配置中的 API 与沙箱路径。</summary>
public static class DesktopPptModuleFactory
{
    /// <param name="useLegacyPrompt">true 时回落到 P1 旧 prompt + 旧 JSON schema。</param>
    public static IPptModule CreateForDesktop(AppConfig config, bool useLegacyPrompt = false)
    {
        ArgumentNullException.ThrowIfNull(config);
        var bridge = new OpenAiPptLlmBridge(new OpenAiApiClient(config));
        return PptModuleFactory.Create(bridge, config.SandboxPath, useLegacyPrompt);
    }
}
