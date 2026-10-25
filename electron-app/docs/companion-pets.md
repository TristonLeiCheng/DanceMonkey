# 猫狗工程师动作素材

使用内置 image_gen 生成，参照现有工程师狐狸。猫为灰白虎斑，狗为金色垂耳犬；统一护目镜、工装与柔和 3D 质感。

## 文件与动作

- `assets/pets/cat/spritesheet-engineer.png`
- `assets/pets/dog/spritesheet-engineer.png`
- 两张原始透明 RGBA PNG 均为 836 × 1881；每套 9 组动作 × 4 帧，共 72 帧。原始像素未经后处理。
- 动作顺序：idle、right、left、wave、jump、failed、waiting、working、review。
- 默认、吃饭、休闲映射到 idle；无聊、困倦、任务提醒映射到 waiting；工作/阅读映射到对应动作；点击播放 wave，开心/跳跃事件播放 jump。左右行走素材已经提供，沿用现有行为，不自动游走。
- `cat` / `dog` 原 ID 保留。资源缺失时各自回退到原像素猫/狗；其他皮肤不受影响。

## 裁切与渲染

生成图片的行间距并非严格等分。`tools/index-companion-atlases.py` 只读取 alpha 并生成 `src/pet-companion-atlases.js` 的逐帧裁切坐标，不修改 PNG。每帧按统一 256 × 256 逻辑画布居中、统一脚底基线，跳跃帧保留抬升。逐帧坐标避免裁掉耳朵、尾巴或混入相邻动作。

运行 `python3 tools/index-companion-atlases.py` 重建坐标（需要 Pillow）。若替换源图，必须重建并重新验证；文件 SHA-256 保存于坐标清单。

## 预览与验证

打开 `docs/companion-pets-preview.html` 可切换九组动作，与原狐狸比较。运行 `node --test test/desktop-pet.test.js test/pet-atlas.test.js`，再分别用 `DM_PET_QA_ANIMAL=cat`、`dog`、`engineer-fox` 运行 `node test/e2e-pet-atlas.mjs`，验证真实 Electron 渲染、透明度、四种尺寸、DPR 1/2、隐藏恢复及动画清理。

本次验收：完整单元/集成测试 421/421 通过；猫、狗、狐狸的真实图集渲染测试通过；`npm run test:e2e:pet` 的设置保存、互动、切换、关闭与重启流程通过。已检查浅色和深色背景的实际合成效果；预览截图保存为 `docs/companion-pets-preview.png`。

## 最终生成提示词

### 猫

```text
Use case: stylized-concept. Asset type: production transparent PNG sprite atlas for a desktop companion.
Input image 1 is STYLE REFERENCE ONLY: the existing engineer fox sheet. Generate a NEW GREY AND WHITE TABBY CAT engineer, in the same polished soft 3D animated toy character style, detailed fluffy fur, expressive amber eyes, round teal-blue goggles worn over eyes, olive khaki engineer overalls, brown belt/gloves/boots. Recognizably a CAT: short feline muzzle, small triangular ears, grey striped forehead, white muzzle/chest, long curved grey striped tail (NOT a fox tail). Cute friendly proportions, big head, compact upright body. Consistent identity, clothing, anatomy, camera, lighting and scale in every cell.
CRITICAL TECHNICAL LAYOUT: one single image exactly 1024 pixels wide by 2304 pixels high. A strict invisible uniform grid of 4 columns by 9 rows. Each cell exactly 256x256. Exactly one full-body cat in each of the 36 cells. No gutters or borders, no text or labels, no contact sheet title, no background, genuine transparent alpha. All characters inside their own cell with at least 20px clear padding, feet baseline at local y=228 except airborne jump. Head-to-toe height about 194px, centered on local x=128, consistent scale. No clipped ears/tails/tools; no neighboring cell overlap. No floor, no ground shadow, no props outside cells.
Frames read left to right as sequential animation phases. Rows top to bottom:
row 1 (idle): neutral upright breathing, eyes open / half blink / closed blink / open; paws down and gentle tail sway.
row 2 (walk right): four distinct side-facing right walk cycle phases with alternating foot contact, passing, opposite contact, passing; body remains centered.
row 3 (walk left): four distinct side-facing left walk cycle phases, matching row 2.
row 4 (wave): front-facing raises right paw / waves outward / waves inward / lowers paw, warm smile.
row 5 (jump): front-facing crouch / rising jump with paws raised / airborne delighted / landing. Stay within cell; do not change scale.
row 6 (failed): front-facing disappointed drooping ears / looks down / gentle sigh / starts looking up; no tears or text.
row 7 (waiting): front-facing hands open, head tilt left / head center / tilt right / head center, curious patient expression.
row 8 (working): front-facing holds small compact brass tool with both paws at chest, inspecting / adjusting / tightening / inspecting; tool stays consistently same and within silhouette.
row 9 (review): front-facing reads small dark teal notebook at chest, looks down / thoughtful head tilt / turns one page / looks down. Notebook in all four cells.
Render clean crisp transparent edges, matching the engineer fox reference's warm materials and sculpted 3D aesthetic. No foxes, no humans, no duplicate characters inside a cell. The output is the usable atlas itself.
```

