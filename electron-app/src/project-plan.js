(() => {
  const PRIORITY = { Low: "低", Medium: "中", High: "高", Critical: "紧急" };
  const cleanError = (cause, fallback) => String(cause?.message || fallback).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");

  // AI plan breakdown: notes → generate → editable preview → create selected milestones and tasks.
  function create({ api, esc, attr, rerender, onResult, onCreated }) {
    const { value: field, list } = window.DMZenModel;
    let plan = null;
    let generation = 0;

    const available = () => Boolean(api.projectAi?.plan && api.projectAi?.applyPlan);
    const isOpen = () => Boolean(plan);

    function selection() {
      if (!plan?.groups) return { milestones: 0, tasks: 0 };
      let milestones = 0;
      let tasks = 0;
      for (const group of plan.groups) {
        if (!group.selected) continue;
        if (!group.existingId) milestones += 1;
        tasks += group.tasks.filter((task) => task.selected).length;
      }
      return { milestones, tasks };
    }
    const summaryText = () => { const count = selection(); return `将创建 ${count.milestones} 个里程碑、${count.tasks} 项任务`; };

    function open(project) {
      if (!project || !available()) return;
      plan = { projectId: field(project, "Id"), phase: "input", notes: "", groups: null, dropped: 0, error: "", requestId: "", cancelled: false, saving: false };
      rerender();
    }

    async function generate() {
      if (!plan || plan.phase === "generating") return;
      const current = plan;
      const startedIn = generation;
      Object.assign(current, { phase: "generating", error: "", cancelled: false, requestId: `pm-plan-${Date.now()}-${Math.random().toString(36).slice(2)}` });
      rerender();
      try {
        const result = await api.projectAi.plan({ requestId: current.requestId, projectId: current.projectId, notes: current.notes });
        if (plan !== current || startedIn !== generation) return;
        if (!result?.success) throw new Error(result?.error || "AI 拆解计划失败，请重试。");
        Object.assign(current, { phase: "preview", groups: result.plan.groups, dropped: result.plan.dropped || 0 });
      } catch (cause) {
        if (plan !== current || startedIn !== generation) return;
        current.phase = current.groups ? "preview" : "input";
        current.error = current.cancelled ? "" : cleanError(cause, "AI 拆解计划失败，请重试。");
      } finally {
        if (plan === current && startedIn === generation) { current.requestId = ""; rerender(); }
      }
    }

    function cancelGeneration() {
      if (plan?.phase !== "generating") return;
      plan.cancelled = true;
      if (plan.requestId) void api.ai?.cancel?.(plan.requestId);
    }

    async function createSelected() {
      if (!plan?.groups || plan.saving) return;
      const current = plan;
      const startedIn = generation;
      const payload = { groups: current.groups.filter((group) => group.selected).map((group) => ({
        existingId: group.existingId, name: group.name, dueDate: group.dueDate, acceptanceCriteria: group.acceptanceCriteria,
        tasks: group.tasks.filter((task) => task.selected).map(({ title, dueDate, priority }) => ({ title, dueDate, priority })),
      })).filter((group) => !group.existingId || group.tasks.length) };
      const count = selection();
      if (!count.milestones && !count.tasks) { current.error = "请至少选择一个里程碑或任务"; rerender(); return; }
      current.saving = true;
      current.error = "";
      rerender();
      try {
        const result = await api.projectAi.applyPlan(current.projectId, payload);
        if (plan !== current || startedIn !== generation) return;
        await onResult?.(result.state);
        plan = null;
        onCreated?.(result.created);
      } catch (cause) {
        if (plan === current && startedIn === generation) current.error = cleanError(cause, "创建失败，请重试。");
      } finally {
        if (plan === current) current.saving = false;
        if (startedIn === generation) rerender();
      }
    }

    function close() {
      if (!plan || plan.saving) return false;
      cancelGeneration();
      plan = null;
      rerender();
      return true;
    }

    function renderInput(project) {
      const goal = field(project, "Goal");
      const criteria = field(project, "AcceptanceCriteria");
      const stages = list(project, "Milestones").length;
      const generating = plan.phase === "generating";
      return `<p class="pm-muted">AI 会根据项目目标、完成标准、已有里程碑和任务，拆解出按时间排列的里程碑和任务。生成后可以逐项修改和取舍，确认后才会创建。</p>
        <div class="pm-plan-facts"><div><span>项目目标</span><p>${goal ? esc(goal) : '<em>未填写，建议先在「编辑项目」中补充，拆解会更准确。</em>'}</p></div>${criteria ? `<div><span>完成标准</span><p>${esc(criteria)}</p></div>` : ""}<div><span>现有内容</span><p>${stages} 个里程碑，新任务会避开已有任务</p></div></div>
        <label>补充说明（可选）<textarea data-plan-notes rows="3" maxlength="1500" placeholder="例如：两个人，每周约 10 小时；12 月中旬前要给客户演示" ${generating ? "disabled" : ""}>${esc(plan.notes)}</textarea></label>
        ${generating ? '<p class="pm-draft-notice" role="status">正在拆解计划，通常需要十几秒…</p>' : ""}`;
    }

    function renderPreview() {
      const groups = plan.groups.map((group, groupIndex) => {
        const off = !group.selected || plan.saving ? "disabled" : "";
        const head = group.existingId
          ? `<div class="pm-plan-group-head"><label class="pm-plan-check"><input type="checkbox" data-plan-group="${groupIndex}" data-plan-field="selected" ${group.selected ? "checked" : ""} ${plan.saving ? "disabled" : ""} /><span>补充到已有里程碑：<strong>${esc(group.name)}</strong></span></label></div>`
          : `<div class="pm-plan-group-head"><label class="pm-plan-check"><input type="checkbox" data-plan-group="${groupIndex}" data-plan-field="selected" ${group.selected ? "checked" : ""} ${plan.saving ? "disabled" : ""} aria-label="创建里程碑 ${attr(group.name)}" /><span class="pm-plan-tag">新里程碑</span></label>
              <input class="pm-plan-name" data-plan-group="${groupIndex}" data-plan-field="name" value="${attr(group.name)}" maxlength="160" aria-label="里程碑名称" ${off} />
              <input type="date" data-plan-group="${groupIndex}" data-plan-field="dueDate" value="${attr(group.dueDate)}" aria-label="里程碑目标日期" ${off} /></div>
            <input class="pm-plan-criteria" data-plan-group="${groupIndex}" data-plan-field="acceptanceCriteria" value="${attr(group.acceptanceCriteria)}" maxlength="500" placeholder="验收标准" aria-label="验收标准" ${off} />`;
        const tasks = group.tasks.map((task, taskIndex) => {
          const key = `${groupIndex}:${taskIndex}`;
          const taskOff = !group.selected || !task.selected || plan.saving ? "disabled" : "";
          return `<div class="pm-plan-task ${task.duplicate ? "is-duplicate" : ""}"><input type="checkbox" data-plan-task="${key}" data-plan-field="selected" ${task.selected ? "checked" : ""} ${off} aria-label="创建任务 ${attr(task.title)}" />
            <input class="pm-plan-title" data-plan-task="${key}" data-plan-field="title" value="${attr(task.title)}" maxlength="160" aria-label="任务标题" ${taskOff} />
            <input type="date" data-plan-task="${key}" data-plan-field="dueDate" value="${attr(task.dueDate)}" aria-label="任务截止日期" ${taskOff} />
            ${task.priority ? `<span class="pm-plan-priority">${PRIORITY[task.priority]}</span>` : ""}${task.duplicate ? '<span class="pm-plan-duplicate">已有同名任务</span>' : ""}</div>`;
        }).join("") || '<p class="pm-muted">没有任务</p>';
        return `<section class="pm-plan-group ${group.selected ? "" : "is-off"}">${head}<div class="pm-plan-tasks">${tasks}</div></section>`;
      }).join("");
      return `<p class="pm-muted">取消勾选可跳过某个里程碑或任务；标题、日期和验收标准都可以直接修改。${plan.dropped ? ` 另有 ${plan.dropped} 项因数量上限或内容不完整被略过。` : ""}</p><div class="pm-plan-groups">${groups}</div>`;
    }

    function renderModal(project) {
      if (!plan) return "";
      if (!project || field(project, "Id") !== plan.projectId) { plan = null; return ""; }
      const generating = plan.phase === "generating";
      const preview = plan.phase === "preview";
      const actions = generating
        ? '<button type="button" class="pm-button" data-module-action="pm-plan-stop">停止</button>'
        : preview
          ? `<span class="pm-muted" data-plan-summary>${summaryText()}</span><button type="button" class="pm-button" data-module-action="pm-plan-back" ${plan.saving ? "disabled" : ""}>修改说明</button><button type="button" class="pm-button" data-module-action="pm-plan-generate" ${plan.saving ? "disabled" : ""}>重新生成</button><button type="button" class="module-primary" data-module-action="pm-plan-create" ${plan.saving ? "disabled" : ""}>${plan.saving ? "正在创建…" : "创建选中项"}</button>`
          : `<button type="button" class="pm-button" data-module-action="pm-plan-close">取消</button><button type="button" class="module-primary" data-module-action="pm-plan-generate">✨ 生成计划</button>`;
      return `<div class="module-modal-backdrop"><div class="module-modal pm-dialog pm-plan-dialog" role="dialog" aria-modal="true" aria-label="AI 拆解计划">
        <h2>AI 拆解计划 · ${esc(field(project, "Name"))}</h2>
        ${preview ? renderPreview() : renderInput(project)}
        ${plan.error ? `<div class="module-error" role="alert">${esc(plan.error)}</div>` : ""}
        <div class="module-modal-actions">${preview && !plan.saving ? '<button type="button" class="pm-button pm-plan-cancel" data-module-action="pm-plan-close">取消</button>' : ""}${actions}</div>
      </div></div>`;
    }

    async function handleAction(action, _id, project) {
      if (action === "pm-plan-open") open(project);
      if (action === "pm-plan-generate") void generate();
      if (action === "pm-plan-stop") cancelGeneration();
      if (action === "pm-plan-back" && plan && !plan.saving) { plan.phase = "input"; plan.error = ""; rerender(); }
      if (action === "pm-plan-create") await createSelected();
      if (action === "pm-plan-close") close();
      return true;
    }

    function bind(scope) {
      if (!plan) return;
      const notes = scope.querySelector("[data-plan-notes]");
      if (notes) notes.oninput = () => { plan.notes = notes.value; };
      scope.querySelectorAll("[data-plan-field]").forEach((input) => {
        const update = () => {
          const fieldName = input.dataset.planField;
          const target = input.dataset.planTask
            ? plan.groups?.[Number(input.dataset.planTask.split(":")[0])]?.tasks[Number(input.dataset.planTask.split(":")[1])]
            : plan.groups?.[Number(input.dataset.planGroup)];
          if (!target) return;
          target[fieldName] = fieldName === "selected" ? input.checked : input.value;
          if (fieldName === "selected") rerender();
          else { const summary = scope.querySelector("[data-plan-summary]"); if (summary) summary.textContent = summaryText(); }
        };
        input.oninput = update;
        input.onchange = update;
      });
    }

    function reset() {
      cancelGeneration();
      generation += 1;
      plan = null;
    }

    return { available, isOpen, open, renderModal, handleAction, bind, close, reset, isBusy: () => Boolean(plan?.saving) };
  }

  window.DMProjectPlan = { create };
})();
