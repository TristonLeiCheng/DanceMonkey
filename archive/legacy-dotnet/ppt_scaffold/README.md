# DanceMonkey 内置 PPT 脚手架（python-pptx）

CLI 启动时会将本目录复制到当前工作目录下的 **`.dancemonkey/ppt_scaffold/`**，Agent 可用 `read_file` 直接读取。

## 文件说明

| 文件 | 说明 |
|------|------|
| `scaffold_core.py` | 四套主题色板 + 背景/顶栏/卡片/要点/双栏/引述等布局函数 |
| `sample_build.py` | 最小可运行示例：生成 `sample_dancemonkey_deck.pptx` |

## 推荐用法

1. `read_file` 阅读 `scaffold_core.py` 与 `sample_build.py`
2. 复制 `sample_build.py` 为项目脚本，或 `import scaffold_core`（需保证同目录或在 `PYTHONPATH`）
3. 用 `run_shell` 执行：`python your_script.py`
4. 禁止整份脚本一次性 `write_file` 过长；可基于本脚手架 `edit_file` 分块追加

## 主题名

| 主题名 | 风格 |
|--------|------|
| `light_business` | 浅色商务（默认）— 米白底 / 深蓝主色 |
| `tech_blue` | 科技蓝 — 冷灰底 / 蓝色主色 |
| `warm_magazine` | 暖色杂志风 — 暖米底 / 橙红主色 |

> `dark_premium`（深色高端）由 ShapeCrawler 渲染器负责，python-pptx 脚手架暂不提供该主题。

## 核心函数速查

| 函数 | 版式 | 说明 |
|------|------|------|
| `add_title_slide` | 封面 | 大标题 + 副标题 + 装饰卡片 |
| `add_content_slide` | 要点 | 索引号 + 标题 + bullet 列表 |
| `add_two_column_slide` | 双栏 | 左右两组 bullets，支持可选栏头标题 |
| `add_quote_slide` | 引述 | 大字金句 + 出处 + 可选页标题 |
| `add_closing_slide` | 结尾 | 大字标语 + 副标语 |