### 狗

```text
Use case: stylized-concept. Asset type: production transparent PNG sprite atlas for a desktop companion.
Input image 1 is STYLE REFERENCE ONLY: the existing engineer fox sheet. Input image 2 is the matching cat teammate: match its polished style, goggles, overalls and character scale, but make a clearly different dog species. Generate a NEW GOLDEN FLOPPY-EARED PUPPY engineer, in the same polished soft 3D animated toy character style, detailed fluffy fur, expressive amber eyes, round teal-blue goggles worn over eyes, olive khaki engineer overalls, brown belt/gloves/boots. Recognizably a DOG: short rounded canine muzzle, black button nose, soft floppy ears, golden honey fur, cream muzzle/chest, curved medium-length golden tail (NOT pointed fox ears and NOT dog stripes). Cute friendly proportions, big head, compact upright body. Consistent identity, clothing, anatomy, camera, lighting and scale in every cell.
CRITICAL TECHNICAL LAYOUT: one single image exactly 1024 pixels wide by 2304 pixels high. A strict invisible uniform grid of 4 columns by 9 rows. Each cell exactly 256x256. Exactly one full-body dog in each of the 36 cells. No gutters or borders, no text or labels, no contact sheet title, no background, genuine transparent alpha. All characters inside their own cell with at least 20px clear padding, feet baseline at local y=228 except airborne jump. Head-to-toe height about 194px, centered on local x=128, consistent scale. No clipped ears/tails/tools; no neighboring cell overlap. No floor, no ground shadow, no props outside cells.
Frames read left to right as sequential animation phases. Rows top to bottom:
row 1 (idle): neutral upright breathing, eyes open / half blink / closed blink / open; paws down and gentle tail sway.
row 2 (walk right): four distinct side-facing right walk cycle phases with alternating foot contact, passing, opposite contact, passing; body remains centered.
row 3 (walk left): four distinct side-facing left walk cycle phases, matching row 2.
row 4 (wave): front-facing raises right paw / waves outward / waves inward / lowers paw, warm smile and happy floppy ears.
row 5 (jump): front-facing crouch / rising jump with paws raised / airborne delighted / landing. Stay within cell; do not change scale.
row 6 (failed): front-facing disappointed drooping ears / looks down / gentle sigh / starts looking up; no tears or text.
row 7 (waiting): front-facing hands open, head tilt left / head center / tilt right / head center, curious patient expression.
row 8 (working): front-facing holds small compact brass tool with both paws at chest, inspecting / adjusting / tightening / inspecting; tool stays consistently same and within silhouette.
row 9 (review): front-facing reads small dark teal notebook at chest, looks down / thoughtful head tilt / turns one page / looks down. Notebook in all four cells.
Render clean crisp transparent edges, matching the engineer fox reference's warm materials and sculpted 3D aesthetic. No foxes, no humans, no duplidoge characters inside a cell. The output is the usable atlas itself.
Maintain clear transparent separation between every row: every character and prop must fit inside its own equal-size cell, a minimum 20px blank gutter to each cell edge. Neutral stance has the same foot baseline across cells. Do not render red/yellow outline effects or colored halos.
```
