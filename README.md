# DanceMonkey

---

## Overview

**English**

**DanceMonkey** is a Windows desktop assistant (WPF + Windows Forms) that brings together a local **Markdown note vault**, **Zen-style task and project management**, **AI chat**, and assorted **productivity and system utilities** in one main window. A separate **command-line Agent (CLI)** shares the same **Agent Core** runtime as the GUI so you can use the same LLM and tool stack from the terminal or the app.

| Item | Description |
|------|-------------|
| Main app | `DesktopAssistant.csproj` → `DanceMonkey.exe` (`.NET 8` Windows, WPF) |
| CLI | `DanceMonkey.Cli` → `dancemonkey.exe` |
| Agent core | `DanceMonkey.Agent.Core` — shared LLM client, tool registry, sessions, approval |
| Config | `%AppData%\DanceMonkey\config.json` (migrated from legacy `DesktopAssistant` if present) |

**中文**

**DanceMonkey** 是一款面向 **Windows** 的桌面助手（**WPF + WinForms**），将本地 **Markdown 笔记库**、**类 Zen 的任务与项目管理**、**AI 对话** 以及多种**效率与系统小工具**整合在同一主窗口；独立的 **命令行 Agent（CLI）** 与 GUI 共用 **Agent Core** 运行时，在终端与界面中复用相同的大模型与工具能力。

| 项目 | 说明 |
|------|------|
| 主程序 | `DesktopAssistant.csproj` → 程序集名 `DanceMonkey.exe`（`net8.0-windows`，WPF） |
| CLI | `DanceMonkey.Cli` → 可执行文件 `dancemonkey.exe` |
| Agent 核心 | `DanceMonkey.Agent.Core`：共享的 LLM、工具链、会话与审批 |
| 配置 | `%AppData%\DanceMonkey\config.json`（若存在旧版 `DesktopAssistant` 配置会迁移） |

---

## Screenshot features

**English**

