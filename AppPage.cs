namespace DesktopAssistant;

/// <summary>主窗口侧栏页面，顺序与 UI 导航按钮及枚举值一致（用于高亮索引）。</summary>
public enum AppPage
{
    AiChat = 0,
    Notes = 1,
    Translate = 2,
    Email = 3,
    [System.Obsolete("Merged into AiChat")] Chat = 4,
    NetworkMonitor = 5,
    Cleanup = 6,
    QuickAccess = 7,
    Todo = 8,
    /// <summary>本地加密密码库（KeePass 风格）。</summary>
    PasswordVault = 9,
    PdfTools = 10,
    FileTools = 11,
    Dance = 12,
    MeetingAssistant = 13,
    FileManager = 14,
    Settings = 15,
    /// <summary>管理沙箱下 Agent Skills（.dancemonkey/skills）。</summary>
    Skills = 16,
    [System.Obsolete("Removed")] PersonalHomepage = 17,
    /// <summary>PPT 工作台：选择来源（笔记/文件/主题）→ 主题与参数 → 大纲预览 → 渲染 .pptx。</summary>
    Ppt = 18,
    /// <summary>进程诊断：拖入程序分析进程树与网络连接。</summary>
    ProcessDiagnostics = 19,
    /// <summary>Codex Responses API 本地中转站。</summary>
    CodexProxy = 20,
    /// <summary>定时提醒：喝水、久坐及自定义提醒。</summary>
    ScheduledReminders = 21
}
