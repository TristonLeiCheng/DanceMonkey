const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const KINDS = ['IntervalMinutes', 'ActiveUseInterval', 'Daily', 'Weekly', 'Monthly', 'Once'];
const STYLES = ['GlassCard', 'Circular', 'DynamicIsland', 'Toast', 'Banner', 'Compact'];
const BUILT_INS = ['builtin-water', 'builtin-sedentary'];
const clone = value => structuredClone(value);
const restore = (target, previous) => { for (const key of Object.keys(target)) delete target[key]; Object.assign(target, previous); };
const enumValue = (value, values, fallback) => Number.isInteger(value) ? values[value] ?? fallback : values.find(item => item.toLowerCase() === String(value).toLowerCase()) ?? fallback;
const bounded = (value, fallback, min, max) => Math.min(max, Math.max(min, Math.round(Number(value) || fallback)));
const stamp = value => value ? new Date(value).getTime() || 0 : 0;
const pad = value => String(value).padStart(2, '0');
const localDay = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
function normalizeTime(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value).trim());
  return match && Number(match[1]) < 24 && Number(match[2]) < 60 ? `${pad(Number(match[1]))}:${match[2]}` : null;
}
function normalizeReminder(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('提醒格式无效。');
  const title = String(input.title || '').trim();
  if (!title) throw new Error('请填写提醒标题。');
  const schedule = input.schedule || {};
  const kind = enumValue(schedule.kind, KINDS, null);
  if (!kind) throw new Error('请选择有效的重复规则。');
  const times = [...new Set((Array.isArray(schedule.times) ? schedule.times : ['09:00']).map(normalizeTime))];
  if (['Daily', 'Weekly', 'Monthly'].includes(kind) && (!times.length || times.includes(null))) throw new Error('提醒时间格式应为 HH:mm，例如 09:00。');
  if (kind === 'Once' && !stamp(schedule.onceAt)) throw new Error('请选择一次性提醒的日期和时间。');
  if (kind === 'Weekly' && schedule.weekdays != null && (!Number.isInteger(Number(schedule.weekdays)) || Number(schedule.weekdays) < 1 || Number(schedule.weekdays) > 127)) throw new Error('请至少选择一个有效星期。');
  const id = String(input.id || randomUUID()).trim().toLowerCase();
  if (!id || id.length > 200) throw new Error('提醒 ID 无效。');
  return {
    id, title: title.slice(0, 200), message: String(input.message || '').slice(0, 4000), icon: String(input.icon || '🔔').slice(0, 32),
    enabled: input.enabled !== false, isBuiltIn: BUILT_INS.includes(id),
    notifyStyle: enumValue(input.notifyStyle, ['DesktopPopup', 'PetBubble'], 'PetBubble'),
    useDefaultDelivery: input.useDefaultDelivery === true || input.notifyStyle == null || input.notifyStyle === 'Default',
    popupStyleOverride: input.popupStyleOverride == null || input.popupStyleOverride === '' ? null : enumValue(input.popupStyleOverride, STYLES, null),
    doneLabel: String(input.doneLabel || '已完成').slice(0, 40), laterLabel: String(input.laterLabel || '稍后提醒').slice(0, 40),
    snoozeMinutes: bounded(input.snoozeMinutes, 10, 1, 240), trackDailyStats: input.trackDailyStats !== false,
    schedule: { kind, intervalMinutes: bounded(schedule.intervalMinutes, 30, 1, 1440), times: times.filter(Boolean).sort(), weekdays: bounded(schedule.weekdays, 31, 1, 127), dayOfMonth: bounded(schedule.dayOfMonth, 1, 1, 31), onceAt: kind === 'Once' ? schedule.onceAt : null },
    trigger: { skipWhenIdle: input.trigger?.skipWhenIdle !== false, idleThresholdSeconds: bounded(input.trigger?.idleThresholdSeconds, 300, 1, 86400), resetOnAcknowledge: input.trigger?.resetOnAcknowledge !== false },
  };
}
function builtIns(config = {}) {
  const enabled = config.healthReminderEnabled ?? config.HealthReminderEnabled ?? true;
  return [
    { id: BUILT_INS[0], title: '该喝水啦', message: '起身倒杯水，给自己补充一点水分。', icon: '💧', doneLabel: '已喝水', laterLabel: '稍后再喝', schedule: { kind: 'IntervalMinutes', intervalMinutes: config.waterReminderMinutes ?? config.WaterReminderMinutes ?? 45 } },
    { id: BUILT_INS[1], title: '该起身活动了', message: '站起来伸展一下身体，活动活动筋骨吧。', icon: '🏃', doneLabel: '已活动', laterLabel: '稍后活动', schedule: { kind: 'ActiveUseInterval', intervalMinutes: config.movementReminderMinutes ?? config.MovementReminderMinutes ?? 60 } },
  ].map(item => normalizeReminder({ ...item, enabled, useDefaultDelivery: true }));
}
function dueSlot(reminder, now, lastSlot) {
  const { kind, times, weekdays, dayOfMonth } = reminder.schedule;
  if (kind === 'Weekly' && !(weekdays & (1 << ((now.getDay() + 6) % 7)))) return null;
  if (kind === 'Monthly' && now.getDate() !== dayOfMonth) return null;
  if (!['Daily', 'Weekly', 'Monthly'].includes(kind)) return null;
  const clock = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  // Coalesce missed slots into the latest one; never alternate between old daily slots.
  const time = [...times].reverse().find(value => value <= clock);
  const slot = time ? `${localDay(now)}T${time}` : null;
  return slot && (!lastSlot || slot > lastSlot) ? slot : null;
}

