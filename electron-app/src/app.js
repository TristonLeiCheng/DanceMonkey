(() => {
  const INBOX = "inbox";
  const TODOS = "todos";
  const isElectron = Boolean(window.lumen);

  const icons = {
    note: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M7 3.75h7.2L19.25 8.8V20.25H7A1.25 1.25 0 0 1 5.75 19V5A1.25 1.25 0 0 1 7 3.75Z" stroke="currentColor" stroke-width="1.4"/><path d="M14 3.8V8.8h5.1" stroke="currentColor" stroke-width="1.4"/><path d="M8.5 12.5h7M8.5 16h5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    check: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none"><rect x="4.6" y="4.6" width="14.8" height="14.8" rx="2" stroke="currentColor" stroke-width="1.4"/><path d="M8 12.2 10.7 15l5.3-6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    ai: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M12 3.8 13.6 9l5.2 1.6-5.2 1.7-1.6 5.1-1.7-5.1-5.1-1.7L10.3 9 12 3.8Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="m18 15 .7 2.2 2.1.7-2.1.7L18 21l-.7-2.4-2.2-.7 2.2-.7L18 15Z" stroke="currentColor" stroke-width="1.2"/></svg>',
    books: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M6 5.5h6.5A2 2 0 0 1 14.5 7.5V19H7.2A2.2 2.2 0 0 1 5 16.8V6.7A1.2 1.2 0 0 1 6.2 5.5" stroke="currentColor" stroke-width="1.4"/><path d="M14.5 8.5H18a1.5 1.5 0 0 1 1.5 1.5V19H14.5" stroke="currentColor" stroke-width="1.4"/></svg>',
    search: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="5.25" stroke="currentColor" stroke-width="1.4"/><path d="M15.2 15.2 19 19" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    pin: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M9.5 10.5 7 13v2h2l2.5-2.5M14.8 4.8l4.4 4.4-6.6 3.2-3.2 6.6-1.8-1.8 6.6-3.2 3.2-6.6Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
    close: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M7 7l10 10M17 7 7 17" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    sun: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3.4" stroke="currentColor" stroke-width="1.4"/><path d="M12 4.5v1.6M12 17.9v1.6M4.5 12h1.6M17.9 12h1.6M6.5 6.5l1.1 1.1M16.4 16.4l1.1 1.1M17.5 6.5l-1.1 1.1M7.6 16.4 6.5 17.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    moon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M15.5 4.8A7.4 7.4 0 1 0 19.2 15 6.2 6.2 0 0 1 15.5 4.8Z" stroke="currentColor" stroke-width="1.4"/></svg>',
    plus: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M12 6v12M6 12h12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    back: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M14 6.5 8.5 12l5.5 5.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    expand: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M8.5 5H5v3.5M15.5 5H19v3.5M8.5 19H5v-3.5M15.5 19H19v-3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    power: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M12 4.6v7.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M7.6 7.3a6.2 6.2 0 1 0 8.8 0" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    link: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M10 13a5 5 0 0 0 7.1.1l1.8-1.8a5 5 0 0 0-7.1-7.1L10.6 5.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M14 11a5 5 0 0 0-7.1-.1L5.1 12.7a5 5 0 0 0 7.1 7.1l1.2-1.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    settings: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.4"/><path d="M12 3.75v1.7M12 18.55v1.7M3.75 12h1.7M18.55 12h1.7M6.05 6.05l1.2 1.2M16.75 16.75l1.2 1.2M17.95 6.05l-1.2 1.2M7.25 16.75l-1.2 1.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    workspace: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><rect x="4.5" y="4.5" width="6.5" height="6.5" rx="1.2" stroke="currentColor" stroke-width="1.4"/><rect x="13" y="4.5" width="6.5" height="6.5" rx="1.2" stroke="currentColor" stroke-width="1.4"/><rect x="4.5" y="13" width="6.5" height="6.5" rx="1.2" stroke="currentColor" stroke-width="1.4"/><rect x="13" y="13" width="6.5" height="6.5" rx="1.2" stroke="currentColor" stroke-width="1.4"/></svg>',
  };

  function createDefaultState() {
    const now = Date.now();
    return {
      theme: "dark",
      pinned: false,
      activeNotebookId: INBOX,
      activeNoteId: "welcome",
      notebooks: [
        { id: INBOX, name: "收件箱", system: true, createdAt: now },
        { id: TODOS, name: "待办", system: true, createdAt: now },
      ],
      notes: [
        {
          id: "welcome",
          notebookId: INBOX,
          title: "欢迎使用 DM",
          body: "从屏幕右缘唤出快捷轨，记下此刻的想法。\n\nCtrl+Enter 保存并收起，Esc 收起但保留草稿。内容会自动写入本地。",
          createdAt: now,
          updatedAt: now,
        },
      ],
      todos: [
        { id: "todo-1", notebookId: TODOS, title: "把 DM 钉在桌面右侧试试", done: false, createdAt: now },
      ],
      aiMessages: [],
    };
  }

  function newId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function createBrowserApi() {
    const key = "lumen-store";
    const zenKey = "lumen-browser-zentask";
    const linkKey = "lumen-browser-links";
    let state;
    try {
      state = { ...createDefaultState(), ...JSON.parse(localStorage.getItem(key) || "null") };
    } catch {
      state = createDefaultState();
    }
    const stateListeners = new Set();
    const shellListeners = new Set();
    const save = () => localStorage.setItem(key, JSON.stringify(state));
    save();

    function loadZen() {
      try {
        return (
          JSON.parse(localStorage.getItem(zenKey) || "null") || {
            tasks: [
              {
                Id: "demo1",
                ProjectId: "p1",
                Project: "产品升级",
                Title: "整理本周工作重点",
                Impact: 5,
                Urgency: 4,
                RaciRole: "Responsible",
                EnergyLevel: "Medium",
                WorkflowStatus: "Todo",
                DueDate: new Date().toISOString(),
                Notes: "浏览器预览数据，桌面模式会读写 NoteVault。",
                Tags: "focus",
              },
            ],
            projects: [
              {
                Id: "p1",
                Name: "产品升级",
                Owner: "",
                Progress: 20,
                Priority: "High",
                Status: "On Track",
                Category: "New Initiatives",
                Description: "示例项目",
              },
            ],
          }
        );
      } catch {
        return { tasks: [], projects: [] };
      }
    }

    function saveZen(next) {
      localStorage.setItem(zenKey, JSON.stringify(next));
      return next;
    }

    function loadLinks() {
      try {
        return (
          JSON.parse(localStorage.getItem(linkKey) || "null") || [
            {
              id: "custom-0",
              name: "DM 官网示例",
              path: "https://example.com",
              category: "web",
              description: "浏览器预览入口",
              group: "",
              clickCount: 0,
              lastClicked: null,
              pinned: true,
              detected: false,
            },
          ]
        );
      } catch {
        return [];
      }
    }

    function saveLinks(list) {
      localStorage.setItem(linkKey, JSON.stringify(list));
      return list;
    }

    return {
      platform: navigator.platform.toLowerCase().includes("mac") ? "darwin" : "win32",
      getState: async () => state,
      setState: async (partial) => {
        state = { ...state, ...partial };
        save();
        stateListeners.forEach((cb) => cb(state));
        return state;
      },
      setShell: async (mode) => shellListeners.forEach((cb) => cb(mode)),
      openWorkspace: async (section) => {
        location.hash = !section || section === "notes" ? "workspace" : `workspace/${section}`;
        location.reload();
      },
      onState: (cb) => {
        stateListeners.add(cb);
        return () => stateListeners.delete(cb);
      },
      onToggleQuick: () => () => undefined,
      onFocusTitle: () => () => undefined,
      onShellMode: (cb) => {
        shellListeners.add(cb);
        return () => shellListeners.delete(cb);
      },
      ai: {
        getSettings: async () => ({
          apiEndpoint: "",
          apiKey: "",
          model: "gpt-4o-mini",
          modelProfiles: [],
          promptSnippets: [],
          globalChatSystemPrompt: "",
        }),
        saveSettings: async (settings) => settings,
        chat: async () => ({ success: false, error: "浏览器预览不连接 AI，请使用桌面模式。" }),
        cancel: async () => false,
        onChunk: () => () => undefined,
      },
      screenshot: {
        quick: async () => ({ success: false, error: "浏览器预览不支持截屏" }),
        region: async () => ({ success: false, error: "浏览器预览不支持截屏" }),
        onFollowUp: () => () => undefined,
      },
      settings: {
        get: async () => ({
          globalChatHotkey: "Alt+Q",
          quickScreenshotHotkey: "Ctrl+Shift+S",
          regionScreenshotHotkey: "Ctrl+Shift+R",
          proxyForceEnabled: false,
          proxyForceMode: "manual",
          proxyPacUrl: "",
          proxyServer: "",
          proxyPort: 8080,
          proxyBypass: "",
          proxyRefreshMinutes: 3,
          proxyPacUrlShanghai: "",
          proxyPacUrlBeijing: "",
        }),
        save: async (payload) => ({ success: true, settings: payload }),
        applyProxy: async () => ({ success: false, error: "浏览器预览无法写入系统代理" }),
      },
      zenTask: window.DMZenModel.previewApi(loadZen, saveZen),
      quickAccess: {
        list: async () => loadLinks(),
        add: async (input) => {
          const links = loadLinks();
          links.push({
            id: `custom-${links.length}`,
            ...input,
            clickCount: 0,
            lastClicked: null,
            pinned: false,
            detected: false,
          });
          return saveLinks(links.map((item, index) => ({ ...item, id: item.detected ? item.id : `custom-${index}` })));
        },
        update: async (id, input) => {
          const links = loadLinks().map((item) => (item.id === id ? { ...item, ...input } : item));
          return saveLinks(links);
        },
        remove: async (id) => saveLinks(loadLinks().filter((item) => item.id !== id)),
        togglePin: async (id) =>
          saveLinks(loadLinks().map((item) => (item.id === id ? { ...item, pinned: !item.pinned } : item))),
        open: async (id) => {
          const links = loadLinks();
          const item = links.find((entry) => entry.id === id);
          if (item && /^https?:/i.test(item.path)) window.open(item.path, "_blank");
          return links;
        },
      },
    };
  }

  const api = window.lumen || createBrowserApi();

  function escapeHtml(value) {
    return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  }

  function escapeAttr(value) {
    return escapeHtml(value).replaceAll('"', "&quot;");
  }

  function formatTime(ts) {
    return new Date(ts).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function createOverlay(root, options = {}) {
    let state = null;
    let mode = options.mode || "collapsed";
    let tab = "notes";
    // 面板内的浮层，同一块玻璃里切换：null | "books" | "search" | "links" | "ai-settings"
    let sheet = null;
    let query = "";
    let renamingId = null;
    let renameValue = "";
    let pendingDeleteId = null;
    let pendingQuit = false;
    let newBookName = "";
    let aiSettings = null;
    let aiDraft = "";
    let aiBusy = false;
    let aiRequestId = null;
    let aiStreamingText = "";
    let aiError = "";
    let activeSnippet = "";
    let leaveTimer = null;
    let railGraceUntil = 0;
    const RAIL_LEAVE_DELAY_MS = 750;
    const RAIL_ENTER_GRACE_MS = 550;

    let skipRender = false;
    let zenTasks = [];
    let zenProjects = [];
    let quickLinks = [];
    let zenError = "";

    function zenField(item, name, fallback = "") {
      const camel = name[0].toLowerCase() + name.slice(1);
      return item?.[name] ?? item?.[camel] ?? fallback;
    }

    function zenDate(value) {
      return value ? String(value).slice(0, 10) : "";
    }

    function zenPriority(task) {
      const impact = Number(zenField(task, "Impact", 3));
      const urgency = Number(zenField(task, "Urgency", 3));
      if (impact >= 4 && urgency >= 4) return ["紧急重要", "q1"];
      if (impact >= 4) return ["重要", "q2"];
      if (urgency >= 4) return ["紧急", "q3"];
      return ["常规", "q4"];
    }

    function zenDone(task) {
      return ["Completed", "Done"].includes(zenField(task, "WorkflowStatus"));
    }

    function applyZen(data) {
      zenTasks = data?.tasks || [];
      zenProjects = data?.projects || [];
    }

    async function loadZenTasks() {
      try {
        zenError = "";
        applyZen(await api.zenTask.load());
      } catch (error) {
        zenError = error?.message || "无法加载 Zen Task";
      }
      render();
    }

    async function loadQuickLinks() {
      try {
        zenError = "";
        quickLinks = await api.quickAccess.list();
      } catch (error) {
        zenError = error?.message || "无法加载快速访问";
      }
      render();
    }

    function zenStats() {
      const open = zenTasks.filter((task) => !zenDone(task));
      const today = new Date().toISOString().slice(0, 10);
      return {
        open: open.length,
        urgent: open.filter((task) => zenPriority(task)[1] === "q1").length,
        overdue: open.filter((task) => {
          const due = zenDate(zenField(task, "DueDate"));
          return due && due < today;
        }).length,
      };
    }

    // 每个请求都返回完整快照，迟到的旧快照会把新状态覆盖掉，这里按修订号丢弃
    function adopt(next) {
      if (!next) return false;
      if (state && typeof next.revision === "number" && typeof state.revision === "number") {
        if (next.revision < state.revision) return false;
      }
      state = next;
      return true;
    }

    api.onState((next) => {
      if (adopt(next) && !skipRender) render();
    });
    api.onShellMode((next) => {
      mode = next;
      render();
    });
    api.onToggleQuick(() => void openPanel("notes", "none"));
    api.onFocusTitle(() => focusLater(".title-input"));
    api.screenshot?.onFollowUp?.(() => {
      void openAiPanel();
    });
    api.ai.onChunk(({ requestId, chunk }) => {
      if (requestId !== aiRequestId) return;
      aiStreamingText += chunk;
      const bubble = root.querySelector(".ai-message.streaming .ai-message-body");
      if (bubble) bubble.innerHTML = renderAiMarkdown(aiStreamingText);
      const messages = root.querySelector(".ai-messages");
      if (messages) messages.scrollTop = messages.scrollHeight;
    });

    function focusLater(selector) {
      requestAnimationFrame(() => root.querySelector(selector)?.focus());
    }

    async function persist(partial) {
      adopt(await api.setState(partial));
      render();
    }

    async function openPanel(nextTab, kind) {
      if (leaveTimer) clearTimeout(leaveTimer);
      tab = nextTab;
      mode = "panel";
      sheet = null;
      await api.setShell("panel");
      if (!state) adopt(await api.getState());
      if (kind === "todo" || nextTab === "todos") await loadZenTasks();
      else render();
      if (kind === "todo") focusLater(".zen-input");
    }

    async function openLinksSheet() {
      if (mode !== "panel") {
        await openPanel(tab === "ai" ? "notes" : tab, "none");
      }
      sheet = "links";
      await loadQuickLinks();
      focusLater(".links-sheet .sheet-list");
    }

    function collapse() {
      if (leaveTimer) {
        clearTimeout(leaveTimer);
        leaveTimer = null;
      }
      mode = "collapsed";
      sheet = null;
      void api.setShell("collapsed");
      render();
    }

    function enterRail() {
      if (mode !== "collapsed") return;
      if (leaveTimer) {
        clearTimeout(leaveTimer);
        leaveTimer = null;
      }
      railGraceUntil = Date.now() + RAIL_ENTER_GRACE_MS;
      mode = "rail";
      void api.setShell("rail");
      render();
    }

    function leaveRail(event) {
      if (mode !== "rail") return;
      // 仍在快捷轨或其子节点内时忽略（含 DOM 替换后的抖动）
      const next = event?.relatedTarget;
      if (next && root.contains(next)) return;
      if (Date.now() < railGraceUntil) return;
      if (leaveTimer) clearTimeout(leaveTimer);
      leaveTimer = setTimeout(() => {
        leaveTimer = null;
        if (mode === "rail") collapse();
      }, RAIL_LEAVE_DELAY_MS);
    }

    function stayOnRail() {
      if (leaveTimer) {
        clearTimeout(leaveTimer);
        leaveTimer = null;
      }
    }

    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (sheet) {
          sheet = null;
          render();
          return;
        }
        if (mode === "panel" && !state?.pinned) collapse();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k" && mode === "panel") {
        e.preventDefault();
        sheet = "search";
        render();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && mode === "panel" && !state?.pinned) collapse();
    });

    function renderBooksSheet() {
      const rows = state.notebooks
        .map((book) => {
          const counts =
            book.id === TODOS
              ? `${zenTasks.filter((t) => !zenDone(t)).length} 项任务`
              : `${state.notes.filter((n) => n.notebookId === book.id).length} 则笔记`;
          const main =
            renamingId === book.id
              ? `<input class="rename-input" data-id="${book.id}" value="${escapeAttr(renameValue)}" />`
              : `<button class="book-open" data-act="select-book" data-id="${book.id}">
                   <strong>${escapeHtml(book.name)}</strong>
                   <span>${counts}</span>
                 </button>`;
          const actions = book.system
            ? ""
            : `<button class="ghost" data-act="rename-book" data-id="${book.id}">改名</button>
               <button class="ghost danger" data-act="ask-delete" data-id="${book.id}">删除</button>`;
          return `<div class="book-item ${book.id === state.activeNotebookId ? "active" : ""}">${main}${actions}</div>`;
        })
        .join("");
      const pending = state.notebooks.find((n) => n.id === pendingDeleteId);
      const confirm = pending
        ? `<div class="confirm">删除「${escapeHtml(pending.name)}」及其全部内容？不可恢复。
             <div class="confirm-actions">
               <button class="ghost" data-act="cancel-delete">取消</button>
               <button class="ghost danger" data-act="confirm-delete">确认删除</button>
             </div>
           </div>`
        : "";
      return `<div class="sheet">
        <div class="sheet-head">
          <button class="icon-btn" data-act="close-sheet" title="返回">${icons.back}</button>
          <strong>笔记本</strong>
        </div>
        <div class="sheet-list">${rows}</div>
        ${confirm}
        <div class="add-row">
          <input class="new-book" placeholder="新笔记本名称" value="${escapeAttr(newBookName)}" />
          <button class="add-btn" data-act="create-book">新建</button>
        </div>
      </div>`;
    }

    function searchHits() {
      const q = query.trim().toLowerCase();
      const noteHits = (q ? state.notes.filter((n) => `${n.title} ${n.body}`.toLowerCase().includes(q)) : state.notes).slice(0, 8);
      const taskHits = (
        q
          ? zenTasks.filter((t) =>
              [zenField(t, "Title"), zenField(t, "Project"), zenField(t, "Tags")]
                .join(" ")
                .toLowerCase()
                .includes(q),
            )
          : zenTasks.filter((t) => !zenDone(t))
      ).slice(0, 8);
      return (
        noteHits
          .map((n) => `<button class="search-hit" data-act="open-note" data-id="${n.id}">${escapeHtml(n.title || "未命名便签")}<small>笔记</small></button>`)
          .join("") +
        taskHits
          .map(
            (t) =>
              `<button class="search-hit" data-act="open-zen-task" data-id="${escapeAttr(zenField(t, "Id"))}">${escapeHtml(zenField(t, "Title", "未命名任务"))}<small>任务</small></button>`,
          )
          .join("")
      );
    }

    function renderSearchSheet() {
      return `<div class="sheet">
        <div class="sheet-head">
          <button class="icon-btn" data-act="close-sheet" title="返回">${icons.back}</button>
          <strong>搜索</strong>
        </div>
        <input class="search-input" value="${escapeAttr(query)}" placeholder="搜索笔记与任务" />
        <div class="sheet-list">${searchHits()}</div>
      </div>`;
    }

    function renderLinksSheet() {
      const rows = [...quickLinks]
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.clickCount || 0) - (a.clickCount || 0) || a.name.localeCompare(b.name, "zh-CN"))
        .map(
          (link) => `<div class="link-item ${link.pinned ? "pinned" : ""}">
            <button class="link-open" data-act="open-link" data-id="${escapeAttr(link.id)}">
              <strong>${escapeHtml(link.name)}</strong>
              <span>${escapeHtml(link.description || link.path)}</span>
            </button>
            ${
              link.detected
                ? ""
                : `<button class="ghost visible" data-act="pin-link" data-id="${escapeAttr(link.id)}" title="${link.pinned ? "取消置顶" : "置顶"}">${link.pinned ? "取消置顶" : "置顶"}</button>`
            }
          </div>`,
        )
        .join("");
      return `<div class="sheet links-sheet">
        <div class="sheet-head">
          <button class="icon-btn" data-act="close-sheet" title="返回">${icons.back}</button>
          <strong>快速访问</strong>
        </div>
        ${zenError ? `<div class="zen-error">${escapeHtml(zenError)}</div>` : ""}
        <div class="sheet-list">${rows || '<div class="empty">暂无快捷入口</div>'}</div>
        <div class="zen-actions">
          <button class="add-btn" data-act="open-workspace" data-section="links">完整快速访问</button>
          <button class="add-btn" data-act="open-workspace" data-section="sync">文件同步</button>
        </div>
      </div>`;
    }

    function renderZenTodos() {
      const stats = zenStats();
      const open = zenTasks.filter((task) => !zenDone(task));
      const done = zenTasks.filter((task) => zenDone(task));
      const row = (task) => {
        const id = zenField(task, "Id");
        const [label, level] = zenPriority(task);
        const due = zenDate(zenField(task, "DueDate"));
        const overdue = due && due < new Date().toISOString().slice(0, 10) && !zenDone(task);
        return `<div class="zen-item ${zenDone(task) ? "done" : ""} ${overdue ? "overdue" : ""}">
          <button class="check ${zenDone(task) ? "checked" : ""}" data-act="toggle-zen" data-id="${escapeAttr(id)}"></button>
          <div class="zen-body">
            <strong>${escapeHtml(zenField(task, "Title", "未命名任务"))}</strong>
            <div class="zen-meta">
              <span>${escapeHtml(zenField(task, "Project", "Unassigned"))}</span>
              ${due ? `<span class="${overdue ? "overdue-text" : ""}">${escapeHtml(due)}</span>` : ""}
              <span class="zen-priority ${level}">${label}</span>
            </div>
          </div>
          <button class="ghost danger" data-act="delete-zen" data-id="${escapeAttr(id)}">删除</button>
        </div>`;
      };
      return `<div class="zen-wrap">
        <div class="zen-stats">
          <div><strong>${stats.open}</strong><span>进行中</span></div>
          <div><strong>${stats.urgent}</strong><span>紧急</span></div>
          <div><strong>${stats.overdue}</strong><span>逾期</span></div>
        </div>
        <input class="zen-input" placeholder="添加任务，按 Enter" />
        ${zenError ? `<div class="zen-error">${escapeHtml(zenError)}</div>` : ""}
        <div class="zen-list">
          ${open.map(row).join("")}
          ${done.length ? `<div class="done-label">已完成</div>` : ""}
          ${done.map(row).join("")}
          ${!zenTasks.length ? '<p class="empty">还没有任务，输入后按 Enter 添加。</p>' : ""}
        </div>
        <div class="zen-actions">
          <button class="ghost visible" data-act="open-workspace" data-section="tasks">完整 Zen Task</button>
          <button class="ghost visible" data-act="open-workspace" data-section="projects">项目管理</button>
        </div>
      </div>`;
    }

    function renderAiMarkdown(value) {
      if (!value) return "";
      if (window.marked && window.DOMPurify) {
        return window.DOMPurify.sanitize(window.marked.parse(value));
      }
      return escapeHtml(value).replaceAll("\n", "<br>");
    }

    function renderAiSettings() {
      const settings = aiSettings || {};
      const profiles = (settings.modelProfiles || [])
        .map((profile) => `<option value="${escapeAttr(profile.model)}" ${profile.model === settings.model ? "selected" : ""}>${escapeHtml(profile.name || profile.model)}</option>`)
        .join("");
      return `<div class="sheet ai-settings-sheet">
        <div class="sheet-head">
          <button class="icon-btn" data-act="close-sheet" title="返回">${icons.back}</button>
          <strong>AI 设置</strong>
        </div>
        <div class="ai-settings-form">
          <label>API 端点<input class="ai-setting-endpoint" value="${escapeAttr(settings.apiEndpoint || "")}" placeholder="https://api.openai.com/v1" /></label>
          <label>API Key<input class="ai-setting-key" type="password" value="${escapeAttr(settings.apiKey || "")}" placeholder="sk-..." /></label>
          <label>模型<input class="ai-setting-model" list="ai-models" value="${escapeAttr(settings.model || "")}" /></label>
          <datalist id="ai-models">${profiles}</datalist>
          <label>系统提示词<textarea class="ai-setting-prompt" rows="5" placeholder="留空使用默认提示词">${escapeHtml(settings.globalChatSystemPrompt || "")}</textarea></label>
          <p>${api.platform === "darwin" ? "设置保存在 macOS 的 Application Support/DanceMonkey/config.json。" : "设置与旧版共用 %AppData%\\DanceMonkey\\config.json。"}</p>
        </div>
        <div class="ai-settings-actions">
          <button class="ghost visible" data-act="test-ai">测试连接</button>
          <button class="add-btn" data-act="save-ai-settings">保存</button>
        </div>
      </div>`;
    }

    function renderAiChat() {
      const messages = [...(state.aiMessages || [])];
      if (aiBusy) messages.push({ role: "assistant", content: aiStreamingText, streaming: true });
      const rows = messages
        .map((message) => `<div class="ai-message ${message.role} ${message.streaming ? "streaming" : ""}">
          <div class="ai-message-role">${message.role === "user" ? "你" : "AI"}</div>
          <div class="ai-message-body">${message.role === "assistant" ? renderAiMarkdown(message.content) : escapeHtml(message.content).replaceAll("\n", "<br>")}</div>
        </div>`)
        .join("");
      return `<div class="ai-wrap">
        <div class="ai-toolbar">
          <select class="ai-model-select" ${aiBusy ? "disabled" : ""}>
            ${(aiSettings?.modelProfiles || []).map((profile) => `<option value="${escapeAttr(profile.model)}" ${profile.model === aiSettings?.model ? "selected" : ""}>${escapeHtml(profile.name || profile.model)}</option>`).join("")}
            ${aiSettings?.model && !(aiSettings.modelProfiles || []).some((profile) => profile.model === aiSettings.model) ? `<option selected value="${escapeAttr(aiSettings.model)}">${escapeHtml(aiSettings.model)}</option>` : ""}
          </select>
          <select class="ai-snippet-select" ${aiBusy ? "disabled" : ""}>
            <option value="">Prompt</option>
            ${(aiSettings?.promptSnippets || []).map((snippet, index) => `<option value="${index}" ${String(index) === activeSnippet ? "selected" : ""}>${escapeHtml(snippet.title || `片段 ${index + 1}`)}</option>`).join("")}
          </select>
          <button class="ghost visible" data-act="screenshot-region" ${aiBusy ? "disabled" : ""}>框选</button>
          <button class="ghost visible" data-act="screenshot-quick" ${aiBusy ? "disabled" : ""}>截屏</button>
          <button class="ghost visible" data-act="clear-ai" ${aiBusy ? "disabled" : ""}>新对话</button>
          <button class="ghost visible" data-act="open-ai-settings">设置</button>
        </div>
        <div class="ai-messages">${rows || '<div class="ai-empty">有什么可以帮你？<small>可截屏后 AI 分析 · Ctrl+Shift+S 全屏 / Ctrl+Shift+R 框选</small></div>'}</div>
        ${aiError ? `<div class="ai-error">${escapeHtml(aiError)}</div>` : ""}
        <div class="ai-composer">
          <textarea class="ai-input" placeholder="输入问题，Enter 发送，Shift+Enter 换行" ${aiBusy ? "disabled" : ""}>${escapeHtml(aiDraft)}</textarea>
          <button class="ai-send ${aiBusy ? "stop" : ""}" data-act="${aiBusy ? "stop-ai" : "send-ai"}">${aiBusy ? "停止" : "发送"}</button>
        </div>
      </div>`;
    }

    function render() {
      if (!state) return;
      document.documentElement.dataset.theme = state.theme;

      const notebook = state.notebooks.find((n) => n.id === state.activeNotebookId);
      const notes = state.notes
        .filter((n) => n.notebookId === state.activeNotebookId)
        .sort((a, b) => b.updatedAt - a.updatedAt);
      const activeNote = notes.find((n) => n.id === state.activeNoteId) || notes[0];

      let html = "";
      if (mode === "collapsed") {
        html = `<div class="collapsed-hit"><div class="collapsed-bar"></div></div>`;
      } else if (mode === "rail") {
        html = `<div class="rail">
          <button class="rail-btn" data-act="quick-ai">${icons.ai}<span class="tooltip">AI 问答</span></button>
          <button class="rail-btn" data-act="quick-note">${icons.note}<span class="tooltip">快速便签</span></button>
          <button class="rail-btn" data-act="quick-todo">${icons.check}<span class="tooltip">快速任务</span></button>
          <button class="rail-home" data-act="open-workspace" data-section="notes" title="打开主界面">
            <img class="rail-home-avatar" src="assets/logo.png" alt="DanceMonkey" width="32" height="32" draggable="false" />
            <span class="tooltip">打开主界面</span>
          </button>
          <button class="rail-btn" data-act="open-books">${icons.books}<span class="tooltip">笔记本</span></button>
          <button class="rail-btn" data-act="open-links">${icons.link}<span class="tooltip">快速访问</span></button>
          <button class="rail-btn" data-act="open-search">${icons.search}<span class="tooltip">搜索</span></button>
          <button class="rail-btn" data-act="open-workspace" data-section="settings">${icons.settings}<span class="tooltip">软件设置</span></button>
        </div>`;
      } else {
        const noteItems = notes
          .map(
            (note) => `<button class="note-item ${activeNote && activeNote.id === note.id ? "active" : ""}" data-act="select-note" data-id="${note.id}">
              <strong>${escapeHtml(note.title || "未命名便签")}</strong>
              <span>${formatTime(note.updatedAt)}</span>
            </button>`,
          )
          .join("");

        html = `<div class="panel-shell"><section class="panel">
          <header class="panel-header">
            <div class="brand">${escapeHtml(notebook?.name || "DM")}<small>DanceMonkey</small></div>
            <button class="icon-btn ${sheet === "books" ? "on" : ""}" data-act="open-books" title="笔记本">${icons.books}</button>
            <button class="icon-btn ${sheet === "links" ? "on" : ""}" data-act="open-links" title="快速访问">${icons.link}</button>
            <button class="icon-btn ${sheet === "search" ? "on" : ""}" data-act="open-search" title="搜索">${icons.search}</button>
            <button class="icon-btn" data-act="open-workspace" data-section="settings" title="软件设置">${icons.settings}</button>
            <button class="icon-btn" data-act="open-workspace" data-section="${tab === "ai" ? "ai" : tab === "todos" ? "tasks" : "notes"}" title="${tab === "ai" ? "打开完整 AI 问答" : tab === "todos" ? "打开完整任务" : "打开完整笔记"}">${icons.expand}</button>
            <button class="icon-btn ${state.pinned ? "on" : ""}" data-act="pin" title="钉住">${icons.pin}</button>
            <button class="icon-btn" data-act="theme" title="主题">${state.theme === "dark" ? icons.sun : icons.moon}</button>
            <button class="icon-btn" data-act="collapse" title="收起">${icons.close}</button>
            ${isElectron ? `<button class="icon-btn quit ${pendingQuit ? "armed" : ""}" data-act="quit" title="${pendingQuit ? "再次点击退出 DM" : "退出 DM"}">${icons.power}</button>` : ""}
          </header>
          ${
            sheet
              ? ""
              : `<div class="tabs">
                   <button class="tab ${tab === "ai" ? "active" : ""}" data-act="tab-ai">AI</button>
                   <button class="tab ${tab === "notes" ? "active" : ""}" data-act="tab-notes">笔记</button>
                   <button class="tab ${tab === "todos" ? "active" : ""}" data-act="tab-todos">任务</button>
                   ${tab !== "ai" ? `<button class="icon-btn" style="margin-left:auto" data-act="new" title="新建">${icons.plus}</button>` : ""}
                 </div>`
          }
          <div class="panel-body">
            ${
              sheet === "books"
                ? renderBooksSheet()
                : sheet === "search"
                  ? renderSearchSheet()
                  : sheet === "links"
                    ? renderLinksSheet()
                  : sheet === "ai-settings"
                    ? renderAiSettings()
                  : tab === "notes"
                    ? `<aside class="note-col">${noteItems}</aside>
                       <div class="editor">${
                         activeNote
                           ? `<input class="title-input" data-id="${activeNote.id}" value="${escapeAttr(activeNote.title)}" placeholder="标题" />
                              <textarea class="body-input" data-id="${activeNote.id}" placeholder="写下此刻…">${escapeHtml(activeNote.body)}</textarea>`
                           : `<p class="empty">这个本子还没有笔记。</p>`
                       }</div>`
                    : tab === "todos"
                      ? renderZenTodos()
                      : renderAiChat()
            }
          </div>
          <footer class="panel-footer">
            <span>${
              sheet === "books"
                ? `${state.notebooks.length} 个笔记本`
                : sheet === "search"
                  ? "Esc 返回"
                  : sheet === "links"
                    ? `${quickLinks.length} 个入口`
                  : tab === "notes"
                    ? `${activeNote?.body.length || 0} 字`
                    : tab === "todos"
                      ? `${zenStats().open} 项进行中`
                      : aiBusy ? "正在生成…" : `${(state.aiMessages || []).length} 条消息`
            }</span>
            ${
              tab === "ai" && !sheet
                ? `<button class="footer-open" data-act="open-workspace" data-section="ai">完整 AI 问答 ${icons.expand}</button>`
                : sheet === "links"
                  ? ""
                  : tab === "todos" && !sheet
                    ? `<button class="footer-open" data-act="open-workspace" data-section="tasks">完整 Zen Task ${icons.expand}</button>`
                    : `<button class="footer-open" data-act="open-workspace" data-section="notes">完整笔记 ${icons.expand}</button>`
            }
          </footer>
        </section></div>`;
      }

      root.classList.add("overlay-root");
      root.innerHTML = html;
      options.onMode?.(mode);
      bind();
    }

    function bind() {
      root.onmouseenter = mode === "collapsed" ? enterRail : mode === "rail" ? stayOnRail : null;
      root.onmouseleave = mode === "rail" ? leaveRail : null;

      const rail = root.querySelector(".rail");
      if (rail) {
        rail.onmouseenter = stayOnRail;
        rail.onmousemove = stayOnRail;
        rail.onmousedown = stayOnRail;
        // 展开后鼠标已在窗口内时不会再次触发 mouseenter，主动取消收起
        stayOnRail();
      }

      root.onclick = (e) => {
        const btn = e.target.closest("[data-act]");
        if (!btn) return;
        const act = btn.dataset.act;
        const id = btn.dataset.id;

        // 退出键紧邻收起键，先点亮一次作为确认，点其它地方即取消
        if (act === "quit") {
          if (pendingQuit) {
            void api.quitApp();
            return;
          }
          pendingQuit = true;
          render();
          return;
        }
        if (pendingQuit) {
          pendingQuit = false;
          render();
        }

        if (act === "quick-note") void openPanel("notes", "none");
        if (act === "quick-todo") void openPanel("todos", "todo");
        if (act === "quick-ai") void openAiPanel();
        if (act === "open-workspace") void api.openWorkspace(btn.dataset.section || "notes");
        if (act === "open-links") void openLinksSheet();
        if (act === "open-books" || act === "open-search") {
          const target = act === "open-books" ? "books" : "search";
          const show = async () => {
            sheet = target;
            if (target === "search" || target === "books") {
              try {
                applyZen(await api.zenTask.load());
              } catch (error) {
                zenError = error?.message || "无法加载 Zen Task";
              }
            }
            render();
            focusLater(target === "search" ? ".search-input" : ".new-book");
          };
          if (mode === "panel") void show();
          else void openPanel(tab === "ai" ? "notes" : tab, "none").then(show);
        }
        if (act === "close-sheet") {
          sheet = null;
          pendingDeleteId = null;
          renamingId = null;
          render();
        }
        // 先就地更新再落盘，否则连点时后一次仍读到旧值，算出同一个目标
        if (act === "pin") {
          const pinned = !state.pinned;
          state = { ...state, pinned };
          void persist({ pinned });
        }
        if (act === "theme") {
          const theme = state.theme === "dark" ? "light" : "dark";
          state = { ...state, theme };
          document.documentElement.dataset.theme = theme;
          void persist({ theme });
        }
        if (act === "collapse") collapse();
        if (act === "tab-notes") {
          tab = "notes";
          render();
        }
        if (act === "tab-todos") {
          tab = "todos";
          void loadZenTasks();
        }
        if (act === "tab-ai") void openAiPanel();
        if (act === "open-ai-settings") void openAiSettings();
        if (act === "save-ai-settings") void saveAiSettings(false);
        if (act === "test-ai") void saveAiSettings(true);
        if (act === "send-ai") void sendAi();
        if (act === "stop-ai") void stopAi();
        if (act === "screenshot-quick") void runScreenshot("quick");
        if (act === "screenshot-region") void runScreenshot("region");
        if (act === "clear-ai") {
          aiDraft = "";
          aiError = "";
          void persist({ aiMessages: [] });
        }
        if (act === "new" && tab === "notes") {
          const note = {
            id: newId(),
            notebookId: INBOX,
            title: "",
            body: "",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          void persist({
            activeNotebookId: INBOX,
            activeNoteId: note.id,
            notes: [note, ...state.notes],
          }).then(() => focusLater(".title-input"));
        }
        if (act === "new" && tab === "todos") focusLater(".zen-input");
        if (act === "select-note") void persist({ activeNoteId: id });
        if (act === "toggle-zen") {
          void api.zenTask
            .toggleTask(id)
            .then(applyZen)
            .then(() => render())
            .catch((error) => {
              zenError = error?.message || "切换失败";
              render();
            });
        }
        if (act === "delete-zen") {
          void api.zenTask
            .deleteTask(id)
            .then(applyZen)
            .then(() => render())
            .catch((error) => {
              zenError = error?.message || "删除失败";
              render();
            });
        }
        if (act === "open-link") {
          void api.quickAccess
            .open(id)
            .then((list) => {
              quickLinks = list;
              render();
            })
            .catch((error) => {
              zenError = error?.message || "打开失败";
              render();
            });
        }
        if (act === "pin-link") {
          void api.quickAccess
            .togglePin(id)
            .then((list) => {
              quickLinks = list;
              render();
            })
            .catch((error) => {
              zenError = error?.message || "置顶失败";
              render();
            });
        }

        if (act === "select-book") {
          sheet = null;
          if (id === TODOS) {
            tab = "todos";
            void loadZenTasks();
          } else {
            tab = "notes";
            void persist({ activeNotebookId: id });
          }
        }
        if (act === "rename-book") {
          renamingId = id;
          renameValue = state.notebooks.find((n) => n.id === id).name;
          render();
          focusLater(".rename-input");
        }
        if (act === "ask-delete") {
          pendingDeleteId = id;
          render();
        }
        if (act === "cancel-delete") {
          pendingDeleteId = null;
          render();
        }
        if (act === "confirm-delete") confirmDelete();
        if (act === "create-book") createBook();

        if (act === "open-note") {
          const note = state.notes.find((n) => n.id === id);
          tab = "notes";
          sheet = null;
          void persist({ activeNotebookId: note.notebookId, activeNoteId: note.id });
        }
        if (act === "open-zen-task" || act === "open-todo") {
          tab = "todos";
          sheet = null;
          void loadZenTasks();
        }
      };

      const title = root.querySelector(".title-input");
      const body = root.querySelector(".body-input");
      if (title && body) {
        // 编辑时本地更新并跳过重渲染，避免打断输入焦点
        const update = () => {
          const id = title.dataset.id;
          const notes = state.notes.map((n) =>
            n.id === id ? { ...n, title: title.value, body: body.value, updatedAt: Date.now() } : n,
          );
          state = { ...state, notes, activeNoteId: id };
          skipRender = true;
          void api.setState({ notes, activeNoteId: id }).then((next) => {
            adopt(next);
            skipRender = false;
          });
        };
        title.oninput = update;
        body.oninput = update;
      }

      const zenInput = root.querySelector(".zen-input");
      if (zenInput) {
        zenInput.onkeydown = (e) => {
          if (e.key !== "Enter") return;
          const text = zenInput.value.trim();
          if (!text) return;
          zenInput.value = "";
          void api.zenTask
            .addTask({ title: text })
            .then(applyZen)
            .then(() => {
              render();
              focusLater(".zen-input");
            })
            .catch((error) => {
              zenError = error?.message || "添加失败";
              render();
              focusLater(".zen-input");
            });
        };
      }

      const newBook = root.querySelector(".new-book");
      if (newBook) {
        newBook.oninput = () => {
          newBookName = newBook.value;
        };
        newBook.onkeydown = (e) => {
          if (e.key === "Enter") createBook();
        };
      }

      const renameInput = root.querySelector(".rename-input");
      if (renameInput) {
        renameInput.oninput = () => {
          renameValue = renameInput.value;
        };
        renameInput.onkeydown = (e) => {
          if (e.key === "Enter") commitRename();
          if (e.key === "Escape") {
            renamingId = null;
            render();
          }
        };
        renameInput.onblur = commitRename;
      }

      const searchInput = root.querySelector(".search-input");
      if (searchInput) {
        searchInput.oninput = () => {
          query = searchInput.value;
          root.querySelector(".sheet-list").innerHTML = searchHits();
        };
      }

      const aiInput = root.querySelector(".ai-input");
      if (aiInput) {
        aiInput.oninput = () => {
          aiDraft = aiInput.value;
        };
        aiInput.onkeydown = (e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void sendAi();
          }
        };
      }

      const modelSelect = root.querySelector(".ai-model-select");
      if (modelSelect) {
        modelSelect.onchange = () => {
          aiSettings = { ...aiSettings, model: modelSelect.value };
          void api.ai.saveSettings(aiSettings);
        };
      }

      const snippetSelect = root.querySelector(".ai-snippet-select");
      if (snippetSelect) {
        snippetSelect.onchange = () => {
          activeSnippet = snippetSelect.value;
          const snippet = aiSettings?.promptSnippets?.[Number(activeSnippet)];
          if (snippet) aiSettings = { ...aiSettings, globalChatSystemPrompt: snippet.systemPrompt || "" };
        };
      }
    }

    async function ensureAiSettings() {
      if (!aiSettings) aiSettings = await api.ai.getSettings();
      return aiSettings;
    }

    async function openAiPanel() {
      await ensureAiSettings();
      await openPanel("ai", "none");
      requestAnimationFrame(() => {
        const messages = root.querySelector(".ai-messages");
        if (messages) messages.scrollTop = messages.scrollHeight;
        root.querySelector(".ai-input")?.focus();
      });
    }

    async function runScreenshot(modeName) {
      if (!api.screenshot) {
        aiError = "当前环境不支持截屏。";
        render();
        return;
      }
      aiError = "";
      const result =
        modeName === "region" ? await api.screenshot.region() : await api.screenshot.quick();
      if (!result?.success && result?.error) {
        aiError = result.error;
        render();
      }
    }

    async function openAiSettings() {
      await ensureAiSettings();
      sheet = "ai-settings";
      render();
    }

    function readAiSettingsForm() {
      return {
        ...aiSettings,
        apiEndpoint: root.querySelector(".ai-setting-endpoint")?.value || "",
        apiKey: root.querySelector(".ai-setting-key")?.value || "",
        model: root.querySelector(".ai-setting-model")?.value || "",
        globalChatSystemPrompt: root.querySelector(".ai-setting-prompt")?.value || "",
      };
    }

    async function saveAiSettings(testAfterSave) {
      aiError = "";
      aiSettings = await api.ai.saveSettings(readAiSettingsForm());
      sheet = null;
      tab = "ai";
      render();
      if (testAfterSave) {
        aiDraft = "请只回复：连接成功";
        await sendAi();
      }
    }

    async function sendAi() {
      const text = aiDraft.trim();
      if (!text || aiBusy) return;
      await ensureAiSettings();
      aiDraft = "";
      aiError = "";
      aiBusy = true;
      aiStreamingText = "";
      aiRequestId = newId();
      const messages = [...(state.aiMessages || []), { role: "user", content: text }];
      state = { ...state, aiMessages: messages };
      render();
      const result = await api.ai.chat({
        requestId: aiRequestId,
        model: aiSettings.model,
        systemPrompt: aiSettings.globalChatSystemPrompt,
        messages,
      });
      aiBusy = false;
      if (result.success) {
        const assistantText = aiStreamingText || result.text || "";
        aiStreamingText = "";
        aiRequestId = null;
        await persist({
          aiMessages: [...messages, { role: "assistant", content: assistantText }],
        });
      } else {
        aiError = result.error || "AI 请求失败";
        aiStreamingText = "";
        aiRequestId = null;
        state = { ...state, aiMessages: messages };
        await persist({ aiMessages: messages });
      }
      focusLater(".ai-input");
    }

    async function stopAi() {
      if (!aiRequestId) return;
      await api.ai.cancel(aiRequestId);
    }

    function createBook() {
      const name = newBookName.trim();
      if (!name) return;
      newBookName = "";
      void persist({ notebooks: [...state.notebooks, { id: newId(), name, createdAt: Date.now() }] });
    }

    function commitRename() {
      const id = renamingId;
      if (!id) return;
      const name = renameValue.trim();
      renamingId = null;
      if (name) void persist({ notebooks: state.notebooks.map((n) => (n.id === id ? { ...n, name } : n)) });
      else render();
    }

    function confirmDelete() {
      const book = state.notebooks.find((n) => n.id === pendingDeleteId);
      if (!book || book.system) return;
      const id = book.id;
      const notebooks = state.notebooks.filter((n) => n.id !== id);
      pendingDeleteId = null;
      void persist({
        notebooks,
        notes: state.notes.filter((n) => n.notebookId !== id),
        activeNotebookId: state.activeNotebookId === id ? notebooks[0]?.id : state.activeNotebookId,
      });
    }

    api.getState().then((s) => {
      state = s;
      render();
    });

    return {
      setMode(next) {
        mode = next;
        sheet = null;
        render();
      },
    };
  }

  const root = document.getElementById("root");

  if (location.hash.startsWith("#workspace")) return;

  if (isElectron) {
    if (api.softwareRender) document.documentElement.dataset.render = "software";
    createOverlay(root);
    return;
  }

  document.documentElement.dataset.theme = "dark";
  root.innerHTML = `<div class="preview-desktop">
    <div class="preview-toolbar">
      <span>DM 预览</span>
      <button data-mode="collapsed">细条</button>
      <button data-mode="rail">快捷轨</button>
      <button class="on" data-mode="panel">笔记本</button>
    </div>
    <div class="preview-overlay"></div>
  </div>`;

  const shell = root.querySelector(".preview-overlay");
  const sizeClass = { collapsed: "collapsed-size", rail: "rail-size", panel: "" };

  // 预览窗口没有真实窗口边界，这里用容器尺寸模拟主进程的窗口几何
  function syncPreview(mode) {
    shell.classList.remove("collapsed-size", "rail-size");
    const cls = sizeClass[mode];
    if (cls) shell.classList.add(cls);
    root.querySelectorAll("[data-mode]").forEach((el) => el.classList.toggle("on", el.dataset.mode === mode));
  }

  const overlay = createOverlay(shell, { mode: "panel", onMode: syncPreview });

  root.querySelector(".preview-toolbar").onclick = (e) => {
    const btn = e.target.closest("[data-mode]");
    if (btn) overlay.setMode(btn.dataset.mode);
  };
})();
