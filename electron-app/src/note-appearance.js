((scope) => {
  const colors = [
    ['#e57373', '珊瑚红'], ['#e8a04d', '暖橙'], ['#c6a33b', '金黄'], ['#63ad78', '草绿'],
    ['#43a7a5', '青绿'], ['#639ce0', '天空蓝'], ['#9b87d5', '淡紫'], ['#d780b2', '玫瑰粉'],
  ];
  const backgrounds = [
    ['#fce8e6', '浅玫瑰'], ['#fff0db', '浅杏色'], ['#fff6cf', '奶油黄'], ['#e5f3e8', '浅草绿'],
    ['#e1f3f2', '浅青色'], ['#e6effb', '浅雾蓝'], ['#eee8fa', '浅薰衣草'], ['#292d3e', '深石板'],
  ];
  const templates = [
    { id: 'work', label: '专注工作', color: '#285c9b', backgroundColor: '#e6effb', emoji: '💼' },
    { id: 'study', label: '学习积累', color: '#596d27', backgroundColor: '#edf3dd', emoji: '📚' },
    { id: 'idea', label: '灵感收集', color: '#8c661a', backgroundColor: '#fff6cf', emoji: '💡' },
    { id: 'journal', label: '日常手记', color: '#a34c77', backgroundColor: '#fbe9f1', emoji: '🌸' },
    { id: 'project', label: '项目计划', color: '#60449b', backgroundColor: '#eee8fa', emoji: '🚀' },
    { id: 'nature', label: '自然清新', color: '#286f54', backgroundColor: '#e5f3e8', emoji: '🌱' },
    { id: 'night', label: '夜间思考', color: '#c6d6f5', backgroundColor: '#292d3e', emoji: '🌙' },
    { id: 'coffee', label: '咖啡时光', color: '#795438', backgroundColor: '#f4e9dd', emoji: '☕' },
  ];
  const emojiGroups = [
    { id: 'common', label: '常用', items: [
      ['📁','文件夹'], ['📂','打开文件夹'], ['📝','笔记'], ['📚','书籍'], ['💡','灵感'], ['⭐','星星收藏'], ['❤️','爱心'], ['🎯','目标'],
      ['🚀','火箭项目'], ['💼','工作'], ['🏠','家'], ['🌱','成长'], ['🎨','艺术'], ['🎵','音乐'], ['📅','日历'], ['✅','完成'],
      ['🔥','热门'], ['🌈','彩虹'], ['🐱','猫 cat'], ['🐵','猴子 monkey'], ['☕','咖啡 coffee'], ['✈️','飞机旅行'], ['🧠','大脑思考'], ['🔖','书签'],
    ] },
    { id: 'work', label: '工作学习', items: [
      ['💻','电脑 code'], ['🖥️','显示器'], ['⌨️','键盘'], ['📱','手机'], ['📊','图表'], ['📈','增长'], ['📉','下降'], ['📋','清单'],
      ['📌','图钉'], ['📎','回形针附件'], ['🗂️','资料分类'], ['🗃️','卡片档案'], ['🗄️','档案柜'], ['📐','设计尺'], ['✏️','铅笔'], ['🖊️','钢笔'],
      ['📖','阅读'], ['🎓','毕业学习'], ['🔬','科学实验'], ['🔭','研究探索'], ['🧪','化学实验'], ['🧮','计算数学'], ['🗓️','计划日程'], ['🤝','合作会议'],
    ] },
    { id: 'life', label: '生活美食', items: [
      ['🍎','苹果 apple'], ['🍊','橙子'], ['🍋','柠檬'], ['🍉','西瓜'], ['🍓','草莓'], ['🍒','樱桃'], ['🥑','牛油果'], ['🥦','西兰花'],
      ['🍞','面包'], ['🥐','可颂'], ['🍜','面条'], ['🍣','寿司'], ['🍕','披萨'], ['🍔','汉堡'], ['🍰','蛋糕'], ['🍪','饼干'],
      ['🍵','茶'], ['🧋','奶茶'], ['🥛','牛奶'], ['🍷','红酒'], ['🛒','购物'], ['🛍️','购物袋'], ['🎁','礼物'], ['🛋️','休息沙发'],
    ] },
    { id: 'animals', label: '动物', items: [
      ['🐶','狗 dog'], ['🐰','兔子 rabbit'], ['🦊','狐狸 fox'], ['🐻','熊 bear'], ['🐼','熊猫 panda'], ['🐨','考拉'], ['🐯','老虎'], ['🦁','狮子'],
      ['🐮','牛'], ['🐷','猪'], ['🐸','青蛙'], ['🐹','仓鼠'], ['🐔','鸡'], ['🐧','企鹅'], ['🦉','猫头鹰'], ['🦋','蝴蝶 butterfly'],
      ['🐝','蜜蜂'], ['🐢','乌龟'], ['🐬','海豚'], ['🐳','鲸鱼'], ['🐙','章鱼'], ['🦀','螃蟹'], ['🦄','独角兽'], ['🐲','龙'],
    ] },
    { id: 'nature', label: '自然天气', items: [
      ['🌸','樱花'], ['🌷','郁金香'], ['🌹','玫瑰'], ['🌻','向日葵'], ['🌼','小花'], ['🌿','草叶'], ['🍀','四叶草幸运'], ['🍁','枫叶'],
      ['🍂','落叶秋天'], ['🌵','仙人掌'], ['🌴','棕榈树'], ['🌳','树木'], ['🍄','蘑菇'], ['☀️','太阳晴天'], ['🌤️','多云晴天'], ['☁️','云'],
      ['🌧️','下雨'], ['⛈️','雷雨'], ['❄️','雪花'], ['⛄','雪人'], ['🌙','月亮夜晚'], ['🌟','闪亮星星'], ['⚡','闪电'], ['🌊','海浪'],
    ] },
    { id: 'mood', label: '心情符号', items: [
      ['😀','开心笑脸'], ['😊','微笑'], ['🥰','喜爱'], ['😎','酷'], ['🤔','思考'], ['🥳','庆祝'], ['🤩','惊喜'], ['😴','睡觉'],
      ['🥺','可怜'], ['😂','大笑'], ['😭','哭泣'], ['😤','加油'], ['🤗','拥抱'], ['👍','赞'], ['👏','鼓掌'], ['🙌','欢呼'],
      ['💪','力量健身'], ['🙏','感谢'], ['💯','百分百'], ['✨','闪光'], ['💎','钻石'], ['🏆','奖杯'], ['🔔','提醒'], ['❗','重要'],
    ] },
    { id: 'travel', label: '旅行运动', items: [
      ['🗺️','地图'], ['🧭','指南针'], ['🏕️','露营'], ['⛺','帐篷'], ['🏔️','雪山'], ['🏖️','海滩'], ['🏝️','海岛'], ['🌋','火山'],
      ['🏰','城堡'], ['⛩️','神社'], ['🗼','铁塔'], ['🌉','大桥'], ['🚗','汽车'], ['🚲','自行车骑行'], ['🚆','火车'], ['🚢','轮船'],
      ['🧳','行李箱'], ['🏃','跑步'], ['⚽','足球'], ['🏀','篮球'], ['🎾','网球'], ['🏊','游泳'], ['🧘','瑜伽冥想'], ['🏋️','举重健身'],
    ] },
    { id: 'creative', label: '兴趣创作', items: [
      ['🎬','电影'], ['🎥','摄影机'], ['📷','相机摄影'], ['🎧','耳机音乐'], ['🎤','唱歌'], ['🎹','钢琴'], ['🎸','吉他'], ['🎻','小提琴'],
      ['🥁','鼓'], ['🎭','戏剧'], ['🖌️','画笔'], ['🧵','手工线'], ['🧶','毛线'], ['🎮','游戏'], ['🎲','骰子桌游'], ['🧩','拼图'],
      ['♟️','国际象棋'], ['🪄','魔法'], ['🕹️','游戏手柄'], ['🛠️','工具修理'], ['🔧','扳手'], ['🔑','钥匙'], ['💌','情书信件'], ['📮','信箱'],
    ] },
  ];
  const emojis = [...new Set(emojiGroups.flatMap(group => group.items.map(([emoji]) => emoji)))];
  function searchEmojis(query = '', category = 'common') {
    const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return emojiGroups.filter(group => words.length || category === 'all' || group.id === category).flatMap(group =>
      group.items.filter(([emoji, label]) => words.every(word => `${emoji} ${label} ${group.label}`.toLocaleLowerCase().includes(word)))
        .map(([emoji, label]) => ({ emoji, label })));
  }
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

  function normalize(value = {}) {
    const color = value.color ?? '';
    const backgroundColor = value.backgroundColor ?? '';
    const rawEmoji = value.emoji ?? '';
    if (typeof rawEmoji !== 'string') throw new Error('请输入一个 emoji 表情');
    const emoji = rawEmoji.trim();
    for (const selected of [color, backgroundColor]) {
      if (typeof selected !== 'string' || (selected && !/^#[\da-f]{6}$/i.test(selected))) throw new Error('请选择有效的颜色');
    }
    if (typeof emoji !== 'string' || (emoji && (emoji.length > 32 || [...segmenter.segment(emoji)].length !== 1 ||
      !/(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3)/u.test(emoji)))) throw new Error('请输入一个 emoji 表情');
    return { color: color.toLowerCase(), backgroundColor: backgroundColor.toLowerCase(), emoji };
  }

  // Ignore invalid decorations from imported files; never interpolate unvalidated CSS.
  function get(node) {
    try { return normalize(node?.appearance); } catch { return { color: '', backgroundColor: '', emoji: '' }; }
  }

  function style(node) {
    const { color, backgroundColor } = get(node);
    return `${color ? `--note-accent:${color};` : ''}${backgroundColor ? `--note-bg:${backgroundColor};` : ''}`;
  }

  const api = { colors, backgrounds, templates, emojiGroups, emojis, searchEmojis, normalize, get, style };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else scope.DMNoteAppearance = api;
})(typeof window !== 'undefined' ? window : globalThis);
