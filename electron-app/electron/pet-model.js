const { messages, taps } = require('../src/pet-dialogue');
const ANIMALS = { human: '小人', cat: '猫咪', dog: '狗狗', rabbit: '兔子', fox: '狐狸', goose: '大鹅', cockroach: '蟑螂', mosquito: '蚊子', capybara: '水豚', frog: '青蛙', penguin: '企鹅', turtle: '乌龟', hedgehog: '刺猬', 'engineer-fox': '工程师' };
const SIZES = [48, 68, 96, 128];
const DEFAULTS = { petModeEnabled: false, petAnimal: 'human', petDisplaySize: 68, petMoodDecayEnabled: true,
  petPreventSleepEnabled: true, todoReminderEnabled: false, todoReminderMinutes: 60 };
function normalizeSettings(config = {}) {
  const result = {};
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const pascal = key[0].toUpperCase() + key.slice(1);
    result[key] = config[key] ?? config[pascal] ?? fallback;
  }
  for (const key of ['petModeEnabled', 'petMoodDecayEnabled', 'petPreventSleepEnabled', 'todoReminderEnabled']) {
    result[key] = result[key] === true;
  }
  result.petAnimal = String(result.petAnimal).trim().toLowerCase();
  if (!Object.hasOwn(ANIMALS, result.petAnimal)) result.petAnimal = 'cat';
  result.petDisplaySize = SIZES.includes(Number(result.petDisplaySize)) ? Number(result.petDisplaySize) : 68;
  const minutes = Number(result.todoReminderMinutes);
  result.todoReminderMinutes = Math.min(240, Math.max(45, Number.isFinite(minutes) ? Math.round(minutes) : 60));
  return result;
}
const spriteMood = (mood) => ({ focused: 'working', encouraging: 'happy', taskReminder: 'bored', sleeping: 'sleepy' })[mood] || mood;
function createMood({ now = Date.now, random = Math.random } = {}) {
  let mood = 'normal', interactions = 0, lastInteraction = now(), until = 0;
  const pick = (items) => items[Math.min(items.length - 1, Math.floor(random() * items.length))];
  function set(next, duration = 0) { mood = next; until = now() + duration; }
  function tap(animal) {
    lastInteraction = now();
    interactions++;
    set(interactions >= 5 ? 'happy' : 'normal');
    return { text: pick(mood === 'happy' ? messages.happy : taps[animal] || messages.tap), animation: mood === 'happy' ? 'jump' : 'pop' };
  }
  function decay(enabled) {
    if (now() < until) return;
    if (!['normal', 'happy', 'bored', 'sleepy'].includes(mood)) mood = 'normal';
    if (!enabled) { if (mood === 'bored' || mood === 'sleepy') mood = 'normal'; return; }
    const minutes = (now() - lastInteraction) / 60000;
    if (minutes > 15) { mood = 'sleepy'; interactions = 0; }
    else if (minutes > 8) { mood = 'bored'; interactions = Math.max(0, interactions - 1); }
    else if (minutes > 4) { if (mood === 'happy') mood = 'normal'; interactions = Math.max(0, interactions - 1); }
  }
  function auto() {
    if (mood === 'normal' && now() >= until && random() < .45) {
      set(pick(['eating', 'sleeping', 'working', 'reading', 'exercising', 'relaxing']), (2 + Math.floor(random() * 3)) * 60000);
    }
    if (mood === 'happy' && random() >= 1 / 3) return null;
    const key = mood === 'sleeping' ? 'sleepy' : mood;
    if (!messages[key]) return null;
    return { text: pick(messages[key]), animation: ['happy', 'encouraging', 'exercising'].includes(mood) ? 'jump' : mood === 'bored' ? 'shake' : '' };
  }
  return { tap, decay, auto, set, get mood() { return spriteMood(mood); } };
}
// Keep dates in local calendar time, matching the original DateTime.Today behavior.
function localDay(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function buildTaskReminder(tasks, lastId, date = new Date()) {
  const get = (task, key) => task[key] ?? task[key[0].toLowerCase() + key.slice(1)];
  const today = localDay(date);
  const due = (task) => String(get(task, 'DueDate') || '').slice(0, 10);
  const urgent = (task) => get(task, 'Impact') >= 4 && get(task, 'Urgency') >= 4;
  const rank = (task) => due(task) && due(task) < today ? 0 : due(task) === today ? 1 : urgent(task) ? 2 : get(task, 'WorkflowStatus') === 'In Progress' ? 3 : 4;
  const pending = tasks.filter((task) => String(get(task, 'Title') || '').trim() && !['done', 'completed', 'cancelled', 'canceled', 'deferred'].includes(String(get(task, 'WorkflowStatus') || '').trim().toLowerCase()))
    .sort((a, b) => rank(a) - rank(b) || (due(a) || '9999').localeCompare(due(b) || '9999') || ((get(b, 'Impact') || 0) + (get(b, 'Urgency') || 0)) - ((get(a, 'Impact') || 0) + (get(a, 'Urgency') || 0)));
  if (!pending.length) return null;
  const pick = pending.find((task) => get(task, 'Id') !== lastId) || pending[0];
  const overdue = pending.filter((task) => due(task) && due(task) < today).length;
  const dueToday = pending.filter((task) => due(task) === today).length;
  const high = pending.filter(urgent).length;
  const title = String(get(pick, 'Title')).trim();
  const prefix = overdue ? `还有 ${overdue} 项逾期任务，先看：` : dueToday ? `今天还有 ${dueToday} 项任务，先推进：` : high ? `有 ${high} 项高优先任务待处理：` : `待办还有 ${pending.length} 项，挑一个推进吧：`;
  return { id: get(pick, 'Id'), text: prefix + (title.length > 28 ? title.slice(0, 28) + '…' : title) };
}
function clampBounds(bounds, displays) {
  const area = displays.map((display) => display.workArea).reduce((best, area) => {
    const distance = (candidate) => Math.hypot(Math.max(candidate.x - bounds.x, 0, bounds.x - (candidate.x + candidate.width - bounds.width)), Math.max(candidate.y - bounds.y, 0, bounds.y - (candidate.y + candidate.height - bounds.height)));
    return !best || distance(area) < distance(best) ? area : best;
  }, null);
  return { ...bounds, x: Math.round(Math.max(area.x, Math.min(bounds.x, area.x + area.width - bounds.width))), y: Math.round(Math.max(area.y, Math.min(bounds.y, area.y + area.height - bounds.height))) };
}
module.exports = { ANIMALS, SIZES, DEFAULTS, normalizeSettings, createMood, buildTaskReminder, clampBounds };
