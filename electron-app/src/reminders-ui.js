(() => {
  const STYLES = [['GlassCard', '磨砂卡片'], ['Circular', '圆形'], ['DynamicIsland', '灵动岛'], ['Toast', '右下角 Toast'], ['Banner', '顶部横幅'], ['Compact', '紧凑胶囊']];
  const KINDS = [['IntervalMinutes', '每隔 N 分钟'], ['ActiveUseInterval', '连续使用 N 分钟'], ['Daily', '每天'], ['Weekly', '每周'], ['Monthly', '每月'], ['Once', '一次性']];
  function create(api, { esc, attr, rerender }) {
    let state = null, draft = null, error = '', notice = '', busy = false;
    const options = (values, selected) => values.map(([value, label]) => `<option value="${attr(value)}" ${value === selected ? 'selected' : ''}>${esc(label)}</option>`).join('');
    const button = (action, label, id = '', extra = '') => `<button type="button" data-reminder-action="${action}" data-id="${attr(id)}" ${extra} ${busy ? 'disabled' : ''}>${label}</button>`;
    async function load() {
      if (!api.reminders) return;
      try { state = await api.reminders.list(); }
      catch (cause) { error = cause.message; state = { reminders: [], settings: { defaultNotifyStyle:'PetBubble', defaultPopupStyle: 'GlassCard', acrylic: true } }; }
    }
    api.reminders?.onChanged?.(() => {
      void load().then(() => {
        // Preserve an open editor and any unsaved settings while background reminders change.
        const scope = document.querySelector('[data-reminders]');
        if (scope && !draft && !scope.contains(document.activeElement)) rerender();
      }).catch(cause => { error = cause.message; });
    });
    function describe(item) {
      const s = item.schedule;
      if (s.kind === 'IntervalMinutes') return `每 ${s.intervalMinutes} 分钟`;
      if (s.kind === 'ActiveUseInterval') return `连续使用 ${s.intervalMinutes} 分钟`;
      if (s.kind === 'Once') return `一次性 · ${new Date(s.onceAt).toLocaleString()}`;
      const days = ['一', '二', '三', '四', '五', '六', '日'].filter((_, i) => s.weekdays & (1 << i)).join('、');
      return `${s.kind === 'Daily' ? '每天' : s.kind === 'Weekly' ? `周${days}` : `每月 ${s.dayOfMonth} 日`} · ${s.times.join('、')}`;
    }
    function readDraft() {
      const form = document.querySelector('[data-reminder-form]');
      if (!form) return draft;
      const v = Object.fromEntries(new FormData(form));
      const weekdays = [...form.querySelectorAll('[name="weekday"]:checked')].reduce((mask, input) => mask | Number(input.value), 0);
      return { ...draft, title: v.title, message: v.message, icon: v.icon, enabled: form.enabled.checked,
        notifyStyle: v.notifyStyle, useDefaultDelivery: v.notifyStyle === 'Default', popupStyleOverride: v.popupStyleOverride || null,
        snoozeMinutes: Number(v.snoozeMinutes), doneLabel: v.doneLabel, laterLabel: v.laterLabel, trackDailyStats: form.trackDailyStats.checked,
        schedule: { kind: v.kind, intervalMinutes: Number(v.intervalMinutes), times: String(v.times).split(/[,，、]/).map(value => value.trim()), weekdays, dayOfMonth: Number(v.dayOfMonth), onceAt: v.onceAt || null },
        trigger: { skipWhenIdle: form.skipWhenIdle.checked, idleThresholdSeconds: Number(v.idleThresholdSeconds), resetOnAcknowledge: form.resetOnAcknowledge.checked },
      };
    }
    function editor() {
      if (!draft) return '';
      const d = draft, effective = d.useDefaultDelivery ? state.settings.defaultNotifyStyle : d.notifyStyle, s = d.schedule, interval = ['IntervalMinutes', 'ActiveUseInterval'].includes(s.kind), calendar = ['Daily', 'Weekly', 'Monthly'].includes(s.kind);
      return `<div class="module-modal-backdrop reminder-backdrop"><form class="module-modal reminder-editor" data-reminder-form role="dialog" aria-modal="true" aria-labelledby="reminder-edit-title">
        <h3 id="reminder-edit-title">${d.id ? '编辑提醒' : '新建提醒'}</h3>
        <div class="reminder-fields"><label>标题<input name="title" required maxlength="200" value="${attr(d.title)}"></label><label>图标<input name="icon" maxlength="32" value="${attr(d.icon)}"></label></div>
        <label>提醒内容<textarea name="message" rows="3" maxlength="4000">${esc(d.message)}</textarea></label>
        <div class="reminder-fields"><label>重复规则<select name="kind">${options(KINDS, s.kind)}</select></label><label ${interval ? '' : 'hidden'}>间隔（分钟）<input name="intervalMinutes" type="number" min="1" max="1440" value="${attr(s.intervalMinutes || 30)}"></label>
        <label ${calendar ? '' : 'hidden'}>提醒时刻（多个用逗号分隔）<input name="times" value="${attr((s.times || ['09:00']).join(', '))}" placeholder="09:00, 14:00"></label>
        <label ${s.kind === 'Monthly' ? '' : 'hidden'}>每月几号<input name="dayOfMonth" type="number" min="1" max="31" value="${attr(s.dayOfMonth || 1)}"><small>当月没有该日期时跳过</small></label>
        <label ${s.kind === 'Once' ? '' : 'hidden'}>日期和时间<input name="onceAt" type="datetime-local" value="${attr(localDateInput(s.onceAt))}"></label></div>
        <fieldset ${s.kind === 'Weekly' ? '' : 'hidden'}><legend>星期</legend><div class="reminder-weekdays">${['一', '二', '三', '四', '五', '六', '日'].map((name, i) => `<label><input type="checkbox" name="weekday" value="${1 << i}" ${s.weekdays & (1 << i) ? 'checked' : ''}>${name}</label>`).join('')}</div></fieldset>
        <div class="reminder-fields"><label>通知方式<select name="notifyStyle">${options([['Default', '跟随默认'], ['PetBubble', '宠物提醒'], ['DesktopPopup', '桌面弹窗']], d.useDefaultDelivery ? 'Default' : d.notifyStyle)}</select></label><label ${effective === 'PetBubble' ? 'hidden' : ''}>弹窗样式<select name="popupStyleOverride">${options([['', '跟随全局'], ...STYLES], d.popupStyleOverride || '')}</select></label><label>稍后提醒（分钟）<input name="snoozeMinutes" type="number" min="1" max="240" value="${attr(d.snoozeMinutes)}"></label>
        <label>空闲阈值（秒）<input name="idleThresholdSeconds" type="number" min="1" max="86400" value="${attr(d.trigger.idleThresholdSeconds)}"></label><label>完成按钮<input name="doneLabel" maxlength="40" value="${attr(d.doneLabel)}"></label><label>稍后按钮<input name="laterLabel" maxlength="40" value="${attr(d.laterLabel)}"></label></div>
        <div class="reminder-checks"><label><input type="checkbox" name="enabled" ${d.enabled ? 'checked' : ''}>启用提醒</label><label><input type="checkbox" name="skipWhenIdle" ${d.trigger.skipWhenIdle ? 'checked' : ''}>离开电脑时跳过</label><label><input type="checkbox" name="trackDailyStats" ${d.trackDailyStats ? 'checked' : ''}>记录今日完成次数</label><label><input type="checkbox" name="resetOnAcknowledge" ${d.trigger.resetOnAcknowledge ? 'checked' : ''}>完成后重新计算连续使用时间</label></div>
        <p class="reminder-hint">${effective === 'PetBubble' ? '宠物会缓步走向所在屏幕中央，途中逐渐放大并展示提醒牌；完成或稍后提醒后回到原位。请先开启桌面宠物，宠物关闭、隐藏或正在交互时使用桌面弹窗。' : '桌面弹窗支持六种样式，也可以切换为宠物提醒。'}</p>${error ? `<p class="reminder-error" role="alert">${esc(error)}</p>` : ''}
        <div class="module-modal-actions">${button('cancel', '取消')}${button('test-draft', '测试通知')}${button('save', '保存', '', 'class="module-primary"')}</div>
      </form></div>`;
    }
    function localDateInput(value) {
      if (!value) return '';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '';
      return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    }
    function render() {
      if (!api.reminders) return '<div class="module-empty">请在桌面版中使用定时提醒。</div>';
      if (!state) return '<div class="module-empty">正在加载提醒…</div>';
      return `<div class="reminders-page" data-reminders><div class="module-heading"><div><h2>定时提醒</h2><p>喝水、活动一下，或为重要的事留一个提醒。</p></div>${button('new', '＋ 新建提醒', '', 'class="module-primary"')}</div>
        <div class="reminder-toolbar"><label>默认提醒方式<select name="reminder-default-style">${options([['PetBubble','宠物提醒'], ...STYLES], state.settings.defaultNotifyStyle === 'PetBubble' ? 'PetBubble' : state.settings.defaultPopupStyle)}</select></label><label class="reminder-inline"><input name="reminder-acrylic" type="checkbox" ${state.settings.acrylic ? 'checked' : ''}>磨砂背景</label>${button('settings', '保存默认方式')}<span class="reminder-toolbar-spacer"></span>${button('import-merge', '合并导入')}${button('import-replace', '替换导入')}${button('export', '导出 JSON')}</div>
        <p class="reminder-hint">关闭工作区后仍会提醒，完全退出软件后停止。选择顶部默认提醒方式并保存，所有“跟随默认”的提醒会一起切换；也可编辑单条提醒单独指定。宠物提醒会行走、放大并举牌，需开启桌面宠物。测试通知不计入完成次数。</p>
        ${error && !draft ? `<p class="reminder-error" role="alert">${esc(error)}</p>` : ''}${notice ? `<p class="reminder-notice" role="status">${esc(notice)}</p>` : ''}
        <div class="reminder-grid">${state.reminders.map(item => `<article class="reminder-card ${item.enabled ? '' : 'is-disabled'}"><div class="reminder-card-head"><span class="reminder-icon">${esc(item.icon)}</span><div><h3>${esc(item.title)}</h3><span>${item.isBuiltIn ? '内置提醒' : '自定义提醒'} · ${item.enabled ? '已启用' : '已暂停'}${item.pending ? ' · 等待处理' : ''}</span></div>${button('toggle', item.enabled ? '暂停' : '启用', item.id)}</div><p class="reminder-message">${esc(item.message)}</p><p class="reminder-schedule">${esc(describe(item))}</p><div class="reminder-meta"><span>${(item.useDefaultDelivery ? state.settings.defaultNotifyStyle : item.notifyStyle) === 'PetBubble' ? '宠物提醒' : STYLES.find(([id]) => id === (item.popupStyleOverride || state.settings.defaultPopupStyle))?.[1]}${item.useDefaultDelivery ? ' · 跟随默认' : ''}</span><span>今日完成 <strong>${Number(item.runtime.todayAckCount) || 0}</strong> 次</span></div>${item.runtime.snoozeUntil ? `<p class="reminder-hint">稍后提醒：${esc(new Date(item.runtime.snoozeUntil).toLocaleString())}</p>` : ''}<div class="reminder-card-actions">${item.pending ? `${button('done', esc(item.doneLabel), item.id, 'class="module-primary"')}${button('snooze', `稍后 ${item.snoozeMinutes} 分钟`, item.id)}` : ''}${button('test', '测试', item.id)}${button('edit', '编辑', item.id)}${item.isBuiltIn ? button('reset', '重置', item.id) : button('delete', '删除', item.id)}</div></article>`).join('')}</div>${editor()}</div>`;
    }
    async function action(name, id) {
      if (busy) return;
      error = ''; notice = ''; busy = true;
      const item = state?.reminders.find(value => value.id === id);
      try {
        if (name === 'new') draft = { title: '', message: '', icon: '🔔', enabled: true, notifyStyle: state.settings.defaultNotifyStyle, useDefaultDelivery: true, snoozeMinutes: 10, doneLabel: '已完成', laterLabel: '稍后提醒', trackDailyStats: true, schedule: { kind: 'IntervalMinutes', intervalMinutes: 30, times: ['09:00'], weekdays: 31, dayOfMonth: 1 }, trigger: { skipWhenIdle: true, idleThresholdSeconds: 300, resetOnAcknowledge: true } };
        else if (name === 'edit') draft = structuredClone(item);
        else if (name === 'cancel') draft = null;
        else if (name === 'delete' && window.confirm(`删除提醒“${item.title}”？`)) state = await api.reminders.remove(id);
        else if (name === 'reset') state = await api.reminders.reset(id);
        else if (name === 'toggle') state = await api.reminders.save({ ...item, enabled: !item.enabled });
        else if (name === 'done' || name === 'snooze') state = await api.reminders.act(id, name);
        else if (name === 'test') { await api.reminders.test(id); notice = '已显示测试通知'; }
        else if (name === 'test-draft' || name === 'save') {
          draft = readDraft();
          const form = document.querySelector('[data-reminder-form]');
          if (!form.reportValidity()) return;
          if (draft.schedule.kind === 'Weekly' && !draft.schedule.weekdays) throw new Error('请至少选择一个星期。');
          if (name === 'test-draft') { await api.reminders.test(draft); notice = '已显示测试通知'; }
          else { state = await api.reminders.save(draft); draft = null; notice = '提醒已保存'; }
        } else if (name === 'settings') {
          const selected = document.querySelector('[name="reminder-default-style"]').value;
          state = await api.reminders.saveSettings({ defaultNotifyStyle: selected === 'PetBubble' ? 'PetBubble' : 'DesktopPopup', defaultPopupStyle: selected === 'PetBubble' ? state.settings.defaultPopupStyle : selected, acrylic: document.querySelector('[name="reminder-acrylic"]').checked }); notice = '默认提醒方式已保存';
        } else if (name === 'export') { if (await api.reminders.export()) notice = '提醒已导出'; }
        else if (name.startsWith('import-')) {
          if (name === 'import-replace' && !window.confirm('替换导入将移除现有自定义提醒，内置提醒会保留。继续？')) return;
          const result = await api.reminders.import(name === 'import-replace' ? 'replace' : 'merge');
          if (result) { state = result; notice = '提醒已导入'; }
        }
      } catch (cause) { error = cause.message || '操作失败'; }
      finally { busy = false; rerender(); }
    }
    function bind(scope) {
      scope.querySelectorAll('[data-reminder-action]').forEach(node => node.onclick = event => { event.preventDefault(); event.stopPropagation(); void action(node.dataset.reminderAction, node.dataset.id); });
      const form = scope.querySelector('[data-reminder-form]');
      if (form) {
        form.onsubmit = event => { event.preventDefault(); void action('save'); };
        for (const name of ['kind', 'notifyStyle']) form.querySelector(`[name="${name}"]`).onchange = () => { draft = readDraft(); rerender(); };
        const inputs = [...form.querySelectorAll('input, select, textarea, button')].filter(node => !node.closest('[hidden]'));
        form.onkeydown = event => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); draft = null; rerender(); }
          if (event.key === 'Tab') {
            const first = inputs[0], last = inputs[inputs.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
          }
        };
        if (!form.contains(document.activeElement)) form.querySelector('[name="title"]').focus();
      }
    }
    return { load, render, bind, closeModal: () => { if (!draft) return false; draft = null; rerender(); return true; } };
  }
  window.DMRemindersUI = { create };
})();
