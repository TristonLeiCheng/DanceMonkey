# 会议中心生命周期工作台 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将会议中心工作台改造为无语音依赖、以人工笔记和文字 AI 整理为核心的生命周期工作区，同时保留应用级左侧导航栏。

**Architecture:** 继续由 `Assets/meeting-hub.html` 渲染会议 WebView；仅重新组织工作台结构与样式，既有其他导航页面继续复用。`MeetingHubService` 增加一个收尾消息，将文本笔记的纪要生成串为可恢复的结束会议动作。

**Tech Stack:** .NET 8 WPF、WebView2、HTML/CSS/JavaScript、PowerShell 合约测试。

---

### Task 1: 建立会议工作台 HTML 合约测试

**Files:**
- Create: `tools/tests/MeetingHubLifecycleContract.Tests.ps1`
- Test: `tools/tests/MeetingHubLifecycleContract.Tests.ps1`

- [ ] **Step 1: 写入失败的 UI 合约测试**

```powershell
$ErrorActionPreference = 'Stop'
$html = Get-Content -Raw -Encoding UTF8 (Join-Path $PSScriptRoot '..\..\Assets\meeting-hub.html')
$required = @('lifecycle-stepper', 'manual-notes-editor', 'completeMeeting', '转为行动项', '转为决策项', '根据当前笔记整理')
foreach ($needle in $required) {
    if ($html -notmatch [regex]::Escape($needle)) { throw "Missing lifecycle UI contract: $needle" }
}
foreach ($forbidden in @('实时转写', '录制中', '录音', '麦克风', 'waveform')) {
    if ($html -match [regex]::Escape($forbidden)) { throw "Forbidden voice UI contract: $forbidden" }
}
if ($html -match 'class="app-sidebar"') { throw 'The meeting WebView must not create an application-level left sidebar.' }
Write-Output 'Meeting hub lifecycle contract passed.'
```

- [ ] **Step 2: 运行测试并确认它因缺少生命周期元素失败**

Run: `powershell -ExecutionPolicy Bypass -File tools/tests/MeetingHubLifecycleContract.Tests.ps1`

Expected: FAIL with `Missing lifecycle UI contract: lifecycle-stepper`.

- [ ] **Step 3: 提交测试基线**

```bash
git add tools/tests/MeetingHubLifecycleContract.Tests.ps1
git commit -m "test: define meeting lifecycle UI contract"
```

### Task 2: 重构会议工作台为文本优先的生命周期布局

**Files:**
- Modify: `Assets/meeting-hub.html:7-126`
- Modify: `Assets/meeting-hub.html:136-314`
- Test: `tools/tests/MeetingHubLifecycleContract.Tests.ps1`

- [ ] **Step 1: 在测试保持失败的前提下，替换工作台的样式与结构**

实现 `lifecycle-stepper`、紧凑会议元信息、可折叠会议设置、`agenda-navigation`、`manual-notes-editor`、文字选择转换提示以及只显示文本来源的 AI 整理栏。保留 WebView 内现有的横向功能入口，但不新增 `app-sidebar`，以继续使用 WPF 应用层的最左侧导航。

- [ ] **Step 2: 添加前端收尾动作**

在 `handleAction` 中为 `completeMeeting` 调用 `pushWb()` 和 `send('completeMeeting')`；按钮文案固定为“结束会议并整理纪要”。

- [ ] **Step 3: 运行 UI 合约测试并确认通过**

Run: `powershell -ExecutionPolicy Bypass -File tools/tests/MeetingHubLifecycleContract.Tests.ps1`

Expected: `Meeting hub lifecycle contract passed.`

- [ ] **Step 4: 提交 HTML 重构**

```bash
git add Assets/meeting-hub.html
git commit -m "feat: redesign meeting lifecycle workspace"
```

### Task 3: 实现安全的结束会议与文本纪要流程

**Files:**
- Modify: `Services/MeetingHubService.cs:134-191`
- Modify: `Services/MeetingHubService.cs:401-429`
- Test: `tools/tests/MeetingHubLifecycleContract.Tests.ps1`

- [ ] **Step 1: 在 `HandleAsync` 中增加 `completeMeeting` 分支**

```csharp
case "completeMeeting":
    await CompleteMeetingAsync();
    break;
```

- [ ] **Step 2: 实现文本优先的 `CompleteMeetingAsync`**

```csharp
private async Task CompleteMeetingAsync()
{
    _workbench.Status = MeetingStatus.Completed;
    _workbench.EndTime = DateTime.Now.ToString("yyyy-MM-dd HH:mm");
    await GenerateSummaryAsync();
    SaveMeeting();
}
```

`GenerateSummaryAsync` 继续从 `BuildTranscript()` 读取议程和 `QuickNotes`；不要接入 `MeetingTranscriptSessionService` 或任何音频服务。

- [ ] **Step 3: 重新运行合约测试和解决方案构建**

Run: `powershell -ExecutionPolicy Bypass -File tools/tests/MeetingHubLifecycleContract.Tests.ps1; dotnet build DesktopAssistant.sln --no-restore`

Expected: 合约测试通过，构建以 exit code 0 结束。

- [ ] **Step 4: 提交服务层收尾行为**

```bash
git add Services/MeetingHubService.cs
git commit -m "feat: complete meetings from text workspace"
```

### Task 4: 端到端验证与视觉检查

**Files:**
- Modify: `docs/superpowers/plans/2026-08-04-meeting-center-lifecycle.md`

- [ ] **Step 1: 运行全量构建与 HTML 合约测试**

Run: `powershell -ExecutionPolicy Bypass -File tools/tests/MeetingHubLifecycleContract.Tests.ps1; dotnet build DesktopAssistant.sln --no-restore`

Expected: 两项命令都成功。

- [ ] **Step 2: 启动应用并检查会议中心工作台**

打开会议中心，确认最左侧仍由现有 WPF 软件导航栏负责；确认 WebView 内没有第二个左侧应用导航；确认“结束会议并整理纪要”、人工笔记、选择文字转换和 AI 文本来源说明都可见。

- [ ] **Step 3: 记录实际验证结果并提交计划复选框更新**

```bash
git add docs/superpowers/plans/2026-08-04-meeting-center-lifecycle.md
git commit -m "docs: record meeting lifecycle verification"
```
