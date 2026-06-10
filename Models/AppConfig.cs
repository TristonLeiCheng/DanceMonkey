using System.Text.Json.Serialization;

namespace DesktopAssistant.Models;

public sealed class AppConfig
{
    [JsonPropertyName("provider")]
    public string Provider { get; set; } = "openai";

    [JsonPropertyName("apiEndpoint")]
    public string ApiEndpoint { get; set; } = "";

    [JsonPropertyName("apiKey")]
    public string ApiKey { get; set; } = "";

    [JsonPropertyName("model")]
    public string Model { get; set; } = "gpt-3.5-turbo";

    /// <summary>可在 GUI / CLI 中快速切换的模型列表；<see cref="Model"/> 仍表示当前选中的模型。</summary>
    [JsonPropertyName("modelProfiles")]
    public List<ModelProfileItem> ModelProfiles { get; set; } = new();

    [JsonPropertyName("preferredUserName")]
    public string PreferredUserName { get; set; } = "";

    /// <summary>界面语言：zh-CN 或 en-US。</summary>
    [JsonPropertyName("language")]
    public string Language { get; set; } = "zh-CN";

    /// <summary>与 Python 版共用 config.json 时的字段名。</summary>
    [JsonPropertyName("floatingIconEnabled")]
    public bool FloatingIconEnabled { get; set; } = true;

    [JsonPropertyName("floatingIconX")]
    public double? FloatingIconX { get; set; }

    [JsonPropertyName("floatingIconY")]
    public double? FloatingIconY { get; set; }

    [JsonPropertyName("quickLinks")]
    public List<QuickLinkItem> QuickLinks { get; set; } = new();

    [JsonPropertyName("folderSyncProfiles")]
    public List<FolderSyncProfile> FolderSyncProfiles { get; set; } = new();

    [JsonPropertyName("promptSnippets")]
    public List<PromptSnippetItem> PromptSnippets { get; set; } = new();

    [JsonPropertyName("notesRootPath")]
    public string? NotesRootPath { get; set; }

    [JsonPropertyName("graphTenantId")]
    public string? GraphTenantId { get; set; }

    [JsonPropertyName("graphClientId")]
    public string? GraphClientId { get; set; }

    [JsonPropertyName("startWithWindows")]
    public bool StartWithWindows { get; set; }

    [JsonPropertyName("clipboardHistoryEnabled")]
    public bool ClipboardHistoryEnabled { get; set; }

    /// <summary>是否在任务栏托盘显示资源监控（CPU/内存/磁盘/网络）。</summary>
    [JsonPropertyName("taskbarResourceMonitorEnabled")]
    public bool TaskbarResourceMonitorEnabled { get; set; } = true;

    /// <summary>任务栏资源监控刷新间隔（秒）。</summary>
    [JsonPropertyName("taskbarResourceMonitorIntervalSeconds")]
    public int TaskbarResourceMonitorIntervalSeconds { get; set; } = 2;

    /// <summary>资源监控详情窗口是否使用迷你模式。</summary>
    [JsonPropertyName("taskbarResourceMonitorMiniMode")]
    public bool TaskbarResourceMonitorMiniMode { get; set; } = false;

    [JsonPropertyName("taskbarResourceMonitorWindowX")]
    public double? TaskbarResourceMonitorWindowX { get; set; }

    [JsonPropertyName("taskbarResourceMonitorWindowY")]
    public double? TaskbarResourceMonitorWindowY { get; set; }

    /// <summary>桌面宠物模式：角色可被点击互动，具有情绪系统。</summary>
    [JsonPropertyName("petModeEnabled")]
    public bool PetModeEnabled { get; set; }

    /// <summary>宠物情绪衰减（默认开启）：长期无互动时心情值缓慢下降。</summary>
    [JsonPropertyName("petMoodDecayEnabled")]
    public bool PetMoodDecayEnabled { get; set; } = true;

    /// <summary>宠物外形（human / cat / dog / rabbit / fox）。</summary>
    [JsonPropertyName("petAnimal")]
    public string PetAnimal { get; set; } = "human";

