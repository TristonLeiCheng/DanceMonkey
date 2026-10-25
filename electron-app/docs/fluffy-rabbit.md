# 绒绒兔

独立外形ID：fluffy-rabbit。奶油白长绒毛、粉色鼻尖、一只微弯耳尖、圆肚皮和棉花球尾巴。自然小兔造型，不穿衣、不戴眼镜。保留像素兔和话务员兔子。

[动作预览](fluffy-rabbit-preview.html) · [预览截图](fluffy-rabbit-preview.png) · [原始透明PNG](../assets/pets/fluffy-rabbit/spritesheet-fluffy.png) · [完整提示词](fluffy-rabbit-prompt.txt)

采用内置image_gen生成，transparent_background=true。原始PNG为836×1881 RGBA，SHA-256 b680ba412715f5282e6e68f7cb12c581a1c3cf7383d222a407f1b128b8b056c1；直接复制生成结果，像素和alpha未修改。tools/index-companion-atlases.py读取轮廓生成36个裁切范围及落点，避免耳朵被不均匀网格裁断。

9组动作：眨眼、右蹦、左蹦、挥爪、开心小跳、失落、打盹、洗脸、歪头嗅嗅。每组4帧，挥爪和跳跃在桌面播放一次后回到当前情绪；预览可循环。左右动作保留供预览，未新增自动桌面游走。

已接入设置的动画伙伴第一张卡片、右键菜单、独立互动台词和加载失败提示。现有19种宠物，其中9种动画伙伴、10种像素伙伴。

验证：26项宠物相关测试通过；真实Electron中的36帧坐标、活动动作播放、一次性动作收尾、48/68/96/128尺寸与DPR1/2、透明度、隐藏暂停、减少动态效果和清理验证通过；设置预览与保存切换端到端验证通过。
