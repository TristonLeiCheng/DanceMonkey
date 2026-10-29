(() => {
  async function open({ root, text, sourcePath, selected, api, esc, attr = esc, onProjects }) {
    const candidates = window.DMZenModel.taskCandidatesFromNote(text);
    const state = await api.load();
    const projects = state.projects.filter((project) => !window.DMZenModel.archived(project));
    const existing = root.querySelector(".ws-note-task-backdrop");
    existing?.remove();
    const overlay = document.createElement("div");
    overlay.className = "module-modal-backdrop ws-note-task-backdrop";
    overlay.innerHTML = `<form class="module-modal ws-note-task-dialog"><h2>从${selected ? "选中内容" : "整篇笔记"}生成任务</h2><p class="pm-muted">预览并编辑候选项后再保存；每个任务会保留来源笔记与摘录。</p>${!projects.length ? '<div class="module-error">请先在「项目」中新建项目。</div>' : `<label>目标项目<select name="projectId" required>${projects.map((project) => `<option value="${attr(window.DMZenModel.value(project, "Id"))}">${esc(window.DMZenModel.value(project, "Name"))}</option>`).join("")}</select></label><label>里程碑<select name="milestoneId"><option value="">未分配阶段</option></select></label>`}${!candidates.length ? '<div class="module-error">未找到可生成的内容。请选择正文或输入列表项后重试。</div>' : `<div class="ws-note-task-list">${candidates.map((item, index) => `<label class="ws-note-task-row"><input type="checkbox" data-candidate="${index}" checked /><input class="ws-note-task-title" data-title="${index}" maxlength="160" value="${attr(item.title)}" aria-label="候选任务 ${index + 1}" /></label>`).join("")}</div>`}<div class="module-error ws-note-task-error" hidden></div><div class="module-modal-actions"><button type="button" data-note-task-cancel>取消</button><button type="submit" class="module-primary" ${!projects.length || !candidates.length ? "disabled" : ""}>创建选中任务</button></div></form>`;
    root.append(overlay);
    const form = overlay.querySelector("form");
    const projectSelect = form.querySelector('[name="projectId"]');
    const stageSelect = form.querySelector('[name="milestoneId"]');
    const syncPreview = () => {
      const marked = window.DMZenModel.duplicateTaskCandidates(candidates.map((item, index) => ({ ...item, title: form.querySelector(`[data-title="${index}"]`)?.value || item.title })), state.tasks || [], projectSelect.value, sourcePath);
      marked.forEach((item, index) => {
        const box = form.querySelector(`[data-candidate="${index}"]`);
        const row = box?.closest(".ws-note-task-row");
        row?.querySelector(".ws-duplicate-hint")?.remove();
        if (item.suspectedDuplicate) {
          row?.insertAdjacentHTML("beforeend", `<small class="ws-duplicate-hint">${item.duplicate ? "已从此笔记导入" : "疑似同名任务"}</small>`);
          if (item.duplicate) { box.checked = false; box.disabled = true; }
        } else if (box) box.disabled = false;
      });
    };
    const syncStages = () => {
      const project = projects.find((entry) => window.DMZenModel.value(entry, "Id") === projectSelect.value);
      stageSelect.innerHTML = `<option value="">未分配阶段</option>${window.DMZenModel.list(project, "Milestones").map((stage) => `<option value="${attr(window.DMZenModel.value(stage, "Id"))}">${esc(window.DMZenModel.value(stage, "Name"))}</option>`).join("")}`;
      syncPreview();
    };
    form.querySelectorAll("[data-title]").forEach((input) => { input.oninput = syncPreview; });
    if (projectSelect) { projectSelect.onchange = syncStages; syncStages(); }
    overlay.onclick = (event) => { if (event.target === overlay || event.target.closest("[data-note-task-cancel]")) overlay.remove(); };
    form.onsubmit = async (event) => {
      event.preventDefault();
      const chosen = [...form.querySelectorAll("[data-candidate]:checked")].map((box) => ({ box, index: Number(box.dataset.candidate), title: form.querySelector(`[data-title="${box.dataset.candidate}"]`).value.trim() }));
      const errorBox = form.querySelector(".ws-note-task-error");
      const showError = (message) => { errorBox.hidden = false; errorBox.textContent = message; };
      if (!chosen.length) return showError("请至少选择一项任务。");
      if (chosen.some((item) => !item.title)) return showError("任务标题不能为空。");
      const submit = form.querySelector('[type="submit"]');
      submit.disabled = true;
      try {
        const project = projects.find((entry) => window.DMZenModel.value(entry, "Id") === projectSelect.value);
        if (!project) throw new Error("请选择目标项目");
        const targetProjectId = projectSelect.value;
        const payload = chosen.map((item) => ({ title: item.title, projectId: targetProjectId, milestoneId: stageSelect.value, sourceNotePath: sourcePath, sourceExcerpt: candidates[item.index].excerpt }));
        await api.addTasksBatch(payload);
        form.innerHTML = `<h2>已创建 ${payload.length} 项任务</h2><p class="pm-muted">整批保存成功，来源笔记与项目关联已一并保留。</p><div class="module-modal-actions"><button type="button" data-note-task-source>返回来源笔记</button><button type="button" class="module-primary" data-note-task-project>查看项目任务</button></div>`;
        form.querySelector("[data-note-task-source]").onclick = () => overlay.remove();
        form.querySelector("[data-note-task-project]").onclick = async () => { overlay.remove(); await onProjects(targetProjectId); };
      } catch (error) {
        showError(`${error?.message || "创建失败"}。本次未保存任何任务，可修改后安全重试。`);
      } finally { submit.disabled = false; }
    };
  }
  window.DMNoteTasks = { open };
})();
