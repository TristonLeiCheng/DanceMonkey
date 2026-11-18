(() => {
  const { value: field, done, archived, lifecycle, health, milestoneProgress, list, calendarDate: date, localDate, taskStatus: status, statusLabels: STATUS, taskSummary, isOverdue: overdue, matchesTaskFilter, projectActivity } = window.DMZenModel;
  const HEALTH = { "On Track": "正常", "At Risk": "有风险", Blocked: "受阻" };
  const LIFECYCLE = { Planned: "计划中", "In Progress": "进行中", Paused: "已暂停", Completed: "已完成" };
  const PRIORITY = { Low: "低", Medium: "中", High: "高", Critical: "紧急" };
  const TABS = [["overview", "概览"], ["tasks", "任务"], ["milestones", "里程碑"], ["notes", "资料"], ["updates", "动态"], ["ai", "AI 助手"]];
  const flatten = (tree) => tree.flatMap((node) => node.type === "file" ? [node] : flatten(node.children || []));

  function create({ api, esc, attr, rerender, getState, onResult, editTask, editProject, openNote, renderMarkdown }) {
    let selectedId = "";
    let detailTab = "overview";
    const projectTabs = new Map();
    let filter = "active";
    let query = "";
    let taskQuery = "";
    let taskFilter = "all";
    let milestoneFilter = "all";
    let focusedTaskId = "";
    let view = "list";
    let sort = "updated";
    let pageError = "";
    let busy = false;
    let files = [];
    let filesLoaded = false;
    let picker = null;
    let dialog = null;
    let renderedAttention = [];

    const project = () => getState().projects.find((p) => field(p, "Id") === selectedId);
    const associated = (id) => getState().tasks.filter((task) => field(task, "ProjectId") === id);
    const button = (action, label, id = "", className = "pm-button") => `<button type="button" class="${className}" data-module-action="pm-${action}" data-id="${attr(id)}" ${busy ? "disabled" : ""}>${label}</button>`;
    const errorHtml = () => pageError ? `<div class="module-error" role="alert">${esc(pageError)}</div>` : "";
    const metrics = (id) => taskSummary(associated(id));
    const aiPanel = window.DMProjectAIPanel?.create({ api, esc, attr, rerender, renderMarkdown, getState, onResult,
      openNote, onNoteSaved: async () => { if (selectedId) { try { await loadFiles(); } catch { filesLoaded = false; } } },
      onWeeklyDraft: () => { const p = project(); if (!p || archived(p)) return; selectTab("updates"); dialog = updateDialog(); void draftUpdate(); } });
    const planUI = window.DMProjectPlan?.create({ api, esc, attr, rerender, onResult, onCreated: () => { selectTab("milestones"); milestoneFilter = "all"; pageError = ""; } });
    const updateDialog = () => ({ type: "update", values: { health: health(project()), summary: "", risks: "", nextAction: "" }, drafting: false, notice: "", requestId: "" });
    const canDraft = () => Boolean(api.projectAi?.draftUpdate);
    async function draftUpdate() {
      const current = dialog;
      if (current?.type !== "update" || current.drafting || !canDraft()) return;
      current.drafting = true;
      current.cancelled = false;
      current.notice = "";
      current.requestId = `pm-draft-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      pageError = "";
      rerender();
      try {
        const result = await api.projectAi.draftUpdate({ requestId: current.requestId, projectId: selectedId, notes: { ...current.values } });
        if (dialog !== current) return;
        if (!result?.success) throw new Error(result?.error || "AI 起草失败，请重试。");
        const draft = result.draft || {};
        current.values = { health: draft.health || current.values.health, summary: draft.summary || "", risks: draft.risks || "", nextAction: draft.nextAction || "" };
        const counts = result.counts || {};
        current.notice = draft.parsed
          ? `已根据本周完成 ${counts.completed || 0} 项、新增 ${counts.created || 0} 项、受阻 ${counts.blocked || 0} 项、逾期 ${counts.overdue || 0} 项起草，请检查后保存。`
          : "AI 未按约定格式返回，已将全文放入「本周进展」，请整理后保存。";
      } catch (error) {
        if (dialog !== current) return;
        if (current.cancelled) current.notice = "已停止起草，表单内容未改变。";
        else pageError = error?.message || "AI 起草失败，请重试。";
      } finally {
        if (dialog === current) { current.drafting = false; current.requestId = ""; rerender(); }
      }
    }
    function cancelDraft() {
      if (!dialog?.drafting) return;
      dialog.cancelled = true;
      if (dialog.requestId) void api.ai?.cancel?.(dialog.requestId);
    }
    function selectTab(tab) {
      if (!TABS.some(([key]) => key === tab)) return;
      detailTab = tab;
      projectTabs.set(selectedId, tab);
    }
    async function loadFiles() {
      filesLoaded = false;
      files = flatten((await api.workspace.list()).tree || []);
      filesLoaded = true;
    }
    async function open(id, tab) {
      selectedId = id;
      selectTab(tab || projectTabs.get(id) || "overview");
      taskQuery = "";
      taskFilter = "all";
      milestoneFilter = "all";
      focusedTaskId = "";
      pageError = "";
      rerender();
      try { await loadFiles(); } catch { pageError = "暂时无法读取笔记列表，可稍后重新关联。"; }
      rerender();
    }
    function renderOverview() {
      const all = getState().projects;
      renderedAttention = window.DMZenModel.attentionItems(getState());
      const visible = all.filter((p) => (filter === "archived" ? archived(p) : !archived(p)) && ["Name", "Description", "Owner", "Category"].some((key) => String(field(p, key)).toLowerCase().includes(query.trim().toLowerCase())));
      visible.sort((a, b) => sort === "due"
        ? (date(field(a, "DueDate")) || "9999").localeCompare(date(field(b, "DueDate")) || "9999")
        : sort === "name" ? field(a, "Name").localeCompare(field(b, "Name"), "zh-CN")
        : (Date.parse(projectActivity(b, getState().tasks)) || 0) - (Date.parse(projectActivity(a, getState().tasks)) || 0));
      return `<section class="module-page pm-page">
        <div class="module-heading"><div><div class="pm-eyebrow">PROJECTS / 项目工作台</div><h1>把目标推进到完成</h1><p>任务、行动与笔记，都留在项目里。</p></div>${button("new", "＋ 新建项目", "", "module-primary")}</div>
        ${errorHtml()}
        ${filter === "active" && aiPanel && all.some((p) => !archived(p)) ? aiPanel.renderBrief() : ""}
        ${filter === "active" ? `<section class="pm-panel pm-attention"><div class="pm-panel-heading"><h2>Needs attention / 需要关注 <span>${renderedAttention.length}</span></h2><small>未来 7 天里程碑 · 逾期/受阻任务 · 风险健康度 · 14 天未汇报进展</small></div>${renderedAttention.length ? `<div class="pm-attention-list">${renderedAttention.map((item, index) => `<button type="button" data-module-action="pm-attention" data-id="${index}"><strong>${esc(item.projectName)} · ${esc(item.label)}</strong><span>${esc(item.detail)}</span></button>`).join("")}</div>` : '<div class="pm-empty compact">当前没有需要关注的活跃项目。</div>'}</section>` : ""}
        <div class="module-toolbar pm-toolbar"><div class="module-segments">${button("filter", `活跃项目 · ${all.filter((p) => !archived(p)).length}`, "active", filter === "active" ? "active" : "")}${button("filter", `已归档 · ${all.filter(archived).length}`, "archived", filter === "archived" ? "active" : "")}</div>
          <input class="pm-search module-search" data-pm-search="projects" value="${attr(query)}" aria-label="搜索项目" placeholder="搜索项目、负责人或分类" />
          <select data-pm-sort aria-label="项目排序"><option value="updated" ${sort === "updated" ? "selected" : ""}>最近活动</option><option value="due" ${sort === "due" ? "selected" : ""}>截止日期</option><option value="name" ${sort === "name" ? "selected" : ""}>项目名称</option></select>
        </div>
        <div class="projects-grid pm-projects">${visible.map((p) => {
          const id = field(p, "Id");
          const m = metrics(id);
          const due = date(field(p, "DueDate"));
          return `<article class="project-card pm-project-card"><div class="project-card-head"><span class="project-icon">◎</span><span class="pm-category">${esc(field(p, "Category") || "未分类")}</span><span class="priority ${attr(String(field(p, "Priority", "Medium")).toLowerCase())}">${esc(PRIORITY[field(p, "Priority")] || "中")}</span></div>
            <h2>${button("open", esc(field(p, "Name")), id, "pm-project-title")}</h2><p>${esc(field(p, "Goal") || field(p, "Description") || "添加项目目标，让下一步更清晰。")}</p>
            <div class="project-progress"><span style="width:${m.progress}%"></span></div><div class="project-footer"><span>任务完成率 ${m.progress}% · ${m.completed}/${m.tasks.length}</span><span>${esc(LIFECYCLE[lifecycle(p)] || lifecycle(p))} · ${esc(HEALTH[health(p)] || health(p))}</span></div>
            <div class="pm-card-meta"><span>${esc(field(p, "Owner") || "未指定负责人")}</span><span>${due ? `截止 ${esc(due)}` : "未设截止日期"}</span></div>
            ${m.blocked || m.overdue ? `<div class="pm-alert">${m.blocked ? `${m.blocked} 项受阻` : ""}${m.blocked && m.overdue ? " · " : ""}${m.overdue ? `${m.overdue} 项逾期` : ""}</div>` : ""}
            <div class="module-row-actions visible">${button("open", "打开项目 →", id)}${button(archived(p) ? "restore" : "archive", archived(p) ? "恢复" : "归档", id)}</div></article>`;
        }).join("") || `<div class="pm-empty"><strong>${query ? "没有匹配的项目" : filter === "archived" ? "还没有归档项目" : "从一个明确的目标开始"}</strong><p>${query ? "试试项目名称、负责人或分类。" : filter === "archived" ? "归档保留全部任务与笔记关联，随时可以恢复。" : "创建项目，再把目标拆成可执行的任务。"}</p>${!query && filter === "active" ? button("new", "创建第一个项目", "", "module-primary") : ""}</div>`}</div>
        ${filter === "active" && aiPanel && all.some((p) => !archived(p)) ? aiPanel.renderPortfolio() : ""}
      </section>`;
    }
    function taskCard(task, readOnly) {
      const id = field(task, "Id");
      const due = date(field(task, "DueDate"));
      const state = status(task);
      return `<article class="pm-task ${done(task) ? "done" : ""} ${focusedTaskId === id ? "pm-task-focused" : ""}"><div class="pm-task-top"><span class="pm-dot state-${attr(state.replaceAll(" ", "-"))}"></span>${readOnly ? `<strong>${esc(field(task, "Title"))}</strong>` : button("edit-task", esc(field(task, "Title")), id, "pm-task-title")}</div>
        ${field(task, "Notes") ? `<p>${esc(field(task, "Notes"))}</p>` : ""}
        <div class="pm-task-bottom"><span class="${overdue(task) ? "pm-overdue" : ""}">${due ? `${overdue(task) ? "逾期 · " : "截止 "}${esc(due)}` : "无截止日期"}</span>${field(task, "MilestoneId") ? `<span>里程碑 · ${esc(field(list(project(), "Milestones").find((stage) => field(stage, "Id") === field(task, "MilestoneId")), "Name") || "已移除")}</span>` : ""}${field(task, "SourceNotePath") ? button("open-task-source", "↗ 来源笔记", field(task, "SourceNotePath")) : ""}<select data-pm-task-status="${attr(id)}" aria-label="${attr(field(task, "Title"))}的状态" ${readOnly || busy ? "disabled" : ""}>${Object.entries(STATUS).map(([key, text]) => `<option value="${key}" ${state === key ? "selected" : ""}>${text}</option>`).join("")}</select></div>${field(task, "SourceExcerpt") ? `<small class="pm-source-excerpt">摘录：${esc(field(task, "SourceExcerpt"))}</small>` : ""}</article>`;
    }
    function renderStats(m) {
      return `<div class="module-stats pm-stats"><div><strong>${m.progress}<small>%</small></strong><span>任务完成率 · ${m.completed}/${m.tasks.length}</span></div><div><strong>${m.inProgress}</strong><span>进行中</span></div><div><strong>${m.blocked}</strong><span>受阻任务</span></div><div><strong>${m.overdue}</strong><span>逾期任务</span></div></div>`;
    }
    function renderProjectOverview(p, m, readOnly) {
      const stages = list(p, "Milestones");
      const upcoming = stages.filter((stage) => !field(stage, "CompletedAt")).sort((a, b) => (date(field(a, "DueDate")) || "9999").localeCompare(date(field(b, "DueDate")) || "9999"))[0];
      const latest = list(p, "Updates")[0];
      return `${renderStats(m)}<div class="pm-overview-grid">
        <section class="pm-panel pm-context"><div class="pm-panel-heading"><h2>目标与行动</h2>${!readOnly ? button("edit", "编辑说明", field(p, "Id")) : ""}</div>
          ${[["Goal", "项目目标", "明确这个项目要解决的问题。"], ["AcceptanceCriteria", "完成标准", "写下可检查的交付成果。"], ["NextAction", "下一步行动", "从任务中选择下一件要推进的事。"], ["Blockers", "阻塞与风险", "暂无记录"]].map(([key, label, fallback]) => `<div class="pm-context-item"><h3>${label}</h3><p class="${field(p, key) ? "" : "pm-muted"}">${esc(field(p, key) || fallback)}</p></div>`).join("")}
          ${button("tab", `查看任务 · ${m.open} 项未完成`, "tasks")}
          ${!readOnly && planUI?.available() && !stages.length && !m.tasks.length ? `<div class="pm-plan-hint"><span>还没有里程碑和任务？</span>${button("plan-open", "✨ 用 AI 拆解目标")}</div>` : ""}
        </section>
        <div class="pm-overview-side"><section class="pm-panel"><div class="pm-panel-heading"><h2>下一里程碑</h2>${button("tab", "全部里程碑", "milestones")}</div>
          ${upcoming ? `<h3>${esc(field(upcoming, "Name"))}</h3><p class="pm-muted">${date(field(upcoming, "DueDate")) ? `目标 ${esc(date(field(upcoming, "DueDate")))}` : "未设置目标日期"}</p><p>${esc(field(upcoming, "AcceptanceCriteria") || "尚未填写验收标准")}</p>` : `<p class="pm-muted">${stages.length ? "全部里程碑已验收。" : "添加一个阶段交付成果，让目标更清晰。"}</p>${!readOnly && !stages.length ? button("new-milestone", "＋ 添加里程碑") : ""}`}
        </section><section class="pm-panel"><div class="pm-panel-heading"><h2>最新进展</h2>${button("tab", "查看动态", "updates")}</div>
          ${latest ? `<p class="pm-muted">${esc(localDate(field(latest, "CreatedAt")))} · ${esc(HEALTH[field(latest, "Health")] || field(latest, "Health"))}</p><p class="pm-summary-text">${esc(field(latest, "Summary"))}</p>` : '<p class="pm-muted">尚无进展记录。</p>'}
          ${!readOnly ? button("new-update", "＋ 记录本周进展") : ""}
        </section></div></div>`;
    }
    function renderMilestones(p, m, readOnly) {
      const stages = list(p, "Milestones");
      return `<section class="pm-panel pm-milestones"><div class="pm-panel-heading"><div><h2>里程碑 <span>${stages.length}</span></h2><p class="pm-muted">任务完成率与成果验收分别记录。</p></div>${!readOnly ? `<div class="pm-actions">${planUI?.available() ? button("plan-open", "✨ AI 拆解计划") : ""}${button("new-milestone", "＋ 添加里程碑")}</div>` : ""}</div><div class="pm-milestone-grid">${stages.map((stage) => {
        const progress = milestoneProgress(stage, m.tasks); const stageId = field(stage, "Id");
        return `<article class="pm-milestone"><div class="pm-milestone-head"><strong>${esc(field(stage, "Name"))}</strong><span>${field(stage, "CompletedAt") ? "已验收" : "待验收"}</span></div>
          <div class="project-progress"><span style="width:${progress.percent}%"></span></div><small>任务完成率 ${progress.percent}% · ${progress.completed}/${progress.total}</small>
          <p>${esc(field(stage, "AcceptanceCriteria") || "未设置验收标准")}</p><small>${field(stage, "DueDate") ? `目标 ${esc(date(field(stage, "DueDate")))}` : "未设置目标日期"}</small>
          ${field(stage, "CompletedAt") && progress.completed < progress.total ? `<p class="pm-alert">已验收，仍有 ${progress.total - progress.completed} 项任务未完成。</p>` : ""}
          <div class="module-row-actions visible">${button("filter-stage", "查看任务", stageId)}${!readOnly ? `${button("move-milestone-up", "上移", stageId)}${button("move-milestone-down", "下移", stageId)}${button("edit-milestone", "编辑", stageId)}${button("toggle-milestone", field(stage, "CompletedAt") ? "重新打开" : "标记已验收", stageId)}${button("delete-milestone", "删除", stageId)}` : ""}</div></article>`;
      }).join("") || '<div class="pm-empty compact">设定阶段交付成果，再把任务分配给里程碑。</div>'}</div></section>`;
    }
    function renderTasks(p, m, readOnly) {
      const visible = m.tasks.filter((task) => (!focusedTaskId || field(task, "Id") === focusedTaskId) && matchesTaskFilter(task, taskFilter) && (milestoneFilter === "all" || field(task, "MilestoneId") === milestoneFilter || (milestoneFilter === "none" && !field(task, "MilestoneId"))) && `${field(task, "Title")} ${field(task, "Notes")} ${field(task, "Tags")}`.toLowerCase().includes(taskQuery.trim().toLowerCase()));
      visible.sort((a, b) => Number(done(a)) - Number(done(b)) || (date(field(a, "DueDate")) || "9999").localeCompare(date(field(b, "DueDate")) || "9999"));
      return `<section class="pm-panel"><div class="pm-panel-heading"><h2>项目任务 <span>${visible.length}/${m.tasks.length}</span></h2>${!readOnly ? button("add-task", "＋ 添加任务", field(p, "Id"), "module-primary") : ""}</div>
        <div class="pm-task-toolbar"><div class="module-segments">${button("view", "列表", "list", view === "list" ? "active" : "")}${button("view", "看板", "board", view === "board" ? "active" : "")}</div><input class="pm-search" data-pm-search="tasks" value="${attr(taskQuery)}" placeholder="搜索项目内任务" aria-label="搜索项目内任务" /><select data-pm-task-filter aria-label="任务筛选">${[["all", "全部任务"], ["open", "未完成"], ...Object.entries(STATUS)].map(([key, label]) => `<option value="${key}" ${taskFilter === key ? "selected" : ""}>${label}</option>`).join("")}</select><select data-pm-milestone-filter aria-label="里程碑筛选"><option value="all" ${milestoneFilter === "all" ? "selected" : ""}>所有里程碑</option><option value="none" ${milestoneFilter === "none" ? "selected" : ""}>未分配</option>${list(p, "Milestones").map((stage) => `<option value="${attr(field(stage, "Id"))}" ${milestoneFilter === field(stage, "Id") ? "selected" : ""}>${esc(field(stage, "Name"))}</option>`).join("")}</select>${focusedTaskId ? button("clear-task-focus", "显示全部任务") : ""}</div>
        ${view === "board" ? `<div class="pm-board">${Object.entries(STATUS).map(([key, label]) => {
          const tasks = visible.filter((task) => status(task) === key);
          return `<section class="pm-lane"><h3><span class="pm-dot state-${key.replaceAll(" ", "-")}"></span>${label}<span>${tasks.length}</span></h3>${tasks.map((task) => taskCard(task, readOnly)).join("") || '<div class="pm-lane-empty">暂无任务</div>'}</section>`;
        }).join("")}</div>` : `<div class="pm-task-list">${visible.map((task) => taskCard(task, readOnly)).join("") || `<div class="pm-empty"><strong>${m.tasks.length ? "没有匹配的任务" : "把目标拆成第一个行动"}</strong><p>${m.tasks.length ? "调整搜索、状态或里程碑筛选。" : "任务会自动归属当前项目。"}</p></div>`}</div>`}
      </section>`;
    }
    function renderNotes(p, readOnly) {
      const linked = list(p, "LinkedNotes");
      return `<section class="pm-panel"><div class="pm-panel-heading"><h2>关联笔记 <span>${linked.length}</span></h2>${!readOnly ? button("link-notes", "＋ 关联笔记") : ""}</div><div class="pm-notes">${linked.map((note) => {
        const missing = filesLoaded && !files.some((file) => file.path === note);
        return `<div class="pm-note"><div><span class="pm-note-icon">▤</span>${button("open-note", esc(note.split("/").pop().replace(/\.md$/i, "")), note)}<small>${esc(note)}${missing ? " · 文件不存在，请重新关联" : ""}</small></div>${!readOnly ? button("unlink-note", "解除关联", note) : ""}</div>`;
      }).join("") || '<div class="pm-empty compact">把方案、会议记录或复盘关联到这里，随时返回原文。</div>'}</div></section>`;
    }
    function renderUpdates(p, readOnly) {
      const updates = list(p, "Updates");
      const activity = localDate(projectActivity(p, getState().tasks));
      return `<section class="pm-panel pm-updates"><div class="pm-panel-heading"><div><h2>进展记录 <span>${updates.length}</span></h2><p class="pm-muted">最近活动：${esc(activity || "暂无记录")} · 汇报单独记录</p></div>${!readOnly ? button("new-update", "＋ 记录本周进展") : ""}</div>${updates.length ? updates.map((entry) => `<article class="pm-update"><div><strong>${esc(localDate(field(entry, "CreatedAt")))}</strong><span>${esc(HEALTH[field(entry, "Health")] || field(entry, "Health"))}</span></div><p>${esc(field(entry, "Summary"))}</p>${field(entry, "Risks") ? `<small>风险：${esc(field(entry, "Risks"))}</small>` : ""}${field(entry, "NextAction") ? `<small>下一步：${esc(field(entry, "NextAction"))}</small>` : ""}</article>`).join("") : '<div class="pm-empty compact">每周留下进展、风险和下一步，回看时不丢上下文。</div>'}</section>`;
    }
    function renderDetail(p) {
      const id = field(p, "Id"), m = metrics(id), readOnly = archived(p);
      const panels = { overview: () => renderProjectOverview(p, m, readOnly), tasks: () => renderTasks(p, m, readOnly), milestones: () => renderMilestones(p, m, readOnly), notes: () => renderNotes(p, readOnly), updates: () => renderUpdates(p, readOnly), ai: () => aiPanel ? aiPanel.render(p, { readOnly }) : '<div class="pm-empty compact">AI 助手暂不可用。</div>' };
      return `<section class="module-page pm-page pm-detail">
        <div class="pm-breadcrumb">${button("back", "← 所有项目")}<span>/</span><span>${esc(field(p, "Name"))}</span></div>
        <div class="module-heading"><div><div class="pm-eyebrow">${esc(field(p, "Category") || "项目详情")}${readOnly ? " / 已归档" : ""}</div><h1>${esc(field(p, "Name"))}</h1>${field(p, "Description") ? `<p>${esc(field(p, "Description"))}</p>` : ""}</div><div class="pm-actions">${!readOnly ? button("edit", "编辑项目", id) : ""}${button(readOnly ? "restore" : "archive", readOnly ? "恢复项目" : "归档项目", id)}</div></div>
        ${errorHtml()}${readOnly ? '<div class="pm-notice">项目已归档，任务与笔记关联均已保留。恢复后可继续编辑。</div>' : ""}
        <div class="pm-facts"><span>负责人 · ${esc(field(p, "Owner") || "未指定")}</span><span>截止 · ${esc(date(field(p, "DueDate")) || "未设置")}</span><span>阶段 · ${esc(LIFECYCLE[lifecycle(p)] || lifecycle(p))}</span><span>健康度 · ${esc(HEALTH[health(p)] || health(p))}</span><span>优先级 · ${esc(PRIORITY[field(p, "Priority")] || "中")}</span></div>
        <div class="pm-tabs" role="tablist" aria-label="项目详情">${TABS.map(([key, label]) => `<button type="button" role="tab" id="pm-tab-${key}" aria-controls="pm-panel-${key}" aria-selected="${detailTab === key}" tabindex="${detailTab === key ? 0 : -1}" data-module-action="pm-tab" data-id="${key}">${label}</button>`).join("")}</div>
        ${TABS.map(([key]) => `<div role="tabpanel" id="pm-panel-${key}" aria-labelledby="pm-tab-${key}" tabindex="0" ${detailTab !== key ? "hidden" : ""}>${detailTab === key ? panels[key]() : ""}</div>`).join("")}
      </section>`;
    }
    function render() { const p = project(); return p ? renderDetail(p) : renderOverview(); }
    function renderUpdateFields() {
      const values = dialog.values || updateDialog().values;
      const off = dialog.drafting ? "disabled" : "";
      const option = (key, label) => `<option value="${key}" ${values.health === key ? "selected" : ""}>${label}</option>`;
      const bar = canDraft() ? `<div class="pm-draft-bar"><span>${dialog.drafting ? "正在根据本周任务变化起草…" : "根据本周任务变化和你已写的要点起草，保存前可修改。"}</span>${dialog.drafting
        ? '<button type="button" class="pm-button" data-module-action="pm-cancel-draft">停止起草</button>'
        : `<button type="button" class="pm-button pm-draft-button" data-module-action="pm-draft-update" ${busy ? "disabled" : ""}>✨ AI 起草</button>`}</div>${dialog.notice ? `<p class="pm-draft-notice" role="status">${esc(dialog.notice)}</p>` : ""}` : "";
      return `${bar}<label>当前健康度<select name="health" ${off}>${option("On Track", "正常")}${option("At Risk", "有风险")}${option("Blocked", "受阻")}</select></label><label>本周进展<textarea name="summary" required rows="4" placeholder="本周完成了什么？" ${off}>${esc(values.summary)}</textarea></label><label>风险或阻塞<textarea name="risks" rows="2" placeholder="当前风险（可选）" ${off}>${esc(values.risks)}</textarea></label><label>下一步行动<textarea name="nextAction" rows="2" placeholder="下周最重要的行动（可选）" ${off}>${esc(values.nextAction)}</textarea></label>`;
    }
    function renderModal() {
      if (planUI?.isOpen()) return planUI.renderModal(project());
      if (dialog) {
        const editing = dialog.type === "milestone" ? list(project(), "Milestones").find((stage) => field(stage, "Id") === dialog.id) : null;
        if (dialog.type === "delete-milestone") {
          const linked = associated(selectedId).filter((task) => field(task, "MilestoneId") === dialog.id).length;
          const others = list(project(), "Milestones").filter((stage) => field(stage, "Id") !== dialog.id);
          return `<div class="module-modal-backdrop"><div class="module-modal pm-dialog" role="dialog" aria-modal="true"><h2>确认删除里程碑</h2><p>${linked ? `仍有 ${linked} 项关联任务。必须转移到其他里程碑或设为未分配后才能删除。` : "此操作不会删除任务，且无法撤销。"}</p><form data-pm-delete-milestone>${linked ? `<label>关联任务处理<select name="reassign" required><option value="">设为未分配</option>${others.map((stage) => `<option value="${attr(field(stage, "Id"))}">转移到 ${esc(field(stage, "Name"))}</option>`).join("")}</select></label>` : ""}<label class="pm-confirm"><input type="checkbox" name="confirmed" required /> 我确认删除此里程碑</label><div class="module-modal-actions">${button("close-dialog", "取消")}<button class="module-primary" type="submit">确认删除</button></div></form>${errorHtml()}</div></div>`;
        }
        return `<div class="module-modal-backdrop"><div class="module-modal pm-dialog" role="dialog" aria-modal="true" aria-label="${dialog.type === "milestone" ? "编辑里程碑" : "记录项目进展"}"><h2>${dialog.type === "milestone" ? editing ? "编辑里程碑" : "新建里程碑" : "记录本周进展"}</h2><form data-pm-dialog-form>${dialog.type === "milestone" ? `<label>里程碑名称<input name="name" required maxlength="160" value="${attr(field(editing, "Name"))}" placeholder="例如：首版方案通过" /></label><label>目标日期<input name="dueDate" type="date" value="${attr(date(field(editing, "DueDate")))}" /></label><label>验收标准<textarea name="acceptanceCriteria" rows="3" placeholder="交付什么成果算完成？">${esc(field(editing, "AcceptanceCriteria"))}</textarea></label>` : renderUpdateFields()}<div class="module-modal-actions">${button("close-dialog", "取消")}<button class="module-primary" type="submit" ${busy || dialog.drafting ? "disabled" : ""}>保存</button></div></form>${errorHtml()}</div></div>`;
      }
      if (!picker) return "";
      const matches = files.filter((file) => file.path.toLowerCase().includes(picker.query.toLowerCase()));
      return `<div class="module-modal-backdrop"><div class="module-modal pm-note-picker" role="dialog" aria-modal="true" aria-label="关联项目笔记"><h2>关联项目笔记</h2><p class="pm-muted">选择知识库中的 Markdown 笔记，保留原文件位置。</p><input data-pm-search="notes" value="${attr(picker.query)}" placeholder="搜索文件名或路径" aria-label="搜索可关联笔记" /><div class="pm-picker-list">${matches.slice(0, 150).map((file) => `<label class="pm-picker-row"><input type="checkbox" data-pm-note="${attr(file.path)}" ${picker.selected.has(file.path) ? "checked" : ""} /><span>${esc(file.name)}<small>${esc(file.path)}</small></span></label>`).join("") || '<div class="pm-empty compact">没有匹配的笔记，请先在「笔记」中新建。</div>'}${matches.length > 150 ? '<p class="pm-muted">仅显示前 150 篇，请搜索缩小范围。</p>' : ""}</div>${errorHtml()}<div class="module-modal-actions"><span class="pm-muted" data-pm-selected>已选 ${picker.selected.size} 篇</span>${button("close-picker", "取消")}${button("save-notes", "保存关联", "", "module-primary")}</div></div></div>`;
    }
    async function run(action) {
      if (busy) return;
      busy = true;
      pageError = "";
      try { await action(); } catch (error) { pageError = error?.message || "操作失败，请重试"; }
      finally { busy = false; rerender(); }
    }
    async function handleAction(action, id) {
      if (!action.startsWith("pm-")) return false;
      // AI requests run for a long time and must not hold the page-wide busy lock.
      if (action.startsWith("pm-ai-") || action === "pm-weekly-draft") {
        if (aiPanel) await aiPanel.handleAction(action, id, project());
        return true;
      }
      if (action.startsWith("pm-plan-")) { if (planUI) await planUI.handleAction(action, id, project()); return true; }
      if (action === "pm-draft-update") { void draftUpdate(); return true; }
      if (action === "pm-cancel-draft") { cancelDraft(); return true; }
      await run(async () => {
        const p = project();
        if (action === "pm-open") await open(id);
        if (action === "pm-tab") selectTab(id);
        if (action === "pm-back") { selectedId = ""; picker = null; }
        if (action === "pm-attention") { const item = renderedAttention[Number(id)]; if (item) { await open(item.projectId, item.taskId ? "tasks" : item.milestoneId ? "milestones" : item.kind === "stale-update" ? "updates" : "overview"); if (item.milestoneId) milestoneFilter = item.milestoneId; if (item.taskFilter) taskFilter = item.taskFilter; if (item.taskId) { focusedTaskId = item.taskId; taskQuery = ""; view = "list"; } } }
        if (action === "pm-clear-task-focus") { focusedTaskId = ""; taskFilter = "all"; }
        if (action === "pm-new-milestone") { selectTab("milestones"); dialog = { type: "milestone", id: "" }; }
        if (action === "pm-edit-milestone") dialog = { type: "milestone", id };
        if (action === "pm-delete-milestone") dialog = { type: "delete-milestone", id };
        if (action === "pm-move-milestone-up" || action === "pm-move-milestone-down") {
          const stages = list(p, "Milestones").map((stage) => ({ id: field(stage, "Id"), name: field(stage, "Name"), dueDate: field(stage, "DueDate"), acceptanceCriteria: field(stage, "AcceptanceCriteria"), completed: !!field(stage, "CompletedAt") }));
          const from = stages.findIndex((stage) => stage.id === id); const to = from + (action.endsWith("up") ? -1 : 1);
          if (from >= 0 && to >= 0 && to < stages.length) { [stages[from], stages[to]] = [stages[to], stages[from]]; await onResult(await api.zenTask.updateProject(selectedId, { milestones: stages })); }
        }
        if (action === "pm-new-update") { selectTab("updates"); dialog = updateDialog(); }
        if (action === "pm-close-dialog") { cancelDraft(); dialog = null; }
        if (action === "pm-filter-stage") { milestoneFilter = id; focusedTaskId = ""; taskFilter = "all"; taskQuery = ""; view = "list"; selectTab("tasks"); }
        if (action === "pm-toggle-milestone") {
          const stages = list(p, "Milestones");
          await onResult(await api.zenTask.updateProject(selectedId, { milestones: stages.map((stage) => ({ id: field(stage, "Id"), name: field(stage, "Name"), dueDate: field(stage, "DueDate"), acceptanceCriteria: field(stage, "AcceptanceCriteria"), completed: field(stage, "Id") === id ? !field(stage, "CompletedAt") : !!field(stage, "CompletedAt") })) }));
        }
        if (action === "pm-new") editProject(null);
        if (action === "pm-edit") editProject(p);
        if (action === "pm-filter") { filter = id; }
        if (action === "pm-view") { view = id; selectTab("tasks"); }
        if (action === "pm-add-task") { selectTab("tasks"); editTask(null, selectedId, list(p, "Milestones").some((stage) => field(stage, "Id") === milestoneFilter) ? milestoneFilter : ""); }
        if (action === "pm-edit-task") editTask(getState().tasks.find((t) => field(t, "Id") === id), selectedId);
        if (action === "pm-archive" || action === "pm-restore") {
          await onResult(await api.zenTask.updateProject(id, { archived: action === "pm-archive" }));
          filter = action === "pm-archive" ? "archived" : "active";
        }
        if (action === "pm-link-notes") { selectTab("notes"); await loadFiles(); picker = { query: "", selected: new Set(field(p, "LinkedNotes", [])) }; }
        if (action === "pm-close-picker") picker = null;
        if (action === "pm-save-notes") { await onResult(await api.zenTask.updateProject(selectedId, { linkedNotes: [...picker.selected] })); picker = null; }
        if (action === "pm-unlink-note") await onResult(await api.zenTask.updateProject(selectedId, { linkedNotes: field(p, "LinkedNotes", []).filter((note) => note !== id) }));
        if (action === "pm-open-note") await openNote(id);
        if (action === "pm-open-task-source") await openNote(id);
      });
      return true;
    }
    function bind(scope) {
      scope.querySelectorAll('.pm-tabs [role="tab"]').forEach((tab) => {
        tab.onkeydown = (event) => {
          const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
          if (!keys.includes(event.key)) return;
          event.preventDefault();
          const current = TABS.findIndex(([key]) => key === tab.dataset.id);
          const index = event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + TABS.length) % TABS.length;
          selectTab(TABS[index][0]); rerender();
          scope.querySelector(`#pm-tab-${detailTab}`)?.focus();
        };
      });
      scope.querySelectorAll("[data-pm-search]").forEach((input) => {
        input.oninput = () => {
          const key = input.dataset.pmSearch;
          const caret = input.selectionStart;
          if (key === "projects") query = input.value;
          if (key === "tasks") taskQuery = input.value;
          if (key === "notes") picker.query = input.value;
          rerender();
          const next = scope.querySelector(`[data-pm-search="${key}"]`);
          next?.focus(); next?.setSelectionRange(caret, caret);
        };
      });
      const order = scope.querySelector("[data-pm-sort]");
      if (order) order.onchange = () => { sort = order.value; rerender(); };
      const taskSelect = scope.querySelector("[data-pm-task-filter]");
      if (taskSelect) taskSelect.onchange = () => { taskFilter = taskSelect.value; rerender(); };
      const stageSelect = scope.querySelector("[data-pm-milestone-filter]");
      if (stageSelect) stageSelect.onchange = () => { milestoneFilter = stageSelect.value; rerender(); };
      const deleteForm = scope.querySelector("[data-pm-delete-milestone]");
      if (deleteForm) deleteForm.onsubmit = (event) => { event.preventDefault(); if (!deleteForm.reportValidity()) return; const data = new FormData(deleteForm); run(async () => { await onResult(await api.zenTask.deleteMilestone(selectedId, dialog.id, deleteForm.elements.reassign ? data.get("reassign") : "")); dialog = null; }); };
      if (detailTab === "ai" && project()) aiPanel?.bind(scope, project());
      else if (!project()) aiPanel?.bind(scope, null);
      planUI?.bind(scope);
      const form = scope.querySelector("[data-pm-dialog-form]");
      if (form && dialog?.type === "update") form.oninput = form.onchange = () => {
        if (!dialog.drafting) dialog.values = { ...dialog.values, ...Object.fromEntries(new FormData(form)) };
      };
      if (form) form.onsubmit = (event) => {
        event.preventDefault();
        if (!form.reportValidity() || dialog?.drafting) return;
        const data = new FormData(form);
        run(async () => {
          if (dialog.type === "milestone") {
            const current = list(project(), "Milestones");
            const entry = { id: dialog.id || crypto.randomUUID(), name: data.get("name"), dueDate: data.get("dueDate"), acceptanceCriteria: data.get("acceptanceCriteria") };
            const stages = current.map((stage) => ({ id: field(stage, "Id"), name: field(stage, "Name"), dueDate: field(stage, "DueDate"), acceptanceCriteria: field(stage, "AcceptanceCriteria"), completed: !!field(stage, "CompletedAt") }));
            const index = stages.findIndex((stage) => stage.id === dialog.id);
            if (index < 0) stages.push(entry); else stages[index] = { ...stages[index], ...entry };
            await onResult(await api.zenTask.updateProject(selectedId, { milestones: stages }));
          } else {
            await onResult(await api.zenTask.updateProject(selectedId, { addUpdate: { health: data.get("health"), summary: data.get("summary"), risks: data.get("risks"), nextAction: data.get("nextAction") } }));
          }
          dialog = null;
        });
      };
      scope.querySelectorAll("[data-pm-task-status]").forEach((select) => {
        select.onchange = () => run(async () => { await onResult(await api.zenTask.updateTask(select.dataset.pmTaskStatus, { workflowStatus: select.value })); });
      });
      scope.querySelectorAll("[data-pm-note]").forEach((checkbox) => {
        checkbox.onchange = () => {
          if (checkbox.checked) picker.selected.add(checkbox.dataset.pmNote); else picker.selected.delete(checkbox.dataset.pmNote);
          scope.querySelector("[data-pm-selected]").textContent = `已选 ${picker.selected.size} 篇`;
        };
      });
    }
    function closeModal() { if (planUI?.isOpen()) return planUI.close(); if ((!picker && !dialog) || busy) return false; cancelDraft(); picker = null; dialog = null; pageError = ""; rerender(); return true; }
    async function refreshFiles() {
      if (!selectedId) return;
      try { await loadFiles(); } catch { filesLoaded = false; }
    }
    function resetVault() {
      if (dialog?.requestId) void api.ai?.cancel?.(dialog.requestId);
      aiPanel?.reset();
      planUI?.reset();
      selectedId = "";
      detailTab = "overview";
      projectTabs.clear();
      taskFilter = "all";
      view = "list";
      picker = null;
      dialog = null;
      files = [];
      filesLoaded = false;
      focusedTaskId = "";
      milestoneFilter = "all";
      taskQuery = "";
      pageError = "";
      renderedAttention = [];
    }
    return { render, renderModal, handleAction, bind, open, closeModal, refreshFiles, resetVault,
      hasPendingEdits: () => Boolean(picker || dialog || planUI?.isOpen()) };
  }
  window.DMProjectManager = { create };
})();
