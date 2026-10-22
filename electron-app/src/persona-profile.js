(function(root) {
  const zodiac = ["白羊座", "金牛座", "双子座", "巨蟹座", "狮子座", "处女座", "天秤座", "天蝎座", "射手座", "摩羯座", "水瓶座", "双鱼座"];
  // Original observation prompts, not the official MBTI questionnaire.
  const questions = [
    ["精力恢复", "与人交流后更有精神", "独处后更有精神"],
    ["想法形成", "边交流边形成想法", "先独立思考再交流"],
    ["社交习惯", "主动结识更多人", "偏好少数深入关系"],
    ["理解信息", "先看具体事实和细节", "先看整体模式和可能性"],
    ["学习方式", "偏好实例和实际操作", "偏好概念和原理探索"],
    ["处理问题", "倾向使用已有经验", "倾向探索新思路"],
    ["做出决定", "先考虑逻辑和一致性", "先考虑价值观和人的感受"],
    ["提出反馈", "优先指出问题所在", "优先顾及对方的感受"],
    ["意见冲突", "先比较论据与规则", "先理解各方需求与关系"],
    ["安排工作", "喜欢提前计划并确定安排", "喜欢保留余地灵活调整"],
    ["推进任务", "倾向尽早完成并收尾", "倾向边探索边调整"],
    ["面对选择", "倾向及时确定方案", "倾向继续收集可能选项"],
  ];
  function assess(answers) {
    if (!Array.isArray(answers) || answers.length !== 12 || answers.some(a => ![-1, 0, 1].includes(a))) throw new Error("请完成全部 12 题；不确定的题目请选择不了解。");
    const pairs = ["EI", "SN", "TF", "JP"];
    const dimensions = pairs.map((pair, i) => {
      const values = answers.slice(i * 3, i * 3 + 3), score = values.reduce((a, b) => a + b, 0);
      return { pair, score, observed: values.filter(Boolean).length, letter: score > 0 ? pair[0] : score < 0 ? pair[1] : "X" };
    });
    return { type: dimensions.map(d => d.letter).join(""), dimensions };
  }
  function normalize(value = {}) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("人物档案格式无效。");
    const text = (key, max) => {
      const s = value[key] ?? "";
      if (typeof s !== "string" || s.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s)) throw new Error("人物档案字段过长或格式无效：" + key);
      return s.trim();
    };
    const birthDate = text("birthDate", 10), sign = text("zodiac", 8);
    if (birthDate) {
      if (!/^\d{4}-\d{2}(?:-\d{2})?$/.test(birthDate)) throw new Error("出生年月请填写 YYYY-MM，也可填写 YYYY-MM-DD。");
      const full = birthDate.length === 7 ? birthDate + "-01" : birthDate;
      const date = new Date(full + "T00:00:00Z");
      if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== full || date.getTime() > Date.now() || Number(full.slice(0,4)) < 1) throw new Error("出生日期无效或晚于今天。");
    }
    if (sign && !zodiac.includes(sign)) throw new Error("请选择有效星座。");
    const answers = value.answers ?? Array(12).fill(null);
    if (!Array.isArray(answers) || answers.length !== 12 || answers.some(a => a !== null && ![-1, 0, 1].includes(a))) throw new Error("MBTI 观察答案无效。");
    const mode = value.mbtiMode ?? "manual";
    if (!["manual", "assessment"].includes(mode)) throw new Error("MBTI 来源无效。");
    let mbti = text("mbti", 4).toUpperCase();
    if (mode === "assessment") mbti = assess(answers).type;
    else if (mbti && !/^[EIX][SNX][TFX][JPX]$/.test(mbti)) throw new Error("MBTI 请填写如 INTJ；不确定的维度可填 X。");
    return { birthDate, zodiac: sign, resume: text("resume", 12000), events: text("events", 12000), mbti, mbtiMode: mode,
      answers: [...answers], mbtiNotes: text("mbtiNotes", 2000) };
  }
  function evidence(value) {
    const p = normalize(value);
    return [["出生年月 / 日期", p.birthDate], ["星座（仅记录）", p.zodiac], ["简历", p.resume], ["人物事件（用户记录）", p.events],
      [p.mbtiMode === "assessment" ? "MBTI（用户代填观察问卷，非正式测评）" : "MBTI（用户手动标注）", p.mbti], ["MBTI 观察依据", p.mbtiNotes]]
      .filter(([,v]) => v).map(([k,v]) => k + "：" + v).join("\n");
  }
  const api = { zodiac, questions, assess, normalize, evidence };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DMPersonaProfile = api;
})(typeof window === "undefined" ? globalThis : window);
