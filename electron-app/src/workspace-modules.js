(() => {
  function field(item, name, fallback = "") {
    const camel = name[0].toLowerCase() + name.slice(1);
    return item?.[name] ?? item?.[camel] ?? fallback;
  }

  function dateValue(value) {
    return value ? String(value).slice(0, 10) : "";
  }

  function priority(task) {
    const impact = Number(field(task, "Impact", 3));
    const urgency = Number(field(task, "Urgency", 3));
    if (impact >= 4 && urgency >= 4) return ["Urgent & Important", "Q1 紧急重要", "q1"];
    if (impact >= 4) return ["Not Urgent & Important", "Q2 重要不紧急", "q2"];
    if (urgency >= 4) return ["Urgent & Not Important", "Q3 紧急不重要", "q3"];
    return ["Medium", "Q4 常规", "q4"];
  }

  function create(api, helpers) {
    const { esc, attr, rerender } = helpers;
    let tasks = [];
    let projects = [];
    let links = [];
    let syncProfiles = [];
    let syncSelectedId = "";
    let syncDraft = null;
    let syncPreview = null;
    let syncLog = "";
    let syncStatus = "";
    let syncBusy = false;
    let syncError = "";
    let query = "";
    let taskFilter = "open";
    let linkFilter = "all";
    let linkSort = "pinned";
    let modal = null;
    let error = "";
    let aiSettings = null;
    let aiMessages = [];
    let aiDraft = "";
    let aiBusy = false;
    let aiStreamingText = "";
    let aiRequestId = null;
    let aiError = "";
    let aiSnippet = "";
    let unsubscribeChunk = null;
    let unsubscribeSyncProgress = null;
    let appSettings = null;
    let settingsMessage = "";
    let settingsError = "";
    let updateInfo = { currentVersion: "", installDirectory: "" };
    let updateStatus = "";
    let updateBusy = false;
    let unsubscribeUpdateProgress = null;

    const AI_PROMPTS = [
      ["总结要点", "请用条目总结下面内容的核心结论与待办：\n\n"],
      ["拆解任务", "请把下面目标拆成可执行任务，标注优先级与依赖：\n\n"],
      ["润色表达", "请把下面文字润色得更清晰专业，保留原意：\n\n"],
      ["写周报", "请根据下面工作记录写一份简洁周报（本周完成 / 风险 / 下周计划）：\n\n"],
    ];

    function blankSyncDraft(partial = {}) {
      return {
        id: "",
        name: "",
        masterPath: "",
        slavePath: "",
        mode: "masterToSlave",
        enabled: true,
        deleteExtraFiles: false,
        trashRetentionDays: 30,
        conflictPolicy: "keepConflictCopy",
        autoSyncEnabled: false,
        autoSyncIntervalMinutes: 30,
        excludePatterns: "*.tmp;~$*;.DS_Store;Thumbs.db",
        lastRunAt: null,
        lastStatus: "",
        ...partial,
      };
    }

    async function loadZen() {
      const state = await api.zenTask.load();
      tasks = state.tasks || [];
      projects = state.projects || [];
    }

    async function loadLinks() {
      links = await api.quickAccess.list();
    }

    async function loadSync() {
      if (!api.folderSync?.list) {
        syncProfiles = [];
        return;
      }
      syncProfiles = await api.folderSync.list();
      if (!syncDraft) {
        const selected = syncProfiles.find((item) => item.id === syncSelectedId) || syncProfiles[0];
        syncSelectedId = selected?.id || "";
        syncDraft = selected ? { ...selected } : blankSyncDraft();
      }
    }

    async function loadAi() {
      if (api.ai?.getSettings) {
        aiSettings = await api.ai.getSettings();
      }
      if (api.getState) {
        const state = await api.getState();
        aiMessages = Array.isArray(state.aiMessages) ? state.aiMessages : [];
      }
    }

    async function loadAppSettings() {
      if (api.settings?.get) {
        appSettings = await api.settings.get();
      }
      if (api.appUpdate?.info) {
        try {
          updateInfo = await api.appUpdate.info();
        } catch {
          updateInfo = { currentVersion: "", installDirectory: "" };
        }
      }
      if (!unsubscribeUpdateProgress && api.appUpdate?.onProgress) {
        unsubscribeUpdateProgress = api.appUpdate.onProgress((payload) => {
          updateStatus = payload?.message || updateStatus;
          const el = document.querySelector(".ws-settings-update-status");
          if (el) el.textContent = updateStatus;
        });
      }
    }

    async function loadAll() {
      await Promise.all([loadZen(), loadLinks(), loadSync(), loadAi(), loadAppSettings()]);
      if (!unsubscribeSyncProgress && api.folderSync?.onProgress) {
        unsubscribeSyncProgress = api.folderSync.onProgress((payload) => {
          if (payload?.profileId && payload.profileId !== syncSelectedId) return;
          syncStatus = payload.statusText || syncStatus;
          if (payload.isCompleted || payload.isCancelled) {
            syncBusy = false;
            void loadSync().then(() => {
              const selected = syncProfiles.find((item) => item.id === syncSelectedId);
              if (selected) syncDraft = { ...selected };
              rerender();
            });
            return;
          }
          const statusEl = document.querySelector(".sync-status");
          if (statusEl) statusEl.textContent = syncStatus;
        });
      }
    }

    async function persistAiMessages(messages) {
      aiMessages = messages;
      if (api.setState) await api.setState({ aiMessages: messages });
    }

    function renderMarkdown(value) {
      if (!value) return "";
      if (window.marked && window.DOMPurify) {
        return window.DOMPurify.sanitize(window.marked.parse(value));
      }
      return esc(value).replaceAll("\n", "<br>");
    }

    function updateStreamingDom() {
      const body = document.querySelector(".ws-ai-message.streaming .ws-ai-message-body");
      if (body) body.innerHTML = renderMarkdown(aiStreamingText);
      const status = document.querySelector(".ws-ai-status");
      if (status) status.textContent = aiBusy ? "正在生成…" : `${aiMessages.length} 条消息`;
    }

    function projectName(id) {
      return field(projects.find((item) => field(item, "Id") === id), "Name", "未分配");
    }

    function isDone(task) {
      return ["Completed", "Done"].includes(field(task, "WorkflowStatus"));
    }

    function filteredTasks() {
      const text = query.trim().toLowerCase();
      return tasks.filter((task) => {
        if (taskFilter === "open" && isDone(task)) return false;
        if (taskFilter === "done" && !isDone(task)) return false;
        if (!text) return true;
        return [
          field(task, "Title"),
          field(task, "Project"),
          field(task, "Tags"),
          field(task, "Notes"),
        ].some((value) => String(value).toLowerCase().includes(text));
      });
    }

    function taskStats() {
      const open = tasks.filter((task) => !isDone(task));
      const overdue = open.filter((task) => {
        const due = dateValue(field(task, "DueDate"));
        return due && due < new Date().toISOString().slice(0, 10);
      });
      return {
        total: tasks.length,
        open: open.length,
        done: tasks.length - open.length,
        urgent: open.filter((task) => priority(task)[2] === "q1").length,
        overdue: overdue.length,
      };
    }

    function renderStats() {
      const stats = taskStats();
      return `<div class="module-stats">
        <div><strong>${stats.open}</strong><span>进行中</span></div>
        <div><strong>${stats.urgent}</strong><span>紧急重要</span></div>
        <div><strong>${stats.overdue}</strong><span>已逾期</span></div>
        <div><strong>${stats.done}</strong><span>已完成</span></div>
      </div>`;
    }

    function renderTasks() {
      const rows = filteredTasks()
        .map((task) => {
          const id = field(task, "Id");
          const [, label, level] = priority(task);
          const due = dateValue(field(task, "DueDate"));
          return `<article class="task-card ${isDone(task) ? "done" : ""}">
            <button class="task-check ${isDone(task) ? "checked" : ""}" data-module-action="toggle-task" data-id="${attr(id)}" title="切换完成"></button>
            <div class="task-content">
              <div class="task-title">${esc(field(task, "Title", "未命名任务"))}</div>
              <div class="task-meta">
                <span>${esc(field(task, "Project", "Unassigned"))}</span>
                <span class="priority ${level}">${label}</span>
                <span>${esc(field(task, "RaciRole", "Responsible"))}</span>
                <span>能量 ${esc(field(task, "EnergyLevel", "Medium"))}</span>
                ${due ? `<span>截止 ${esc(due)}</span>` : ""}
              </div>
              ${field(task, "Notes") ? `<p>${esc(field(task, "Notes"))}</p>` : ""}
            </div>
            <div class="module-row-actions visible">
              <button data-module-action="edit-task" data-id="${attr(id)}">编辑</button>
              <button class="danger" data-module-action="delete-task" data-id="${attr(id)}">删除</button>
            </div>
          </article>`;
        })
        .join("");
      return `<section class="module-page">
        <div class="module-heading">
          <div><h1>Zen Task</h1><p>战略任务、优先级、责任与能量管理</p></div>
          <button class="module-primary" data-module-action="add-task">＋ 新建任务</button>
        </div>
        ${renderStats()}
        <div class="module-toolbar">
          <input class="module-search" value="${attr(query)}" placeholder="搜索任务、项目或标签" />
          <div class="module-segments">
            ${[["open", "进行中"], ["all", "全部"], ["done", "已完成"]].map(([key, label]) => `<button class="${taskFilter === key ? "active" : ""}" data-module-action="task-filter" data-value="${key}">${label}</button>`).join("")}
          </div>
        </div>
        <div class="task-list">${rows || '<div class="module-empty">当前筛选下没有任务</div>'}</div>
      </section>`;
    }

    function renderProjects() {
      const cards = projects
        .map((project) => {
          const id = field(project, "Id");
          const associated = tasks.filter((task) => field(task, "ProjectId") === id);
          const calculated = associated.length
            ? Math.round((associated.filter(isDone).length / associated.length) * 100)
            : Number(field(project, "Progress", 0));
          return `<article class="project-card">
            <div class="project-card-head">
              <span class="project-icon">◎</span>
              <span class="priority ${String(field(project, "Priority", "Medium")).toLowerCase()}">${esc(field(project, "Priority", "Medium"))}</span>
            </div>
            <h2>${esc(field(project, "Name", "未命名项目"))}</h2>
            <p>${esc(field(project, "Description", "暂无项目说明"))}</p>
            <div class="project-progress"><span style="width:${Math.max(0, Math.min(100, calculated))}%"></span></div>
            <div class="project-footer"><span>${calculated}% · ${associated.length} 个任务</span><span>${esc(field(project, "Status", "On Track"))}</span></div>
            <div class="module-row-actions visible">
              <button data-module-action="project-tasks" data-id="${attr(id)}">查看任务</button>
              <button data-module-action="edit-project" data-id="${attr(id)}">编辑</button>
              <button class="danger" data-module-action="delete-project" data-id="${attr(id)}">删除</button>
            </div>
          </article>`;
        })
        .join("");
      return `<section class="module-page">
        <div class="module-heading">
          <div><h1>项目管理</h1><p>连接项目目标与 Zen Task 执行进度</p></div>
          <button class="module-primary" data-module-action="add-project">＋ 新建项目</button>
        </div>
        <div class="projects-grid">${cards || '<div class="module-empty">还没有项目</div>'}</div>
      </section>`;
    }

    function filteredLinks() {
      const text = query.trim().toLowerCase();
      return links
        .filter((link) => linkFilter === "all" || (linkFilter === "pinned" ? link.pinned : link.category === linkFilter))
        .filter((link) => !text || `${link.name} ${link.path} ${link.description} ${link.group}`.toLowerCase().includes(text))
        .sort((a, b) => {
          if (linkSort === "clicks") return (b.clickCount || 0) - (a.clickCount || 0) || a.name.localeCompare(b.name, "zh-CN");
          if (linkSort === "name") return a.name.localeCompare(b.name, "zh-CN");
          if (linkSort === "recent") {
            return String(b.lastClicked || "").localeCompare(String(a.lastClicked || "")) || a.name.localeCompare(b.name, "zh-CN");
          }
          return Number(b.pinned) - Number(a.pinned) || (b.clickCount || 0) - (a.clickCount || 0) || a.name.localeCompare(b.name, "zh-CN");
        });
    }

    function canSyncFromLink(link) {
      return link && !/^https?:\/\//i.test(link.path || "") && ["local", "network", "onedrive"].includes(link.category);
    }

    function renderQuickAccess() {
      const cards = filteredLinks()
        .map((link) => `<article class="quick-card">
          <button class="quick-open" data-module-action="open-link" data-id="${attr(link.id)}">
            <span class="quick-icon">${link.category === "web" ? "◎" : link.category === "sharepoint" ? "◇" : link.category === "onedrive" ? "☁" : link.category === "network" ? "⧉" : "▣"}</span>
            <span><strong>${esc(link.name)}</strong><small>${esc(link.description || link.path)}</small></span>
          </button>
          <div class="quick-meta">${link.pinned ? "已置顶 · " : ""}${link.detected ? "系统探测 · " : ""}${link.clickCount ? `${link.clickCount} 次 · ` : ""}${esc(link.group || link.category)}</div>
          <div class="module-row-actions visible">
            ${link.detected ? "" : `<button data-module-action="pin-link" data-id="${attr(link.id)}">${link.pinned ? "取消置顶" : "置顶"}</button>
            <button data-module-action="edit-link" data-id="${attr(link.id)}">编辑</button>
            <button class="danger" data-module-action="delete-link" data-id="${attr(link.id)}">删除</button>`}
            ${canSyncFromLink(link) ? `<button data-module-action="create-sync-from-link" data-id="${attr(link.id)}">创建同步</button>` : ""}
          </div>
        </article>`)
        .join("");
      return `<section class="module-page">
        <div class="module-heading">
          <div><h1>快速访问</h1><p>本地文件夹、OneDrive、网络路径和网页入口</p></div>
          <div class="ws-ai-heading-actions">
            <button type="button" data-module-action="refresh-links">刷新探测</button>
            <button class="module-primary" data-module-action="add-link">＋ 添加入口</button>
          </div>
        </div>
        <div class="module-toolbar">
          <input class="module-search" value="${attr(query)}" placeholder="搜索名称、路径或分组" />
          <div class="module-segments">
            ${[["all", "全部"], ["pinned", "置顶"], ["local", "本地"], ["onedrive", "OneDrive"], ["network", "网络"], ["sharepoint", "SharePoint"], ["web", "网页"]].map(([key, label]) => `<button class="${linkFilter === key ? "active" : ""}" data-module-action="link-filter" data-value="${key}">${label}</button>`).join("")}
          </div>
          <div class="module-segments">
            ${[["pinned", "常用"], ["clicks", "点击"], ["recent", "最近"], ["name", "名称"]].map(([key, label]) => `<button class="${linkSort === key ? "active" : ""}" data-module-action="link-sort" data-value="${key}">${label}</button>`).join("")}
          </div>
        </div>
        <div class="quick-grid">${cards || '<div class="module-empty">当前筛选下没有入口</div>'}</div>
      </section>`;
    }

    function modeLabel(mode) {
      return mode === "twoWay" ? "完全同步" : "主从单向";
    }

    function readSyncForm() {
      const form = document.querySelector('form[data-form="folder-sync"]');
      if (!form) return syncDraft || blankSyncDraft();
      const values = Object.fromEntries(new FormData(form));
      return blankSyncDraft({
        ...(syncDraft || {}),
        id: syncDraft?.id || "",
        name: values.name || "",
        masterPath: values.masterPath || "",
        slavePath: values.slavePath || "",
        mode: values.mode || "masterToSlave",
        enabled: Boolean(values.enabled),
        deleteExtraFiles: Boolean(values.deleteExtraFiles),
        trashRetentionDays: Number(values.trashRetentionDays) || 30,
        conflictPolicy: values.conflictPolicy || "keepConflictCopy",
        autoSyncEnabled: Boolean(values.autoSyncEnabled),
        autoSyncIntervalMinutes: Number(values.autoSyncIntervalMinutes) || 30,
        excludePatterns: values.excludePatterns || "",
      });
    }

    function renderFolderSync() {
      const draft = syncDraft || blankSyncDraft();
      const previewRows = (syncPreview?.items || [])
        .slice(0, 200)
        .map(
          (item) => `<tr class="${item.isConflict ? "conflict" : ""}">
            <td>${esc(item.operation)}</td>
            <td>${item.isConflict ? "冲突" : ""}</td>
            <td title="${attr(item.relativePath)}">${esc(item.relativePath)}</td>
            <td>${esc(item.sizeDisplay || "")}</td>
            <td>${esc(item.reason || "")}</td>
          </tr>`,
        )
        .join("");
      return `<section class="module-page sync-page">
        <div class="module-heading">
          <div>
            <h1>文件同步</h1>
            <p>本地文件夹与企业共享盘/局域网盘之间同步。主从单向复制到从端；完全同步按变更互相复制。</p>
          </div>
          <button class="module-primary" type="button" data-module-action="sync-new">＋ 新建任务</button>
        </div>
        <div class="sync-layout">
          <aside class="sync-list">
            ${
              syncProfiles.length
                ? syncProfiles
                    .map(
                      (profile) => `<button type="button" class="sync-list-item ${profile.id === syncSelectedId ? "active" : ""}" data-module-action="sync-select" data-id="${attr(profile.id)}">
                        <strong>${esc(profile.name || "未命名")}</strong>
                        <small>${esc(modeLabel(profile.mode))} · ${profile.enabled ? "启用" : "停用"}${profile.autoSyncEnabled ? " · 自动" : ""}</small>
                        <span>${esc(profile.lastStatus || "尚未同步")}</span>
                      </button>`,
                    )
                    .join("")
                : '<div class="module-empty">还没有同步任务</div>'
            }
          </aside>
          <form class="sync-editor ws-settings-form" data-form="folder-sync" onsubmit="return false;">
            <div class="form-columns">
              <label>同步名称<input name="name" value="${attr(draft.name)}" placeholder="例如：部门共享盘" /></label>
              <label>同步模式<select name="mode">${[["masterToSlave", "主从单向"], ["twoWay", "完全同步"]].map(([value, label]) => option(value, draft.mode, label)).join("")}</select></label>
            </div>
            <div class="sync-checks">
              <label class="ws-settings-check"><input type="checkbox" name="enabled" ${draft.enabled ? "checked" : ""} /><span>启用</span></label>
              <label class="ws-settings-check"><input type="checkbox" name="autoSyncEnabled" ${draft.autoSyncEnabled ? "checked" : ""} /><span>自动同步</span></label>
              <label class="ws-settings-check"><input type="checkbox" name="deleteExtraFiles" ${draft.deleteExtraFiles ? "checked" : ""} /><span>单向删除从端多余文件</span></label>
            </div>
            <label>主文件夹（本地）
              <div class="sync-path-row">
                <input name="masterPath" value="${attr(draft.masterPath)}" placeholder="C:\\Users\\...\\Documents" />
                <button type="button" data-module-action="sync-browse-master">浏览</button>
              </div>
            </label>
            <label>从文件夹（共享盘/局域网）
              <div class="sync-path-row">
                <input name="slavePath" value="${attr(draft.slavePath)}" placeholder="\\\\server\\share 或映射盘" />
                <button type="button" data-module-action="sync-browse-slave">浏览</button>
              </div>
            </label>
            <label>排除规则（分号分隔）<input name="excludePatterns" value="${attr(draft.excludePatterns)}" /></label>
            <div class="form-columns">
              <label>自动间隔（分钟）<input name="autoSyncIntervalMinutes" type="number" min="1" value="${attr(draft.autoSyncIntervalMinutes)}" /></label>
              <label>回收保留天数<input name="trashRetentionDays" type="number" min="1" value="${attr(draft.trashRetentionDays)}" /></label>
              <label>冲突策略<select name="conflictPolicy">${[
                ["keepConflictCopy", "保留冲突副本（推荐）"],
                ["preferMaster", "主覆盖从"],
                ["preferSlave", "从覆盖主"],
                ["skip", "跳过冲突"],
              ]
                .map(([value, label]) => option(value, draft.conflictPolicy, label))
                .join("")}</select></label>
            </div>
            <div class="sync-actions">
              <button class="module-primary" type="button" data-module-action="sync-save" ${syncBusy ? "disabled" : ""}>保存任务</button>
              <button type="button" data-module-action="sync-preview" ${syncBusy ? "disabled" : ""}>预览同步</button>
              <button type="button" data-module-action="sync-run" ${syncBusy || !draft.id ? "disabled" : ""}>立即同步</button>
              <button type="button" data-module-action="sync-cancel" ${syncBusy ? "" : "disabled"}>取消</button>
              <button type="button" data-module-action="sync-log" ${!draft.id ? "disabled" : ""}>刷新日志</button>
              <button type="button" data-module-action="sync-open-log" ${!draft.id ? "disabled" : ""}>打开日志</button>
              <button class="danger" type="button" data-module-action="sync-remove" ${!draft.id || syncBusy ? "disabled" : ""}>删除</button>
            </div>
            ${syncError ? `<div class="module-error">${esc(syncError)}</div>` : ""}
            <p class="sync-status">${esc(syncStatus || (syncPreview?.summary ? `预览：${syncPreview.summary}` : "选择或新建任务后可预览/同步"))}</p>
            ${
              syncPreview
                ? `<div class="sync-preview-wrap"><table class="sync-preview"><thead><tr><th>操作</th><th>标记</th><th>文件</th><th>大小</th><th>原因</th></tr></thead><tbody>${previewRows || '<tr><td colspan="5">没有待同步文件</td></tr>'}</tbody></table></div>`
                : ""
            }
            ${syncLog ? `<pre class="sync-log">${esc(syncLog)}</pre>` : ""}
          </form>
        </div>
      </section>`;
    }

    function renderAiMessages() {
      const rows = [...aiMessages];
      if (aiBusy) rows.push({ role: "assistant", content: aiStreamingText, streaming: true });
      if (!rows.length) {
        return `<div class="ws-ai-empty">
          <h2>有什么可以帮你？</h2>
          <p>与侧边快捷面板共用对话记录与 API 配置。可用 Ctrl+Shift+S 全屏截图、Ctrl+Shift+R 框选后 AI 分析。</p>
          <div class="ws-ai-prompts">
            ${AI_PROMPTS.map(
              ([label], index) =>
                `<button type="button" data-module-action="ai-prompt" data-value="${index}">${esc(label)}</button>`,
            ).join("")}
          </div>
        </div>`;
      }
      return rows
        .map(
          (message) => `<article class="ws-ai-message ${message.role} ${message.streaming ? "streaming" : ""}">
            <div class="ws-ai-role">${message.role === "user" ? "你" : "AI"}</div>
            <div class="ws-ai-message-body">${
              message.role === "assistant"
                ? renderMarkdown(message.content)
                : esc(message.content).replaceAll("\n", "<br>")
            }</div>
          </article>`,
        )
        .join("");
    }

    function renderAi() {
      const settings = aiSettings || {};
      const profiles = settings.modelProfiles || [];
      return `<section class="module-page ws-ai-page">
        <div class="module-heading">
          <div>
            <h1>AI 问答</h1>
            <p>OpenAI 兼容接口 · 多轮上下文 · 流式输出</p>
          </div>
          <div class="ws-ai-heading-actions">
            <button type="button" data-module-action="screenshot-region" ${aiBusy ? "disabled" : ""}>框选</button>
            <button type="button" data-module-action="screenshot-quick" ${aiBusy ? "disabled" : ""}>截屏</button>
            <button type="button" data-module-action="ai-clear" ${aiBusy ? "disabled" : ""}>新对话</button>
            <button class="module-primary" type="button" data-module-action="ai-settings">设置</button>
          </div>
        </div>
        <div class="ws-ai-toolbar">
          <label class="ws-ai-field">
            <span>模型</span>
            <select class="ws-ai-model" ${aiBusy ? "disabled" : ""}>
              ${profiles
                .map(
                  (profile) =>
                    `<option value="${attr(profile.model)}" ${profile.model === settings.model ? "selected" : ""}>${esc(profile.name || profile.model)}</option>`,
                )
                .join("")}
              ${
                settings.model && !profiles.some((profile) => profile.model === settings.model)
                  ? `<option selected value="${attr(settings.model)}">${esc(settings.model)}</option>`
                  : ""
              }
            </select>
          </label>
          <label class="ws-ai-field">
            <span>Prompt</span>
            <select class="ws-ai-snippet" ${aiBusy ? "disabled" : ""}>
              <option value="">默认系统提示</option>
              ${(settings.promptSnippets || [])
                .map(
                  (snippet, index) =>
                    `<option value="${index}" ${String(index) === aiSnippet ? "selected" : ""}>${esc(snippet.title || `片段 ${index + 1}`)}</option>`,
                )
                .join("")}
            </select>
          </label>
          <div class="ws-ai-status">${aiBusy ? "正在生成…" : `${aiMessages.length} 条消息`}</div>
        </div>
        <div class="ws-ai-messages">${renderAiMessages()}</div>
        ${aiError ? `<div class="module-error ws-ai-error">${esc(aiError)}</div>` : ""}
        <div class="ws-ai-composer">
          <textarea class="ws-ai-input" rows="3" placeholder="输入问题，Enter 发送，Shift+Enter 换行" ${aiBusy ? "disabled" : ""}>${esc(aiDraft)}</textarea>
          <button class="module-primary ws-ai-send ${aiBusy ? "stop" : ""}" type="button" data-module-action="${aiBusy ? "ai-stop" : "ai-send"}">${aiBusy ? "停止" : "发送"}</button>
        </div>
      </section>`;
    }

    function renderAppSettings() {
      const s = appSettings || {};
      const mode = s.proxyForceMode === "pac" ? "pac" : "manual";
      return `<section class="module-page ws-settings-page">
        <div class="module-heading">
          <div>
            <h1>软件设置</h1>
            <p>全局快捷键、强制代理与在线升级，写入旧版共用的 config.json</p>
          </div>
          <div class="ws-ai-heading-actions">
            <button type="button" data-module-action="settings-reload">重新加载</button>
            <button class="module-primary" type="button" data-module-action="settings-save">保存设置</button>
          </div>
        </div>

        <form class="ws-settings-form" data-form="app-settings" onsubmit="return false;">
          <section class="ws-settings-card">
            <h2>全局快捷键</h2>
            <p class="ws-settings-desc">需包含 Ctrl / Alt / Shift 等修饰键。保存后立即生效。</p>
            <div class="form-columns">
              <label>唤出面板<input name="globalChatHotkey" value="${attr(s.globalChatHotkey || "Alt+Q")}" placeholder="Alt+Q" /></label>
              <label>全屏截图<input name="quickScreenshotHotkey" value="${attr(s.quickScreenshotHotkey || "Ctrl+Shift+S")}" placeholder="Ctrl+Shift+S" /></label>
              <label>框选截图<input name="regionScreenshotHotkey" value="${attr(s.regionScreenshotHotkey || "Ctrl+Shift+R")}" placeholder="Ctrl+Shift+R" /></label>
            </div>
          </section>

          <section class="ws-settings-card">
            <h2>强制代理</h2>
            <p class="ws-settings-desc">定时回写 Windows 系统代理，用于对抗组策略覆盖。AI 请求会跟随系统代理/PAC。</p>
            <label class="ws-settings-check">
              <input type="checkbox" name="proxyForceEnabled" ${s.proxyForceEnabled ? "checked" : ""} />
              <span>启用强制代理</span>
            </label>
            <div class="form-columns">
              <label>模式
                <select name="proxyForceMode">
                  ${option("manual", mode, "手动代理（地址 + 端口）")}
                  ${option("pac", mode, "PAC 脚本地址")}
                </select>
              </label>
              <label>强制刷新间隔（分钟）
                <input name="proxyRefreshMinutes" type="number" min="1" max="60" value="${attr(s.proxyRefreshMinutes ?? 3)}" />
              </label>
            </div>
            <div class="ws-settings-mode ${mode === "pac" ? "is-pac" : "is-manual"}">
              <label class="ws-settings-pac">PAC 地址
                <input name="proxyPacUrl" value="${attr(s.proxyPacUrl || "")}" placeholder="http://proxy.example.com/proxy.pac" />
              </label>
              <div class="form-columns ws-settings-manual">
                <label>代理地址<input name="proxyServer" value="${attr(s.proxyServer || "")}" placeholder="10.0.0.1" /></label>
                <label>端口<input name="proxyPort" type="number" min="1" max="65535" value="${attr(s.proxyPort ?? 8080)}" /></label>
              </div>
            </div>
            <label>例外地址（可选）
              <input name="proxyBypass" value="${attr(s.proxyBypass || "")}" placeholder="localhost;127.*;&lt;local&gt;" />
            </label>
            <div class="form-columns">
              <label>上海 PAC（托盘快捷备用）
                <input name="proxyPacUrlShanghai" value="${attr(s.proxyPacUrlShanghai || "")}" />
              </label>
              <label>北京 PAC（托盘快捷备用）
                <input name="proxyPacUrlBeijing" value="${attr(s.proxyPacUrlBeijing || "")}" />
              </label>
            </div>
            <div class="ws-settings-actions">
              <button type="button" data-module-action="settings-apply-proxy">立即应用代理</button>
              <button type="button" data-module-action="settings-use-shanghai">切到上海 PAC</button>
              <button type="button" data-module-action="settings-use-beijing">切到北京 PAC</button>
            </div>
          </section>

          <section class="ws-settings-card">
            <h2>关于与更新</h2>
            <p class="ws-settings-desc">当前版本 v${esc(updateInfo.currentVersion || s._currentVersion || "1.0.0")}。优先使用升级清单 URL；留空则检查 GitHub Releases。</p>
            <label>升级清单 URL（可选）
              <input name="updateManifestUrl" value="${attr(s.updateManifestUrl || "")}" placeholder="https://example.com/update-manifest.json 或本地/UNC 路径" />
            </label>
            <div class="form-columns">
              <label>GitHub 仓库
                <input name="updateGitHubRepo" value="${attr(s.updateGitHubRepo || "TristonLeiCheng/DanceMonkey")}" placeholder="owner/repo" />
              </label>
              <label>资源关键字
                <input name="updateAssetKeyword" value="${attr(s.updateAssetKeyword || "win-x64")}" placeholder="win-x64" />
              </label>
            </div>
            <div class="ws-settings-actions">
              <button class="module-primary" type="button" data-module-action="settings-check-update" ${updateBusy ? "disabled" : ""}>${updateBusy ? "检查中…" : "检查并更新"}</button>
            </div>
            ${updateStatus ? `<p class="ws-settings-update-status">${esc(updateStatus)}</p>` : ""}
            ${updateInfo.installDirectory ? `<p class="ws-settings-desc">安装目录：${esc(updateInfo.installDirectory)}</p>` : ""}
          </section>
        </form>
        ${settingsError ? `<div class="module-error">${esc(settingsError)}</div>` : ""}
        ${settingsMessage ? `<div class="ws-settings-ok">${esc(settingsMessage)}</div>` : ""}
      </section>`;
    }

    function option(value, current, label = value) {
      return `<option value="${attr(value)}" ${value === current ? "selected" : ""}>${esc(label)}</option>`;
    }

    function renderModal() {
      if (!modal) return "";
      if (modal.type === "ai-settings") {
        const settings = aiSettings || {};
        const profiles = (settings.modelProfiles || [])
          .map((profile) => option(profile.model, settings.model, profile.name || profile.model))
          .join("");
        return `<div class="module-modal-backdrop"><form class="module-modal ws-ai-settings" data-form="ai-settings" onsubmit="return false;">
          <h2>AI 设置</h2>
          <label>API 端点<input name="apiEndpoint" value="${attr(settings.apiEndpoint || "")}" placeholder="https://api.openai.com/v1" /></label>
          <label>API Key<input name="apiKey" type="password" value="${attr(settings.apiKey || "")}" placeholder="sk-..." /></label>
          <label>模型<input name="model" list="ws-ai-models" value="${attr(settings.model || "")}" /></label>
          <datalist id="ws-ai-models">${profiles}</datalist>
          <label>系统提示词<textarea name="globalChatSystemPrompt" rows="5" placeholder="留空使用默认提示词">${esc(settings.globalChatSystemPrompt || "")}</textarea></label>
          <p class="ws-ai-settings-hint">与旧版共用 %AppData%\\DanceMonkey\\config.json；请求自动走系统代理。</p>
          ${error ? `<div class="module-error">${esc(error)}</div>` : ""}
          <div class="module-modal-actions">
            <button type="button" data-module-action="close-modal">取消</button>
            <button type="button" data-module-action="ai-test">测试连接</button>
            <button class="module-primary" type="button" data-module-action="save-modal">保存</button>
          </div>
        </form></div>`;
      }
      if (modal.type === "task") {
        const item = modal.item || {};
        const projectId = field(item, "ProjectId");
        const [currentPriority] = priority(item);
        return `<div class="module-modal-backdrop"><form class="module-modal" data-form="task" onsubmit="return false;">
          <h2>${modal.id ? "编辑任务" : "新建任务"}</h2>
          <label>标题<input name="title" required value="${attr(field(item, "Title"))}" /></label>
          <div class="form-columns">
            <label>项目<select name="projectId"><option value="">未分配</option>${projects.map((p) => option(field(p, "Id"), projectId, field(p, "Name"))).join("")}</select></label>
            <label>优先级<select name="priority">${["Urgent & Important", "Not Urgent & Important", "Urgent & Not Important", "Medium", "Low"].map((p) => option(p, currentPriority)).join("")}</select></label>
            <label>责任角色<select name="raci">${["Responsible", "Accountable", "Consulted", "Informed"].map((p) => option(p, field(item, "RaciRole", "Responsible"))).join("")}</select></label>
            <label>能量<select name="energy">${["Low", "Medium", "High"].map((p) => option(p, field(item, "EnergyLevel", "Medium"))).join("")}</select></label>
            <label>状态<select name="workflowStatus">${["Todo", "In Progress", "Blocked", "Completed"].map((p) => option(p, field(item, "WorkflowStatus", "Todo"))).join("")}</select></label>
            <label>截止日期<input name="dueDate" type="date" value="${attr(dateValue(field(item, "DueDate")))}" /></label>
          </div>
          <label>标签<input name="tags" value="${attr(field(item, "Tags"))}" /></label>
          <label>备注<textarea name="notes" rows="4">${esc(field(item, "Notes"))}</textarea></label>
          ${error ? `<div class="module-error">${esc(error)}</div>` : ""}
          <div class="module-modal-actions"><button type="button" data-module-action="close-modal">取消</button><button class="module-primary" type="button" data-module-action="save-modal">保存</button></div>
        </form></div>`;
      }
      if (modal.type === "project") {
        const item = modal.item || {};
        return `<div class="module-modal-backdrop"><form class="module-modal" data-form="project" onsubmit="return false;">
          <h2>${modal.id ? "编辑项目" : "新建项目"}</h2>
          <label>项目名称<input name="name" required value="${attr(field(item, "Name"))}" /></label>
          <div class="form-columns">
            <label>负责人<input name="owner" value="${attr(field(item, "Owner"))}" /></label>
            <label>优先级<select name="priority">${["Low", "Medium", "High", "Critical"].map((p) => option(p, field(item, "Priority", "Medium"))).join("")}</select></label>
            <label>状态<select name="status">${["On Track", "At Risk", "Blocked", "Completed"].map((p) => option(p, field(item, "Status", "On Track"))).join("")}</select></label>
            <label>分类<input name="category" value="${attr(field(item, "Category", "New Initiatives"))}" /></label>
          </div>
          <label>说明<textarea name="description" rows="4">${esc(field(item, "Description"))}</textarea></label>
          ${error ? `<div class="module-error">${esc(error)}</div>` : ""}
          <div class="module-modal-actions"><button type="button" data-module-action="close-modal">取消</button><button class="module-primary" type="button" data-module-action="save-modal">保存</button></div>
        </form></div>`;
      }
      const item = modal.item || {};
      return `<div class="module-modal-backdrop"><form class="module-modal" data-form="link" onsubmit="return false;">
        <h2>${modal.id ? "编辑快捷入口" : "添加快捷入口"}</h2>
        <label>名称<input name="name" required value="${attr(item.name || "")}" /></label>
        <label>路径或网址<input name="path" required value="${attr(item.path || "")}" /></label>
        <div class="form-columns">
          <label>分类<select name="category">${["local", "network", "onedrive", "sharepoint", "web"].map((p) => option(p, item.category || "local")).join("")}</select></label>
          <label>分组<input name="group" value="${attr(item.group || "")}" /></label>
        </div>
        <label>说明<input name="description" value="${attr(item.description || "")}" /></label>
        ${error ? `<div class="module-error">${esc(error)}</div>` : ""}
        <div class="module-modal-actions"><button type="button" data-module-action="close-modal">取消</button><button class="module-primary" type="button" data-module-action="save-modal">保存</button></div>
      </form></div>`;
    }

    function render(section) {
      if (section === "ai") return renderAi();
      if (section === "settings") return renderAppSettings();
      if (section === "tasks") return renderTasks();
      if (section === "projects") return renderProjects();
      if (section === "sync") return renderFolderSync();
      return renderQuickAccess();
    }

    async function refreshZen(result) {
      tasks = result.tasks || [];
      projects = result.projects || [];
      modal = null;
      error = "";
      rerender();
    }

    function readSettingsForm() {
      const form = document.querySelector('form[data-form="app-settings"]');
      if (!form) return { ...(appSettings || {}) };
      const values = Object.fromEntries(new FormData(form).entries());
      return {
        ...(appSettings || {}),
        globalChatHotkey: values.globalChatHotkey,
        quickScreenshotHotkey: values.quickScreenshotHotkey,
        regionScreenshotHotkey: values.regionScreenshotHotkey,
        proxyForceEnabled: Boolean(form.querySelector('[name="proxyForceEnabled"]')?.checked),
        proxyForceMode: values.proxyForceMode === "pac" ? "pac" : "manual",
        proxyPacUrl: values.proxyPacUrl || "",
        proxyServer: values.proxyServer || "",
        proxyPort: Number(values.proxyPort) || 8080,
        proxyBypass: values.proxyBypass || "",
        proxyRefreshMinutes: Number(values.proxyRefreshMinutes) || 3,
        proxyPacUrlShanghai: values.proxyPacUrlShanghai || "",
        proxyPacUrlBeijing: values.proxyPacUrlBeijing || "",
        updateManifestUrl: values.updateManifestUrl || "",
        updateGitHubRepo: values.updateGitHubRepo || "TristonLeiCheng/DanceMonkey",
        updateAssetKeyword: values.updateAssetKeyword || "win-x64",
      };
    }

    async function saveAppSettings(extra = {}) {
      if (!api.settings?.save) {
        settingsError = "当前环境不支持保存设置";
        rerender();
        return false;
      }
      settingsError = "";
      settingsMessage = "";
      const payload = { ...readSettingsForm(), ...extra };
      const result = await api.settings.save(payload);
      if (!result?.success) {
        settingsError = result?.error || "保存失败";
        rerender();
        return false;
      }
      appSettings = result.settings;
      settingsMessage = "设置已保存并生效";
      rerender();
      return true;
    }

    async function handleAction(action, id, setSection) {
      if (action === "settings-reload") {
        settingsError = "";
        settingsMessage = "";
        await loadAppSettings();
        rerender();
        return true;
      }
      if (action === "settings-save") {
        await saveAppSettings();
        return true;
      }
      if (action === "settings-apply-proxy") {
        settingsError = "";
        settingsMessage = "";
        const saved = await saveAppSettings();
        if (!saved) return true;
        const result = await api.settings.applyProxy();
        if (!result?.success) settingsError = result?.error || "应用代理失败";
        else settingsMessage = "已立即写入系统代理";
        rerender();
        return true;
      }
      if (action === "settings-use-shanghai" || action === "settings-use-beijing") {
        const draft = readSettingsForm();
        const pac =
          action === "settings-use-shanghai" ? draft.proxyPacUrlShanghai : draft.proxyPacUrlBeijing;
        if (!String(pac || "").trim()) {
          settingsError = action === "settings-use-shanghai" ? "请先填写上海 PAC 地址" : "请先填写北京 PAC 地址";
          rerender();
          return true;
        }
        await saveAppSettings({
          proxyForceEnabled: true,
          proxyForceMode: "pac",
          proxyPacUrl: pac,
        });
        return true;
      }
      if (action === "settings-check-update") {
        if (!api.appUpdate?.check) {
          settingsError = "当前环境不支持在线升级";
          rerender();
          return true;
        }
        const draft = readSettingsForm();
        updateBusy = true;
        settingsError = "";
        settingsMessage = "";
        updateStatus = draft.updateManifestUrl
          ? "正在检查最新版本..."
          : "正在检查 GitHub 最新 Release...";
        rerender();
        try {
          const result = await api.appUpdate.check({
            updateManifestUrl: draft.updateManifestUrl,
            updateGitHubRepo: draft.updateGitHubRepo,
            updateAssetKeyword: draft.updateAssetKeyword,
          });
          updateBusy = false;
          if (!result?.success) {
            settingsError = result?.error || "检查更新失败";
            updateStatus = "";
            rerender();
            return true;
          }
          if (api.settings?.get) appSettings = await api.settings.get();
          if (!result.isUpdateAvailable) {
            updateStatus = result.message || `已是最新版本（v${result.currentVersionText}）。`;
            settingsMessage = updateStatus;
            rerender();
            return true;
          }
          updateStatus = `已准备升级到 v${result.latestVersionText}`;
          const notes = result.releaseNotes ? `\n\n更新说明：\n${String(result.releaseNotes).slice(0, 800)}` : "";
          const confirmed = confirm(
            `已准备升级到 v${result.latestVersionText}。\n程序将退出，在当前目录就地替换为最新版本，并在完成后自动重新启动。\n\n更新目录：\n${result.launchInfo?.installDirectory || ""}${notes}`,
          );
          if (!confirmed) {
            updateStatus = "已取消升级";
            rerender();
            return true;
          }
          updateStatus = `正在退出并更新到 v${result.latestVersionText}...`;
          rerender();
          const applied = await api.appUpdate.apply(result.launchInfo);
          if (!applied?.success) {
            settingsError = applied?.error || "启动升级失败";
            updateStatus = "";
            rerender();
          }
        } catch (cause) {
          updateBusy = false;
          settingsError = cause?.message || "检查更新失败";
          updateStatus = "";
          rerender();
        }
        return true;
      }
      if (action === "ai-settings") {
        modal = { type: "ai-settings" };
        error = "";
        if (!aiSettings && api.ai?.getSettings) aiSettings = await api.ai.getSettings();
        rerender();
        return true;
      }
      if (action === "screenshot-quick" || action === "screenshot-region") {
        if (!api.screenshot) {
          aiError = "当前环境不支持截屏。";
          rerender();
          return true;
        }
        aiError = "";
        const result =
          action === "screenshot-region"
            ? await api.screenshot.region()
            : await api.screenshot.quick();
        if (!result?.success && result?.error) {
          aiError = result.error;
          rerender();
        }
        return true;
      }
      if (action === "ai-clear") {
        if (aiBusy) return true;
        aiDraft = "";
        aiError = "";
        aiStreamingText = "";
        await persistAiMessages([]);
        rerender();
        return true;
      }
      if (action === "ai-prompt") {
        const prompt = AI_PROMPTS[Number(id)];
        if (prompt) {
          aiDraft = prompt[1];
          rerender();
          requestAnimationFrame(() => {
            const input = document.querySelector(".ws-ai-input");
            input?.focus();
            input?.setSelectionRange(aiDraft.length, aiDraft.length);
          });
        }
        return true;
      }
      if (action === "ai-send") {
        await sendAi();
        return true;
      }
      if (action === "ai-stop") {
        if (aiRequestId && api.ai?.cancel) await api.ai.cancel(aiRequestId);
        return true;
      }
      if (action === "ai-test") {
        await testAiConnection();
        return true;
      }
      if (action === "task-filter") {
        taskFilter = id;
        rerender();
        return true;
      }
      if (action === "link-filter") {
        linkFilter = id;
        rerender();
        return true;
      }
      if (action === "link-sort") {
        linkSort = id;
        rerender();
        return true;
      }
      if (action === "refresh-links") {
        links = api.quickAccess.refresh ? await api.quickAccess.refresh() : await api.quickAccess.list();
        rerender();
        return true;
      }
      if (action === "create-sync-from-link") {
        const link = links.find((item) => item.id === id);
        if (!link || !api.folderSync?.createFromLink) {
          error = "当前环境不支持创建同步任务";
          rerender();
          return true;
        }
        try {
          const result = await api.folderSync.createFromLink(link.path, link.name);
          syncProfiles = result.profiles || [];
          syncSelectedId = result.profile?.id || "";
          syncDraft = result.profile ? { ...result.profile } : blankSyncDraft();
          syncPreview = null;
          syncLog = "";
          syncStatus = "已根据快捷入口创建任务，请补全从文件夹后保存";
          syncError = "";
          setSection("sync");
        } catch (cause) {
          error = cause?.message || "创建同步任务失败";
          rerender();
        }
        return true;
      }
      if (action === "add-task") {
        modal = { type: "task" };
        error = "";
        rerender();
        return true;
      }
      if (action === "edit-task") {
        modal = { type: "task", id, item: tasks.find((item) => field(item, "Id") === id) };
        error = "";
        rerender();
        return true;
      }
      if (action === "toggle-task") {
        await refreshZen(await api.zenTask.toggleTask(id));
        return true;
      }
      if (action === "delete-task") {
        if (confirm("确定删除该任务？")) await refreshZen(await api.zenTask.deleteTask(id));
        return true;
      }
      if (action === "add-project") {
        modal = { type: "project" };
        error = "";
        rerender();
        return true;
      }
      if (action === "edit-project") {
        modal = { type: "project", id, item: projects.find((item) => field(item, "Id") === id) };
        error = "";
        rerender();
        return true;
      }
      if (action === "delete-project") {
        if (confirm("删除项目后，关联任务将变为未分配。是否继续？")) {
          await refreshZen(await api.zenTask.deleteProject(id));
        }
        return true;
      }
      if (action === "project-tasks") {
        query = projectName(id);
        taskFilter = "all";
        setSection("tasks");
        return true;
      }
      if (action === "add-link") {
        modal = { type: "link" };
        error = "";
        rerender();
        return true;
      }
      if (action === "edit-link") {
        modal = { type: "link", id, item: links.find((item) => item.id === id) };
        error = "";
        rerender();
        return true;
      }
      if (action === "pin-link") {
        links = await api.quickAccess.togglePin(id);
        rerender();
        return true;
      }
      if (action === "delete-link") {
        if (confirm("确定删除该快捷入口？")) {
          links = await api.quickAccess.remove(id);
          rerender();
        }
        return true;
      }
      if (action === "open-link") {
        links = await api.quickAccess.open(id);
        rerender();
        return true;
      }
      if (action === "sync-new") {
        syncSelectedId = "";
        syncDraft = blankSyncDraft();
        syncPreview = null;
        syncLog = "";
        syncStatus = "填写主从路径后保存任务";
        syncError = "";
        rerender();
        return true;
      }
      if (action === "sync-select") {
        const profile = syncProfiles.find((item) => item.id === id);
        syncSelectedId = id;
        syncDraft = profile ? { ...profile } : blankSyncDraft();
        syncPreview = null;
        syncLog = "";
        syncStatus = profile?.lastStatus || "";
        syncError = "";
        if (profile && api.folderSync?.log) {
          try {
            syncLog = await api.folderSync.log(profile.id);
          } catch {}
        }
        rerender();
        return true;
      }
      if (action === "sync-browse-master" || action === "sync-browse-slave") {
        syncDraft = readSyncForm();
        if (!api.folderSync?.browse) {
          syncError = "当前环境不支持浏览文件夹";
          rerender();
          return true;
        }
        const picked = await api.folderSync.browse();
        if (picked) {
          if (action === "sync-browse-master") syncDraft.masterPath = picked;
          else syncDraft.slavePath = picked;
          syncError = "";
          rerender();
        }
        return true;
      }
      if (action === "sync-save") {
        if (!api.folderSync?.save) {
          syncError = "当前环境不支持保存同步任务";
          rerender();
          return true;
        }
        try {
          const draft = readSyncForm();
          if (!draft.name.trim() || !draft.masterPath.trim() || !draft.slavePath.trim()) {
            throw new Error("名称、主文件夹和从文件夹都不能为空");
          }
          syncProfiles = await api.folderSync.save(draft);
          const saved =
            syncProfiles.find((item) => item.id === draft.id) ||
            syncProfiles.find(
              (item) => item.name === draft.name && item.masterPath === draft.masterPath,
            ) ||
            syncProfiles[syncProfiles.length - 1];
          syncSelectedId = saved?.id || "";
          syncDraft = saved ? { ...saved } : draft;
          syncStatus = "任务已保存";
          syncError = "";
          rerender();
        } catch (cause) {
          syncError = cause?.message || "保存失败";
          rerender();
        }
        return true;
      }
      if (action === "sync-remove") {
        const draft = readSyncForm();
        if (!draft.id || !confirm("确定删除该同步任务？")) return true;
        syncProfiles = await api.folderSync.remove(draft.id);
        syncSelectedId = syncProfiles[0]?.id || "";
        syncDraft = syncProfiles[0] ? { ...syncProfiles[0] } : blankSyncDraft();
        syncPreview = null;
        syncLog = "";
        syncStatus = "任务已删除";
        syncError = "";
        rerender();
        return true;
      }
      if (action === "sync-preview") {
        try {
          const draft = readSyncForm();
          syncDraft = draft;
          syncPreview = await api.folderSync.preview(draft.id || draft);
          syncStatus = `预览：${syncPreview.summary}`;
          syncError = "";
          rerender();
        } catch (cause) {
          syncError = cause?.message || "预览失败";
          rerender();
        }
        return true;
      }
      if (action === "sync-run") {
        const draft = readSyncForm();
        if (!draft.id) {
          syncError = "请先保存任务再同步";
          rerender();
          return true;
        }
        try {
          syncBusy = true;
          syncError = "";
          syncStatus = "正在同步…";
          rerender();
          const result = await api.folderSync.run(draft.id);
          syncBusy = false;
          if (result.profiles) syncProfiles = result.profiles;
          const selected = syncProfiles.find((item) => item.id === draft.id);
          if (selected) syncDraft = { ...selected };
          if (!result.success) {
            syncError = result.error || "同步失败";
            syncStatus = "同步失败";
          } else {
            syncStatus = result.result?.summary || "同步完成";
            syncPreview = result.result?.preview || syncPreview;
            syncError = "";
          }
          if (api.folderSync.log) syncLog = await api.folderSync.log(draft.id);
          rerender();
        } catch (cause) {
          syncBusy = false;
          syncError = cause?.message || "同步失败";
          syncStatus = "同步中断";
          rerender();
        }
        return true;
      }
      if (action === "sync-cancel") {
        const draft = readSyncForm();
        if (draft.id && api.folderSync?.cancel) await api.folderSync.cancel(draft.id);
        syncStatus = "正在取消…";
        rerender();
        return true;
      }
      if (action === "sync-log") {
        const draft = readSyncForm();
        if (!draft.id) return true;
        try {
          syncLog = await api.folderSync.log(draft.id);
          syncError = "";
          rerender();
        } catch (cause) {
          syncError = cause?.message || "读取日志失败";
          rerender();
        }
        return true;
      }
      if (action === "sync-open-log") {
        const draft = readSyncForm();
        if (!draft.id) return true;
        try {
          await api.folderSync.openLog(draft.id);
        } catch (cause) {
          syncError = cause?.message || "打开日志失败";
          rerender();
        }
        return true;
      }
      if (action === "close-modal") {
        return closeModal();
      }
      if (action === "save-modal") {
        await saveModal();
        return true;
      }
      return false;
    }

    async function saveModal() {
      const form = document.querySelector("form.module-modal");
      if (!form || !modal) return;
      if (typeof form.reportValidity === "function" && !form.reportValidity()) return;
      const values = Object.fromEntries(new FormData(form));
      try {
        if (form.dataset.form === "ai-settings") {
          if (!api.ai?.saveSettings) throw new Error("当前环境不支持保存 AI 设置");
          aiSettings = await api.ai.saveSettings({
            apiEndpoint: values.apiEndpoint,
            apiKey: values.apiKey,
            model: values.model,
            globalChatSystemPrompt: values.globalChatSystemPrompt,
          });
          modal = null;
          error = "";
          rerender();
          return;
        }
        if (form.dataset.form === "task") {
          const result = modal.id
            ? await api.zenTask.updateTask(modal.id, values)
            : await api.zenTask.addTask(values);
          await refreshZen(result);
        } else if (form.dataset.form === "project") {
          const result = modal.id
            ? await api.zenTask.updateProject(modal.id, values)
            : await api.zenTask.addProject(values);
          await refreshZen(result);
        } else {
          links = modal.id
            ? await api.quickAccess.update(modal.id, values)
            : await api.quickAccess.add(values);
          modal = null;
          error = "";
          rerender();
        }
      } catch (cause) {
        error = cause?.message || "保存失败";
        rerender();
      }
    }

    async function testAiConnection() {
      const form = document.querySelector('form[data-form="ai-settings"]');
      if (!form || !api.ai) return;
      const values = Object.fromEntries(new FormData(form));
      try {
        aiSettings = await api.ai.saveSettings({
          apiEndpoint: values.apiEndpoint,
          apiKey: values.apiKey,
          model: values.model,
          globalChatSystemPrompt: values.globalChatSystemPrompt,
        });
        const result = await api.ai.chat({
          requestId: `test-${Date.now()}`,
          model: aiSettings.model,
          systemPrompt: "你是连接测试助手。",
          messages: [{ role: "user", content: "请只回复：连接成功" }],
        });
        error = result.success ? "" : result.error || "测试失败";
        if (result.success) {
          modal = null;
          alert(result.text || "连接成功");
        }
        rerender();
      } catch (cause) {
        error = cause?.message || "测试失败";
        rerender();
      }
    }

    async function sendAi() {
      if (aiBusy) return;
      if (!api.ai?.chat) {
        aiError = "浏览器预览不连接 AI，请使用桌面模式。";
        rerender();
        return;
      }
      const input = document.querySelector(".ws-ai-input");
      const draft = String(input?.value ?? aiDraft).trim();
      if (!draft) return;

      if (!aiSettings) aiSettings = await api.ai.getSettings();
      const modelSelect = document.querySelector(".ws-ai-model");
      const snippetSelect = document.querySelector(".ws-ai-snippet");
      if (modelSelect?.value) {
        aiSettings = { ...aiSettings, model: modelSelect.value };
        await api.ai.saveSettings(aiSettings);
      }
      if (snippetSelect) aiSnippet = snippetSelect.value;
      const snippet = aiSettings.promptSnippets?.[Number(aiSnippet)];
      const systemPrompt = snippet?.systemPrompt || aiSettings.globalChatSystemPrompt || "";

      const history = [...aiMessages, { role: "user", content: draft }];
      aiDraft = "";
      aiError = "";
      aiBusy = true;
      aiStreamingText = "";
      aiRequestId = `ws-ai-${Date.now()}`;
      await persistAiMessages(history);
      rerender();

      unsubscribeChunk?.();
      unsubscribeChunk = api.ai.onChunk?.(({ requestId, chunk }) => {
        if (requestId !== aiRequestId) return;
        aiStreamingText += chunk;
        updateStreamingDom();
      });

      try {
        const result = await api.ai.chat({
          requestId: aiRequestId,
          model: aiSettings.model,
          systemPrompt,
          messages: history,
        });
        if (result.success) {
          await persistAiMessages([
            ...history,
            { role: "assistant", content: result.text || aiStreamingText || "" },
          ]);
        } else {
          aiError = result.error || "AI 请求失败";
        }
      } catch (cause) {
        aiError = cause?.message || "AI 请求失败";
      } finally {
        unsubscribeChunk?.();
        unsubscribeChunk = null;
        aiBusy = false;
        aiStreamingText = "";
        aiRequestId = null;
        rerender();
        requestAnimationFrame(() => {
          const box = document.querySelector(".ws-ai-messages");
          if (box) box.scrollTop = box.scrollHeight;
          document.querySelector(".ws-ai-input")?.focus();
        });
      }
    }

    function closeModal() {
      if (!modal) return false;
      modal = null;
      error = "";
      rerender();
      return true;
    }

    async function handleClick(event, setSection) {
      if (event.target.classList.contains("module-modal-backdrop")) {
        return closeModal();
      }
      const button = event.target.closest("[data-module-action]");
      if (!button) return false;
      event.preventDefault();
      event.stopPropagation();
      const action = button.dataset.moduleAction;
      const id = button.dataset.id || button.dataset.value;
      return handleAction(action, id, setSection);
    }

    function bindSearch(scope) {
      const search = scope.querySelector(".module-search");
      if (search) {
        search.oninput = () => {
          query = search.value;
          rerender();
          requestAnimationFrame(() => {
            const next = scope.querySelector(".module-search");
            next?.focus();
            next?.setSelectionRange(query.length, query.length);
          });
        };
      }
      bindAi(scope);
      bindSettings(scope);
    }

    function bindSettings(scope) {
      const modeSelect = scope.querySelector('select[name="proxyForceMode"]');
      const modeBox = scope.querySelector(".ws-settings-mode");
      if (modeSelect && modeBox) {
        const sync = () => {
          modeBox.classList.toggle("is-pac", modeSelect.value === "pac");
          modeBox.classList.toggle("is-manual", modeSelect.value !== "pac");
        };
        modeSelect.onchange = sync;
        sync();
      }
    }

    function bindAi(scope) {
      const input = scope.querySelector(".ws-ai-input");
      if (input) {
        input.oninput = () => {
          aiDraft = input.value;
        };
        input.onkeydown = (event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void sendAi();
          }
        };
        requestAnimationFrame(() => {
          const box = scope.querySelector(".ws-ai-messages");
          if (box) box.scrollTop = box.scrollHeight;
        });
      }
      const modelSelect = scope.querySelector(".ws-ai-model");
      if (modelSelect) {
        modelSelect.onchange = async () => {
          if (!aiSettings || !api.ai?.saveSettings) return;
          aiSettings = { ...aiSettings, model: modelSelect.value };
          await api.ai.saveSettings(aiSettings);
        };
      }
      const snippetSelect = scope.querySelector(".ws-ai-snippet");
      if (snippetSelect) {
        snippetSelect.onchange = () => {
          aiSnippet = snippetSelect.value;
          const snippet = aiSettings?.promptSnippets?.[Number(aiSnippet)];
          if (snippet) {
            aiSettings = {
              ...aiSettings,
              globalChatSystemPrompt: snippet.systemPrompt || "",
            };
          }
        };
      }
    }

    function syncAiMessages(messages) {
      if (aiBusy) return;
      aiMessages = Array.isArray(messages) ? messages : [];
      rerender();
    }

    return { loadAll, loadAi, render, renderModal, handleClick, bindSearch, closeModal, syncAiMessages };
  }

  window.DMWorkspaceModules = { create };
})();
