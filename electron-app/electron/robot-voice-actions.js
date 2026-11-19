const { createPkb, PROTECTED_DIRECTORIES } = require("./pkb");

const CONFIRM = /^(?:确认(?:新增|添加|创建)?(?:任务)?|确定|是的)[。！!]?$/;
const REJECT = /^(?:取消(?:新增|添加|创建)?(?:任务)?|不用了|不添加)[。！!]?$/;
const task = /^(?:请)?(?:帮我)?(?:添加|新增|创建|新建)(?:一个|一条)?(?:任务|待办)[：:\s]*(.+)$/;
const notes = /^(?:请)?(?:帮我)?(?:在(?:我的)?笔记里(?:查找|搜索|查一下)|(?:查找|搜索|查询|查一下|查)(?:我的)?笔记)[：:\s]*(.+)$/;
function response(speech, display) { return { speech, display }; }
function splitDate(text, now) {
  const date = /^(今天|明天|后天)(?:之前|前)?[，,\s]*(.+)$/.exec(text);
  const absolute = /^(\d{4}-\d{2}-\d{2})(?:之前|前)?[，,\s]*(.+)$/.exec(text);
  if (absolute) {
    const parsed = new Date(absolute[1] + "T00:00:00Z");
    if (Number.isFinite(+parsed) && parsed.toISOString().slice(0, 10) === absolute[1]) {
      return { title: absolute[2], dueDate: absolute[1] };
    }
  }
  if (!date) return { title: text };
  const next = new Date(now);
  next.setDate(next.getDate() + ["今天", "明天", "后天"].indexOf(date[1]));
  const dueDate = [next.getFullYear(), next.getMonth() + 1, next.getDate()].map(v => String(v).padStart(2, "0")).join("-");
  return { title: date[2], dueDate };
}
function isUnprotected(relative) {
  const p = "/" + relative.toLowerCase() + "/";
  return !PROTECTED_DIRECTORIES.some(folder => {
    return p.includes("/" + folder.toLowerCase() + "/");
  });
}
function createRobotActions({ enabled, getRoot, getGeneration, addTask, onTaskAdded = () => {}, now = () => new Date() }) {
  return function run(text, context, signal) {
    signal.throwIfAborted();
    const pending = context.pending;
    delete context.pending;
    const confirm = CONFIRM.test(text), reject = REJECT.test(text);
    const newTask = task.exec(text), noteQuery = notes.exec(text);
    if (!(confirm || reject || newTask || noteQuery)) return;
    if (!enabled()) return response("请先在 Dance Monkey 的机器人语音设置中开启笔记和任务。");
    if (confirm || reject) {
      if (!pending) return response("当前没有待确认的任务。");
      if (reject) return response("已取消。");
      if (+now() > pending.expires || pending.root !== getRoot() || pending.generation !== getGeneration()) {
        return response("任务确认已过期或笔记库已切换，请重新说一遍。");
      }
      addTask(pending.input, pending.generation);
      onTaskAdded();
      return response("任务已添加。", "已添加：" + pending.input.title);
    }
    if (newTask) {
      const input = splitDate(newTask[1].replace(/[。！!]+$/, "").trim().slice(0, 180), now());
      if (!input.title) return response("请说出任务标题。");
      context.pending = { input, root: getRoot(), generation: getGeneration(), expires: +now() + 60000 };
      return response("请说确认添加任务，或说取消。",
        "添加任务：" + input.title + (input.dueDate ? " · 截止 " + input.dueDate : "") + "。请说确认或取消。");
    }
    const query = noteQuery[1].replace(/[。？！?!]+$/, "").trim().slice(0, 80);
    if (!query) return response("请说出要查的笔记关键词。");
    const hits = createPkb(getRoot()).search(query, { allowPath: isUnprotected, excludeSensitive: true });
    if (!hits.length) return response("没有找到匹配的笔记，可以换个关键词。");
    // Only the device receives note excerpts. The voice service hears the count.
    const shown = hits.slice(0, 2).map(hit => hit.title + "：" + hit.snippet);
    const speech = "找到" + hits.length + (hits.length === 100 ? "篇或更多笔记" : "篇笔记") + "，请看屏幕。";
    return response(speech, shown.join("\n").slice(0, 210));
  };
}
module.exports = { createRobotActions };