DanceMonkey includes several capture modes. Image files are stored under the configured **notes root** (see [Notes](#notes)) in **`Inbox/Screenshots/`** unless noted otherwise. Typical defaults in **Settings** (customizable): **global chat** `Ctrl+Shift+Q`, **quick (fullscreen) screenshot** `Ctrl+Shift+S`, **region capture** `Ctrl+Shift+R`. The same actions are also available from the **tray icon**, **floating orb**, and **Dock** (where applicable).

| Mode | Behavior |
|------|----------|
| **Quick / fullscreen** | Captures the **monitor under the cursor** to a **PNG** and copies the image to the clipboard, then opens the **result window**. |
| **Region** | Fullscreen dim overlay: drag a rectangle, adjust handles, then **Complete**; saving uses **box selection** only. Toolbar also offers **AI** (analysis), **OCR** (saves a temp PNG under `%TEMP%` for the pipeline), and **Copy** (clipboard only, no file). **Esc** cancels. |
| **Scroll capture** | Select a **tall area**; the tool scrolls the wheel and **stitches** frames into one tall PNG, then **saves** and copies like a normal region save. |
| **Continuous capture** | From the tray / floating / Dock **context menu** — enter **Continuous capture mode** with a small **floating control** (e.g. camera + check, counter badge). Each shot is **region-only**; images append to a **single** `Inbox/Captures/capture-series-<timestamp>.md` and PNGs to `Inbox/Screenshots/`; **Done** finalizes and opens that note. |
| **Result window** | After a file-backed capture: **Copy image**, **Save to note** (copies into Inbox and creates/links Markdown), **AI analyze**, **OCR**, **Close**. |

> **WebView2** is used for in-app rich UI (e.g. notes preview, Zen Task). **WebView2 Runtime** is required on the machine (usually preinstalled on recent Windows).

**中文**

DanceMonkey 提供多种**截图**能力。图片默认保存在配置项 **「笔记根目录」** 下的 **`Inbox\Screenshots\`**（与「笔记」章节一致）。**设置** 中可改热键，常见默认：**全局对话** `Ctrl+Shift+Q`、**快速（全屏）截图** `Ctrl+Shift+S`、**框选截图** `Ctrl+Shift+R`；**托盘**、**悬浮球**、**桌面 Dock** 中也可调用相应入口。

| 模式 | 说明 |
|------|------|
| **快速 / 全屏** | 截取**鼠标所在显示器**全屏，保存为 **PNG** 并**复制到剪贴板**，随后打开**截图结果窗口**。 |
| **框选** | 全屏半透明遮罩：拖出矩形、调整尺寸后点 **完成截图**；仅支持框选完成保存。工具栏另含 **AI 分析**、**OCR**（OCR/AI 可能使用 **`%TEMP%`** 下临时 PNG）、**复制**（仅剪贴板不保存文件）。**Esc** 取消。 |
| **滚动截屏** | 对选定的**长区域**自动滚轮拼接多帧，合并为**一张长图** PNG 并保存、复制。 |
| **连续截图** | 通过托盘 / 悬浮球 / Dock 的**右键**进入 **「连续截图模式」**；出现小型**悬浮条**（相机 / 对勾、计数等）。**仅支持框选**；每张追加到**同一** `Inbox\Captures\capture-series-时间戳.md`，图片在 `Inbox\Screenshots\`；点 **完成** 结束会话并**打开该汇总笔记**。 |
| **截图结果窗口** | 对写盘类截图可：**复制图片**、**保存到笔记**、**AI 分析**、**OCR**、**关闭** 等。 |

> 笔记预览、Zen 待办等依赖 **WebView2**；目标机需安装 **WebView2 运行时**（一般 Win10/11 已具备）。

---

## Feature map

**English**

The sidebar groups **Workbench** and other entries; alignment follows `AppPage` and the main `MainWindow` navigation.

**Workbench (examples)**  
- **AI Chat** — WebView2 chat, streaming, **text + image** attachments, **OpenAI-compatible** API, **Prompt snippets**.  
- **Notes** — Local **Markdown** vault, tree + editor + live preview (images, task lists, wiki-style links, etc.).  
- **Todo (Zen Task)** — **WebView2** + `Assets/zentask.html` board; data under **`Journal/*.json`**, two-way `WebMessage` with `TodoView`. **Reminders**, **Dock quick-add** task.  
- **Quick access** — User-defined **shortcuts to folders** (local / cloud / shares).  
- **Skills** — Manage **Agent Skills** under the configured **sandbox** (e.g. `.dancemonkey/skills`), consistent with the CLI.
- **Scheduled reminders** — Sidebar **Reminders** page: water / sedentary / custom schedules; **six desktop popup styles** (glass, circular, Dynamic Island, toast, banner, compact pill) or **pet bubble**; import/export JSON; screen-capture frosted glass backgrounds.

**Other** — Translate, Email (Microsoft Graph), network monitor, cleanup, PDF tools, file tools, **Dance mode** (animation + **stay-awake**), meeting assistant, file manager / sandbox, **Settings**, **Password vault** (local encrypted), tray / floating / Dock (screens, global chat, proxy shortcuts, etc.).

**中文**

主窗口**左侧导航**按分组列出功能，与 `AppPage`、`MainWindow` 中按钮一致。

**工作台（举例）**  
- **AI 对话** — WebView2 流式聊天，支持**文本/图片**附件，**OpenAI 兼容 API**，**Prompt 片段**。  
- **笔记** — 本地 **Markdown 笔记库**，树 + 编辑 + 实时预览（图、任务列表、双链等）。  
- **待办 (Zen Task)** — **WebView2** + `zentask.html` 看板，数据在笔记根下 **`Journal\*.json`**，与 `TodoView` 互发 `WebMessage`；**提醒**、**Dock 快速加任务**。  
- **快速访问** — 配置常用**文件夹/路径**。  
- **Skills** — 在**沙箱**中管理 **Agent Skills**（如 `.dancemonkey/skills`），与 CLI 一致。
- **定时提醒** — 侧栏 **「定时提醒」**：喝水 / 久坐 / 自定义；**六种桌面弹窗**（磨砂卡片、圆形、灵动岛、Toast、横幅、紧凑胶囊）或**宠物气泡**；JSON 导入/导出；截屏磨砂背景。

**其他** — 翻译、邮件（Graph）、网络、清理、PDF、文件工具、**Dance 模式**、会议助手、文件管理/沙箱、**设置**、**密码库**、托盘/悬浮球/Dock（截图、全局对话、代理等）。

---

## Notes

**English**

- **`notesRootPath`** in config; if empty, defaults to `Documents/NoteVault` (`NoteService.DefaultNotesRoot`).  
- `NoteService` **creates a folder layout** (Inbox, Journal, Projects, Areas, AI, Templates, etc.) and may seed **default templates** when `Templates/` is empty.  
- **Tree**, **search** (name/path, optional full-text with snippets), **version history** (`.history/`), **export HTML** (with optional image inlining), **PPT** via AI + `PptGenerationService`, **Note AI** actions (organize, summarize, continue, polish) via the same **OpenAI-compatible** endpoint.  
- Screenshots can be **written into notes** under `Inbox` and linked from Markdown; **continuous capture** produces one `capture-series-*.md` in `Inbox/Captures/` with multiple images under `Inbox/Screenshots/`.  

**中文**

- 配置项 **`notesRootPath`**；未配置时默认可为**文档**下的 `NoteVault`（`NoteService.DefaultNotesRoot`）。  
- `NoteService` 会**创建目录结构**（Inbox、Journal、Projects、Areas、AI、Templates 等），`Templates\` 为空时可能写入**默认模板**。  
- **树形浏览、搜索**（路径/名称，可选**全文+摘要**）、**版本历史**（`.history\`）、**HTML 导出**、经 AI 的 **PPT 生成**、**笔记 AI**（整理 / 总结 / 续写 / 润色）等，均走用户配置的 **OpenAI 兼容 API**。  
- 截图可**写入 Inbox 笔记**；**连续截图**在 `Inbox\Captures\` 生成 `capture-series-*.md`，图片在 `Inbox\Screenshots\`。

---

## Zen Task (Todo)

**English**

- UI: **`Assets/zentask.html`** inside **WebView2** (`TodoView`).  
- Data: e.g. **`Journal/task-module.json`**, **`Journal/zentask-projects.json`** (same notes root as Notes).  
- **Strategic** tasks with projects, **impact/urgency**, **RACI**, **energy**, status, due dates, audit trail, etc.; **Web → host** messages (`addTask`, `updateTask`, `toggleDone`, …). **Reminders**, **Focus mode** hooks, **Dock** quick-add of a default task.  

**中文**

- 界面： **`Assets/zentask.html`** 托管在 **WebView2**（`TodoView`）。  
- 数据： 如 **`Journal\task-module.json`**、**`Journal\zentask-projects.json`**（与**笔记**共用根目录）。  
- **战略任务** + 项目、**影响×紧急**、**RACI**、**能量**、状态、期限、审计等；Web 与宿主通过 JSON 消息（`addTask` 等）同步；**待办提醒**、**专注模式**、**Dock 快捷加任务**。

---

## Scheduled reminders (v1.3+)

**English**

- **Sidebar → Reminders** — Manage built-in **water** and **sedentary** reminders plus **custom** ones.
- **Recurrence** — Interval, active-use interval, daily / weekly / monthly times, or one-shot.
- **Notify via** — **Desktop popup** (pick a global default or per-reminder override) or **pet bubble** when the desktop pet is enabled.
- **Popup styles** — Glass card, circular, **Dynamic Island** (top capsule, tap to expand), toast (bottom-right), top banner, compact pill.
- **Frosted background** — Optional screen-capture blur for desktop popups (toggle on the Reminders page).
- **Import / export** — `reminders.json` merge or replace; built-in definitions are protected on replace.
- **Todo reminders** stay separate under **Settings → Reminder center** (Zen Task module).

**中文**

- **侧栏 → 定时提醒** — 管理内置**喝水**、**久坐**及**自定义**提醒。
- **重复规则** — 间隔、连续使用、每日 / 每周 / 每月时刻，或一次性。
- **通知方式** — **桌面弹窗**（全局默认或单条覆盖样式）或**宠物气泡**（需开启桌面宠物）。
- **弹窗样式** — 磨砂卡片、圆形、**灵动岛**（顶部胶囊，点击展开）、Toast（右下）、顶部横幅、紧凑胶囊。
- **磨砂背景** — 桌面弹窗可选截屏模糊（在定时提醒页勾选）。
- **导入 / 导出** — `reminders.json` 合并或替换导入；替换时保留内置项。
- **待办提醒**仍在 **设置 → 提醒中心**（Zen 待办模块），与定时提醒独立。

---

## AI (app-wide)

**English**

- **In-app AI chat** — Streaming, **vision** depends on the **model** you choose; **Prompt snippets** in Settings. **Endpoint** normalization in `OpenAiEndpointResolver` (e.g. append `/chat/completions` when you paste a base API URL).  
- **Global chat** (`GlobalChatWindow`, default **Ctrl+Shift+Q**) — AI / **translate** / **file search** modes; can save to **`AI/Conversations/`** and attach screenshot context.  
- **Screenshot** flow — result window: **AI analysis** / **OCR**; temp files may live under `%TEMP%` for one-shot AI/OCR from region toolbar.  
- **Meeting assistant** — STT, segments, optional summary; see **Settings** and `MeetingAssistantView`.  
- **Health / scheduled reminders** — Water, sedentary, and custom schedules on the **Reminders** page; todo reminders in **Settings**.  

**中文**

- **主窗 AI 对话** — 流式回复；**多模态/看图** 取决于你选的**模型**；**Prompt 片段**在设置中；**端点** 可由 `OpenAiEndpointResolver` 自动补全。  
- **全局对话**（默认 `Ctrl+Shift+Q`）— AI、**翻译**、**本地文件搜索** 等；可存到笔记库 **`AI\Conversations\`**，并关联截图。  
- **截图流程** — 结果窗的 **AI 分析** / **OCR**；框选工具条上的 **AI/OCR** 可能使用 **临时文件**（`%TEMP%`）。  
- **会议助手** — 语音转写、分段、可选摘要等，见**设置**与 `MeetingAssistantView`。  
- **健康 / 定时提醒** — 喝水、久坐与自定义提醒在 **「定时提醒」** 页；待办提醒在 **设置** 中。

---

## CLI & Agent Core

**English**

- **CLI** (`DanceMonkey.Cli`) — REPL or **one-shot** run; “Claude-Code style” **Agent loop** with **tools** (read/write files, list dir, grep, shell, etc.), **approvals** (`plan` / `ask` / `auto`, `-y`), **sessions** (`-s`, autosave), explicit skill selection (`--skill`, `--only-skill`), **`--sandbox`**, **JSON output** (`-f json`), and env overrides (`--show-config` shows help). **Same `config.json`** as the GUI.
- **Codex proxy / DM Proxy** — start it from the desktop **DM Proxy** page or Dock shortcut, or run `dancemonkey proxy --port 8000`. It exposes a local OpenAI Responses-compatible endpoint at `http://127.0.0.1:8000/v1/responses`, backed by the configured Chat Completions gateway. Point Codex/OpenAI clients at `OPENAI_BASE_URL=http://127.0.0.1:8000/v1`.
- **Agent core** — `AgentRunner` drives turn-taking with **ToolRegistry** and **IApprovalService**; **SkillCatalog** injects skills into prompts.
- **Launching CLI from the app** — `DanceMonkeyCliLauncher` looks for `cli/dancemonkey.exe` or `dancemonkey.exe` next to the main exe; the **`publish.bat`** script copies the CLI as **`dancemonkey-cli.exe`** next to `DanceMonkey.exe` to avoid **case-insensitive name collision** on Windows.  
- **Build / publish** — e.g. `dotnet publish` self-contained `win-x64`; WPF and WebView2 require **.NET 8** Windows and **WebView2 Runtime** on the target machine. Use **`publish.bat`** for a combined desktop + CLI layout.  

**中文**

- **CLI**（`DanceMonkey.Cli`）— 支持 **REPL** 与**一次性**执行；**工具**（读/写/列目录/Shell 等）、**审批**（`plan` / `ask` / `auto`、`-y`）、**会话**（`-s`、自动保存）、显式 skill 选择（`--skill`、`--only-skill`）、**`--sandbox`**、**`-f json`** 等；**环境变量** 与 **`--show-config`** 见 CLI 帮助；**与 GUI 共用** `config.json`。
- **Codex 中转站 / DM Proxy** — 可从桌面端 **DM Proxy** 页面或 Dock 快捷按钮启动，也可运行 `dancemonkey proxy --port 8000`。它会在本机启动 OpenAI Responses 兼容入口 `http://127.0.0.1:8000/v1/responses`，上游复用已配置的 Chat Completions 网关。Codex/OpenAI 客户端可配置 `OPENAI_BASE_URL=http://127.0.0.1:8000/v1`。
- **Agent Core** — `AgentRunner` 循环调度 **LLM** 与 **ToolRegistry**；**ModeAwareApprovalService**、**SkillCatalog** 等。
- **从主程序启动 CLI** — `DanceMonkeyCliLauncher` 查找同目录 `cli\dancemonkey.exe` 等；**`publish.bat`** 将 CLI 复制为 **`dancemonkey-cli.exe`**，避免与 `DanceMonkey.exe` 在**大小写不敏感**下互相覆盖。  
- **构建发布** — 自包含 `win-x64` 等；需 **.NET 8 Windows** 与 **WebView2 运行时**；发布可用根目录 **`publish.bat`** 打包**桌面版 + CLI**。

---

## Build

**English**

```text
dotnet build DesktopAssistant.sln -c Debug
# Main output (example):
# bin\Debug\net8.0-windows10.0.19041.0\

dotnet build DanceMonkey.Cli\DanceMonkey.Cli.csproj -c Debug
```

Use **`publish.bat`** at the repo root for a **Release** `win-x64` self-contained **single-file** layout (see script for exact `dotnet publish` flags).

**中文**

```text
dotnet build DesktopAssistant.sln -c Debug
# 主程序输出示例：
# bin\Debug\net8.0-windows10.0.19041.0\

dotnet build DanceMonkey.Cli\DanceMonkey.Cli.csproj -c Debug
```

生产环境可使用根目录 **`publish.bat`** 进行 **Release**、**win-x64**、**自包含单文件** 等发布（参数以脚本内为准）。

在线升级：`publish.bat` 还会额外生成 `publish/win-x64/artifacts/update-manifest.json` 与对应版本 ZIP 包。将这两个文件部署到同一 URL 目录后，在应用的设置页 About 区填入该 manifest 地址，用户点击 `Update` 就会自动检查、下载、替换当前程序并重启。也可在 **GitHub Releases**（`TristonLeiCheng/DanceMonkey`）获取最新 `DanceMonkey-win-x64-*.zip`。

**安装目录建议**：解压到任意本地文件夹（如 `DanceMonkey` 或 `DanceMonkey-win-x64-1.3.10`）后，直接运行其中的 `DanceMonkey.exe`。**应用内升级会在当前目录就地替换**，不会另复制到其它固定目录。若从网络盘（UNC）路径启动，可双击包内的 **`启动 DanceMonkey.bat`**，程序会复制到 `%LOCALAPPDATA%\DanceMonkey\app` 后运行（Windows 禁止从 UNC 直接执行 exe）。

升级清单示例：

```json
{
	"version": "1.3.10",
	"packageUrl": "DanceMonkey-win-x64-1.3.10.zip",
	"entryExe": "DanceMonkey.exe"
}
```

版本说明见 [`docs/releases/`](docs/releases/)（如 [v1.3.10](docs/releases/v1.3.10.md)）。

---

## Legal / third parties

**English**

This document describes the product for developers only; it does not endorse any third-party service (OpenAI, Microsoft Graph, etc.). You are responsible for complying with their terms and for protecting API keys in `config.json`.

**中文**

本文档仅供开发说明，**不** 构成对任何第三方服务（OpenAI、Microsoft Graph 等）的背书；使用其 API 时请遵守各服务商条款，并妥善保管 `config.json` 与密钥。

---

*README structure: English first, 中文 second per section. If the UI and code differ slightly, the code wins.*
