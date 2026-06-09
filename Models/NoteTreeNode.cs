using System.Collections.ObjectModel;

namespace DesktopAssistant.Models;

/// <summary>笔记目录在笔记库中的语义分类（用于左侧树按类型上色）。</summary>
public enum NoteCategory
{
    /// <summary>普通文件夹（默认黄色）。</summary>
    General,
    /// <summary>Inbox/* — 速记 / 截图收件箱（蓝）。</summary>
    Inbox,
    /// <summary>Journal/* — 日记 / 周报 / 便签（绿）。</summary>
    Journal,
    /// <summary>Projects/* — 项目（紫）。</summary>
    Projects,
    /// <summary>Areas/* — 长期领域（青绿）。</summary>
    Areas,
    /// <summary>Resources/* — 资料库（蓝灰）。</summary>
    Resources,
    /// <summary>AI/* — AI 对话 / 生成内容（紫红）。</summary>
    Ai,
    /// <summary>Attachments/* — 附件（橙灰）。</summary>
    Attachments,
    /// <summary>Archive — 归档（灰）。</summary>
    Archive,
    /// <summary>Templates — 模板（暖粉）。</summary>
    Templates
}

/// <summary>笔记文件的子类型（用于在文档图标上叠加角标，便于一眼识别）。</summary>
public enum NoteKind
{
    /// <summary>普通 Markdown 笔记。</summary>
    General,
    /// <summary>Inbox/Captures/capture-*.md，包含截图引用。</summary>
    Screenshot,
    /// <summary>AI/Conversations/chat-*.md。</summary>
    AiConversation,
    /// <summary>AI/Generated/* —— AI 生成的产物。</summary>
    AiGenerated,
    /// <summary>Templates/*.md。</summary>
    Template,
    /// <summary>Journal/Daily/yyyy-MM-dd.md。</summary>
    Daily,
    /// <summary>Journal/Stickies/sticky-*.md。</summary>
    Sticky,
    /// <summary>Inbox/Captures/quick-*.md —— 快速笔录。</summary>
    Quick
}

/// <summary>笔记库目录树节点（用于 TreeView 绑定）。</summary>
public sealed class NoteTreeNode
{
    public string Name { get; init; } = "";
    public string FullPath { get; init; } = "";
    public bool IsFolder { get; init; }

    /// <summary>语义分类（仅文件夹有意义；笔记继承父分类便于颜色统一）。</summary>
    public NoteCategory Category { get; init; } = NoteCategory.General;

    /// <summary>笔记子类型（仅文件有意义）。</summary>
    public NoteKind Kind { get; init; } = NoteKind.General;

    public ObservableCollection<NoteTreeNode> Children { get; } = new();
}
