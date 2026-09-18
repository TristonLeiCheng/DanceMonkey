# DM (DanceMonkey)

Windows / macOS 桌面常驻的磨砂玻璃笔记与待办应用。

## 预览

无需安装依赖：

```powershell
npm run dev
```

打开 `http://127.0.0.1:5173`。预览页可切换右缘细条、快捷轨与笔记面板三种形态。

笔记本、笔记、待办、搜索全部收在右侧同一块玻璃面板内：顶栏点「笔记本」或「搜索」即在面板内切换，不会另开窗口。

右侧快速笔记顶栏的“展开”按钮会打开完整工作区。完整页面包含：

- **AI 问答**：与快捷面板共用对话记录与 API 配置，支持流式输出、模型切换、Prompt 片段与设置
- **截图与 AI 分析**：`Ctrl+Shift+S` 全屏截图、`Ctrl+Shift+R` 框选截图；结果可复制、保存到笔记，并用视觉模型分析画面
- **软件设置**：强制系统代理（手动/PAC、定时回刷）与全局快捷键，写入旧版共用 `config.json`
- 真实本地 `.md` 文件与递归文件夹树
- 新建、重命名、删除文件夹和笔记
- Markdown 编辑、实时预览与分栏模式
- 650ms 自动保存，以及 `Ctrl+S` 手动保存
- `Ctrl+P` 快速文件查找
- 可调整宽度的文件树，以及可拖动的编辑/预览分栏
- 玻璃、纯色、纸张三种界面效果及深浅主题
- **Zen Task**：读写旧版 `Journal/task-module.json`，支持优先级、RACI、能量、截止日期
- **项目管理**：里程碑及任务进度、生命周期与健康度、每周进展记录、风险提醒、任务列表/看板、归档恢复和 Markdown 笔记关联；可从笔记选段批量生成带来源的任务
- **快速访问**：系统路径探测 + 旧版 `config.json` 的 `quickLinks`

桌面知识库与旧版 DanceMonkey 共用 `%AppData%\DanceMonkey\config.json` 中的
`notesRootPath`；未配置时使用“文档”目录下的 `NoteVault`。快速便签对应
`Journal\Stickies` 中的 Markdown 文件，因此升级无需迁移笔记。

面板「任务」标签直接操作同一套 Zen Task 数据；「快速访问」可在面板内打开常用路径，
也可跳转完整工作区。

面板中的 **AI** 标签也复用旧版配置里的 API 端点、Key、模型列表和系统提示词。
支持 OpenAI Chat Completions 兼容接口、多轮上下文、Markdown 回复、流式输出、
停止生成、新对话及连接测试。AI 请求会自动使用 Windows 当前系统代理（PAC 或手动代理服务器）。
浏览器预览只展示界面，实际问答与真实 NoteVault 需使用桌面模式。

## 桌面模式

在 macOS 上，从终端运行：

```bash
cd electron-app
npm install
npm run desktop
```

打包当前 Mac 架构的 `.app`、`.dmg` 和 `.zip`：

```bash
npm run package:mac
```

也可以分别运行 `npm run package:mac:arm64` 或 `npm run package:mac:x64`。
产物位于 `out/`。本地开发包使用临时签名，可在本机测试；对外分发时需配置 Apple Developer ID
签名和公证，然后以 `DM_MAC_SIGN=1` 启用打包配置中的签名流程。
macOS 的屏幕截图需要在系统设置中授权「屏幕与系统音频录制」。当前 macOS 版本的
AI 请求会跟随系统代理，但不写入系统代理；应用内更新暂不可用，请下载安装新版 DMG。

Windows 可用 `npm run package:win` 生成 Forge ZIP。`npm run publish:win` 仍保留旧版
`v1.3.x` 升级器所需的 `win-x64` ZIP 与升级清单，供迁移老用户使用。
在 macOS 交叉打包 Windows ZIP 后运行 `npm run prepare:win-release`，可在
`out/make/release/` 生成兼容 GitHub Latest 更新和旧版清单更新的 `win-x64` ZIP 与 `update-manifest.json`。

以下 Windows 启动器说明仍适用于 Windows：

双击项目根目录的 `启动DM.bat`（内部调用 `start-dm.ps1`）。缺少依赖时会自动执行 `npm install`。

若本机没有 Node.js，启动器会使用项目 `vendor/node-v*-win-x64.zip` 便携包，自动解压到 `%LOCALAPPDATA%\DanceMonkey\runtime\node`（无需管理员权限）。

程序以独立进程运行，启动脚本确认窗口出现后即可关闭，不会影响程序。要完全退出，请点击面板右上角的电源按钮（需连点两次确认），它会一并结束后台的预览服务。

也可以手动启动：

```powershell
npm install
npm run desktop
```

桌面模式提供透明无边框窗口、始终置顶、失焦收起、本地 JSON 持久化，以及 `Alt+Q` 全局快捷键。程序为单实例运行，重复启动只会唤出已有窗口。

若所在环境（远程桌面、虚拟机等）无法启动 GPU 进程，启动器会自动改用软件渲染重试；也可直接指定：

```powershell
$env:LUMEN_SOFTWARE_RENDER="1"; npm run desktop
```

## 快捷键

- `Alt+Q`：唤出或收起快速便签（可在「设置」中修改）
- `Ctrl+Shift+S`：全屏截图（可在「设置」中修改）
- `Ctrl+Shift+R`：框选截图（可在「设置」中修改）
- `Ctrl+K`：搜索笔记与任务
- `Ctrl+Enter`：保存并收起
- `Esc`：保留草稿并收起
- `Ctrl+S`：在完整页面保存 Markdown
- `Ctrl+P`：在完整页面快速查找文件

完整工作区导航：`#workspace`（笔记）、`#workspace/tasks`、`#workspace/projects`、`#workspace/links`。

## 项目工作台

在「项目」中新建项目，点击项目名称进入详情。项目内添加的任务自动归属当前项目；
列表和看板使用同一份任务数据，可直接用任务上的状态菜单切换待办、进行中、受阻、完成。
任务完成率按关联任务数量计算，项目状态独立维护；没有任务时完成率为 0%。

项目详情支持目标、完成标准、下一步行动、阻塞与风险，以及负责人和截止日期。
通过「关联笔记」选择知识库中的 Markdown 文件，点击即可进入原笔记编辑器。
应用内重命名笔记或文件夹会同步关联路径；外部移动或删除的文件会提示重新关联。
解除关联不会删除原文件。

归档项目会从活跃项目列表移出，保留任务与笔记关联；在「已归档」中可恢复。
旧版 JSON 继续兼容，编辑保留未提交的字段。只有项目名称且无 ID 的旧任务，
仅在名称唯一时解析归属；同名歧义任务需手动指定项目。

数据与界面回归检查：`npm test`。浏览器预览和桌面版共用任务/项目字段更新逻辑，
浏览器示例保存在浏览器本地，不会写入真实知识库。
