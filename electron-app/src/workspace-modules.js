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
    return [impact <= 2 && urgency <= 2 ? "Low" : "Medium", "Q4 常规", "q4"];
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
    let modalSaving = false;
    let error = "";
    let aiSettings = null;
    let aiMessages = [];
    let aiDraft = "";
    let aiBusy = false;
    let aiStreamingText = "";
    let aiRequestId = null;
    let aiError = "";
    let aiNotice = "";
    let aiStopped = false;
    let aiFollowOutput = true;
    let aiScrollTop = 0;
    let aiSnippet = "";
    let unsubscribeChunk = null;
    let unsubscribeSyncProgress = null;
    let appSettings = null;
    let settingsMessage = "";
    let settingsError = "";
    let networkTesting = false;
    let settingsTab = "shortcuts";
    let petPicker = null;
    const settingsTabs = [
      { id: "shortcuts", label: "快捷键", description: "设置唤出面板与截图的全局快捷键。" },
      { id: "pet", label: "桌面宠物", description: "选择宠物外形，调整互动、任务提醒与唤醒行为。" },
      { id: "sync", label: "笔记同步", description: "连接 GitHub，配置笔记、任务与项目的多设备同步。" },
      { id: "proxy", label: "网络连接", description: "选择 AI 直连或跟随系统，保存并测试连接。" },
      { id: "about", label: "关于与更新", description: "查看当前版本，检查并安装应用更新。" },
    ];
    const editableSettingsTab = (id) => ["shortcuts", "pet", "proxy"].includes(id);
    const petAnimals = { human: "小人", cat: "猫咪", dog: "狗狗", rabbit: "兔子", fox: "狐狸", goose: "大鹅", cockroach: "蟑螂", mosquito: "蚊子", capybara: "卡皮巴拉（水豚）", frog: "青蛙", penguin: "企鹅", turtle: "乌龟", hedgehog: "刺猬", "engineer-fox": "工程师", "operator-rabbit": "话务员兔子", otter: "抱贝壳的小海獭", "red-panda": "小熊猫咖啡师", "baby-dragon": "团子小龙", "fluffy-rabbit": "绒绒兔" };
    api.settings?.onPetChanged?.((settings) => {
      if (settings.aiNetworkMode !== undefined) {
        const chosen=document.querySelector('form[data-form="app-settings"] [name="aiNetworkMode"]:checked');
        const dirty=chosen && chosen.value!==(appSettings?.aiNetworkMode || 'direct');
        if (!dirty) {
          appSettings={...(appSettings||{}),aiNetworkMode:settings.aiNetworkMode};
          for(const input of document.querySelectorAll('form[data-form="app-settings"] [name="aiNetworkMode"]')) input.checked=input.value===settings.aiNetworkMode;
        }
        if(aiSettings) aiSettings={...aiSettings,aiNetworkMode:settings.aiNetworkMode};
      }
      const keys = ["petModeEnabled", "petAnimal", "petDisplaySize", "petMoodDecayEnabled", "petPreventSleepEnabled", "todoReminderEnabled", "todoReminderMinutes"];
      for (const key of keys) {
        if (settings[key] === undefined) continue;
        appSettings = { ...(appSettings || {}), [key]: settings[key] };
        const input = document.querySelector(`form[data-form="app-settings"] [name="${key}"]`);
        if (key === 'petAnimal' && input && ![...input.options].some(option => option.value === settings[key])) {
          const option = document.createElement('option');
          option.value = settings[key]; option.textContent = '已保存的宠物（当前版本暂不支持）'; input.append(option);
        }
        if (input?.type === "checkbox") input.checked = settings[key];
        else if (input) input.value = settings[key];
      }
      petPicker?.sync();
    });

    const githubUI = window.DMGitHubSyncUI?.create(api, {
      esc, attr, beforeRender: () => { appSettings = readSettingsForm(); },
    });
    const personaManager = window.DMPersonaManager?.create(api, {
      esc, attr, rerender,
      openSettings: () => handleAction("ai-settings"),
    });
    const projectManager = window.DMProjectManager.create({
      api, esc, attr, rerender,
      getState: () => ({ tasks, projects }),
      onResult: refreshZen,
      openNote: async (path) => { await helpers.openNote(path); modal = null; },
      editProject: (project) => {
        modal = { type: "project", id: field(project, "Id"), item: project || {} };
        error = "";
      },
      editTask: (task, projectId) => {
        modal = { type: "task", id: field(task, "Id"), item: task || { ProjectId: projectId } };
        error = "";
      },
    });

    const AI_PROMPTS = [
      ["梳理要点", "请用条目总结下面内容的核心结论与待办：\n\n", "从长篇内容中，找到真正重要的事", "outline"],
      ["拆解计划", "请把下面目标拆成可执行任务，标注优先级与依赖：\n\n", "让一个目标，变成清楚的下一步", "plan"],
      ["润色文字", "请把下面文字润色得更清晰专业，保留原意：\n\n", "保留你的意思，让表达更清晰", "edit"],
      ["整理周报", "请根据下面工作记录写一份简洁周报（本周完成 / 风险 / 下周计划）：\n\n", "整理本周进展、收获与下一周计划", "report"],
    ];

    function aiIcon(name) {
      const paths = {
        spark: '<path d="m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4Z"/>',
        plus: '<path d="M12 5v14M5 12h14"/>',
        settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
        crop: '<path d="M8 3v13h13M3 8h13v13"/>',
        camera: '<path d="M8 6 9.5 4h5L16 6h4v14H4V6Z"/><circle cx="12" cy="13" r="4"/>',
        arrow: '<path d="M12 19V5m-6 6 6-6 6 6"/>',
        down: '<path d="M12 5v14m-6-6 6 6 6-6"/>',
        stop: '<rect x="7" y="7" width="10" height="10" rx="1" fill="currentColor" stroke="none"/>',
        copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>',
        check: '<path d="m5 12 4 4L19 6"/>',
        retry: '<path d="M4 10a8 8 0 1 1 1 7M4 4v6h6"/>',
        outline: '<path d="M9 6h11M9 12h11M9 18h7M4 6h.01M4 12h.01M4 18h.01"/>',
        plan: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/><path d="M14 7h3v7M7 14v3h7"/>',
        edit: '<path d="m15 5 4 4M4 20l4-1L20 7l-4-4L4 15Z"/>',
        report: '<path d="M6 3h9l3 3v15H6Z M10 10h4M10 14h4M10 18h2"/>',
      };
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.spark}</svg>`;
    }

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
      await projectManager.refreshFiles();
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
      await githubUI?.load();
      if (api.settings?.get) {
        appSettings = await api.settings.get();
      }
      await helpers.updateUI?.load();
    }

    async function loadAll() {
      await personaManager?.load();
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
      if (api.setState) await api.setState({ aiMessages: messages });
      aiMessages = messages;
    }

    function renderMarkdown(value) {
      if (!value) return "";
      if (window.marked && window.DOMPurify) {
        return window.DOMPurify.sanitize(window.marked.parse(value));
      }
      return esc(value).replaceAll("\n", "<br>");
    }

    function updateStreamingDom() {
      const box = document.querySelector(".ws-ai-messages");
      const follow = aiFollowOutput;
      const body = document.querySelector(".ws-ai-message.streaming .ws-ai-message-body");
      if (body && aiStreamingText) body.innerHTML = renderMarkdown(aiStreamingText);
      const status = document.querySelector(".ws-ai-status");
      if (status) status.textContent = aiStreamingText ? "正在回复" : "正在思考";
      if (box && follow) box.scrollTop = box.scrollHeight;
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
                <input name="masterPath" value="${attr(draft.masterPath)}" placeholder="${api.platform === "darwin" ? "/Users/…/Documents" : "C:\\Users\\...\\Documents"}" />
                <button type="button" data-module-action="sync-browse-master">浏览</button>
              </div>
            </label>
            <label>从文件夹（共享盘/局域网）
              <div class="sync-path-row">
                <input name="slavePath" value="${attr(draft.slavePath)}" placeholder="${api.platform === "darwin" ? "/Volumes/共享盘" : "\\\\server\\share 或映射盘"}" />
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
          <div class="ws-ai-emblem">${aiIcon("spark")}</div>
          <span class="ws-ai-eyebrow">留一点空间，给新的想法</span>
          <h2>今天，想一起完成什么？</h2>
          <p>梳理一段文字，拆解一个目标，或聊聊眼前的问题。</p>
          <div class="ws-ai-prompts">
            ${AI_PROMPTS.map(([label, , description, icon], index) =>
              `<button type="button" data-module-action="ai-prompt" data-value="${index}">
                <span class="ws-ai-prompt-icon">${aiIcon(icon)}</span>
                <span><strong>${esc(label)}</strong><small>${esc(description)}</small></span>
                <span class="ws-ai-prompt-arrow" aria-hidden="true">↗</span>
              </button>`,
            ).join("")}
          </div>
        </div>`;
      }
      return `<div class="ws-ai-thread">${rows.map((message, index) => {
        const assistant = message.role === "assistant";
        return `<article class="ws-ai-message ${assistant ? "assistant" : "user"} ${message.streaming ? "streaming" : ""}">
          <div class="ws-ai-message-meta">${assistant ? `<span class="ws-ai-avatar">${aiIcon("spark")}</span><span>DM 助手</span>` : '<span>你</span>'}${message.streaming ? '<span class="ws-ai-live-dot" aria-hidden="true"></span>' : ""}</div>
          <div class="ws-ai-message-body">${assistant
            ? message.streaming && !message.content
              ? '<span class="ws-ai-thinking"><i></i><i></i><i></i><span>正在想一想…</span></span>'
              : renderMarkdown(message.content)
            : esc(message.content).replaceAll("\n", "<br>")}</div>
          ${assistant && !message.streaming && message.content ? `<div class="ws-ai-message-actions"><button type="button" data-module-action="ai-copy" data-value="${index}" aria-label="复制回复" title="复制 Markdown 原文">${aiIcon("copy")}<span>复制</span></button></div>` : ""}
        </article>`;
      }).join("")}</div>`;
    }

    function renderAi() {
      const settings = aiSettings || {};
      const profiles = settings.modelProfiles || [];
      const count = aiMessages.filter((message) => message.role === "user").length;
      const canRetry = Boolean(aiError && aiMessages.at(-1)?.role === "user");
      return `<section class="module-page ws-ai-page ${aiMessages.length ? "has-conversation" : "is-empty"}">
        <header class="ws-ai-header">
          <div class="ws-ai-heading"><span class="ws-ai-header-icon">${aiIcon("spark")}</span><div><h1>AI 问答</h1><p>想法、文字与下一步</p></div></div>
          <div class="ws-ai-heading-actions">
            <button class="ws-ai-new" type="button" data-module-action="ai-clear" ${aiBusy || !aiMessages.length ? "disabled" : ""}>${aiIcon("plus")}<span>新对话</span></button>
            <button type="button" class="ws-ai-icon-button" data-module-action="ai-settings" aria-label="AI 设置" title="AI 设置" ${aiBusy ? "disabled" : ""}>${aiIcon("settings")}</button>
          </div>
        </header>
        <div class="ws-ai-conversation">
          <div class="ws-ai-messages" role="region" aria-label="对话消息" tabindex="0">${renderAiMessages()}</div>
          <button class="ws-ai-to-bottom" type="button" data-module-action="ai-bottom" ${aiFollowOutput ? "hidden" : ""}>${aiIcon("down")}回到最新</button>
        </div>
        <div class="ws-ai-compose-area">
          ${aiError ? `<div class="ws-ai-error" role="alert"><span>${esc(aiError)}</span>${canRetry ? `<button type="button" data-module-action="ai-retry" ${aiBusy ? "disabled" : ""}>${aiIcon("retry")}重新尝试</button>` : ""}</div>` : ""}
          <div class="ws-ai-composer ${aiBusy ? "is-generating" : ""}">
            <label class="visually-hidden" for="ws-ai-input">给 AI 发消息</label>
            <textarea id="ws-ai-input" class="ws-ai-input" rows="2" placeholder="写下你的问题，或放入一段想整理的文字…" ${aiBusy ? "disabled" : ""}>${esc(aiDraft)}</textarea>
            <div class="ws-ai-composer-tools">
              <div class="ws-ai-tools-left">
                <label class="ws-ai-field ws-ai-model-field"><span class="visually-hidden">选择模型</span><span class="ws-ai-model-dot" aria-hidden="true"></span>
                  <select class="ws-ai-model" aria-label="选择模型" ${aiBusy ? "disabled" : ""}>
                    ${profiles.map((profile) => `<option value="${attr(profile.model)}" ${profile.model === settings.model ? "selected" : ""}>${esc(profile.name || profile.model)}</option>`).join("")}
                    ${settings.model && !profiles.some((profile) => profile.model === settings.model) ? `<option selected value="${attr(settings.model)}">${esc(settings.model)}</option>` : ""}
                    ${!settings.model && !profiles.length ? '<option value="">选择模型</option>' : ""}
                  </select>
                </label>
                <label class="ws-ai-field ws-ai-snippet-field"><span class="visually-hidden">对话提示词</span><select class="ws-ai-snippet" aria-label="对话提示词" ${aiBusy ? "disabled" : ""}>
                  <option value="" ${aiSnippet === "" ? "selected" : ""}>默认助手</option>
                  ${(settings.promptSnippets || []).map((snippet, index) => `<option value="${index}" ${String(index) === aiSnippet ? "selected" : ""}>${esc(snippet.title || `提示词 ${index + 1}`)}</option>`).join("")}
                </select></label>
                <span class="ws-ai-tool-divider" aria-hidden="true"></span>
                <button class="ws-ai-tool" type="button" data-module-action="screenshot-region" title="框选截图" aria-label="框选截图" ${aiBusy ? "disabled" : ""}>${aiIcon("crop")}<span>框选</span></button>
                <button class="ws-ai-tool" type="button" data-module-action="screenshot-quick" title="全屏截图" aria-label="全屏截图" ${aiBusy ? "disabled" : ""}>${aiIcon("camera")}</button>
              </div>
              <button class="ws-ai-send ${aiBusy ? "stop" : ""}" type="button" data-module-action="${aiBusy ? "ai-stop" : "ai-send"}" aria-label="${aiBusy ? "停止生成" : "发送消息"}" title="${aiBusy ? "停止生成" : "发送消息"}" ${!aiBusy && !aiDraft.trim() ? "disabled" : ""}>${aiIcon(aiBusy ? "stop" : "arrow")}</button>
            </div>
          </div>
          <div class="ws-ai-composer-caption"><span class="ws-ai-status" role="status">${aiBusy ? aiStreamingText ? "正在回复" : "正在思考" : esc(aiNotice) || (count ? `${count} 轮对话` : "从一个问题开始")}</span><span><kbd>Enter</kbd> 发送 <span class="ws-ai-key-separator">/</span> <kbd>Shift + Enter</kbd> 换行</span></div>
        </div>
      </section>`;
    }

    function renderAppSettings() {
      const s = appSettings || {};
      const mode = s.proxyForceMode === "pac" ? "pac" : "manual";
      const savedAnimal = s.petAnimal || "human";
      const unavailableAnimal = Object.hasOwn(petAnimals, savedAnimal) ? "" : `<option value="${attr(savedAnimal)}" selected>已保存的宠物（当前版本暂不支持）</option>`;
      const current = settingsTabs.find((tab) => tab.id === settingsTab) || settingsTabs[0];
      const panel = (id) => `id="settings-panel-${id}" role="tabpanel" aria-labelledby="settings-tab-${id}" data-settings-panel="${id}" tabindex="0" ${settingsTab === id ? "" : "hidden"}`;
      return `<section class="module-page ws-settings-page">
        <div class="module-heading">
          <div>
            <h1>软件设置</h1>
            <p data-settings-description>${current.description}</p>
          </div>
          <div class="ws-ai-heading-actions" data-settings-actions ${editableSettingsTab(settingsTab) ? "" : "hidden"}>
            <button type="button" data-module-action="settings-reload">重新加载</button>
            <button class="module-primary" type="button" data-module-action="settings-save">保存设置</button>
          </div>
        </div>

        <div class="ws-settings-tabs" role="tablist" aria-label="设置分类">
          ${settingsTabs.map((tab) => `<button type="button" class="ws-settings-tab" role="tab" id="settings-tab-${tab.id}" aria-controls="settings-panel-${tab.id}" aria-selected="${settingsTab === tab.id}" tabindex="${settingsTab === tab.id ? 0 : -1}" data-settings-tab="${tab.id}">${tab.label}</button>`).join("")}
        </div>
        <form class="ws-settings-form" data-form="app-settings" onsubmit="return false;">
          <section class="ws-settings-card" ${panel("pet")}>
            <h2>桌面宠物</h2>
            <p class="ws-settings-desc">单击互动，双击打开主界面，拖动调整位置，右键使用快捷功能。在下方选择宠物外形，保存后立即生效，也可从托盘开启。</p>
            <label class="ws-settings-check"><input type="checkbox" name="petModeEnabled" ${s.petModeEnabled ? "checked" : ""} /><span>开启桌面宠物</span></label>
            <div data-pet-picker></div>
            <div class="form-columns">
              <label hidden>宠物外形<select name="petAnimal" tabindex="-1">${unavailableAnimal}${Object.entries(petAnimals).map(([id, name]) => `<option value="${id}" ${id === (s.petAnimal || "human") ? "selected" : ""}>${name}</option>`).join("")}</select></label>
              <label>显示大小<select name="petDisplaySize">${[48, 68, 96, 128].map((size) => `<option value="${size}" ${size === (s.petDisplaySize || 68) ? "selected" : ""}>${size} px</option>`).join("")}</select></label>
            </div>
            <label class="ws-settings-check"><input type="checkbox" name="petMoodDecayEnabled" ${s.petMoodDecayEnabled !== false ? "checked" : ""} /><span>随互动和陪伴时间变化心情</span></label>
            <label class="ws-settings-check"><input type="checkbox" name="petPreventSleepEnabled" ${s.petPreventSleepEnabled !== false ? "checked" : ""} /><span>宠物开启期间保持电脑唤醒</span></label>
            <label class="ws-settings-check"><input type="checkbox" name="todoReminderEnabled" ${s.todoReminderEnabled ? "checked" : ""} /><span>通过宠物气泡提醒待办任务</span></label>
            <label>任务提醒间隔（分钟）<input type="number" name="todoReminderMinutes" min="45" max="240" value="${attr(s.todoReminderMinutes || 60)}" /></label>
            <p class="ws-settings-desc">每 45–240 分钟提醒一次，优先关注逾期、今日到期和高优先任务。点击气泡打开待办。</p>
          </section>
          <section class="ws-settings-card" ${panel("shortcuts")}>
            <h2>全局快捷键</h2>
            <p class="ws-settings-desc">需包含 Ctrl / Alt / Shift 等修饰键。保存后立即生效。</p>
            <div class="form-columns">
              <label>唤出面板<input name="globalChatHotkey" value="${attr(s.globalChatHotkey || "Alt+Q")}" placeholder="Alt+Q" /></label>
              <label>全屏截图<input name="quickScreenshotHotkey" value="${attr(s.quickScreenshotHotkey || "Ctrl+Shift+S")}" placeholder="Ctrl+Shift+S" /></label>
              <label>框选截图<input name="regionScreenshotHotkey" value="${attr(s.regionScreenshotHotkey || "Ctrl+Shift+R")}" placeholder="Ctrl+Shift+R" /></label>
            </div>
          </section>

          <section class="ws-settings-card ws-network-settings" ${panel("proxy")}>
            <div class="ws-network-heading"><div><h2>AI 连接方式</h2><p class="ws-settings-desc">适用于 AI 对话、人物分身和截图分析。保存后对新请求生效。</p></div><span class="ws-network-badge">已保存：${s.aiNetworkMode !== 'system' ? '直连' : '跟随系统'}</span></div>
            <fieldset class="ws-network-choices"><legend class="visually-hidden">AI 请求连接方式</legend>
              <label class="ws-network-choice"><input type="radio" name="aiNetworkMode" value="direct" ${s.aiNetworkMode !== 'system' ? 'checked' : ''}/><span><strong>直连</strong><small>绕过系统代理、PAC 和代理环境变量，直接连接 AI 服务。</small></span></label>
              <label class="ws-network-choice"><input type="radio" name="aiNetworkMode" value="system" ${s.aiNetworkMode === 'system' ? 'checked' : ''}/><span><strong>跟随系统</strong><small>使用 Windows / macOS 的代理和 PAC，按系统规则选择线路。</small></span></label>
            </fieldset>
            <div class="ws-network-tip">遇到代理连接错误，可选择“直连”后保存并测试；如果网络访问 AI 服务需要代理，请使用“跟随系统”。此选项不改动电脑的系统代理。</div>
            <p class="ws-settings-desc">默认使用直连，已保存的选择会在更新和重启后保留。${api.platform === 'darwin' ? '公司在开机时写入的 PAC 仍会保留；选择直连后，本程序的 AI 请求不受它影响，无需手动关闭系统 PAC。' : '系统代理自动维护是独立的可选功能。'}</p>
            <div class="ws-settings-actions"><button class="module-primary" type="button" data-module-action="settings-save">保存网络设置</button><button type="button" data-module-action="network-test" ${networkTesting ? 'disabled' : ''}>${networkTesting ? '正在测试…' : '保存并测试 AI 连接'}</button><button type="button" data-module-action="ai-settings">API 与密钥设置</button></div>
            ${api.platform === 'darwin' ? '' : `<details class="ws-proxy-advanced" ${s.proxyForceEnabled ? 'open' : ''}>
              <summary><span>Windows 系统代理自动维护</span><small>${s.proxyForceEnabled ? '已启用' : '未启用 · 可选'}</small></summary>
              <p class="ws-settings-desc">需要定期保持电脑的代理配置时再开启。它影响其他软件，与上方 AI 连接方式独立。</p>
              <label class="ws-settings-check"><input type="checkbox" name="proxyForceEnabled" ${s.proxyForceEnabled ? 'checked' : ''}/><span>启用系统代理自动维护</span></label>
              <div class="form-columns"><label>配置方式<select name="proxyForceMode">${option('manual', mode, '手动地址与端口')}${option('pac', mode, 'PAC 自动配置脚本')}</select></label><label>维护间隔（分钟）<input name="proxyRefreshMinutes" type="number" min="1" max="60" value="${attr(s.proxyRefreshMinutes ?? 3)}"/></label></div>
              <div class="ws-settings-mode ${mode === 'pac' ? 'is-pac' : 'is-manual'}">
                <label class="ws-settings-pac">PAC 脚本地址<input name="proxyPacUrl" type="url" value="${attr(s.proxyPacUrl || '')}" placeholder="https://proxy.example.com/proxy.pac"/></label>
                <div class="form-columns ws-settings-manual"><label>代理主机<input name="proxyServer" value="${attr(s.proxyServer || '')}" placeholder="127.0.0.1 或 http://127.0.0.1:7890"/></label><label>端口<input name="proxyPort" type="number" min="1" max="65535" value="${attr(s.proxyPort ?? 8080)}"/></label></div>
              </div>
              <label>不经过代理的地址<input name="proxyBypass" value="${attr(s.proxyBypass || '')}" placeholder="localhost;127.*;&lt;local&gt;"/></label>
              <details class="ws-proxy-presets"><summary>备用 PAC（可选）</summary><div class="form-columns"><label>上海 PAC<input name="proxyPacUrlShanghai" type="url" value="${attr(s.proxyPacUrlShanghai || '')}"/></label><label>北京 PAC<input name="proxyPacUrlBeijing" type="url" value="${attr(s.proxyPacUrlBeijing || '')}"/></label></div><div class="ws-settings-actions"><button type="button" data-module-action="settings-use-shanghai">使用上海 PAC 并启用维护</button><button type="button" data-module-action="settings-use-beijing">使用北京 PAC 并启用维护</button></div></details>
              <p class="ws-settings-desc">停用维护或退出软件时，会尝试恢复开启前的配置；其他软件已改动的设置不会被覆盖。旧版遗留且没有恢复记录的代理，请在 Windows 设置中检查。</p>
              <div class="ws-settings-actions"><button type="button" data-module-action="network-open-system">打开 Windows 代理设置</button></div>
            </details>`}
          </section>
          <div ${panel("sync")}>${githubUI?.render() || ""}</div>
          <section class="ws-settings-card" ${panel("about")}>
            <h2>关于与更新</h2>
            <div data-app-update-slot="settings">${helpers.updateUI?.renderSettings() || '<p class="ws-settings-desc">当前环境不支持应用内更新。</p>'}</div>
          </section>
        </form>
        ${settingsError ? `<div class="module-error" role="alert">${esc(settingsError)}</div>` : ""}
        ${settingsMessage ? `<div class="ws-settings-ok" role="status">${esc(settingsMessage)}</div>` : ""}
      </section>`;
    }

    function option(value, current, label = value) {
      return `<option value="${attr(value)}" ${value === current ? "selected" : ""}>${esc(label)}</option>`;
    }

    function renderModal() {
      if (!modal) return projectManager.renderModal();
      const draftItem = { ...(modal.item || {}) };
      for (const [key, val] of Object.entries(modal.draft || {})) {
        draftItem[({ raci: "RaciRole", energy: "EnergyLevel" })[key] || key[0].toUpperCase() + key.slice(1)] = val;
      }
      if (modal.type === "ai-settings") {
        const settings = { ...(aiSettings || {}), ...(modal.draft || {}) };
        const profiles = (settings.modelProfiles || [])
          .map((profile) => option(profile.model, settings.model, profile.name || profile.model))
          .join("");
        return `<div class="module-modal-backdrop"><form class="module-modal ws-ai-settings" data-form="ai-settings" onsubmit="return false;">
          <h2>AI 设置</h2>
          <label>API 端点<input name="apiEndpoint" value="${attr(settings.apiEndpoint || "")}" placeholder="https://api.openai.com/v1" /></label>
          <label>API Key<input name="apiKey" type="password" value="${attr(settings.apiKey || "")}" placeholder="sk-..." /></label>
          <label>模型<input name="model" list="ws-ai-models" value="${attr(settings.model || "")}" /></label>
          <datalist id="ws-ai-models">${profiles}</datalist>
          <label>AI 请求连接方式<select name="aiNetworkMode">${option('direct', settings.aiNetworkMode || 'direct', '直连')}${option('system', settings.aiNetworkMode || 'direct', '跟随系统代理 / PAC')}</select></label>
          <label>系统提示词<textarea name="globalChatSystemPrompt" rows="5" placeholder="留空使用默认提示词">${esc(settings.globalChatSystemPrompt || "")}</textarea></label>
          <p class="ws-ai-settings-hint">${api.platform === "darwin" ? "配置保存在 Application Support/DanceMonkey/config.json；连接方式与“网络连接”设置同步。" : "与旧版共用 %AppData%\\DanceMonkey\\config.json；可选择直连或跟随系统代理。"}</p>
          ${error ? `<div class="module-error">${esc(error)}</div>` : ""}
          <div class="module-modal-actions">
            <button type="button" data-module-action="close-modal">取消</button>
            <button type="button" data-module-action="ai-test">测试连接</button>
            <button class="module-primary" type="button" data-module-action="save-modal">保存</button>
          </div>
        </form></div>`;
      }
      if (modal.type === "task") {
        const item = draftItem;
        const projectId = field(item, "ProjectId");
        const currentPriority = modal.draft?.priority || priority(item)[0];
        return `<div class="module-modal-backdrop"><form class="module-modal" data-form="task" onsubmit="return false;">
          <h2>${modal.id ? "编辑任务" : "新建任务"}</h2>
          <label>标题<input name="title" required value="${attr(field(item, "Title"))}" /></label>
          <div class="form-columns">
            <label>项目<select name="projectId"><option value="">未分配</option>${projects.filter((p) => !window.DMZenModel.archived(p) || field(p, "Id") === projectId).map((p) => option(field(p, "Id"), projectId, field(p, "Name") + (window.DMZenModel.archived(p) ? "（已归档）" : ""))).join("")}</select></label>
            <label>里程碑<select name="milestoneId"><option value="">未分配阶段</option>${window.DMZenModel.list(projects.find((p) => field(p, "Id") === projectId), "Milestones").map((stage) => option(field(stage, "Id"), field(item, "MilestoneId"), field(stage, "Name"))).join("")}</select></label>
            <label>优先级<select name="priority">${[["Urgent & Important", "紧急且重要"], ["Not Urgent & Important", "重要不紧急"], ["Urgent & Not Important", "紧急不重要"], ["Medium", "普通"], ["Low", "低"]].map(([p, label]) => option(p, currentPriority, label)).join("")}</select></label>
            <label>责任角色<select name="raci">${["Responsible", "Accountable", "Consulted", "Informed"].map((p) => option(p, field(item, "RaciRole", "Responsible"))).join("")}</select></label>
            <label>能量<select name="energy">${["Low", "Medium", "High"].map((p) => option(p, field(item, "EnergyLevel", "Medium"))).join("")}</select></label>
            <label>状态<select name="workflowStatus">${[["Todo", "待办"], ["In Progress", "进行中"], ["Blocked", "受阻"], ["Completed", "完成"]].map(([p, label]) => option(p, isDone(item) ? "Completed" : field(item, "WorkflowStatus", "Todo"), label)).join("")}</select></label>
            <label>截止日期<input name="dueDate" type="date" value="${attr(dateValue(field(item, "DueDate")))}" /></label>
          </div>
          <label>标签<input name="tags" value="${attr(field(item, "Tags"))}" /></label>
          <label>备注<textarea name="notes" rows="4">${esc(field(item, "Notes"))}</textarea></label>
          ${field(item, "SourceNotePath") ? `<div class="pm-source-line">来源笔记：<button type="button" data-module-action="pm-open-note" data-id="${attr(field(item, "SourceNotePath"))}">${esc(field(item, "SourceNotePath"))}</button>${field(item, "SourceExcerpt") ? `<small>${esc(field(item, "SourceExcerpt"))}</small>` : ""}</div>` : ""}
          ${error ? `<div class="module-error">${esc(error)}</div>` : ""}
          <div class="module-modal-actions"><button type="button" data-module-action="close-modal">取消</button><button class="module-primary" type="button" data-module-action="save-modal">保存</button></div>
        </form></div>`;
      }
      if (modal.type === "project") {
        const item = draftItem;
        return `<div class="module-modal-backdrop"><form class="module-modal" data-form="project" onsubmit="return false;">
          <h2>${modal.id ? "编辑项目" : "新建项目"}</h2>
          <label>项目名称<input name="name" required value="${attr(field(item, "Name"))}" /></label>
          <div class="form-columns">
            <label>负责人<input name="owner" value="${attr(field(item, "Owner"))}" /></label>
            <label>优先级<select name="priority">${[["Low", "低"], ["Medium", "中"], ["High", "高"], ["Critical", "紧急"]].map(([p, label]) => option(p, field(item, "Priority", "Medium"), label)).join("")}</select></label>
            <label>生命周期<select name="lifecycleStatus">${[["Planned", "计划中"], ["In Progress", "进行中"], ["Paused", "已暂停"], ["Completed", "已完成"]].map(([p, label]) => option(p, modal.id ? window.DMZenModel.lifecycle(item) : "Planned", label)).join("")}</select></label>
            <label>健康度<select name="status">${[["On Track", "正常"], ["At Risk", "有风险"], ["Blocked", "受阻"]].map(([p, label]) => option(p, window.DMZenModel.health(item), label)).join("")}</select></label>
            <label>分类<input name="category" value="${attr(field(item, "Category"))}" placeholder="例如：产品研发" /></label>
            <label>截止日期<input name="dueDate" type="date" value="${attr(dateValue(field(item, "DueDate")))}" /></label>
          </div>
          <label>背景说明<textarea name="description" rows="2">${esc(field(item, "Description"))}</textarea></label>
          <label>项目目标<textarea name="goal" rows="2" placeholder="这个项目要解决什么问题？">${esc(field(item, "Goal"))}</textarea></label>
          <label>完成标准<textarea name="acceptanceCriteria" rows="2" placeholder="交付什么成果，才算完成？">${esc(field(item, "AcceptanceCriteria"))}</textarea></label>
          <label>下一步行动<input name="nextAction" value="${attr(field(item, "NextAction"))}" placeholder="一件可以立即推进的事" /></label>
          <label>阻塞与风险<textarea name="blockers" rows="2">${esc(field(item, "Blockers"))}</textarea></label>
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
      if (section !== "settings") githubUI?.pause();
      if (section === "personas") return personaManager?.render() || '<div class="module-empty">请在桌面版中使用人物分身。</div>';
      if (section === "ai") return renderAi();
      if (section === "settings") return renderAppSettings();
      if (section === "tasks") return renderTasks();
      if (section === "projects") return projectManager.render();
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
      const isMac = api.platform === "darwin";
      return {
        ...(appSettings || {}),
        petModeEnabled: Boolean(form.querySelector('[name="petModeEnabled"]')?.checked),
        petAnimal: values.petAnimal || appSettings?.petAnimal || "human",
        petDisplaySize: Number(values.petDisplaySize) || 68,
        petMoodDecayEnabled: Boolean(form.querySelector('[name="petMoodDecayEnabled"]')?.checked),
        petPreventSleepEnabled: Boolean(form.querySelector('[name="petPreventSleepEnabled"]')?.checked),
        todoReminderEnabled: Boolean(form.querySelector('[name="todoReminderEnabled"]')?.checked),
        todoReminderMinutes: Number(values.todoReminderMinutes) || 60,
        globalChatHotkey: values.globalChatHotkey,
        quickScreenshotHotkey: values.quickScreenshotHotkey,
        regionScreenshotHotkey: values.regionScreenshotHotkey,
        aiNetworkMode: values.aiNetworkMode || appSettings?.aiNetworkMode || 'direct',
        proxyForceEnabled: isMac ? Boolean(appSettings?.proxyForceEnabled) : Boolean(form.querySelector('[name="proxyForceEnabled"]')?.checked),
        proxyForceMode: (values.proxyForceMode ?? appSettings?.proxyForceMode) === "pac" ? "pac" : "manual",
        proxyPacUrl: values.proxyPacUrl ?? appSettings?.proxyPacUrl ?? "",
        proxyServer: values.proxyServer ?? appSettings?.proxyServer ?? "",
        proxyPort: Number(values.proxyPort ?? appSettings?.proxyPort) || 8080,
        proxyBypass: values.proxyBypass ?? appSettings?.proxyBypass ?? "",
        proxyRefreshMinutes: Number(values.proxyRefreshMinutes ?? appSettings?.proxyRefreshMinutes) || 3,
        proxyPacUrlShanghai: values.proxyPacUrlShanghai ?? appSettings?.proxyPacUrlShanghai ?? "",
        proxyPacUrlBeijing: values.proxyPacUrlBeijing ?? appSettings?.proxyPacUrlBeijing ?? "",
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
      githubUI?.capture();
      const payload = { ...readSettingsForm(), ...extra };
      appSettings = payload;
      let result;
      try { result = await api.settings.save(payload); }
      catch (cause) { result = { success: false, error: cause?.message || "保存失败" }; }
      if (!result?.success) {
        settingsError = result?.error || "保存失败";
        rerender();
        return false;
      }
      appSettings = result.settings;
      if(aiSettings) aiSettings={...aiSettings,aiNetworkMode:appSettings.aiNetworkMode};
      settingsMessage = result.settings?.proxyNotice || "设置已保存并生效";
      rerender();
      return true;
    }

    async function handleAction(action, id, setSection) {
      if (await githubUI?.handleAction(action)) return true;
      if (await projectManager.handleAction(action, id)) return true;
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
      if (action === 'network-open-system') {
        try { const result = await api.settings?.openSystemProxy?.(); if (!result?.success) throw Error('请在 Windows 系统设置中打开“网络和 Internet → 代理”。'); }
        catch(cause) { settingsError = cause.message; rerender(); }
        return true;
      }
      if (action === 'network-test') {
        if (networkTesting) return true;
        networkTesting = true;
        try {
          if (!await saveAppSettings()) return true;
          settingsMessage = ''; settingsError = ''; rerender();
          if (appSettings.aiNetworkMode !== 'direct') await api.settings?.refreshProxy?.();
          const result = await api.ai.chat({requestId:`network-test-${Date.now()}`,systemPrompt:'连接测试，请简短回答。',messages:[{role:'user',content:'请回复 OK'}],maxTokens:128,timeoutMs:15000});
          if (!result.success) throw Error(result.error || 'AI 连接测试失败');
          settingsMessage = 'AI 服务响应正常，连接测试成功。';
        } catch(cause) { settingsError = cause.message || '连接测试失败，请检查 API 设置与连接方式。'; }
        finally { networkTesting = false; rerender(); }
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
        aiNotice = "";
        aiFollowOutput = true;
        await persistAiMessages([]);
        rerender();
        return true;
      }
      if (action === "ai-prompt") {
        if (aiBusy) return true;
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
      if (action === "ai-retry") {
        await sendAi(true);
        return true;
      }
      if (action === "ai-copy") {
        const message = aiMessages[Number(id)];
        if (!message || message.role !== "assistant") return true;
        try {
          await navigator.clipboard.writeText(String(message.content || ""));
          const button = document.querySelector(`[data-module-action="ai-copy"][data-value="${Number(id)}"]`);
          if (button) { button.innerHTML = `${aiIcon("check")}<span>已复制</span>`; button.setAttribute("aria-label", "回复已复制"); }
        } catch {
          aiNotice = "复制失败，请选中文字后复制";
          const status = document.querySelector(".ws-ai-status");
          if (status) status.textContent = aiNotice;
        }
        return true;
      }
      if (action === "ai-bottom") {
        aiFollowOutput = true;
        const box = document.querySelector(".ws-ai-messages");
        if (box) box.scrollTop = box.scrollHeight;
        const button = document.querySelector(".ws-ai-to-bottom");
        if (button) button.hidden = true;
        return true;
      }
      if (action === "ai-stop") {
        if (!aiBusy || aiStopped) return true;
        aiStopped = true;
        const status = document.querySelector(".ws-ai-status");
        if (status) status.textContent = "正在停止…";
        const stop = document.querySelector('[data-module-action="ai-stop"]');
        if (stop) stop.disabled = true;
        if (aiRequestId && api.ai?.cancel) {
          try { await api.ai.cancel(aiRequestId); }
          catch { aiNotice = "正在结束当前回复…"; }
        }
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
        await projectManager.open(id);
        await setSection("projects");
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
      if (modalSaving) return;
      const form = document.querySelector("form.module-modal");
      if (!form || !modal) return;
      if (typeof form.reportValidity === "function" && !form.reportValidity()) return;
      const values = Object.fromEntries(new FormData(form));
      modal.draft = values;
      modalSaving = true;
      const saveButton = form.querySelector('[data-module-action="save-modal"]');
      if (saveButton) saveButton.disabled = true;
      try {
        if (form.dataset.form === "ai-settings") {
          if (!api.ai?.saveSettings) throw new Error("当前环境不支持保存 AI 设置");
          aiSettings = await api.ai.saveSettings({
            apiEndpoint: values.apiEndpoint,
            apiKey: values.apiKey,
            model: values.model,
            globalChatSystemPrompt: values.globalChatSystemPrompt,
            aiNetworkMode: values.aiNetworkMode || "direct",
          });
          appSettings = { ...(appSettings || {}), aiNetworkMode: aiSettings.aiNetworkMode || "direct" };
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
      } finally {
        modalSaving = false;
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
          aiNetworkMode: values.aiNetworkMode || "direct",
        });
        appSettings = { ...(appSettings || {}), aiNetworkMode: aiSettings.aiNetworkMode || "direct" };
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

    async function sendAi(retry = false) {
      if (aiBusy) return;
      const input = document.querySelector(".ws-ai-input");
      const draft = String(input?.value ?? aiDraft).trim();
      if (retry ? aiMessages.at(-1)?.role !== "user" : !draft) return;
      if (!api.ai?.chat) {
        aiError = "浏览器预览不连接 AI，请使用桌面模式。";
        rerender();
        return;
      }
      const selectedModel = document.querySelector(".ws-ai-model")?.value;
      const selectedSnippet = document.querySelector(".ws-ai-snippet")?.value;
      if (selectedSnippet !== undefined) aiSnippet = selectedSnippet;
      const history = retry ? [...aiMessages] : [...aiMessages, { role: "user", content: draft }];
      // Own the turn before the first asynchronous settings or persistence call.
      aiBusy = true;
      aiStopped = false;
      aiError = "";
      aiNotice = "";
      aiStreamingText = "";
      aiFollowOutput = true;
      aiRequestId = `ws-ai-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      let historySaved = retry;
      rerender();
      try {
        if (!aiSettings) aiSettings = await api.ai.getSettings();
        if (selectedModel && selectedModel !== aiSettings.model) {
          aiSettings = { ...aiSettings, model: selectedModel };
          await api.ai.saveSettings(aiSettings);
        }
        if (aiStopped) { aiNotice = "已停止"; return; }
        const snippet = aiSnippet !== "" ? aiSettings.promptSnippets?.[Number(aiSnippet)] : null;
        const systemPrompt = snippet?.systemPrompt || aiSettings.globalChatSystemPrompt || "";
        if (!retry) await persistAiMessages(history);
        historySaved = true;
        aiDraft = "";
        rerender();
        if (aiStopped) { aiNotice = "已停止"; return; }
        unsubscribeChunk?.();
        unsubscribeChunk = api.ai.onChunk?.(({ requestId, chunk }) => {
          if (requestId !== aiRequestId) return;
          aiStreamingText += chunk;
          updateStreamingDom();
        });
        const result = await api.ai.chat({ requestId: aiRequestId, model: aiSettings.model, systemPrompt, messages: history });
        if (!result.success && !aiStopped) throw new Error(result.error || "回复未完成，请重试。");
        const answer = result.text || aiStreamingText || "";
        if (answer.trim()) await persistAiMessages([...history, { role: "assistant", content: answer }]);
        else if (!aiStopped) throw new Error("没有收到回复内容，请重试或检查模型设置。");
        if (aiStopped) aiNotice = answer ? "已停止 · 已保留生成内容" : "已停止";
      } catch (cause) {
        if (aiStopped) {
          aiNotice = "已停止";
          if (historySaved && aiStreamingText) {
            try {
              await persistAiMessages([...history, { role: "assistant", content: aiStreamingText }]);
              aiNotice = "已停止 · 已保留生成内容";
            } catch (error) { aiError = error?.message || "保存回复失败，请重试。"; }
          }
        } else aiError = cause?.message || "回复未完成，请重试。";
        if (!historySaved) aiDraft = draft;
      } finally {
        unsubscribeChunk?.();
        unsubscribeChunk = null;
        aiBusy = false;
        aiStreamingText = "";
        aiRequestId = null;
        rerender();
        requestAnimationFrame(() => document.querySelector(".ws-ai-input")?.focus());
      }
    }

    function closeModal() {
      if (!modal && projectManager.closeModal()) return true;
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
      personaManager?.bind(scope);
      projectManager.bind(scope);
      const taskProject = scope.querySelector('form[data-form="task"] select[name="projectId"]');
      if (taskProject) taskProject.onchange = () => {
        const select = scope.querySelector('form[data-form="task"] select[name="milestoneId"]');
        const chosen = projects.find((p) => field(p, "Id") === taskProject.value);
        select.innerHTML = `<option value="">未分配阶段</option>${window.DMZenModel.list(chosen, "Milestones").map((stage) => option(field(stage, "Id"), "", field(stage, "Name"))).join("")}`;
      };
      const search = scope.querySelector(".module-search:not([data-pm-search])");
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
      petPicker?.destroy(); petPicker = null;
      const pickerRoot = scope.querySelector('[data-pet-picker]');
      if (pickerRoot && window.DMPetPicker) petPicker = window.DMPetPicker.mount(pickerRoot, {
        animals: petAnimals, input: scope.querySelector('[name="petAnimal"]'), active: settingsTab === 'pet',
      });
      const tabs = [...scope.querySelectorAll("[data-settings-tab]")];
      const select = (id, focus = false) => {
        const current = settingsTabs.find((tab) => tab.id === id);
        if (!current) return;
        settingsTab = id;
        petPicker?.setActive(id === 'pet');
        for (const tab of tabs) {
          const selected = tab.dataset.settingsTab === id;
          tab.setAttribute("aria-selected", String(selected));
          tab.tabIndex = selected ? 0 : -1;
          if (selected && focus) tab.focus();
        }
        for (const panel of scope.querySelectorAll("[data-settings-panel]")) {
          panel.hidden = panel.dataset.settingsPanel !== id;
        }
        const actions = scope.querySelector("[data-settings-actions]");
        if (actions) actions.hidden = !editableSettingsTab(id);
        const description = scope.querySelector("[data-settings-description]");
        if (description) description.textContent = current.description;
      };
      for (const [index, tab] of tabs.entries()) {
        tab.onclick = (event) => { event.preventDefault(); event.stopPropagation(); select(tab.dataset.settingsTab); };
        tab.onkeydown = (event) => {
          let next;
          if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
          else if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
          else if (event.key === "Home") next = 0;
          else if (event.key === "End") next = tabs.length - 1;
          else return;
          event.preventDefault(); event.stopPropagation();
          select(tabs[next].dataset.settingsTab, true);
        };
      }
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
      const box = scope.querySelector(".ws-ai-messages");
      if (box) {
        box.onscroll = () => {
          aiScrollTop = box.scrollTop;
          aiFollowOutput = box.scrollHeight - box.scrollTop - box.clientHeight < 64;
          const button = scope.querySelector(".ws-ai-to-bottom");
          if (button) button.hidden = aiFollowOutput;
        };
        requestAnimationFrame(() => { box.scrollTop = aiFollowOutput ? box.scrollHeight : aiScrollTop; });
      }
      const input = scope.querySelector(".ws-ai-input");
      if (input) {
        const resize = () => {
          input.style.height = "auto";
          input.style.height = `${Math.min(168, Math.max(56, input.scrollHeight))}px`;
          input.style.overflowY = input.scrollHeight > 168 ? "auto" : "hidden";
        };
        input.oninput = () => {
          aiDraft = input.value;
          resize();
          const send = scope.querySelector('[data-module-action="ai-send"]');
          if (send) send.disabled = !aiDraft.trim();
        };
        input.onkeydown = (event) => {
          if (event.isComposing || event.keyCode === 229) return;
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void sendAi();
          }
        };
        requestAnimationFrame(resize);
      }
      const modelSelect = scope.querySelector(".ws-ai-model");
      if (modelSelect) {
        modelSelect.onchange = async () => {
          if (!aiSettings || !api.ai?.saveSettings || aiBusy) return;
          try {
            const settings = { ...aiSettings, model: modelSelect.value };
            await api.ai.saveSettings(settings);
            aiSettings = settings;
          } catch (cause) { aiError = cause?.message || "保存模型设置失败"; rerender(); }
        };
      }
      const snippetSelect = scope.querySelector(".ws-ai-snippet");
      if (snippetSelect) snippetSelect.onchange = () => { aiSnippet = snippetSelect.value; };
    }

    function syncAiMessages(messages) {
      if (aiBusy) return;
      aiMessages = Array.isArray(messages) ? messages : [];
      rerender();
    }

    function prepareSync() {
      if (["task", "project"].includes(modal?.type) || projectManager.hasPendingEdits()) {
        throw new Error("请先保存或关闭任务、项目编辑窗口，再同步或切换笔记库。");
      }
    }

    async function reloadVault() {
      modal = null;
      error = "";
      tasks = [];
      projects = [];
      projectManager.resetVault();
      await Promise.all([loadZen(), githubUI?.load()]);
    }

    return { pauseGitHub: () => githubUI?.pause(), disposePreviews: () => { petPicker?.destroy(); petPicker = null; }, prepareSync, reloadSyncedTasks: loadZen, reloadVault, loadAll, loadAi, render, renderModal, handleClick, bindSearch, closeModal, syncAiMessages, openProject: (id) => projectManager.open(id) };
  }

  window.DMWorkspaceModules = { create };
})();
