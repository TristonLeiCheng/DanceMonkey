# 卡皮巴拉（水豚）

通过内置 image_gen 生成自然动物形象：暖棕色短毛、圆肚皮、短腿、小耳朵与淡定的眼神。四足站立或趴坐，不戴眼镜、不穿衣服，不采用人形姿态。

## 素材与接入

- 原始图集：`assets/pets/capybara/spritesheet-natural.png`，836 × 1881，RGBA，36 帧。生成原图逐字节复制，未修改像素。
- 动作预览：`docs/capybara-preview.html`。
- 沿用 `capybara` ID，设置中显示为“卡皮巴拉（水豚）”。图集不可用时回退原像素水豚。
- 用 `python3 tools/index-companion-atlases.py`（需要 Pillow）重建逐帧裁切坐标。坐标避免不均匀行距造成的裁切；四足与趴卧动作保持统一落地基线。

| 图集行 | 动作 | 使用方式 |
| --- | --- | --- |
| 0 | 发呆、眨眼 | 默认、无聊 |
| 1–2 | 左右慢走 | 素材与预览提供，当前桌面行为不会自动游走 |
| 3 | 抬头、耳朵动、轻抬前爪 | 点击回应，一次播放 |
| 4 | 四足开心小跳 | 开心/跳跃事件，一次播放 |
| 5 | 趴平、叹气 | failed 状态素材，预览可查看 |
| 6 | 打盹 | 困倦、睡眠、放松 |
| 7 | 嚼叶子 | eating 状态 |
| 8 | 歪头嗅闻 | 工作、阅读与任务提醒状态的自然回应 |

这些是原有桌面宠物生活状态的表现，不代表真实 AI 工作。每行 4 帧；回应/跳跃/行走 6 FPS，其余 4 FPS。每只动物的状态映射独立，猫狗与狐狸保持原来的动作含义。

## 验证方式

`node --test test/pet-atlas.test.js test/desktop-pet.test.js`

`DM_PET_QA_ANIMAL=capybara node test/e2e-pet-atlas.mjs`

本次结果：19 项宠物单元测试通过；真实 Electron 图集测试通过，覆盖所有已接入动作、48/68/96/128 px、DPR 1/2、透明度、隐藏恢复及关闭清理。已人工检查浅色待机及深色嚼叶子效果，预览截图为 `docs/capybara-preview.png`。本次完成源码与素材更新，未打包发布新的安装版。

## 最终提示词（内置 image_gen）

```text
Use case: stylized-concept. Asset type: transparent PNG animation sprite sheet for a desktop capybara pet.
Create one adorable, relaxed, unmistakably natural CAPYBARA with warm caramel-brown short soft fur, a broad blunt rectangular rounded snout, tiny rounded ears high on its head, small sleepy dark eyes, a plump barrel body, four short sturdy legs, and no visible tail. Calm, slightly amused, very unbothered expression. High-quality softly sculpted 3D animated character with tactile fur and warm gentle lighting; appealing but anatomically animal-like, not a humanoid mascot. NO glasses or goggles, NO clothes, NO hat, NO shoes, NO human hands, NO standing upright. Keep it on four legs or loafing with paws tucked. No hamster cheeks, no beaver tail, no oversized cartoon eyes, no orange or accessory on its head.
Layout: one PNG, transparent background with real alpha, desired dimensions 1024x2304. Strict invisible grid FOUR columns by NINE rows, 36 distinct full-body animation poses total. Each 256x256 cell contains exactly one capybara, centered horizontally, coherent body scale across all frames. Body about 185px wide; standing height about 140px. Every pose fully inside its cell, at least 20px clear margin around all edges. Leave wide clean transparent separation between rows and columns, never overlapping neighboring poses. No borders, no labels, no text, no watermark, no environment, no floor and no cast shadow. All props mentioned below stay attached to the muzzle or paws and inside the same cell. Clean transparent edges without colored halos.
Each row is one 4-frame sequential animation, left to right; rows top to bottom:
1 IDLE: front three-quarter view facing slightly right, seated naturally as a rounded loaf, paws tucked, eyes open / half-close / gently closed / reopen, tiny breathing movement.
2 WALK RIGHT: full side profile facing right, four sequential quadrupedal slow-walk phases: near foreleg forward / passing / far foreleg forward / passing. All four legs remain short animal legs.
3 WALK LEFT: same slow quadrupedal walk cycle facing left.
4 GREETING: same front three-quarter loaf posture, notices viewer / lifts chin and twitches ears / briefly lifts one tiny front paw just off ground while other paws stay grounded / lowers paw back into loaf. No humanoid waving.
5 HAPPY BOUNCE: front three-quarter four-legged stance, squashes down / little rising hop / happy tiny airborne hop with all four paws under belly / soft landing. No upright jumping or raised human arms.
6 FLOP: seated loaf looking disappointed / head lowers / chin rests on front paws / gentle slow sigh with droopy eyelids. Keep natural body.
7 DOZING: lying comfortably on belly, paws tucked, closes eyes / head relaxes / slow sleepy breathing / head softly settles. Four frames, same animal and scale.
8 MUNCH: seated naturally on all fours, a small green leaf held at mouth, takes bite / chews / cheeks subtly move / chews happily. Leaf should remain visible and attached to muzzle; no floating food pieces.
9 CURIOUS: same four-legged loaf, sniff forward / head tilt slightly left / small nose twitch / head tilt slightly right, keeping body grounded. No books or human tools.
Maintain exactly the same individual capybara, materials, eye/nose anatomy and warm brown color in all 36 cells. Crisp detailed fur suitable for small desktop sizes. Deliver only the usable sprite atlas.
```