    /// <summary>宠物显示尺寸（像素）：48 / 68 / 96 / 128，默认 68。</summary>
    [JsonPropertyName("petDisplaySize")]
    public int PetDisplaySize { get; set; } = 68;

    /// <summary>桌面宠物开启时是否阻止计算机空闲休眠，默认开启。</summary>
    [JsonPropertyName("petPreventSleepEnabled")]
    public bool PetPreventSleepEnabled { get; set; } = true;

    /// <summary>全局对话快捷键（默认 Ctrl+Shift+Q）。格式如 "Ctrl+Shift+Q"。</summary>
    [JsonPropertyName("globalChatHotkey")]
    public string GlobalChatHotkey { get; set; } = "Ctrl+Shift+Q";

    /// <summary>全屏截图快捷键（默认 Ctrl+Shift+S）。</summary>
    [JsonPropertyName("quickScreenshotHotkey")]
    public string QuickScreenshotHotkey { get; set; } = "Ctrl+Shift+S";

    /// <summary>框选截图快捷键（默认 Ctrl+Shift+R）。</summary>
    [JsonPropertyName("regionScreenshotHotkey")]
    public string RegionScreenshotHotkey { get; set; } = "Ctrl+Shift+R";

    /// <summary>全局对话的系统提示词（留空使用默认）。</summary>
    [JsonPropertyName("globalChatSystemPrompt")]
    public string? GlobalChatSystemPrompt { get; set; }

    /// <summary>启动时恢复上次关闭前打开的桌面便签窗口。</summary>
    [JsonPropertyName("notesRestoreStickiesOnStartup")]
    public bool NotesRestoreStickiesOnStartup { get; set; } = true;

    /// <summary>
    /// 笔记编辑区布局：<c>live</c>（Obsidian 风实时 Markdown，默认）、<c>split</c>（左编辑右预览）、<c>read</c>（仅阅读预览）。
    /// </summary>
    [JsonPropertyName("notesEditorViewMode")]
    public string NotesEditorViewMode { get; set; } = "live";

    /// <summary>Dock 天气城市名称（用于 wttr.in API，如 "Shanghai"、"Beijing"）。留空自动定位。</summary>
    [JsonPropertyName("weatherCity")]
    public string WeatherCity { get; set; } = "";

    /// <summary>Dock 主题（ocean / aurora / sunset / grape / graphite）。</summary>
    [JsonPropertyName("dockTheme")]
    public string DockTheme { get; set; } = "ocean";

    /// <summary>Dock 样式（classic = 经典完整面板，assistant = 桌面助手紧凑版，dancer = 舞蹈家角色）。</summary>
    [JsonPropertyName("dockStyle")]
    public string DockStyle { get; set; } = "classic";

    // ── 会议助手 ──

    /// <summary>会议语音转写服务（whisper = OpenAI Whisper API）。</summary>
    [JsonPropertyName("meetingSttProvider")]
    public string MeetingSttProvider { get; set; } = "whisper";

    /// <summary>会议转写语言（BCP-47，如 zh、en、ja）。</summary>
    [JsonPropertyName("meetingLanguage")]
    public string MeetingLanguage { get; set; } = "zh";

    /// <summary>音频输入源：mic = 麦克风，loopback = 系统回放。</summary>
    [JsonPropertyName("meetingAudioSource")]
    public string MeetingAudioSource { get; set; } = "mic";

    /// <summary>转写分段长度（秒），每段上传一次。</summary>
    [JsonPropertyName("meetingSegmentSeconds")]
    public int MeetingSegmentSeconds { get; set; } = 5;

    /// <summary>会议结束后是否自动生成摘要。</summary>
    [JsonPropertyName("meetingAutoSummary")]
    public bool MeetingAutoSummary { get; set; } = true;

    /// <summary>会议记录保存目录（留空则跟随笔记根目录下 Meetings/）。</summary>
    [JsonPropertyName("meetingSavePath")]
    public string? MeetingSavePath { get; set; }

    // ── 本地语音转文字（whisper.cpp） ──

