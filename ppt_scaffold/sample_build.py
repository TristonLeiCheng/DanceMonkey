"""最小示例：生成 sample_dancemonkey_deck.pptx（需已安装 python-pptx）。"""
from __future__ import annotations

import sys
from pathlib import Path

# 与 scaffold_core 同目录时可直接 import
sys.path.insert(0, str(Path(__file__).resolve().parent))

from scaffold_core import (
    add_closing_slide,
    add_content_slide,
    add_title_slide,
    new_presentation_16_9,
)


def main() -> None:
    prs = new_presentation_16_9()
    theme = "light_business"
    add_title_slide(prs, theme, "Quarterly", "Demo Deck", "使用 DanceMonkey 内置脚手架")
    add_content_slide(prs, theme, "01", "要点示例", ["第一项", "第二项", "第三项"])
    add_content_slide(prs, "tech_blue", "02", "技术主题", ["蓝灰底 + 顶栏强调", "与浅色商务形成对比"])
    add_closing_slide(prs, "warm_magazine", "谢谢", "Q & A")
    out = Path(__file__).resolve().parent / "sample_dancemonkey_deck.pptx"
    prs.save(str(out))
    print("saved:", out)


if __name__ == "__main__":
    main()
