# Modules/Ppt — PPT 大模块

将分散在桌面端「笔记 → 一键生成 PPT」、CLI/Agent「python-pptx 脚手架」中的 PPT 能力，
收敛为一个统一模块。命名空间统一为 `DesktopAssistant.Modules.Ppt.*`。

## 设计原则

- **门面唯一**：对外只暴露 `IPptModule`，WPF/CLI/Agent 都通过它调用。
- **渲染统一**：唯一渲染实现 `Rendering/ShapeCrawlerRenderer`（C# 纯托管，无 Python 依赖）。
- **主题驱动**：所有版式 Builder 通过 `IPptTheme` 拿色板/字号梯度/留白，禁止硬编码颜色。
- **来源可扩展**：通过 `IPptSourceImporter` 接入 Markdown / 纯文本 / PDF / Word，落到统一中间表示。
- **大纲与渲染解耦**：`IPptOutlineGenerator` 只产出 `PptDeck`；UI 可在大纲层做评审/编辑后再渲染。

## 目录结构（按文件位置即可推断职责）

```
Modules/Ppt/
  Abstractions/      // 接口契约
  Models/            // PptDeck / Section / Slide / Media / Theme / Request / Result
  Services/          // 模块门面与编排（PptModule.cs）
  Importers/         // 各种来源 → SourceDocument
  Rendering/         // ShapeCrawlerRenderer + SlideBuilders
  Themes/            // LightBusiness / TechBlue / DarkPremium
  Skills/            // 内置 SKILL.md（默认装载）
```

## 当前阶段（P0）

仅落骨架与三套主题：抽象、模型、占位实现、`PptThemeProvider`。
不改任何现有行为；`Services/PptGenerationService.cs` 与 `Views/NotesView` 现有调用保持原样。

后续 P1 起，会把 `PptGenerationService.SaveToFile` 逐步拆入 `Rendering/`，并让 `NotesView` 改调 `IPptModule`。