    /// <summary>本地 STT：whisper.cpp 可执行文件路径。</summary>
    [JsonPropertyName("localSttWhisperExePath")]
    public string? LocalSttWhisperExePath { get; set; }

    /// <summary>本地 STT：模型文件路径（如 ggml-base.bin）。</summary>
    [JsonPropertyName("localSttModelPath")]
    public string? LocalSttModelPath { get; set; }

    /// <summary>本地 STT 语言（如 zh / en / auto）。</summary>
    [JsonPropertyName("localSttLanguage")]
    public string LocalSttLanguage { get; set; } = "zh";

    /// <summary>本地 STT 线程数。</summary>
    [JsonPropertyName("localSttThreads")]
    public int LocalSttThreads { get; set; } = 4;

    /// <summary>本地 STT 是否保留标点。</summary>
    [JsonPropertyName("localSttAutoPunctuation")]
    public bool LocalSttAutoPunctuation { get; set; } = true;

    /// <summary>本地 STT 超时（秒）。</summary>
    [JsonPropertyName("localSttTimeoutSeconds")]
    public int LocalSttTimeoutSeconds { get; set; } = 240;

    // ── 文件管理 ──

    /// <summary>AI 文件管理沙箱目录。留空使用 %LocalAppData%\DanceMonkey\Sandbox。</summary>
    [JsonPropertyName("sandboxPath")]
    public string? SandboxPath { get; set; }

    // ── 健康提醒 ──

    /// <summary>是否启用健康提醒（喝水、久坐）。</summary>
    [JsonPropertyName("healthReminderEnabled")]
    public bool HealthReminderEnabled { get; set; } = true;

    /// <summary>是否启用待办提醒。</summary>
    [JsonPropertyName("todoReminderEnabled")]
    public bool TodoReminderEnabled { get; set; } = true;

    /// <summary>待办提醒间隔（分钟），默认 30。</summary>
    [JsonPropertyName("todoReminderMinutes")]
    public int TodoReminderMinutes { get; set; } = 30;

    /// <summary>喝水提醒间隔（分钟），默认 45。</summary>
    [JsonPropertyName("waterReminderMinutes")]
    public int WaterReminderMinutes { get; set; } = 45;

    /// <summary>久坐提醒阈值（分钟），默认 60。</summary>
    [JsonPropertyName("movementReminderMinutes")]
    public int MovementReminderMinutes { get; set; } = 60;

    /// <summary>密码库自动锁定：无操作满此分钟数后锁定（0 = 关闭）。</summary>
    [JsonPropertyName("passwordVaultAutoLockMinutes")]
    public int PasswordVaultAutoLockMinutes { get; set; } = 5;

    /// <summary>是否启用系统代理强制覆盖（定时回写，抵抗组策略刷新）。</summary>
    [JsonPropertyName("proxyForceEnabled")]
    public bool ProxyForceEnabled { get; set; }

    /// <summary>强制代理模式：manual 或 pac。</summary>
    [JsonPropertyName("proxyForceMode")]
    public string ProxyForceMode { get; set; } = "manual";

    /// <summary>PAC 文件地址（proxyForceMode=pac 时使用）。</summary>
    [JsonPropertyName("proxyPacUrl")]
    public string ProxyPacUrl { get; set; } = "";

    /// <summary>手动代理服务器地址（proxyForceMode=manual 时使用）。</summary>
    [JsonPropertyName("proxyServer")]
    public string ProxyServer { get; set; } = "";

    /// <summary>手动代理端口（proxyForceMode=manual 时使用）。</summary>
    [JsonPropertyName("proxyPort")]
    public int ProxyPort { get; set; } = 8080;

    /// <summary>手动代理例外（如 &lt;local&gt;;*.corp.local）。</summary>
    [JsonPropertyName("proxyBypass")]
    public string ProxyBypass { get; set; } = "";

    /// <summary>代理强制刷新间隔（分钟）。</summary>
    [JsonPropertyName("proxyRefreshMinutes")]
    public int ProxyRefreshMinutes { get; set; } = 3;

