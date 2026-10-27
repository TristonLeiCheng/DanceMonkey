# 大胃袋良子 · 经典黄纹短袖写实版

独立角色 ID：`liangzi`，显示名“大胃袋良子”。采用真实成年人的脸部特征和身体比例，穿经典黑底黄金花纹短袖、黑色短裤与米色拖鞋，保留短发、手表和红色手串。

## 素材和预览

- [最终透明 PNG](../assets/pets/liangzi/spritesheet-realistic-v2.png)：836 × 1881 RGBA。
- SHA-256：`f2ba101479eb6247ea30a7a0649c62a3d73725f746b3b5b325c2036183a497fd`。
- 内置 image_gen 以公开人物照片为参考生成，`transparent_background=true`；原始 PNG 像素与 alpha 未修改。
- [最终生成提示词](liangzi-realistic-yellow-prompt.txt)。
- [交互动画预览](liangzi-preview.html) · [浅色预览](liangzi-preview.png) · [深色预览](liangzi-preview-dark.png) · [吃面动作](liangzi-eating.png)。

形象与服装参考来自[新京报公开报道](https://m.bjnews.com.cn/detail/1756083753168194.html)中的[经典黄纹短袖近照](https://wx1.sinaimg.cn/mw1024/001Ngxkily4i4ptp1xgzij60u01j646002.jpg)及[全身体态照片](https://wx1.sinaimg.cn/mw1024/001Ngxkily4i4ptozuejyj60u019iwki02.jpg)。

## 使用与动作

设置 → 桌面宠物 → 动画伙伴，选择“大胃袋良子”卡片；选择后保存设置，也可通过桌面宠物右键菜单切换。现有 24 种宠物，其中 14 种动画伙伴、10 种像素伙伴。

9 组动作，每组 4 帧，共 36 帧：待机、右走、左走、招手、小跳、失落、坐下休息、吃面、点赞。吃饭状态播放吃面，工作/专注状态播放点赞，休闲/睡眠状态播放坐下休息。招手和小跳播放一次后返回当前状态；沿用键盘操控、文件搬运与提醒功能。

互动台词包含“味真足”及程序创作的简短陪伴语句。

## 动作裁切

源图中人物轮廓独立，但部分人物的矩形边界相交。`tools/index-companion-atlases.py` 为该角色按 alpha 连通轮廓识别 36 个人物，记录逐帧边界及必要的局部裁切矩形。索引过程校验每个角色的实心轮廓全部保留，且不包含相邻人物的实心像素。

`DMPetAtlas.drawFrame` 在桌面、设置面板和该角色预览页中统一使用这些裁切信息。其他宠物沿用原来的源图裁切范围与落点。重建需要 Pillow：`python3 tools/index-companion-atlases.py`。资源清单记录最终图片路径和哈希。

## 验证

65 项宠物相关单元/集成测试通过，覆盖角色选择、台词、图集哈希、36 帧边界、相邻角色隔离、图像加载切换、动作状态、操控、搬运及提醒。

真实 Electron 验证已通过：九组动作、动作收尾、四种尺寸与 DPR 1/2、透明度、80 组气泡位置场景、隐藏暂停、减少动态效果与清理。浅色、深色和吃面动作截图已检查。

`npm run test:e2e:pet` 已通过，包含写实黄纹角色的设置预览、独立动作、保存切换、磁盘配置校验与应用重启。当前本地开发应用已正常重启，本次未打包或发布安装版。
