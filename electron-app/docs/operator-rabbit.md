# 话务员兔子

原创奶油色拟人兔，青绿色带麦耳机、薄荷绿开衫、日常办公服。独立 ID `operator-rabbit` / 名称“话务员兔子”；保留所有旧宠物及默认选择。仅用户手动保存设置或点击外形菜单才会切换。

内置 image_gen 生成，源 PNG：`assets/pets/operator-rabbit/spritesheet.png`，836×1881 RGBA，SHA-256 `fc866eda6c4633bf45682b0dd663930268090658f416ff4f6c966b3c13f4577e`。PNG 原始像素和 alpha 均未修改；原始提示词在 `docs/operator-rabbit-prompt.txt`。请求为1024×2304，工具实际返回836×1881，故使用逐帧坐标避免按均匀网格裁掉长耳。

`tools/index-operator-atlas.py` 读取 alpha>32 的轮廓，保留3px边缘，生成 `src/pet-operator-atlas.js`；36帧按256×256逻辑画布水平居中、脚底基线248，跳跃帧保留抬升。忽略原图几乎不可见的低alpha残留来确定轮廓，不修改原图。重建需要 Pillow：`python3 tools/index-operator-atlas.py`。

九行、每行4帧：idle 待机眨眼；right 右行；left 左行；wave 招手；jump 开心跳跃；failed 失落恢复；waiting 倾听待命；working 轻触耳麦、说话和倾听；review 记录笔记。wave/jump为单次事件，其余循环。右行/左行保留素材和预览，沿用现有程序行为，不新增自动桌面游走。没有警察、警服、警徽、对讲机或已知角色参考。

`docs/operator-rabbit-preview.html` 可直接打开，显示九行动画、全部36帧、48/68/96/128尺寸和浅深背景；截图在同名PNG。新皮肤加载失败时显示明确错误提示，不冒充其他动物。加载缓存按物种分开，切换期间旧图响应不会覆盖当前皮肤。

验证命令：

```
npm test
DM_PET_QA_ANIMAL=operator-rabbit node test/e2e-pet-atlas.mjs
DM_PET_QA_ANIMAL=engineer-fox node test/e2e-pet-atlas.mjs
node test/e2e-pet.mjs
```

Electron回归使用临时userData与测试状态，不读取或修改用户当前配置、聊天分身或已安装应用。验证工作/阅读等实际动作的所有帧、招手/跳跃结束、重复广播、透明度、四尺寸与DPR 1/2、中心对齐、隐藏恢复、减少动态效果和卸载清理；预览另外呈现右/左行36帧。设置回归验证手动选择话务员兔子，以及旧狐狸停用/启用与重启恢复。

本次未提交、推送、公开发布或替换安装应用。