    /// <summary>上海办公网络对应 PAC 地址（用于托盘快速切换）。</summary>
    [JsonPropertyName("proxyPacUrlShanghai")]
    public string ProxyPacUrlShanghai { get; set; } = "";

    /// <summary>北京办公网络对应 PAC 地址（用于托盘快速切换）。</summary>
    [JsonPropertyName("proxyPacUrlBeijing")]
    public string ProxyPacUrlBeijing { get; set; } = "";

    /// <summary>Codex Responses API 中转服务监听地址。</summary>
    [JsonPropertyName("codexProxyHost")]
    public string CodexProxyHost { get; set; } = "127.0.0.1";

    /// <summary>Codex Responses API 中转服务监听端口。</summary>
    [JsonPropertyName("codexProxyPort")]
    public int CodexProxyPort { get; set; } = 8000;

    /// <summary>Codex Responses API 中转上游超时时间（秒）。</summary>
    [JsonPropertyName("codexProxyTimeoutSeconds")]
    public int CodexProxyTimeoutSeconds { get; set; } = 300;

    /// <summary>在线升级清单地址。支持 http/https，也支持本地或 UNC 路径。</summary>
    [JsonPropertyName("updateManifestUrl")]
    public string? UpdateManifestUrl { get; set; }

    /// <summary>GitHub 发行版仓库（owner/repo），用于"检查更新"自动拉取最新 Release。</summary>
    [JsonPropertyName("updateGitHubRepo")]
    public string UpdateGitHubRepo { get; set; } = "TristonLeiCheng/DanceMonkey";

    /// <summary>从 GitHub Release 资源中按文件名关键字筛选升级包（.zip）。</summary>
    [JsonPropertyName("updateAssetKeyword")]
    public string UpdateAssetKeyword { get; set; } = "win-x64";

    // ── 知识库（在线 KB 服务） ──

    /// <summary>知识库服务根地址。空时使用默认 http://10.66.30.132:8000。</summary>
    [JsonPropertyName("knowledgeBaseUrl")]
    public string KnowledgeBaseUrl { get; set; } = "http://10.66.30.132:8000";

    /// <summary>是否启用知识库自动路由（auto_route）。</summary>
    [JsonPropertyName("knowledgeBaseAutoRoute")]
    public bool KnowledgeBaseAutoRoute { get; set; } = true;

    /// <summary>知识库请求超时（秒），默认 60。</summary>
    [JsonPropertyName("knowledgeBaseTimeoutSeconds")]
    public int KnowledgeBaseTimeoutSeconds { get; set; } = 60;

    public void EnsureModelProfiles()
    {
        Model = string.IsNullOrWhiteSpace(Model) ? "gpt-3.5-turbo" : Model.Trim();
        ModelProfiles ??= new List<ModelProfileItem>();

        var normalized = new List<ModelProfileItem>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var item in ModelProfiles)
        {
            var model = item.Model?.Trim() ?? "";
            if (model.Length == 0 || !seen.Add(model))
                continue;

            var name = item.Name?.Trim() ?? "";
            normalized.Add(new ModelProfileItem
            {
                Name = string.IsNullOrWhiteSpace(name) ? model : name,
                Model = model
            });
        }

        if (!seen.Contains(Model))
        {
            normalized.Insert(0, new ModelProfileItem
            {
                Name = Model,
                Model = Model
            });
        }

