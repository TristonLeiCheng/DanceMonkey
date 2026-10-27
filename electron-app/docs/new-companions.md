# 海獭、小熊猫咖啡师与团子小龙

三个独立外形已加入软件设置和宠物右键菜单，现有选项共18种。选择后保存即可生效；默认选择和用户配置不变。

| ID | 名称 | 原始PNG | 尺寸 | SHA-256 |
|---|---|---|---|---|
| otter | 抱贝壳的小海獭 | [原图](../assets/pets/otter/spritesheet-natural.png) | 836 × 1881 RGBA | 63bb08ec59b842308ba2693a2653ee8a5018d199c6d094ed5b6981d84aa4249b |
| red-panda | 小熊猫咖啡师 | [原图](../assets/pets/red-panda/spritesheet-barista.png) | 836 × 1881 RGBA | 67d5ae0297fd8b0e42962a723c991fdb6cbe21180081960b851b28bde087fe3c |
| baby-dragon | 团子小龙 | [原图](../assets/pets/baby-dragon/spritesheet-dragon.png) | 836 × 1881 RGBA | ef48c81c240808e1daf4bf7d393f105e6694f690d47bcc25df663e174bbabde9 |

## 生成与动作

使用内置 image_gen，transparent_background=true。初始提示词完整保存在 [new-companions-prompts.json](new-companions-prompts.json)。海獭首版行走帧横向挤在一起，使用 image_gen 参照首版重新生成更宽留白，修正提示词在 [otter-spacing-prompt.txt](otter-spacing-prompt.txt)。最终三个PNG均直接复制生成结果，未修改像素或透明通道。

每只9行、每行4帧，共108帧：idle待机、right右行、left左行、wave招手、jump跳跃、failed失落、waiting休息、working忙碌、review好奇。招手和跳跃在程序中播放一次后回到当前状态；预览为方便检查会循环。左右行走可在预览切换，沿用现有桌面宠物行为，不新增自动游走。

海獭：抱贝壳、眨眼、四足散步、挥爪、弹跳、失落、仰躺休息、开贝壳、查看贝壳。小熊猫：围裙造型、圈纹尾巴、走路、挥手、跳跃、失落、揉眼打哈欠、磨咖啡、端杯品尝。小龙：薄荷绿圆肚皮、小翅膀、摇尾走路、挥爪、扑翼跳跃、垂头、盘尾打盹、练习振翅、歪头查看爪子。

工具实际返回836×1881，生成布局不是严格等距网格。`tools/index-companion-atlases.py`读取alpha>32的轮廓并保留3px边缘，为每帧记录原图裁切范围和256×256逻辑画布落点。忽略alpha=1的几乎不可见残留只用于定位，不改动PNG。重建命令：`python3 tools/index-companion-atlases.py`，需Pillow。

新增外形没有旧像素版本，加载失败会显示对应名称的错误提示。加载缓存按物种隔离，切换期间延迟到达的旧图片不会覆盖当前角色。

## 预览与验证

[交互动作预览](new-companions-preview.html)包含9组动作、暂停和浅/深色背景；[截图](new-companions-preview.png)。

已通过：

- `npm test`：429项通过。
- 三次 `DM_PET_QA_ANIMAL=<otter|red-panda|baby-dragon> node test/e2e-pet-atlas.mjs`：实际Electron渲染，循环动作所有帧、一次性动作收尾、重复状态广播、48/68/96/128尺寸、DPR1/2、透明度、居中、隐藏恢复、减少动态效果和卸载清理。
- `node test/e2e-pet.mjs`：逐只从设置选择保存，核对实际窗口外形和配置持久化，验证停用/启用及重启恢复。
- 浏览器检查浅色待机、深色行走与忙碌动作，角色透明边缘正常。

本次完成源代码和素材接入，未打包、发布或替换已安装的Mac应用。验证使用隔离测试配置。
