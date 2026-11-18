(() => {
  const PRIORITY = { Low: "低", Medium: "中", High: "高", Critical: "紧急" };
  const cleanError = (error, fallback) => String(error?.message || fallback).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");

  async function open({ root, text, sourcePath, selected, api, esc, attr = esc, onProjects }) {
    const model = window.DMZenModel;
    const ruleCandidates = model.taskCandidatesFromNote(text);
    let candidates = ruleCandidates;
    let mode = "rules";
    let aiCandidates = null;
    let aiRequest = "";
    let aiNotice = "";
    const canUseAi = typeof api.aiExtract === "function" && String(text || "").trim().length > 0;
    const state = await api.load();
    const projects = state.projects.filter((project) => !model.archived(project));
    root.querySelector(".ws-note-task-backdrop")?.remove();
    const overlay = document.createElement("div");
    overlay.className = "module-modal-backdrop ws-note-task-backdrop";
    overlay.innerHTML = `<form class="module-modal ws-note-task-dialog"><h2>从${selected ? "选中内容" : "整篇笔记"}生成任务</h2><p class="pm-muted">预览并编辑候选项后再保存；每个任务会保留来源笔记与摘录。</p>${canUseAi ? `<div class="ws-note-task-modes" role="group" aria-label="候选来源"><button type="button" data-note-task-mode="rules">规则提取 · ${ruleCandidates.length}</button><button type="button" data-note-task-mode="ai">✨ AI 提取</button></div><p class="pm-muted ws-note-task-ai-hint" hidden>AI 提取会把${selected ? "选中的内容" : "整篇笔记"}发送到你在 AI 设置中配置的服务；受保护目录中的笔记不会发送。</p>` : ""}${!projects.length ? '<div class="module-error">请先在「项目」中新建项目。</div>' : `<label>目标项目<select name="projectId" required>${projects.map((project) => `<option value="${attr(model.value(project, "Id"))}">${esc(model.value(project, "Name"))}</option>`).join("")}</select></label><label>里程碑<select name="milestoneId"><option value="">未分配阶段</option></select></label>`}<div data-note-task-candidates></div><div class="module-error ws-note-task-error" hidden></div><div class="module-modal-actions"><button type="button" data-note-task-cancel>取消</button><button type="submit" class="module-primary">创建选中任务</button></div></form>`;
    root.append(overlay);
    const form = overlay.querySelector("form");
    const projectSelect = form.querySelector('[name="projectId"]');
    const stageSelect = form.querySelector('[name="milestoneId"]');
    const listBox = form.querySelector("[data-note-task-candidates]");
    const errorBox = form.querySelector(".ws-note-task-error");
    const submit = form.querySelector('[type="submit"]');
    const showError = (message) => { errorBox.hidden = !message; errorBox.textContent = message || ""; };

    const syncPreview = () => {
      if (!projectSelect) return;
      const marked = model.duplicateTaskCandidates(candidates.map((item, index) => ({ ...item, title: form.querySelector(`[data-title="${index}"]`)?.value || item.title })), state.tasks || [], projectSelect.value, sourcePath);
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

    function renderCandidates() {
      const busy = Boolean(aiRequest);
      form.querySelectorAll("[data-note-task-mode]").forEach((button) => {
        button.setAttribute("aria-pressed", String(button.dataset.noteTaskMode === mode));
        button.disabled = busy;
      });
      const hint = form.querySelector(".ws-note-task-ai-hint");
      if (hint) hint.hidden = mode !== "ai";
      if (busy) {
        listBox.innerHTML = '<div class="ws-note-task-busy" role="status"><span>AI 正在阅读笔记、提取任务…</span><button type="button" data-note-task-stop>停止</button></div>';
      } else if (mode === "ai" && !aiCandidates) {
        listBox.innerHTML = `<div class="ws-note-task-busy"><span>${esc(aiNotice || "AI 会识别自然语言中的待办、负责人和日期。")}</span><button type="button" class="module-primary" data-note-task-run>开始 AI 提取</button></div>`;
      } else if (!candidates.length) {
        listBox.innerHTML = '<div class="module-error">未找到可生成的内容。请选择正文或输入列表项后重试。</div>';
      } else {
        listBox.innerHTML = `${aiNotice && mode === "ai" ? `<p class="pm-muted">${esc(aiNotice)}</p>` : ""}<div class="ws-note-task-list">${candidates.map((item, index) => `<label class="ws-note-task-row"><input type="checkbox" data-candidate="${index}" checked /><input class="ws-note-task-title" data-title="${index}" maxlength="160" value="${attr(item.title)}" aria-label="候选任务 ${index + 1}" /><input type="date" class="ws-note-task-date" data-due="${index}" value="${attr(item.dueDate || "")}" aria-label="候选任务 ${index + 1} 截止日期" />${item.priority ? `<span class="ws-note-task-priority">${PRIORITY[item.priority]}</span>` : ""}</label>`).join("")}</div>`;
        form.querySelectorAll("[data-title]").forEach((input) => { input.oninput = syncPreview; });
        syncPreview();
      }
      submit.disabled = busy || !projects.length || !candidates.length || (mode === "ai" && !aiCandidates);
    }

    async function runAi() {
      if (aiRequest || !canUseAi) return;
      const requestId = `note-tasks-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      aiRequest = requestId;
      aiNotice = "";
      showError("");
      renderCandidates();
      try {
        const result = await api.aiExtract({ requestId, text, projectId: projectSelect?.value || "", sourcePath });
        if (aiRequest !== requestId || !overlay.isConnected) return;
        if (!result?.success) throw new Error(result?.error || "AI 提取失败");
        aiCandidates = result.candidates;
        candidates = aiCandidates;
        aiNotice = `AI 提取了 ${aiCandidates.length} 项任务，可修改标题和日期后创建。${result.truncated ? "笔记较长，只分析了前一部分。" : ""}`;
      } catch (error) {
        if (aiRequest !== requestId || !overlay.isConnected) return;
        aiNotice = "";
        const message = cleanError(error, "AI 提取失败");
        if (!/已停止/.test(message)) showError(`${message}。可以重试，或切换到规则提取。`);
      } finally {
        if (aiRequest === requestId) { aiRequest = ""; if (overlay.isConnected) renderCandidates(); }
      }
    }

    function stopAi() {
      if (!aiRequest) return;
      const requestId = aiRequest;
      aiRequest = "";
      aiNotice = "已停止 AI 提取。";
      void api.aiCancel?.(requestId);
      renderCandidates();
    }

    const syncStages = () => {
      const project = projects.find((entry) => model.value(entry, "Id") === projectSelect.value);
      stageSelect.innerHTML = `<option value="">未分配阶段</option>${model.list(project, "Milestones").map((stage) => `<option value="${attr(model.value(stage, "Id"))}">${esc(model.value(stage, "Name"))}</option>`).join("")}`;
      syncPreview();
    };
    if (projectSelect) { projectSelect.onchange = syncStages; syncStages(); }
    renderCandidates();
    const close = () => { stopAi(); overlay.remove(); };
    overlay.onclick = (event) => {
      if (event.target === overlay || event.target.closest("[data-note-task-cancel]")) return close();
      const modeButton = event.target.closest("[data-note-task-mode]");
      if (modeButton && !aiRequest) {
        mode = modeButton.dataset.noteTaskMode;
        candidates = mode === "ai" ? aiCandidates || [] : ruleCandidates;
        showError("");
        renderCandidates();
        if (mode === "ai" && !aiCandidates) void runAi();
      }
      if (event.target.closest("[data-note-task-run]")) void runAi();
      if (event.target.closest("[data-note-task-stop]")) stopAi();
    };
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (aiRequest) return;
      const chosen = [...form.querySelectorAll("[data-candidate]:checked")].map((box) => ({ index: Number(box.dataset.candidate), title: form.querySelector(`[data-title="${box.dataset.candidate}"]`).value.trim(), dueDate: form.querySelector(`[data-due="${box.dataset.candidate}"]`)?.value || "" }));
      if (!chosen.length) return showError("请至少选择一项任务。");
      if (chosen.some((item) => !item.title)) return showError("任务标题不能为空。");
      submit.disabled = true;
      try {
        const project = projects.find((entry) => model.value(entry, "Id") === projectSelect.value);
        if (!project) throw new Error("请选择目标项目");
        const targetProjectId = projectSelect.value;
        const payload = chosen.map((item) => {
          const candidate = candidates[item.index];
          const input = { title: item.title, projectId: targetProjectId, milestoneId: stageSelect.value, sourceNotePath: sourcePath, sourceExcerpt: candidate.excerpt || "" };
          if (item.dueDate) input.dueDate = item.dueDate;
          if (candidate.priority) input.priority = candidate.priority;
          if (candidate.fromAi) input.tags = "AI 提取";
          return input;
        });
        await api.addTasksBatch(payload);
        form.innerHTML = `<h2>已创建 ${payload.length} 项任务</h2><p class="pm-muted">整批保存成功，来源笔记与项目关联已一并保留。</p><div class="module-modal-actions"><button type="button" data-note-task-source>返回来源笔记</button><button type="button" class="module-primary" data-note-task-project>查看项目任务</button></div>`;
        form.querySelector("[data-note-task-source]").onclick = () => overlay.remove();
        form.querySelector("[data-note-task-project]").onclick = async () => { overlay.remove(); await onProjects(targetProjectId); };
      } catch (error) {
        showError(`${cleanError(error, "创建失败")}。本次未保存任何任务，可修改后安全重试。`);
        submit.disabled = false;
      }
    };
  }
  window.DMNoteTasks = { open };
})();