        ModelProfiles = normalized;
    }

    public AppConfig Clone() => new()
    {
        Language = Language,
        Provider = Provider,
        ApiEndpoint = ApiEndpoint,
        ApiKey = ApiKey,
        Model = Model,
        ModelProfiles = ModelProfiles.Select(m => new ModelProfileItem { Name = m.Name, Model = m.Model }).ToList(),
        PreferredUserName = PreferredUserName,
        FloatingIconEnabled = FloatingIconEnabled,
        FloatingIconX = FloatingIconX,
        FloatingIconY = FloatingIconY,
        QuickLinks = QuickLinks.Select(l => new QuickLinkItem { Name = l.Name, Path = l.Path, Category = l.Category }).ToList(),
        FolderSyncProfiles = FolderSyncProfiles.Select(p => p.Clone()).ToList(),
        PromptSnippets = PromptSnippets.Select(s => new PromptSnippetItem
            { Title = s.Title, SystemPrompt = s.SystemPrompt }).ToList(),
        NotesRootPath = NotesRootPath,
        GraphTenantId = GraphTenantId,
        GraphClientId = GraphClientId,
        StartWithWindows = StartWithWindows,
        ClipboardHistoryEnabled = ClipboardHistoryEnabled,
        TaskbarResourceMonitorEnabled = TaskbarResourceMonitorEnabled,
        TaskbarResourceMonitorIntervalSeconds = TaskbarResourceMonitorIntervalSeconds,
        TaskbarResourceMonitorMiniMode = TaskbarResourceMonitorMiniMode,
        TaskbarResourceMonitorWindowX = TaskbarResourceMonitorWindowX,
        TaskbarResourceMonitorWindowY = TaskbarResourceMonitorWindowY,
        GlobalChatHotkey = GlobalChatHotkey,
        QuickScreenshotHotkey = QuickScreenshotHotkey,
        RegionScreenshotHotkey = RegionScreenshotHotkey,
        GlobalChatSystemPrompt = GlobalChatSystemPrompt,
        NotesRestoreStickiesOnStartup = NotesRestoreStickiesOnStartup,
        NotesEditorViewMode = NotesEditorViewMode,
        WeatherCity = WeatherCity,
        DockTheme = DockTheme,
        DockStyle = DockStyle,
        MeetingSttProvider = MeetingSttProvider,
        MeetingLanguage = MeetingLanguage,
        MeetingAudioSource = MeetingAudioSource,
        MeetingSegmentSeconds = MeetingSegmentSeconds,
        MeetingAutoSummary = MeetingAutoSummary,
        MeetingSavePath = MeetingSavePath,
        LocalSttWhisperExePath = LocalSttWhisperExePath,
        LocalSttModelPath = LocalSttModelPath,
        LocalSttLanguage = LocalSttLanguage,
        LocalSttThreads = LocalSttThreads,
        LocalSttAutoPunctuation = LocalSttAutoPunctuation,
        LocalSttTimeoutSeconds = LocalSttTimeoutSeconds,
        SandboxPath = SandboxPath,
        HealthReminderEnabled = HealthReminderEnabled,
        TodoReminderEnabled = TodoReminderEnabled,
        TodoReminderMinutes = TodoReminderMinutes,
        WaterReminderMinutes = WaterReminderMinutes,
        MovementReminderMinutes = MovementReminderMinutes,
        PasswordVaultAutoLockMinutes = PasswordVaultAutoLockMinutes,
        ProxyForceEnabled = ProxyForceEnabled,
        ProxyForceMode = ProxyForceMode,
        ProxyPacUrl = ProxyPacUrl,
        ProxyServer = ProxyServer,
        ProxyPort = ProxyPort,
        ProxyBypass = ProxyBypass,
        ProxyRefreshMinutes = ProxyRefreshMinutes,
        ProxyPacUrlShanghai = ProxyPacUrlShanghai,
        ProxyPacUrlBeijing = ProxyPacUrlBeijing,
        CodexProxyHost = CodexProxyHost,
        CodexProxyPort = CodexProxyPort,
        CodexProxyTimeoutSeconds = CodexProxyTimeoutSeconds,
        UpdateManifestUrl = UpdateManifestUrl,
        UpdateGitHubRepo = UpdateGitHubRepo,
        UpdateAssetKeyword = UpdateAssetKeyword,
        KnowledgeBaseUrl = KnowledgeBaseUrl,
        KnowledgeBaseAutoRoute = KnowledgeBaseAutoRoute,
        KnowledgeBaseTimeoutSeconds = KnowledgeBaseTimeoutSeconds,
        PetModeEnabled = PetModeEnabled,
        PetMoodDecayEnabled = PetMoodDecayEnabled,
        PetAnimal = PetAnimal,
        PetDisplaySize = PetDisplaySize,
        PetPreventSleepEnabled = PetPreventSleepEnabled
    };
}
