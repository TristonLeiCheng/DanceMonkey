# DM (DanceMonkey)

Windows 桌面常驻的磨砂玻璃笔记与待办应用。

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
- **项目管理**：读写 `Journal/zentask-projects.json`，进度由关联任务推算
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
