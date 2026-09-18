(() => {
  const { value: field, done, archived } = window.DMZenModel;
  const STATUS = { Todo: "待办", "In Progress": "进行中", Blocked: "受阻", Completed: "完成" };
  const HEALTH = { "On Track": "正常", "At Risk": "有风险", Blocked: "受阻", Completed: "已完成" };
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
    let view = "list";
    let sort = "updated";
    let pageError = "";
    let busy = false;
    let files = [];
    let filesLoaded = false;
    let picker = null;

    const project = () => getState().projects.find((p) => field(p, "Id") === selectedId);
    const associated = (id) => getState().tasks.filter((task) => field(task, "ProjectId") === id);
    const overdue = (task) => !done(task) && date(field(task, "DueDate")) && date(field(task, "DueDate")) < today();
    const button = (action, label, id = "", className = "pm-button") => `<button class="${className}" data-module-action="pm-${action}" data-id="${attr(id)}" ${busy ? "disabled" : ""}>${label}</button>`;
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
      pageError = "";
      rerender();
      try { await loadFiles(); } catch { pageError = "暂时无法读取笔记列表，可稍后重新关联。"; }
      rerender();
    }
    function renderOverview() {
      const all = getState().projects;
      const visible = all.filter((p) => (filter === "archived" ? archived(p) : !archived(p)) && ["Name", "Description", "Owner", "Category"].some((key) => String(field(p, key)).toLowerCase().includes(query.trim().toLowerCase())));
      visible.sort((a, b) => sort === "due"
        ? (date(field(a, "DueDate")) || "9999").localeCompare(date(field(b, "DueDate")) || "9999")
        : sort === "name" ? field(a, "Name").localeCompare(field(b, "Name"), "zh-CN")
        : String(field(b, "UpdatedAt")).localeCompare(String(field(a, "UpdatedAt"))));
      return `<section class="module-page pm-page">
        <div class="module-heading"><div><div class="pm-eyebrow">PROJECTS / 项目工作台</div><h1>把目标推进到完成</h1><p>任务、行动与笔记，都留在项目里。</p></div>${button("new", "＋ 新建项目", "", "module-primary")}</div>
        ${errorHtml()}
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
            <div class="project-progress"><span style="width:${m.progress}%"></span></div><div class="project-footer"><span>任务完成率 ${m.progress}% · ${m.completed}/${m.tasks.length}</span><span>${esc(HEALTH[field(p, "Status")] || field(p, "Status"))}</span></div>
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
      return `<article class="pm-task ${done(task) ? "done" : ""}"><div class="pm-task-top"><span class="pm-dot state-${attr(state.replaceAll(" ", "-"))}"></span>${readOnly ? `<strong>${esc(field(task, "Title"))}</strong>` : button("edit-task", esc(field(task, "Title")), id, "pm-task-title")}</div>
        ${field(task, "Notes") ? `<p>${esc(field(task, "Notes"))}</p>` : ""}
        <div class="pm-task-bottom"><span class="${overdue(task) ? "pm-overdue" : ""}">${due ? `${overdue(task) ? "逾期 · " : "截止 "}${esc(due)}` : "无截止日期"}</span><select data-pm-task-status="${attr(id)}" aria-label="${attr(field(task, "Title"))}的状态" ${readOnly || busy ? "disabled" : ""}>${Object.entries(STATUS).map(([key, text]) => `<option value="${key}" ${state === key ? "selected" : ""}>${text}</option>`).join("")}</select></div></article>`;
    }
    function renderDetail(p) {
      const id = field(p, "Id");
      const m = metrics(id);
      const readOnly = archived(p);
      const visible = m.tasks.filter((task) => (taskFilter === "all" || (taskFilter === "open" ? !done(task) : done(task))) && `${field(task, "Title")} ${field(task, "Notes")} ${field(task, "Tags")}`.toLowerCase().includes(taskQuery.trim().toLowerCase()));
      visible.sort((a, b) => Number(done(a)) - Number(done(b)) || (date(field(a, "DueDate")) || "9999").localeCompare(date(field(b, "DueDate")) || "9999"));
      const linked = field(p, "LinkedNotes", []);
      return `<section class="module-page pm-page">
        <div class="pm-breadcrumb">${button("back", "← 所有项目")}<span>/</span><span>${esc(field(p, "Name"))}</span></div>
        <div class="module-heading"><div><div class="pm-eyebrow">${esc(field(p, "Category") || "项目详情")} ${readOnly ? " / 已归档" : ""}</div><h1>${esc(field(p, "Name"))}</h1><p>${esc(field(p, "Description") || "为项目留下一段背景说明。")}</p></div><div class="pm-actions">${!readOnly ? button("edit", "编辑项目", id) : ""}${button(readOnly ? "restore" : "archive", readOnly ? "恢复项目" : "归档项目", id)}</div></div>
        ${errorHtml()}${readOnly ? '<div class="pm-notice">项目已归档，任务与笔记关联均已保留。恢复后可在此继续推进。</div>' : ""}
        <div class="pm-facts"><span>负责人 · ${esc(field(p, "Owner") || "未指定")}</span><span>截止 · ${esc(date(field(p, "DueDate")) || "未设置")}</span><span>状态 · ${esc(HEALTH[field(p, "Status")] || field(p, "Status"))}</span><span>优先级 · ${esc(PRIORITY[field(p, "Priority")] || "中")}</span></div>
        <div class="module-stats pm-stats"><div><strong>${m.progress}<small>%</small></strong><span>任务完成率 · ${m.completed}/${m.tasks.length}</span></div><div><strong>${m.tasks.filter((t) => status(t) === "In Progress").length}</strong><span>正在进行</span></div><div><strong>${m.blocked}</strong><span>受阻任务</span></div><div><strong>${m.overdue}</strong><span>逾期任务</span></div></div>
        <div class="pm-detail-grid"><div class="pm-main-column"><section class="pm-panel"><div class="pm-panel-heading"><h2>项目任务 <span>${m.tasks.length}</span></h2>${!readOnly ? button("add-task", "＋ 添加任务", id, "module-primary") : ""}</div>
          <div class="pm-task-toolbar"><div class="module-segments">${button("view", "列表", "list", view === "list" ? "active" : "")}${button("view", "看板", "board", view === "board" ? "active" : "")}</div><input class="pm-search" data-pm-search="tasks" value="${attr(taskQuery)}" placeholder="搜索项目内任务" aria-label="搜索项目内任务" /><select data-pm-task-filter aria-label="任务筛选"><option value="all" ${taskFilter === "all" ? "selected" : ""}>全部任务</option><option value="open" ${taskFilter === "open" ? "selected" : ""}>未完成</option><option value="done" ${taskFilter === "done" ? "selected" : ""}>已完成</option></select></div>
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
      </section>`;
    }
    function render() { const p = project(); return p ? renderDetail(p) : renderOverview(); }
    function renderModal() {
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
    function closeModal() { if (!picker || busy) return false; picker = null; pageError = ""; rerender(); return true; }
    async function refreshFiles() {
      if (!selectedId) return;
      try { await loadFiles(); } catch { filesLoaded = false; }
    }
    return { render, renderModal, handleAction, bind, open, closeModal, refreshFiles };
  }
  window.DMProjectManager = { create };
})();