// Keep JSON enum values compatible with the original .NET reminder store and exports.
function serializeStore(data) {
  const result = clone(data);
  for (const item of result.reminders) {
    item.schedule.kind = KINDS.indexOf(item.schedule.kind);
    item.notifyStyle = item.notifyStyle === 'PetBubble' ? 1 : 0;
    item.popupStyleOverride = item.popupStyleOverride == null ? null : STYLES.indexOf(item.popupStyleOverride);
  }
  return result;
}

function createReminderService({ directory, configStore, onDue = () => {}, onChange = () => {}, onError = console.error,
  getIdleSeconds = () => 0, now = Date.now, timers = globalThis }) {
  const file = path.join(directory, 'reminders.json');
  fs.mkdirSync(directory, { recursive: true });
  let data = { schemaVersion: 1, defaultDeliveryVersion: 1, reminders: builtIns(configStore.read()), runtime: [] };
  const pending = new Set();
  const idle = new Map();
  let timer = null, lastTick = now();
  function runtime(item) {
    let state = data.runtime.find(value => value.reminderId === item.id);
    if (!state) {
      state = { reminderId: item.id, continuousUseStart: new Date(now()).toISOString(), statsDate: localDay(new Date(now())), todayAckCount: 0 };
      data.runtime.push(state);
    }
    if (String(state.statsDate).slice(0, 10) !== localDay(new Date(now()))) {
      state.statsDate = localDay(new Date(now())); state.todayAckCount = 0;
    }
    return state;
  }
  function validateFile(input) {
    if (!input || !Array.isArray(input.reminders) || input.reminders.length > 1000) throw new Error('不是有效的提醒文件（需要 reminders 数组，最多 1000 条）。');
    const reminders = input.reminders.map(normalizeReminder);
    if (new Set(reminders.map(item => item.id)).size !== reminders.length) throw new Error('提醒文件中包含重复 ID。');
    return reminders;
  }
  if (fs.existsSync(file)) {
    try {
      const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
      data = { schemaVersion: 1, defaultDeliveryVersion: loaded.defaultDeliveryVersion || 0, reminders: validateFile(loaded), runtime: Array.isArray(loaded.runtime) ? loaded.runtime.filter(item => item && typeof item.reminderId === 'string').map(item => ({ ...item, reminderId: item.reminderId.toLowerCase() })) : [] };
    } catch (error) { throw new Error(`无法读取提醒文件，原文件已保留：${error.message}`); }
  }
  for (const item of builtIns(configStore.read())) if (!data.reminders.some(value => value.id === item.id)) data.reminders.push(item);
  // Existing built-ins without an individual popup override adopt the new
  // default once. Explicit per-item choices made after this migration persist.
  if (!data.defaultDeliveryVersion) {
    for (const item of data.reminders) {
      if (item.isBuiltIn && item.notifyStyle === 'DesktopPopup' && !item.popupStyleOverride) item.useDefaultDelivery = true;
    }
    data.defaultDeliveryVersion = 1;
  }
  for (const item of data.reminders) {
    const state = runtime(item);
    // Time while the app was closed is not continuous computer use.
    state.continuousUseStart = new Date(now()).toISOString();
  }
  function persist() {
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(serializeStore(data), null, 2), 'utf8');
    fs.renameSync(temporary, file);
  }
  persist();
  function mutate(fn) {
    const previous = clone(data);
    try { fn(); persist(); } catch (error) { data = previous; throw error; }
    onChange();
    return list();
  }
  function find(id) {
    const item = data.reminders.find(value => value.id === id);
    if (!item) throw new Error('提醒不存在，请刷新后重试。');
    return item;
  }
  function preferences() {
    const config = configStore.read();
    return { defaultNotifyStyle: enumValue(config.defaultReminderNotifyStyle ?? config.DefaultReminderNotifyStyle, ['DesktopPopup', 'PetBubble'], 'PetBubble'),
      defaultPopupStyle: enumValue(config.defaultReminderPopupStyle ?? config.DefaultReminderPopupStyle, STYLES, 'GlassCard'),
      acrylic: config.reminderPopupAcrylic ?? config.ReminderPopupAcrylic ?? true };
  }
  function delivery(item) {
    return { ...clone(item), notifyStyle: item.useDefaultDelivery ? preferences().defaultNotifyStyle : item.notifyStyle };
  }
  function list() {
    return clone({ reminders: data.reminders.map(item => ({ ...item, runtime: runtime(item), pending: pending.has(item.id) || runtime(item).awaitingAction === true })),
      settings: preferences() });
  }
  function save(input) {
    const item = normalizeReminder(input);
    if (item.isBuiltIn && !data.reminders.some(value => value.id === item.id)) throw new Error('内置提醒不存在。');
    const result = mutate(() => {
      const index = data.reminders.findIndex(value => value.id === item.id);
      const previous = data.runtime.find(value => value.reminderId === item.id);
      const sameSchedule = index >= 0 && JSON.stringify(data.reminders[index].schedule) === JSON.stringify(item.schedule);
      if (index < 0) data.reminders.push(item);
      else data.reminders[index] = item;
      // Editing/re-enabling a schedule starts its interval again.
      data.runtime = data.runtime.filter(value => value.reminderId !== item.id);
      const next = runtime(item);
      if (previous && String(previous.statsDate).slice(0, 10) === next.statsDate) {
        next.todayAckCount = previous.todayAckCount;
      }
      if (sameSchedule && previous?.lastFiredSlotKey) next.lastFiredSlotKey = previous.lastFiredSlotKey;
    });
    pending.delete(item.id); onChange(); return { ...result, ...list() };
  }
  function remove(id) {
    if (find(id).isBuiltIn) throw new Error('内置提醒可以关闭，不能删除。');
    const result = mutate(() => { data.reminders = data.reminders.filter(item => item.id !== id); data.runtime = data.runtime.filter(item => item.reminderId !== id); });
    pending.delete(id); return result;
  }
  function act(id, action) {
    const item = find(id);
    const result = mutate(() => {
      const state = runtime(item), current = new Date(now()).toISOString();
      if (action === 'snooze') { state.snoozeUntil = new Date(now() + item.snoozeMinutes * 60000).toISOString(); state.awaitingAction = false; }
      else if (action === 'done') {
        if (item.trackDailyStats) state.todayAckCount = Math.max(0, Number(state.todayAckCount) || 0) + 1;
        state.awaitingAction = false;
        state.lastAcknowledgedAt = current; state.lastTriggeredAt = current; state.snoozeUntil = null;
        if (item.trigger.resetOnAcknowledge) state.continuousUseStart = current;
        if (item.schedule.kind === 'Once') item.enabled = false;
      } else throw new Error('无效的提醒操作。');
    });
    pending.delete(id); onChange();
    return { ...result, ...list() };
  }
  function tick() {
    const current = now(), date = new Date(current), idleSeconds = getIdleSeconds();
    const gap = current - lastTick > 90000;
    lastTick = current;
    for (const item of data.reminders) {
      const state = runtime(item), isIdle = idleSeconds > item.trigger.idleThresholdSeconds;
      if (item.schedule.kind === 'ActiveUseInterval' && (gap || isIdle || idle.get(item.id))) state.continuousUseStart = date.toISOString();
      idle.set(item.id, isIdle);
      if (!item.enabled || pending.has(item.id) || (item.trigger.skipWhenIdle && isIdle)) continue;
      let slot = null, due = false;
      if (state.snoozeUntil) due = current >= stamp(state.snoozeUntil);
      else if (state.awaitingAction) due = true;
      else if (item.schedule.kind === 'Once') due = current >= stamp(item.schedule.onceAt) && !state.lastTriggeredAt;
      else if (['Daily', 'Weekly', 'Monthly'].includes(item.schedule.kind)) { slot = dueSlot(item, date, state.lastFiredSlotKey); due = !!slot; }
      else {
        const anchor = Math.max(stamp(state.lastTriggeredAt), stamp(state.lastAcknowledgedAt), stamp(state.continuousUseStart));
        due = current - anchor >= item.schedule.intervalMinutes * 60000;
      }
      if (!due) continue;
      const previous = clone(state);
      state.lastTriggeredAt = date.toISOString(); state.snoozeUntil = null; state.awaitingAction = true;
      if (slot) state.lastFiredSlotKey = slot;
      try { persist(); }
      catch (error) { restore(state, previous); onError(error); continue; }
      pending.add(item.id);
      try { onDue(delivery(item), { test: false, ...preferences() }); }
      catch (error) {
        pending.delete(item.id); restore(state, previous);
        try { persist(); } catch (saveError) { onError(saveError); }
        onError(error);
      }
      onChange();
    }
  }
  function test(input) {
    const item = typeof input === 'string' ? find(input) : normalizeReminder(input);
    onDue(delivery(item), { test: true, ...preferences() });
    return true;
  }
  function importData(input, mode = 'merge') {
    const imported = validateFile(input);
    if (!['merge', 'replace'].includes(mode)) throw new Error('请选择合并或替换导入。');
    const result = mutate(() => {
      if (mode === 'replace') data.reminders = data.reminders.filter(item => item.isBuiltIn);
      for (const item of imported) {
        const index = data.reminders.findIndex(value => value.id === item.id);
        if (index < 0) data.reminders.push(item);
        else if (!data.reminders[index].isBuiltIn) data.reminders[index] = item;
      }
      data.runtime = data.runtime.filter(state => data.reminders.some(item => item.id === state.reminderId));
      data.reminders.forEach(runtime);
    });
    pending.clear(); onChange(); return { ...result, ...list() };
  }
  return { list, save, remove, act, tick, test, importData,
    exportData: () => serializeStore(data),
    reset: id => { const item = builtIns(configStore.read()).find(value => value.id === id); if (!item) throw new Error('只能重置内置提醒。'); return save(item); },
    saveSettings: input => {
      const style = enumValue(input?.defaultPopupStyle ?? preferences().defaultPopupStyle, STYLES, null);
      const notifyStyle = enumValue(input?.defaultNotifyStyle ?? 'DesktopPopup', ['DesktopPopup', 'PetBubble'], null);
      if (!style || !notifyStyle) throw new Error('提醒方式无效。');
      configStore.write({ defaultReminderNotifyStyle: notifyStyle === 'PetBubble' ? 1 : 0, defaultReminderPopupStyle: STYLES.indexOf(style), reminderPopupAcrylic: input.acrylic !== false }); onChange(); return list();
    },
    start: () => { if (timer === null) { lastTick = now(); timer = timers.setInterval(() => { try { tick(); } catch (error) { onError(error); } }, 15000); timer?.unref?.(); } },
    stop: () => { if (timer !== null) timers.clearInterval(timer); timer = null; },
  };
}
module.exports = { createReminderService, normalizeReminder, dueSlot, builtIns, STYLES, KINDS };
