(() => {
  const { value: field, done, archived, lifecycle, health, milestoneProgress, list } = window.DMZenModel;
  const STATUS = { Todo: "待办", "In Progress": "进行中", Blocked: "受阻", Completed: "完成" };
  const HEALTH = { "On Track": "正常", "At Risk": "有风险", Blocked: "受阻" };
  const LIFECYCLE = { Planned: "计划中", "In Progress": "进行中", Paused: "已暂停", Completed: "已完成" };
  const PRIORITY = { Low: "低", Medium: "中", High: "高", Critical: "紧急" };
  const date = (value) => String(value || "").slice(0, 10);
  const today = () => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  };
  const status = (task) => done(task) ? "Completed" : field(task, "WorkflowStatus", "Todo");
  const flatten = (tree) => tree.flatMap((node) => node.type === "file" ? [node] : flatten(node.children || []));

  function create({ api, esc, attr, rerender, getState, onResult, editTask, editProject, openNote }) {
    let selectedId = "";
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
    const overdue = (task) => !done(task) && date(field(task, "DueDate")) && date(field(task, "DueDate")) < today();
    const button = (action, label, id = "", className = "pm-button") => `<button type="button" class="${className}" data-module-action="pm-${action}" data-id="${attr(id)}" ${busy ? "disabled" : ""}>${label}</button>`;
    const errorHtml = () => pageError ? `<div class="module-error" role="alert">${esc(pageError)}</div>` : "";
    function metrics(id) {
      const tasks = associated(id);
      const completed = tasks.filter(done).length;
      return { tasks, completed, progress: tasks.length ? Math.round(100 * completed / tasks.length) : 0, blocked: tasks.filter((t) => status(t) === "Blocked").length, overdue: tasks.filter(overdue).length };
    }
    async function loadFiles() {
      filesLoaded = false;
      files = flatten((await api.workspace.list()).tree || []);
      filesLoaded = true;
    }
    async function open(id) {
      selectedId = id;
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
        : String(field(b, "UpdatedAt")).localeCompare(String(field(a, "UpdatedAt"))));
      return `<section class="module-page pm-page">
        <div class="module-heading"><div><div class="pm-eyebrow">PROJECTS / 项目工作台</div><h1>把目标推进到完成</h1><p>任务、行动与笔记，都留在项目里。</p></div>${button("new", "＋ 新建项目", "", "module-primary")}</div>
        ${errorHtml()}
        ${filter === "active" ? `<section class="pm-panel pm-attention"><div class="pm-panel-heading"><h2>Needs attention / 需要关注 <span>${renderedAttention.length}</span></h2><small>未来 7 天里程碑 · 逾期/受阻任务 · 风险健康度 · 14 天未更新</small></div>${renderedAttention.length ? `<div class="pm-attention-list">${renderedAttention.map((item, index) => `<button type="button" data-module-action="pm-attention" data-id="${index}"><strong>${esc(item.projectName)} · ${esc(item.label)}</strong><span>${esc(item.detail)}</span></button>`).join("")}</div>` : '<div class="pm-empty compact">当前没有需要关注的活跃项目。</div>'}</section>` : ""}
        <div class="module-toolbar pm-toolbar"><div class="module-segments">${button("filter", `活跃项目 · ${all.filter((p) => !archived(p)).length}`, "active", filter === "active" ? "active" : "")}${button("filter", `已归档 · ${all.filter(archived).length}`, "archived", filter === "archived" ? "active" : "")}</div>
          <input class="pm-search module-search" data-pm-search="projects" value="${attr(query)}" aria-label="搜索项目" placeholder="搜索项目、负责人或分类" />
          <select data-pm-sort aria-label="项目排序"><option value="updated" ${sort === "updated" ? "selected" : ""}>最近更新</option><option value="due" ${sort === "due" ? "selected" : ""}>截止日期</option><option value="name" ${sort === "name" ? "selected" : ""}>项目名称</option></select>
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
    function renderDetail(p) {
      const id = field(p, "Id");
      const m = metrics(id);
      const readOnly = archived(p);
      const visible = m.tasks.filter((task) => (!focusedTaskId || field(task, "Id") === focusedTaskId) && (taskFilter === "all" || (taskFilter === "open" ? !done(task) : done(task))) && (milestoneFilter === "all" || field(task, "MilestoneId") === milestoneFilter || (milestoneFilter === "none" && !field(task, "MilestoneId"))) && `${field(task, "Title")} ${field(task, "Notes")} ${field(task, "Tags")}`.toLowerCase().includes(taskQuery.trim().toLowerCase()));
      visible.sort((a, b) => Number(done(a)) - Number(done(b)) || (date(field(a, "DueDate")) || "9999").localeCompare(date(field(b, "DueDate")) || "9999"));
      const linked = field(p, "LinkedNotes", []);
      const stages = list(p, "Milestones");
      const updates = list(p, "Updates");
      return `<section class="module-page pm-page">
        <div class="pm-breadcrumb">${button("back", "← 所有项目")}<span>/</span><span>${esc(field(p, "Name"))}</span></div>
        <div class="module-heading"><div><div class="pm-eyebrow">${esc(field(p, "Category") || "项目详情")} ${readOnly ? " / 已归档" : ""}</div><h1>${esc(field(p, "Name"))}</h1><p>${esc(field(p, "Description") || "为项目留下一段背景说明。")}</p></div><div class="pm-actions">${!readOnly ? button("edit", "编辑项目", id) : ""}${button(readOnly ? "restore" : "archive", readOnly ? "恢复项目" : "归档项目", id)}</div></div>
        ${errorHtml()}${readOnly ? '<div class="pm-notice">项目已归档，任务与笔记关联均已保留。恢复后可在此继续推进。</div>' : ""}
        <div class="pm-facts"><span>负责人 · ${esc(field(p, "Owner") || "未指定")}</span><span>截止 · ${esc(date(field(p, "DueDate")) || "未设置")}</span><span>阶段 · ${esc(LIFECYCLE[lifecycle(p)] || lifecycle(p))}</span><span>健康度 · ${esc(HEALTH[health(p)] || health(p))}</span><span>优先级 · ${esc(PRIORITY[field(p, "Priority")] || "中")}</span></div>
        <div class="module-stats pm-stats"><div><strong>${m.progress}<small>%</small></strong><span>任务完成率 · ${m.completed}/${m.tasks.length}</span></div><div><strong>${m.tasks.filter((t) => status(t) === "In Progress").length}</strong><span>正在进行</span></div><div><strong>${m.blocked}</strong><span>受阻任务</span></div><div><strong>${m.overdue}</strong><span>逾期任务</span></div></div>
        <section class="pm-panel pm-milestones"><div class="pm-panel-heading"><h2>里程碑 <span>${stages.length}</span></h2>${!readOnly ? button("new-milestone", "＋ 添加里程碑") : ""}</div><div class="pm-milestone-grid">${stages.map((stage) => { const progress = milestoneProgress(stage, m.tasks); const stageId = field(stage, "Id"); return `<article class="pm-milestone"><div class="pm-milestone-head"><strong>${esc(field(stage, "Name"))}</strong><span>${field(stage, "CompletedAt") ? "已验收" : `任务 ${progress.completed}/${progress.total}`}</span></div><div class="project-progress"><span style="width:${progress.percent}%"></span></div><p>${esc(field(stage, "AcceptanceCriteria") || "未设置验收标准")}</p><small>${field(stage, "DueDate") ? `目标 ${esc(date(field(stage, "DueDate")))}` : "未设置目标日期"} · 进度 ${progress.percent}%</small><div class="module-row-actions visible">${button("filter-stage", "查看任务", stageId)}${!readOnly ? `${button("move-milestone-up", "↑", stageId)}${button("move-milestone-down", "↓", stageId)}${button("edit-milestone", "编辑", stageId)}${button("toggle-milestone", field(stage, "CompletedAt") ? "重新打开" : "确认完成", stageId)}${button("delete-milestone", "删除", stageId)}` : ""}</div></article>`; }).join("") || '<div class="pm-empty compact">设定阶段交付成果，再把任务分配给里程碑。</div>'}</div></section>
        <div class="pm-detail-grid"><div class="pm-main-column"><section class="pm-panel"><div class="pm-panel-heading"><h2>项目任务 <span>${m.tasks.length}</span></h2>${!readOnly ? button("add-task", "＋ 添加任务", id, "module-primary") : ""}</div>
          <div class="pm-task-toolbar"><div class="module-segments">${button("view", "列表", "list", view === "list" ? "active" : "")}${button("view", "看板", "board", view === "board" ? "active" : "")}</div><input class="pm-search" data-pm-search="tasks" value="${attr(taskQuery)}" placeholder="搜索项目内任务" aria-label="搜索项目内任务" /><select data-pm-task-filter aria-label="任务筛选"><option value="all" ${taskFilter === "all" ? "selected" : ""}>全部任务</option><option value="open" ${taskFilter === "open" ? "selected" : ""}>未完成</option><option value="done" ${taskFilter === "done" ? "selected" : ""}>已完成</option></select><select data-pm-milestone-filter aria-label="里程碑筛选"><option value="all" ${milestoneFilter === "all" ? "selected" : ""}>所有里程碑</option><option value="none" ${milestoneFilter === "none" ? "selected" : ""}>未分配</option>${stages.map((stage) => `<option value="${attr(field(stage, "Id"))}" ${milestoneFilter === field(stage, "Id") ? "selected" : ""}>${esc(field(stage, "Name"))}</option>`).join("")}</select>${focusedTaskId ? button("clear-task-focus", "显示全部任务") : ""}</div>
          ${view === "board" ? `<div class="pm-board">${Object.entries(STATUS).map(([key, label]) => {
            const tasks = visible.filter((t) => (STATUS[status(t)] ? status(t) : "Todo") === key);
            return `<section class="pm-lane"><h3><span class="pm-dot state-${key.replaceAll(" ", "-")}"></span>${label}<span>${tasks.length}</span></h3>${tasks.map((t) => taskCard(t, readOnly)).join("") || '<div class="pm-lane-empty">暂无任务</div>'}</section>`;
          }).join("")}</div>` : `<div class="pm-task-list">${visible.map((t) => taskCard(t, readOnly)).join("") || `<div class="pm-empty"><strong>${m.tasks.length ? "没有匹配的任务" : "把目标拆成第一个行动"}</strong><p>${m.tasks.length ? "调整搜索或完成状态筛选。" : "任务会自动归属当前项目。"}</p></div>`}</div>`}
        </section><section class="pm-panel"><div class="pm-panel-heading"><h2>关联笔记 <span>${linked.length}</span></h2>${!readOnly ? button("link-notes", "＋ 关联笔记") : ""}</div>
          <div class="pm-notes">${linked.map((note) => {
            const missing = filesLoaded && !files.some((file) => file.path === note);
            return `<div class="pm-note"><div><span class="pm-note-icon">▤</span>${button("open-note", esc(note.split("/").pop().replace(/\.md$/i, "")), note)}<small>${esc(note)}${missing ? " · 文件不存在，请重新关联" : ""}</small></div>${!readOnly ? button("unlink-note", "解除关联", note) : ""}</div>`;
          }).join("") || '<div class="pm-empty compact">把方案、会议记录或复盘关联到这里，随时返回原文。</div>'}</div>
        </section></div><aside class="pm-context"><section class="pm-panel"><h2>目标与行动</h2>${[["Goal", "项目目标", "这个项目要解决什么问题？"], ["AcceptanceCriteria", "完成标准", "交付什么成果，才算完成？"], ["NextAction", "下一步行动", "下一件可以立即推进的事。"], ["Blockers", "阻塞与风险", "暂无记录"]].map(([key, label, fallback]) => `<div class="pm-context-item"><h3>${label}</h3><p class="${field(p, key) ? "" : "pm-muted"}">${esc(field(p, key) || fallback)}</p></div>`).join("")}${!readOnly ? button("edit", "完善项目说明", id) : ""}</section></aside></div>
        <section class="pm-panel pm-updates"><div class="pm-panel-heading"><h2>进展记录 <span>${updates.length}</span></h2>${!readOnly ? button("new-update", "＋ 记录本周进展") : ""}</div>${updates.length ? updates.map((entry) => `<article class="pm-update"><div><strong>${esc(date(field(entry, "CreatedAt")))}</strong><span>${esc(HEALTH[field(entry, "Health")] || field(entry, "Health"))}</span></div><p>${esc(field(entry, "Summary"))}</p>${field(entry, "Risks") ? `<small>风险：${esc(field(entry, "Risks"))}</small>` : ""}${field(entry, "NextAction") ? `<small>下一步：${esc(field(entry, "NextAction"))}</small>` : ""}</article>`).join("") : '<div class="pm-empty compact">每周留下进展、风险和下一步，回看时不丢上下文。</div>'}</section>
      </section>`;
    }
    function render() { const p = project(); return p ? renderDetail(p) : renderOverview(); }
    function renderModal() {
      if (dialog) {
        const editing = dialog.type === "milestone" ? list(project(), "Milestones").find((stage) => field(stage, "Id") === dialog.id) : null;
        if (dialog.type === "delete-milestone") {
          const linked = associated(selectedId).filter((task) => field(task, "MilestoneId") === dialog.id).length;
          const others = list(project(), "Milestones").filter((stage) => field(stage, "Id") !== dialog.id);
          return `<div class="module-modal-backdrop"><div class="module-modal pm-dialog" role="dialog" aria-modal="true"><h2>确认删除里程碑</h2><p>${linked ? `仍有 ${linked} 项关联任务。必须转移到其他里程碑或设为未分配后才能删除。` : "此操作不会删除任务，且无法撤销。"}</p><form data-pm-delete-milestone>${linked ? `<label>关联任务处理<select name="reassign" required><option value="">设为未分配</option>${others.map((stage) => `<option value="${attr(field(stage, "Id"))}">转移到 ${esc(field(stage, "Name"))}</option>`).join("")}</select></label>` : ""}<label class="pm-confirm"><input type="checkbox" name="confirmed" required /> 我确认删除此里程碑</label><div class="module-modal-actions">${button("close-dialog", "取消")}<button class="module-primary" type="submit">确认删除</button></div></form>${errorHtml()}</div></div>`;
        }
        return `<div class="module-modal-backdrop"><div class="module-modal pm-dialog" role="dialog" aria-modal="true" aria-label="${dialog.type === "milestone" ? "编辑里程碑" : "记录项目进展"}"><h2>${dialog.type === "milestone" ? editing ? "编辑里程碑" : "新建里程碑" : "记录本周进展"}</h2><form data-pm-dialog-form>${dialog.type === "milestone" ? `<label>里程碑名称<input name="name" required maxlength="160" value="${attr(field(editing, "Name"))}" placeholder="例如：首版方案通过" /></label><label>目标日期<input name="dueDate" type="date" value="${attr(date(field(editing, "DueDate")))}" /></label><label>验收标准<textarea name="acceptanceCriteria" rows="3" placeholder="交付什么成果算完成？">${esc(field(editing, "AcceptanceCriteria"))}</textarea></label>` : `<label>当前健康度<select name="health"><option value="On Track" ${health(project()) === "On Track" ? "selected" : ""}>正常</option><option value="At Risk" ${health(project()) === "At Risk" ? "selected" : ""}>有风险</option><option value="Blocked" ${health(project()) === "Blocked" ? "selected" : ""}>受阻</option></select></label><label>本周进展<textarea name="summary" required rows="3" placeholder="本周完成了什么？"></textarea></label><label>风险或阻塞<textarea name="risks" rows="2" placeholder="当前风险（可选）"></textarea></label><label>下一步行动<textarea name="nextAction" rows="2" placeholder="下周最重要的行动（可选）"></textarea></label>`}<div class="module-modal-actions">${button("close-dialog", "取消")}<button class="module-primary" type="submit" ${busy ? "disabled" : ""}>保存</button></div></form>${errorHtml()}</div></div>`;
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
      await run(async () => {
        const p = project();
        if (action === "pm-open") await open(id);
        if (action === "pm-back") { selectedId = ""; picker = null; }
        if (action === "pm-attention") { const item = renderedAttention[Number(id)]; if (item) { await open(item.projectId); if (item.milestoneId) milestoneFilter = item.milestoneId; if (item.taskFilter) taskFilter = item.taskFilter; if (item.taskId) { focusedTaskId = item.taskId; taskQuery = ""; view = "list"; } } }
        if (action === "pm-clear-task-focus") { focusedTaskId = ""; taskFilter = "all"; }
        if (action === "pm-new-milestone") dialog = { type: "milestone", id: "" };
        if (action === "pm-edit-milestone") dialog = { type: "milestone", id };
        if (action === "pm-delete-milestone") dialog = { type: "delete-milestone", id };
        if (action === "pm-move-milestone-up" || action === "pm-move-milestone-down") {
          const stages = list(p, "Milestones").map((stage) => ({ id: field(stage, "Id"), name: field(stage, "Name"), dueDate: field(stage, "DueDate"), acceptanceCriteria: field(stage, "AcceptanceCriteria"), completed: !!field(stage, "CompletedAt") }));
          const from = stages.findIndex((stage) => stage.id === id); const to = from + (action.endsWith("up") ? -1 : 1);
          if (from >= 0 && to >= 0 && to < stages.length) { [stages[from], stages[to]] = [stages[to], stages[from]]; await onResult(await api.zenTask.updateProject(selectedId, { milestones: stages })); }
        }
        if (action === "pm-new-update") dialog = { type: "update" };
        if (action === "pm-close-dialog") dialog = null;
        if (action === "pm-filter-stage") { milestoneFilter = id; view = "list"; }
        if (action === "pm-toggle-milestone") {
          const stages = list(p, "Milestones");
          await onResult(await api.zenTask.updateProject(selectedId, { milestones: stages.map((stage) => ({ id: field(stage, "Id"), name: field(stage, "Name"), dueDate: field(stage, "DueDate"), acceptanceCriteria: field(stage, "AcceptanceCriteria"), completed: field(stage, "Id") === id ? !field(stage, "CompletedAt") : !!field(stage, "CompletedAt") })) }));
        }
        if (action === "pm-new") editProject(null);
        if (action === "pm-edit") editProject(p);
        if (action === "pm-filter") { filter = id; }
        if (action === "pm-view") view = id;
        if (action === "pm-add-task") editTask(null, selectedId);
        if (action === "pm-edit-task") editTask(getState().tasks.find((t) => field(t, "Id") === id), selectedId);
        if (action === "pm-archive" || action === "pm-restore") {
          await onResult(await api.zenTask.updateProject(id, { archived: action === "pm-archive" }));
          filter = action === "pm-archive" ? "archived" : "active";
        }
        if (action === "pm-link-notes") { await loadFiles(); picker = { query: "", selected: new Set(field(p, "LinkedNotes", [])) }; }
        if (action === "pm-close-picker") picker = null;
        if (action === "pm-save-notes") { await onResult(await api.zenTask.updateProject(selectedId, { linkedNotes: [...picker.selected] })); picker = null; }
        if (action === "pm-unlink-note") await onResult(await api.zenTask.updateProject(selectedId, { linkedNotes: field(p, "LinkedNotes", []).filter((note) => note !== id) }));
        if (action === "pm-open-note") await openNote(id);
        if (action === "pm-open-task-source") await openNote(id);
      });
      return true;
    }
    function bind(scope) {
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
      const form = scope.querySelector("[data-pm-dialog-form]");
      if (form) form.onsubmit = (event) => {
        event.preventDefault();
        if (!form.reportValidity()) return;
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
    function closeModal() { if ((!picker && !dialog) || busy) return false; picker = null; dialog = null; pageError = ""; rerender(); return true; }
    async function refreshFiles() {
      if (!selectedId) return;
      try { await loadFiles(); } catch { filesLoaded = false; }
    }
    return { render, renderModal, handleAction, bind, open, closeModal, refreshFiles };
  }
  window.DMProjectManager = { create };
})();
