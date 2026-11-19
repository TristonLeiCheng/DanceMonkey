(() => {
  const PROMPTS = [
    ["总结现状", "请用 5 条以内总结这个项目的现状：整体进度、关键成果和主要问题。"],
    ["下一步建议", "根据项目目标、里程碑和未完成任务，建议接下来最值得推进的 3 件事，并说明理由。"],
    ["风险检查", "检查这个项目的进度风险：哪些任务或里程碑可能延期？原因是什么？分别怎么应对？"],
    ["拆解成任务", "把项目目标中还没有对应任务的部分拆解成可执行任务，给出建议的截止日期和所属里程碑，并以可应用的操作列出。"],
  ];
  const PORTFOLIO_PROMPTS = [
    ["本周风险", "哪些项目本周有风险？按严重程度排序，并说明原因和建议。"],
    ["逾期与受阻", "列出所有逾期或受阻的任务，按项目分组，并给出处理建议。"],
    ["本周重点", "如果这周只能重点推进两个项目，应该选哪两个？为什么？"],
  ];
  const PORTFOLIO = "__portfolio__";
  const REVIEW_FOCUS = [
    ["整体计划", "目标、完成标准和整体计划是否合理"],
    ["进度风险", "进度风险、阻塞和应对办法"],
    ["任务拆分", "任务拆分、优先级和时间安排"],
  ];
  const SOURCES = [["tasks", "任务"], ["milestones", "里程碑"], ["updates", "进展记录"], ["notes", "笔记标题"]];
  const BRIEF = "\u0000brief";
  const FENCE = "```dm-actions";
  const STATE_TEXT = { applied: "已应用", dismissed: "已忽略", undone: "已撤销" };

  // Hide the machine-readable action block while it streams, including a partially received fence.
  function visibleText(text) {
    const source = String(text || "");
    const start = source.indexOf(FENCE);
    if (start >= 0) return source.slice(0, start).trimEnd();
    for (let length = Math.min(FENCE.length - 1, source.length); length > 0; length -= 1) {
      if (source.endsWith(FENCE.slice(0, length))) return source.slice(0, -length).trimEnd();
    }
    return source;
  }
  const cleanError = (cause, fallback) => String(cause?.message || fallback).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");

  function create({ api, esc, attr, rerender, renderMarkdown, getState, onResult, onWeeklyDraft, openNote, onNoteSaved }) {
    const { value: field, list, done } = window.DMZenModel;
    const noteReferences = window.DMNoteReferences;
    const markdown = renderMarkdown || ((text) => esc(text).replaceAll("\n", "<br>"));
    const chats = new Map();
    const loading = new Set();
    const loadingPromises = new Map();
    const loadErrors = new Map();
    const references = new Map();
    let referencePicker, streamedSources = [];
    const drafts = new Map();
    const applying = new Set();
    const include = { tasks: true, milestones: true, updates: true, notes: true };
    let busyProject = "";
    let requestId = "";
    let streamingText = "";
    let stopped = false;
    let error = "";
    let notice = "";
    let lastContext = null;
    let follow = true;
    let generation = 0;
    let unsubscribe = null;
    let brief = null;
    let briefLoaded = false;
    let briefLoading = false;
    let briefError = "";
    let briefNotice = "";
    let briefSavedPath = "";
    let reviewPicker = null;
    const saving = new Set();

    const available = () => Boolean(api.projectAi?.chat);
    const tasksOf = (projectId) => getState().tasks.filter((task) => field(task, "ProjectId") === projectId);

    // Shared per project, so a click made while history is loading waits for it instead of racing it.
    function load(projectId) {
      if (!available() || chats.has(projectId) || loadErrors.has(projectId)) return Promise.resolve();
      if (loadingPromises.has(projectId)) return loadingPromises.get(projectId);
      const startedIn = generation;
      loading.add(projectId);
      const promise = (async () => {
        try {
          const messages = await api.projectAi.history(projectId);
          if (startedIn === generation && !chats.has(projectId)) {
            chats.set(projectId, Array.isArray(messages) ? messages : []);
            if (!references.has(projectId)) references.set(projectId, noteReferences.cleanReferences([...messages].reverse().find(message => Array.isArray(message.references))?.references));
          }
        } catch (cause) {
          if (startedIn === generation && !chats.has(projectId)) loadErrors.set(projectId, cleanError(cause, "读取对话失败"));
        } finally {
          loading.delete(projectId);
          loadingPromises.delete(projectId);
          if (startedIn === generation) rerender();
        }
      })();
      loadingPromises.set(projectId, promise);
      return promise;
    }

    async function save(projectId, messages) {
      const previous = chats.get(projectId);
      const startedIn = generation;
      chats.set(projectId, messages);
      try {
        const stored = await api.projectAi.saveHistory(projectId, messages);
        if (startedIn === generation && chats.get(projectId) === messages) chats.set(projectId, stored);
      } catch (cause) {
        if (startedIn === generation && chats.get(projectId) === messages) {
          if (previous) chats.set(projectId, previous); else chats.delete(projectId);
        }
        throw cause;
      }
    }

    async function refreshSources(projectId) {
      if (!api.projectAi?.resolveReferences || busyProject) return;
      const startedIn = generation;
      await load(projectId);
      const messages = chats.get(projectId), selected = references.get(projectId) || [];
      if (!messages || startedIn !== generation) return;
      const items = [...selected, ...messages.flatMap(message => [...(message.references || []), ...(message.sources || [])])];
      if (!items.length) return;
      const key = item => JSON.stringify([item.path, item.title, item.moveVersion]);
      try {
        const resolved = await api.projectAi.resolveReferences(items, projectId);
        if (startedIn !== generation) return;
        const mapped = new Map(items.map((item, index) => [key(item), resolved[index]]));
        const update = item => {
          const next = mapped.get(key(item));
          return next ? { ...item, path: next.path, title: next.title, moveVersion: next.moveVersion } : item;
        };
        if (chats.get(projectId) === messages) chats.set(projectId, messages.map(message => ({ ...message,
          ...(message.references ? { references: message.references.map(update) } : {}),
          ...(message.sources ? { sources: message.sources.map(update) } : {}) })));
        if (references.get(projectId) === selected) references.set(projectId, selected.map(update));
        rerender();
      } catch (cause) { if (startedIn === generation) { error = cleanError(cause, '更新引用路径失败，原对话已保留'); rerender(); } }
    }

    function renderHistoryError(projectId) {
      const message = loadErrors.get(projectId);
      return message ? `<div class="module-error" role="alert">${esc(message)} <button type="button" class="pm-button" data-module-action="pm-ai-reload" ${busyProject ? "disabled" : ""}>重新读取对话</button></div>` : "";
    }

    function renderReferences(projectId) {
      if (!api.projectAi?.listNotes) return '';
      const selected = references.get(projectId) || [];
      const disabled = busyProject || !chats.has(projectId) ? 'disabled' : '';
      return `<div class="pm-ai-references" aria-label="已选参考笔记">${selected.map((item, index) => `<div class="pm-ai-reference"><span><strong>@ ${esc(item.title)}</strong><small>${esc(item.path)}</small></span><button type="button" class="pm-button" data-module-action="pm-ai-remove-reference" data-id="${index}" aria-label="移除引用 ${attr(item.title)}" ${disabled}>×</button></div>`).join('')}</div>
        <div class="pm-ai-note-tools"><button type="button" class="pm-button" data-module-action="pm-ai-mention" ${disabled}>@ 引用笔记</button><small class="pm-muted">问答引用 · 已选 ${selected.length}/8 篇 · 发送已保存的正文</small></div>
        <div class="pm-ai-note-picker" role="listbox" aria-label="选择引用笔记" hidden></div>`;
    }

    function sourceCount(key, project) {
      const tasks = tasksOf(field(project, "Id"));
      if (key === "tasks") return tasks.filter((task) => !done(task)).length;
      if (key === "milestones") return list(project, "Milestones").length;
      if (key === "updates") return Math.min(3, list(project, "Updates").length);
      return list(project, "LinkedNotes").length;
    }

    function renderAction(action, messageIndex, actionIndex, readOnly) {
      const key = `${messageIndex}:${actionIndex}`;
      const working = applying.has(action.id);
      const lock = working || readOnly ? "disabled" : "";
      const main = action.type === "create_task" ? esc(action.title) : esc(action.detail).replaceAll("\n", "<br>");
      const sub = action.type === "create_task" && action.detail ? `<small>${esc(action.detail)}</small>` : "";
      let controls = "";
      if (working) controls = '<span class="pm-ai-action-state">正在应用…</span>';
      else if (action.state === "pending" || action.state === "failed") {
        controls = readOnly ? '<span class="pm-ai-action-state">项目已归档</span>'
          : `<button type="button" class="module-primary" data-module-action="pm-ai-apply" data-id="${key}" ${lock}>${action.state === "failed" ? "重试" : "应用"}</button><button type="button" class="pm-button" data-module-action="pm-ai-dismiss" data-id="${key}" ${lock}>忽略</button>`;
      } else {
        controls = `<span class="pm-ai-action-state">${STATE_TEXT[action.state] || ""}</span>${action.state === "applied" && action.undo && !readOnly ? `<button type="button" class="pm-button" data-module-action="pm-ai-undo" data-id="${key}">撤销</button>` : ""}`;
      }
      return `<div class="pm-ai-action state-${attr(action.state)}"><div class="pm-ai-action-text"><span class="pm-ai-action-label">${esc(action.label)}</span><span>${main}</span>${sub}${action.error ? `<small class="pm-ai-action-error" role="alert">${esc(action.error)}</small>` : ""}</div><div class="pm-ai-action-buttons">${controls}</div></div>`;
    }

    function renderActions(message, index, readOnly) {
      const actions = message.actions || [];
      if (!actions.length && !message.droppedActions) return "";
      const pending = actions.filter((action) => action.state === "pending" && !applying.has(action.id)).length;
      return `<div class="pm-ai-proposals" aria-label="建议的操作">
        <div class="pm-ai-proposals-head"><span>建议的操作${actions.length ? ` · ${actions.length}` : ""}</span>${pending > 1 && !readOnly ? `<button type="button" class="pm-button" data-module-action="pm-ai-apply-all" data-id="${index}">全部应用</button>` : ""}</div>
        ${actions.map((action, actionIndex) => renderAction(action, index, actionIndex, readOnly)).join("")}
        ${message.droppedActions ? `<small class="pm-muted">另有 ${message.droppedActions} 项建议与当前项目数据不符（如任务不存在或重复），已略过。</small>` : ""}
      </div>`;
    }

    function saveControl(savedPath, busy, action, id) {
      if (!api.projectAi?.saveNote) return "";
      if (busy) return '<span class="pm-ai-action-state">正在保存…</span>';
      if (savedPath) return `<button type="button" class="pm-ai-link" data-module-action="pm-ai-open-note" data-id="${attr(savedPath)}" title="${attr(savedPath)}">已存为笔记 · 打开</button>`;
      return `<button type="button" class="pm-ai-link" data-module-action="${action}" data-id="${id}">保存为笔记</button>`;
    }

    function renderMessages(projectId, readOnly) {
      const scopeKey = projectId;
      const reviewing = /^请人物分身「/.test((chats.get(projectId) || []).at(-1)?.content || "");
      const rows = [...(chats.get(projectId) || [])];
      const streaming = busyProject === projectId;
      if (streaming) rows.push({ role: "assistant", content: visibleText(streamingText), streaming: true });
      return rows.map((message, index) => {
        const assistant = message.role === "assistant";
        return `<article class="pm-ai-message ${assistant ? "assistant" : "user"} ${message.streaming ? "streaming" : ""}">
          <div class="pm-ai-meta">${assistant ? (message.persona ? `${esc(message.persona)} · 人物分身审阅（AI 模拟）` : busyProject === projectId && message.streaming && reviewing ? "人物分身审阅中" : "项目助手") : "你"}</div>
          <div class="pm-ai-body" ${message.streaming ? "data-pm-ai-stream" : ""}>${assistant
            ? message.streaming && !message.content ? '<span class="pm-ai-thinking">正在阅读项目资料…</span>' : markdown(message.content)
            : esc(message.content).replaceAll("\n", "<br>")}</div>
          ${assistant && !message.streaming ? renderActions(message, index, readOnly) : ""}
          ${assistant && message.sources?.length ? `<div class="pm-ai-note-sources" aria-label="回答来源">${message.sources.map(source => `<button type="button" class="pm-button" data-module-action="pm-ai-source" data-id="${index}:${attr(source.id)}" title="${attr(source.path)}">[${esc(source.id)}] ${esc(source.title)}<small>${esc(source.path)}</small></button>`).join('')}</div>` : ''}
          ${!assistant && message.references?.length ? `<div class="pm-ai-sent-references">引用正文：${message.references.map(item => `${esc(item.title)}（${esc(item.path)}）`).join('、')}</div>` : ''}
          ${assistant && message.citations?.length ? `<details class="pm-ai-citations"><summary>引用的人物资料 · ${message.citations.length}</summary>${message.citations.map((citation) => `<p><strong>[${esc(citation.id)}] ${esc(citation.title)}</strong><br>${esc(citation.excerpt)}</p>`).join("")}</details>` : ""}
          ${assistant && !message.streaming ? `<div class="pm-ai-actions"><button type="button" class="pm-ai-link" data-module-action="pm-ai-copy" data-id="${index}">复制</button>${saveControl(message.savedNote, saving.has(`${scopeKey}:${index}`), "pm-ai-save-note", index)}</div>` : ""}
        </article>`;
      }).join("");
    }

    function render(project, { readOnly = false } = {}) {
      const projectId = field(project, "Id");
      if (!available()) {
        return `<section class="pm-panel pm-ai"><div class="pm-empty compact">浏览器预览不连接 AI，请在桌面版中使用项目 AI 助手。</div></section>`;
      }
      if (!chats.has(projectId)) void load(projectId);
      const messages = chats.get(projectId) || [];
      const mine = busyProject === projectId;
      const otherBusy = Boolean(busyProject) && !mine;
      const draft = drafts.get(projectId) || "";
      const chips = SOURCES.map(([key, label]) => `<button type="button" class="pm-ai-chip" aria-pressed="${include[key]}" data-module-action="pm-ai-toggle" data-id="${key}" ${busyProject ? "disabled" : ""}>${include[key] ? "✓ " : ""}${label} · ${sourceCount(key, project)}</button>`).join("");
      const contextNote = lastContext?.projectId === projectId
        ? [lastContext.truncated ? "内容较多，已按紧急程度截断" : "", lastContext.protectedNotesSkipped ? `已排除 ${lastContext.protectedNotesSkipped} 篇受保护目录笔记` : ""].filter(Boolean).join(" · ")
        : "";
      const empty = !messages.length && !mine;
      const prompts = PROMPTS.filter((_, index) => !readOnly || index < 3);
      return `<section class="pm-panel pm-ai">
        <div class="pm-panel-heading"><div><h2>项目 AI 助手</h2><p class="pm-muted">${readOnly ? "项目已归档，AI 只做分析，不提出修改。" : "根据本项目的实时数据回答。修改建议会列成操作卡片，确认后才会执行。"}</p></div>
          <div class="pm-actions">${api.projectAi.personaReview && api.personas?.list ? `<button type="button" class="pm-button" data-module-action="pm-ai-review-open" ${busyProject ? "disabled" : ""}>人物分身审阅</button>` : ""}<button type="button" class="pm-button" data-module-action="pm-ai-clear" ${busyProject || !messages.length ? "disabled" : ""}>新对话</button></div></div>
        ${renderReviewPicker(projectId)}
        ${renderHistoryError(projectId)}
        <div class="pm-ai-context" role="group" aria-label="发送给 AI 的项目资料"><span class="pm-muted">每次提问会发送：</span><span class="pm-ai-chip is-fixed">项目概况</span>${chips}</div>
        <p class="pm-muted pm-ai-privacy">发送项目字段、任务信息和关联笔记标题；只有用 @ 选中的笔记才发送正文（已保存版本）。内容会提交到你配置的 AI 服务。${contextNote ? ` ${esc(contextNote)}。` : ""}</p>
        ${loading.has(projectId) && !chats.has(projectId) ? '<div class="pm-empty compact">正在读取对话…</div>' : ""}
        ${empty ? `<div class="pm-ai-prompts">${prompts.map(([label], index) => `<button type="button" class="pm-ai-prompt" data-module-action="pm-ai-prompt" data-id="${index}" ${busyProject || !chats.has(projectId) ? "disabled" : ""}>${esc(label)}</button>`).join("")}${!readOnly ? `<button type="button" class="pm-ai-prompt" data-module-action="pm-weekly-draft" ${busyProject ? "disabled" : ""}>起草本周进展</button>` : ""}</div>` : `<div class="pm-ai-messages" role="log" aria-label="项目对话" tabindex="0">${renderMessages(projectId, readOnly)}</div>`}
        ${error ? `<div class="module-error" role="alert">${esc(error)}</div>` : ""}
        ${renderReferences(projectId)}
        <div class="pm-ai-composer">
          <label class="visually-hidden" for="pm-ai-input">向项目助手提问</label>
          <textarea id="pm-ai-input" class="pm-ai-input" rows="2" placeholder="${otherBusy ? "AI 正在处理其他请求…" : readOnly ? "问问这个项目的历史情况… 输入 @ 引用笔记" : "问问这个项目… 输入 @ 引用笔记正文"}" ${busyProject ? "disabled" : ""}>${esc(draft)}</textarea>
          <button type="button" class="module-primary pm-ai-send" data-module-action="${mine ? "pm-ai-stop" : "pm-ai-send"}" ${otherBusy || (!mine && (!draft.trim() || !chats.has(projectId))) ? "disabled" : ""}>${mine ? "停止" : "发送"}</button>
        </div>
        <small class="pm-muted pm-ai-status" role="status">${mine ? (streamingText ? "正在回复" : "正在思考") : esc(notice) || "Enter 发送 · Shift + Enter 换行"}</small>
      </section>`;
    }

    async function loadBrief() {
      if (briefLoaded || briefLoading || !api.projectAi?.getBrief) return;
      const startedIn = generation;
      briefLoading = true;
      try {
        const stored = await api.projectAi.getBrief();
        if (startedIn === generation) brief = stored || null;
      } catch (cause) { if (startedIn === generation) briefError = cleanError(cause, "读取简报失败"); }
      finally {
        briefLoading = false;
        if (startedIn === generation) { briefLoaded = true; rerender(); }
      }
    }

    function renderBrief() {
      if (!available() || !api.projectAi.brief) return "";
      if (!briefLoaded) void loadBrief();
      const mine = busyProject === BRIEF;
      const time = brief?.generatedAt ? new Date(brief.generatedAt) : null;
      const stamp = time && Number.isFinite(time.getTime()) ? `今天 ${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")} 生成` : "";
      const body = mine ? (streamingText ? markdown(visibleText(streamingText)) : '<span class="pm-ai-thinking">正在阅读所有进行中的项目…</span>')
        : brief ? markdown(brief.text) : '<p class="pm-muted">根据受阻、逾期、临近的里程碑和健康度，挑出今天最该处理的事。</p>';
      const control = mine ? '<button type="button" class="pm-button" data-module-action="pm-ai-brief-stop">停止</button>'
        : `<button type="button" class="pm-button" data-module-action="pm-ai-brief" ${busyProject ? "disabled" : ""}>${brief ? "重新生成" : "✨ 生成简报"}</button>`;
      return `<section class="pm-panel pm-brief"><div class="pm-panel-heading"><div><h2>AI 今日简报</h2><small class="pm-muted">${mine ? "正在生成" : esc([stamp, briefNotice].filter(Boolean).join(" · ") || "发送项目摘要与需要关注的事项，不含笔记")}</small></div>${control}</div>
        <div class="pm-ai-body pm-brief-body" ${mine ? "data-pm-ai-stream" : ""}>${body}</div>${brief && !mine ? `<div class="pm-ai-actions">${saveControl(briefSavedPath, saving.has("brief"), "pm-ai-brief-save", "")}</div>` : ""}${briefError ? `<div class="module-error" role="alert">${esc(briefError)}</div>` : ""}</section>`;
    }

    function renderPortfolio() {
      if (!available()) return "";
      if (!chats.has(PORTFOLIO)) void load(PORTFOLIO);
      const messages = chats.get(PORTFOLIO) || [];
      const mine = busyProject === PORTFOLIO;
      const otherBusy = Boolean(busyProject) && !mine;
      const draft = drafts.get(PORTFOLIO) || "";
      const contextNote = lastContext?.projectId === PORTFOLIO && lastContext.truncated ? `项目较多，本次只包含前 ${lastContext.included} 个项目的详情。` : "";
      const empty = !messages.length && !mine;
      return `<section class="pm-panel pm-ai pm-portfolio">
        <div class="pm-panel-heading"><div><h2>问问所有项目</h2><p class="pm-muted">根据所有进行中项目的摘要和重点任务回答，只做分析，不修改数据。${esc(contextNote)}</p></div>
          <button type="button" class="pm-button" data-module-action="pm-ai-clear" ${busyProject || !messages.length ? "disabled" : ""}>新对话</button></div>
        ${renderHistoryError(PORTFOLIO)}
        ${empty ? `<div class="pm-ai-prompts">${PORTFOLIO_PROMPTS.map(([label], index) => `<button type="button" class="pm-ai-prompt" data-module-action="pm-ai-prompt" data-id="${index}" ${busyProject || !chats.has(PORTFOLIO) ? "disabled" : ""}>${esc(label)}</button>`).join("")}</div>`
          : `<div class="pm-ai-messages" role="log" aria-label="项目组合对话" tabindex="0">${renderMessages(PORTFOLIO, true)}</div>`}
        ${error ? `<div class="module-error" role="alert">${esc(error)}</div>` : ""}
        ${renderReferences(PORTFOLIO)}
        <div class="pm-ai-composer">
          <label class="visually-hidden" for="pm-ai-input">向项目组合助手提问</label>
          <textarea id="pm-ai-input" class="pm-ai-input" rows="2" placeholder="${otherBusy ? "AI 正在处理其他请求…" : "问问所有项目… 输入 @ 引用笔记正文"}" ${busyProject ? "disabled" : ""}>${esc(draft)}</textarea>
          <button type="button" class="module-primary pm-ai-send" data-module-action="${mine ? "pm-ai-stop" : "pm-ai-send"}" ${otherBusy || (!mine && (!draft.trim() || !chats.has(PORTFOLIO))) ? "disabled" : ""}>${mine ? "停止" : "发送"}</button>
        </div>
        <small class="pm-muted pm-ai-status" role="status">${mine ? (streamingText ? "正在回复" : "正在思考") : esc(notice) || "Enter 发送 · Shift + Enter 换行"}</small>
      </section>`;
    }

    function updateStreamingDom() {
      const body = document.querySelector("[data-pm-ai-stream]");
      const shown = visibleText(streamingText);
      if (body && shown) body.innerHTML = markdown(shown);
      const status = document.querySelector(".pm-ai-status");
      if (status && busyProject !== BRIEF) status.textContent = streamingText ? "正在回复" : "正在思考";
      const box = document.querySelector(".pm-ai-messages");
      if (box && follow) box.scrollTop = box.scrollHeight;
    }

    function beginRequest(owner) {
      referencePicker?.hide();
      streamedSources = [];
      busyProject = owner;
      requestId = `pm-ai-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      streamingText = "";
      stopped = false;
      const own = requestId;
      unsubscribe?.();
      unsubscribe = api.ai?.onChunk?.((payload) => {
        if (payload?.requestId !== own) return;
        if (payload.sources) streamedSources = noteReferences.cleanSources(payload.sources);
        if (typeof payload.chunk !== 'string') return;
        streamingText += payload.chunk;
        updateStreamingDom();
      });
      return own;
    }
    function endRequest(startedIn) {
      unsubscribe?.();
      unsubscribe = null;
      if (startedIn !== generation) return false;
      busyProject = "";
      requestId = "";
      streamingText = "";
      return true;
    }

    // One user turn: save the question, stream the reply, then append the reply to the latest history.
    async function runTurn(projectId, question, { request, toReply, failure = "回复未完成，请重试。", restoreDraft = true, selectedNotes }) {
      // Starting before the stored history has loaded would overwrite it with this single turn.
      if (!question || busyProject || !available() || !chats.has(projectId)) return;
      const startedIn = generation;
      const history = [...(chats.get(projectId) || []), { role: "user", content: question, ...(selectedNotes ? { references: selectedNotes } : {}) }];
      const own = beginRequest(projectId);
      error = "";
      notice = "";
      follow = true;
      if (restoreDraft) drafts.delete(projectId);
      let saved = false;
      try {
        await save(projectId, history);
        saved = true;
        rerender();
        if (stopped) return;
        const result = await request(own, history);
        if (startedIn !== generation) return;
        if (!result?.success && !stopped) throw new Error(result?.error || failure);
        const reply = toReply(result?.success ? result : null);
        // Append to the latest copy: action cards on earlier replies may have changed while this one streamed.
        if (reply.content.trim()) await save(projectId, [...(chats.get(projectId) || history), reply]);
        notice = stopped ? (reply.content.trim() ? "已停止 · 已保留生成内容" : "已停止") : reply.actions ? `AI 提出了 ${reply.actions.length} 项操作，确认后才会执行` : "";
      } catch (cause) {
        if (startedIn !== generation) return;
        if (!saved && restoreDraft) drafts.set(projectId, question);
        error = cleanError(cause, failure);
      } finally {
        if (endRequest(startedIn)) {
          rerender();
          requestAnimationFrame(() => document.querySelector(".pm-ai-input")?.focus());
        }
      }
    }

    function send(projectId, text) {
      const selectedNotes = (references.get(projectId) || []).map(item => ({ ...item }));
      return runTurn(projectId, String(text || "").trim(), {
        selectedNotes,
        request: async (own, history) => {
          const result = await api.projectAi.chat(projectId === PORTFOLIO
            ? { requestId: own, projectId, scope: "portfolio", messages: history, references: selectedNotes.map(item => item.path), referenceItems: selectedNotes }
            : { requestId: own, projectId, include: { ...include }, messages: history, references: selectedNotes.map(item => item.path), referenceItems: selectedNotes });
          if (result?.context) lastContext = { projectId, ...result.context };
          return result;
        },
        toReply: (result) => {
          const reply = { role: "assistant", content: result ? result.text || visibleText(streamingText) : visibleText(streamingText) };
          reply.sources = noteReferences.cleanSources(result?.sources || streamedSources);
          if (result?.actions?.length) reply.actions = result.actions;
          if (result?.droppedActions) reply.droppedActions = result.droppedActions;
          return reply;
        },
      });
    }

    function startReview(projectId) {
      const picker = reviewPicker;
      const persona = picker?.personas?.find((entry) => entry.id === picker.personaId);
      if (!persona || picker.projectId !== projectId) return;
      const focus = REVIEW_FOCUS[Number(picker.focus)] || REVIEW_FOCUS[0];
      reviewPicker = null;
      return runTurn(projectId, `请人物分身「${persona.name}」审阅这个项目，重点：${focus[1]}。`, {
        restoreDraft: false,
        failure: "人物审阅未完成，请重试。",
        request: (own) => api.projectAi.personaReview({ requestId: own, projectId, personaId: persona.id, focus: focus[1] }),
        toReply: (result) => {
          const reply = { role: "assistant", content: result ? result.text : streamingText, persona: persona.name };
          if (result?.citations?.length) reply.citations = result.citations.map(({ id, title, excerpt }) => ({ id, title, excerpt }));
          return reply;
        },
      });
    }

    async function openReview(projectId) {
      if (busyProject) return;
      const startedIn = generation;
      reviewPicker = { projectId, personas: null, personaId: "", focus: "0", error: "" };
      rerender();
      try {
        const list = (await api.personas.list()).filter((entry) => entry.hasCard);
        if (startedIn !== generation || reviewPicker?.projectId !== projectId) return;
        reviewPicker.personas = list;
        reviewPicker.personaId = list[0]?.id || "";
      } catch (cause) {
        if (startedIn === generation && reviewPicker) { reviewPicker.personas = []; reviewPicker.error = cleanError(cause, "读取人物分身失败"); }
      }
      if (startedIn === generation) rerender();
    }

    function renderReviewPicker(projectId) {
      if (reviewPicker?.projectId !== projectId) return "";
      const { personas, personaId, focus } = reviewPicker;
      const body = !personas ? '<span class="pm-muted">正在读取人物分身…</span>'
        : !personas.length ? `<span class="pm-muted">${esc(reviewPicker.error || "还没有已生成人物卡的人物分身。请先在「人物分身」中导入资料并保存人物卡。")}</span>`
        : `<label>人物分身<select data-pm-review="persona">${personas.map((entry) => `<option value="${attr(entry.id)}" ${entry.id === personaId ? "selected" : ""}>${esc(entry.name)}</option>`).join("")}</select></label>
           <label>审阅重点<select data-pm-review="focus">${REVIEW_FOCUS.map(([label], index) => `<option value="${index}" ${String(index) === focus ? "selected" : ""}>${esc(label)}</option>`).join("")}</select></label>
           <button type="button" class="module-primary" data-module-action="pm-ai-review-start">开始审阅</button>`;
      return `<div class="pm-ai-review" role="group" aria-label="人物分身审阅">${body}<button type="button" class="pm-button" data-module-action="pm-ai-review-close">取消</button>
        <small class="pm-muted">会把项目概况、任务、里程碑和最近进展交给所选人物分身，以其判断方式审阅（AI 模拟，不代表本人）。不会写入人物的对话记录。</small></div>`;
    }

    async function generateBrief() {
      if (busyProject || !api.projectAi?.brief) return;
      const startedIn = generation;
      const own = beginRequest(BRIEF);
      briefError = "";
      briefNotice = "";
      rerender();
      try {
        const result = await api.projectAi.brief({ requestId: own });
        if (startedIn !== generation) return;
        if (result?.success) { brief = result.brief; briefLoaded = true; briefSavedPath = ""; briefNotice = result.petNotified ? "已推送到桌面宠物" : ""; }
        else if (stopped) briefNotice = "已停止，保留上一次的简报";
        else throw new Error(result?.error || "生成简报失败，请重试。");
      } catch (cause) {
        if (startedIn === generation) briefError = cleanError(cause, "生成简报失败，请重试。");
      } finally {
        if (endRequest(startedIn)) rerender();
      }
    }

    function stop() {
      if (!busyProject) return;
      stopped = true;
      if (requestId) void (api.projectAi?.cancel || api.ai?.cancel)?.(requestId);
    }

    async function updateAction(projectId, messageIndex, actionIndex, patch) {
      const messages = (chats.get(projectId) || []).map((message, index) => index !== messageIndex ? message
        : { ...message, actions: message.actions.map((action, position) => position === actionIndex ? { ...action, ...patch } : action) });
      await save(projectId, messages);
    }

    async function applyOne(projectId, messageIndex, actionIndex) {
      const action = chats.get(projectId)?.[messageIndex]?.actions?.[actionIndex];
      if (!action || !["pending", "failed"].includes(action.state) || applying.has(action.id)) return false;
      const startedIn = generation;
      applying.add(action.id);
      rerender();
      try {
        const { label, summary, detail, state, error: _error, undo, id, ...payload } = action;
        const result = await api.projectAi.applyAction(projectId, payload);
        if (startedIn !== generation) return false;
        await onResult?.(result.state);
        await updateAction(projectId, messageIndex, actionIndex, { state: "applied", undo: result.undo || null, error: "" });
        return true;
      } catch (cause) {
        if (startedIn === generation) await updateAction(projectId, messageIndex, actionIndex, { state: "failed", error: cleanError(cause, "应用失败") }).catch(() => {});
        return false;
      } finally {
        applying.delete(action.id);
        if (startedIn === generation) rerender();
      }
    }

    function noteTitle(scopeId, project, index) {
      const question = [...(chats.get(scopeId) || []).slice(0, index)].reverse().find((message) => message.role === "user")?.content || "AI 分析";
      const topic = question.replace(/\s+/g, " ").trim().slice(0, 24);
      return `${project ? field(project, "Name") : "项目组合"}：${topic}`;
    }

    async function saveNote(input) {
      const result = await api.projectAi.saveNote(input);
      if (result?.linked) await onResult?.(result.state);
      await onNoteSaved?.();
      notice = result?.linked ? `已保存到「${result.path}」，并关联到项目资料` : `已保存到「${result.path}」`;
      return result.path;
    }

    async function handleAction(action, id, project) {
      if (action === "pm-ai-brief") { void generateBrief(); return true; }
      if (action === "pm-ai-brief-stop") { if (busyProject === BRIEF) stop(); return true; }
      if (action === "pm-ai-open-note") { if (id) await openNote?.(id); return true; }
      if (action === "pm-ai-brief-save") {
        if (!brief || saving.has("brief")) return true;
        const startedIn = generation;
        saving.add("brief");
        rerender();
        try {
          const savedPath = await saveNote({ title: `今日简报 ${brief.date}`, body: brief.text, kind: "digest" });
          if (startedIn === generation) { briefSavedPath = savedPath; briefNotice = "已保存为笔记"; }
        } catch (cause) { if (startedIn === generation) briefError = cleanError(cause, "保存笔记失败"); }
        finally { saving.delete("brief"); if (startedIn === generation) rerender(); }
        return true;
      }
      const projectId = project ? field(project, "Id") : PORTFOLIO;
      const prompts = project ? PROMPTS : PORTFOLIO_PROMPTS;
      const [messageIndex, actionIndex] = String(id).split(":").map(Number);
      if (action === 'pm-ai-mention') referencePicker?.trigger();
      if (action === 'pm-ai-remove-reference' && !busyProject) {
        references.set(projectId, (references.get(projectId) || []).filter((_item, index) => index !== Number(id)));
        rerender();
      }
      if (action === 'pm-ai-source') {
        const source = chats.get(projectId)?.[messageIndex]?.sources?.find(item => item.id === String(id).split(':')[1]);
        const startedIn = generation;
        if (source) try {
          const resolved = api.projectAi.resolveReferences ? (await api.projectAi.resolveReferences([source], projectId))[0] : source;
          if (startedIn !== generation) return true;
          await openNote?.(resolved.path);
        } catch (cause) { if (startedIn === generation) { error = cleanError(cause, '打开来源笔记失败'); rerender(); } }
      }
      if (action === "pm-ai-reload" && !busyProject) {
        loadErrors.delete(projectId);
        await load(projectId);
      }
      if (action === "pm-ai-send") { const text = document.querySelector(".pm-ai-input")?.value ?? drafts.get(projectId); await load(projectId); void send(projectId, text); }
      if (action === "pm-ai-prompt" && prompts[Number(id)]) { await load(projectId); void send(projectId, prompts[Number(id)][1]); }
      if (action === "pm-ai-save-note") {
        await refreshSources(projectId);
        const index = Number(id);
        const message = chats.get(projectId)?.[index];
        const key = `${projectId}:${index}`;
        if (message?.role === "assistant" && !message.savedNote && !saving.has(key)) {
          const startedIn = generation;
          saving.add(key);
          rerender();
          try {
            const savedPath = await saveNote({ projectId: project ? projectId : "", title: noteTitle(projectId, project, index), body: message.content, sources: message.sources, kind: "insight" });
            if (startedIn === generation) {
              const messages = (chats.get(projectId) || []).map((entry, position) => position === index ? { ...entry, savedNote: savedPath } : entry);
              await save(projectId, messages);
            }
          } catch (cause) { if (startedIn === generation) error = cleanError(cause, "保存笔记失败"); }
          finally { saving.delete(key); if (startedIn === generation) rerender(); }
        }
      }
      if (action === "pm-ai-stop" && busyProject === projectId) stop();
      if (action === "pm-ai-toggle" && Object.hasOwn(include, id) && !busyProject) { include[id] = !include[id]; rerender(); }
      if (action === "pm-ai-clear" && !busyProject && chats.has(projectId)) {
        try { await save(projectId, []); references.delete(projectId); error = ""; notice = "已开始新对话"; }
        catch (cause) { error = cleanError(cause, "清空对话失败"); }
        rerender();
      }
      if (action === "pm-ai-copy") {
        await refreshSources(projectId);
        const message = (chats.get(projectId) || [])[Number(id)];
        if (message) {
          try { await navigator.clipboard.writeText(noteReferences.withLinks(message.content, message.sources || [])); notice = "已复制回复及来源"; }
          catch { error = "复制失败，请手动选择文本。"; }
          rerender();
        }
      }
      if (action === "pm-ai-review-open" && project) void openReview(projectId);
      if (action === "pm-ai-review-close") { reviewPicker = null; rerender(); }
      if (action === "pm-ai-review-start") { await load(projectId); void startReview(projectId); }
      if (action === "pm-ai-apply") await applyOne(projectId, messageIndex, actionIndex);
      if (action === "pm-ai-apply-all") {
        const actions = chats.get(projectId)?.[messageIndex]?.actions || [];
        for (let index = 0; index < actions.length; index += 1) {
          if (chats.get(projectId)?.[messageIndex]?.actions?.[index]?.state !== "pending") continue;
          if (!(await applyOne(projectId, messageIndex, index))) break;
        }
      }
      if (action === "pm-ai-dismiss") {
        const target = chats.get(projectId)?.[messageIndex]?.actions?.[actionIndex];
        if (target && ["pending", "failed"].includes(target.state) && !applying.has(target.id)) {
          await updateAction(projectId, messageIndex, actionIndex, { state: "dismissed", error: "" });
          rerender();
        }
      }
      if (action === "pm-ai-undo") {
        const target = chats.get(projectId)?.[messageIndex]?.actions?.[actionIndex];
        if (target?.state === "applied" && target.undo && !applying.has(target.id)) {
          const startedIn = generation;
          applying.add(target.id);
          rerender();
          try {
            const state = await api.projectAi.undoAction(projectId, target.undo);
            if (startedIn !== generation) return true;
            await onResult?.(state);
            await updateAction(projectId, messageIndex, actionIndex, { state: "undone", undo: null, error: "" });
          } catch (cause) {
            if (startedIn === generation) await updateAction(projectId, messageIndex, actionIndex, { error: cleanError(cause, "撤销失败") }).catch(() => {});
          } finally {
            applying.delete(target.id);
            if (startedIn === generation) rerender();
          }
        }
      }
      if (action === "pm-weekly-draft") onWeeklyDraft?.();
      return true;
    }

    function bind(scope, project) {
      referencePicker?.destroy(); referencePicker = null;
      const projectId = project ? field(project, "Id") : PORTFOLIO;
      const box = scope.querySelector(".pm-ai-messages");
      if (box) {
        box.onscroll = () => { follow = box.scrollHeight - box.scrollTop - box.clientHeight < 64; };
        if (follow) requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
      }
      scope.querySelectorAll("[data-pm-review]").forEach((select) => {
        select.onchange = () => { if (!reviewPicker) return; if (select.dataset.pmReview === "persona") reviewPicker.personaId = select.value; else reviewPicker.focus = select.value; };
      });
      const input = scope.querySelector(".pm-ai-input");
      if (!input) return;
      const pickerBox = scope.querySelector('.pm-ai-note-picker');
      if (pickerBox && api.projectAi?.listNotes) referencePicker = noteReferences.createPicker({ input, box: pickerBox,
        search: query => api.projectAi.listNotes(query), selected: () => references.get(projectId) || [],
        disabled: () => Boolean(busyProject) || !chats.has(projectId),
        onDraft: value => { drafts.set(projectId, value); }, onError: message => { error = message; rerender(); },
        onChoose: (item, value, cursor) => {
          references.set(projectId, [...(references.get(projectId) || []), item]); drafts.set(projectId, value); rerender();
          const next = document.querySelector('.pm-ai-input'); next?.focus(); next?.setSelectionRange(cursor, cursor);
        } });
      input.oninput = () => {
        drafts.set(projectId, input.value);
        void referencePicker?.update();
        const button = scope.querySelector('[data-module-action="pm-ai-send"]');
        if (button) button.disabled = !input.value.trim() || Boolean(busyProject) || !chats.has(projectId);
      };
      input.onkeydown = (event) => {
        if (event.isComposing || event.keyCode === 229) return;
        if (referencePicker?.handleKey(event)) return;
        if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(projectId, input.value); }
      };
    }

    // Vault switches invalidate every cached conversation and abandon any in-flight reply.
    function reset() {
      referencePicker?.destroy(); referencePicker = null; references.clear(); streamedSources = [];
      stop();
      generation += 1;
      chats.clear();
      loading.clear();
      loadingPromises.clear();
      loadErrors.clear();
      drafts.clear();
      applying.clear();
      busyProject = "";
      requestId = "";
      streamingText = "";
      error = "";
      notice = "";
      lastContext = null;
      brief = null;
      briefLoaded = false;
      briefLoading = false;
      briefError = "";
      briefNotice = "";
      briefSavedPath = "";
      reviewPicker = null;
      saving.clear();
      unsubscribe?.();
      unsubscribe = null;
    }

    return { render, renderBrief, renderPortfolio, handleAction, bind, reset, stop, refreshSources, isBusy: () => Boolean(busyProject) };
  }

  window.DMProjectAIPanel = { create, visibleText };
})();
