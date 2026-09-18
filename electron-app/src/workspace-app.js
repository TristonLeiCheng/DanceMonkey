(() => {
  if (!location.hash.startsWith("#workspace")) return;

  const root = document.getElementById("root");
  const isElectron = Boolean(window.lumen?.workspace);
  const api = window.lumen || createBrowserApi();
  const SECTIONS = [
    ["ai", "AI"],
    ["notes", "笔记"],
    ["tasks", "Zen Task"],
    ["projects", "项目"],
    ["links", "快速访问"],
    ["sync", "文件同步"],
    ["settings", "设置"],
  ];
  const THEMES = [
    ["dark", "深色"],
    ["light", "浅色"],
    ["frost-yellow", "淡黄磨砂"],
    ["frost-green", "淡绿磨砂"],
    ["slate", "雾蓝"],
    ["lavender", "淡紫"],
  ];
  const LIGHT_THEMES = new Set(["light", "frost-yellow", "frost-green", "lavender"]);

  function sectionFromHash() {
    const part = location.hash.replace(/^#workspace\/?/, "").split("/")[0];
    return ["ai", "notes", "tasks", "projects", "links", "sync", "settings"].includes(part)
      ? part
      : "notes";
  }

  let tree = [];
  let vaultRoot = "";
  let activePath = null;
  let selectedPath = "";
  let content = "";
  let savedContent = "";
  let expanded = new Set();
  let viewMode = localStorage.getItem("lumen-workspace-view") || "split";
  let effect = localStorage.getItem("lumen-workspace-effect") || "glass";
  let theme = localStorage.getItem("lumen-workspace-theme") || "dark";
  if (!THEMES.some(([value]) => value === theme)) theme = "dark";
  const storedBackgroundOpacity = localStorage.getItem("lumen-workspace-opacity");
  let backgroundOpacity = storedBackgroundOpacity === null ? 82 : Number(storedBackgroundOpacity);
  if (!Number.isFinite(backgroundOpacity)) backgroundOpacity = 82;
  backgroundOpacity = Math.max(35, Math.min(100, Math.round(backgroundOpacity)));
  let editorWidth = Number(localStorage.getItem("lumen-workspace-editor-width")) || 50;
  let appVersion = "";
  let maximized = false;
  let saveTimer = null;
  let dialog = null;
  let paletteOpen = false;
  let paletteQuery = "";
  let section = sectionFromHash();
  let modulesReady = false;
  let modulesInstance = null;

  function createBrowserApi() {
    const key = "lumen-browser-vault";
    const zenKey = "lumen-browser-zentask";
    const linkKey = "lumen-browser-links";
    let entries;
    try {
      entries = JSON.parse(localStorage.getItem(key) || "null");
    } catch {
      entries = null;
    }
    if (!Array.isArray(entries)) {
      entries = [
        { type: "folder", path: "项目" },
        {
          type: "file",
          path: "欢迎使用 DM.md",
          content:
            "# 欢迎使用 DM\n\n这里是你的完整 Markdown 知识库。\n\n## 开始使用\n\n- 在左侧创建文件夹或笔记\n- 拖动分栏调整编辑与预览宽度\n- 使用 `Ctrl+S` 保存当前笔记\n- 使用 `Ctrl+P` 快速查找文件\n\n> 所有内容都以真实 `.md` 文件保存在本地。",
          updatedAt: Date.now(),
        },
        {
          type: "file",
          path: "项目/产品构想.md",
          content: "# 产品构想\n\n## 目标\n\n在这里开始记录你的想法。",
          updatedAt: Date.now(),
        },
      ];
    }
    const save = () => localStorage.setItem(key, JSON.stringify(entries));

    function loadZen() {
      try {
        return JSON.parse(localStorage.getItem(zenKey) || "null") || {
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
        };
      } catch {
        return { tasks: [], projects: [] };
      }
    }

    function saveZen(state) {
      localStorage.setItem(zenKey, JSON.stringify(state));
      return state;
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

    function cleanName(name, type) {
      let value = String(name || "").trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, "-");
      if (!value) value = type === "folder" ? "新建文件夹" : "未命名笔记";
      if (type === "file" && !value.toLowerCase().endsWith(".md")) value += ".md";
      return value;
    }

    function unique(parent, name, type) {
      const safe = cleanName(name, type);
      const dot = safe.toLowerCase().endsWith(".md") ? safe.slice(0, -3) : safe;
      const ext = type === "file" ? ".md" : "";
      let candidate = [parent, `${dot}${ext}`].filter(Boolean).join("/");
      let index = 2;
      while (entries.some((item) => item.path === candidate)) {
        candidate = [parent, `${dot} ${index}${ext}`].filter(Boolean).join("/");
        index += 1;
      }
      return candidate;
    }

    function buildTree() {
      const nodes = new Map();
      const roots = [];
      [...entries]
        .sort((a, b) => a.path.localeCompare(b.path, "zh-CN"))
        .forEach((entry) => {
          const node = {
            type: entry.type,
            path: entry.path,
            name: entry.path.split("/").pop(),
            updatedAt: entry.updatedAt,
            children: [],
          };
          nodes.set(entry.path, node);
          const parent = entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : "";
          if (parent && nodes.has(parent)) nodes.get(parent).children.push(node);
          else roots.push(node);
        });
      const sort = (items) => {
        items.sort((a, b) => {
          if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
          return a.name.localeCompare(b.name, "zh-CN", { numeric: true });
        });
        items.forEach((node) => sort(node.children));
      };
      sort(roots);
      return roots;
    }

    const aiKey = "lumen-browser-ai-messages";
    let browserAiMessages = [];
    try {
      browserAiMessages = JSON.parse(localStorage.getItem(aiKey) || "[]");
    } catch {
      browserAiMessages = [];
    }

    return {
      platform: navigator.platform.toLowerCase().includes("mac") ? "darwin" : "win32",
      getState: async () => ({ aiMessages: browserAiMessages }),
      setState: async (partial) => {
        if (Array.isArray(partial?.aiMessages)) {
          browserAiMessages = partial.aiMessages;
          localStorage.setItem(aiKey, JSON.stringify(browserAiMessages));
        }
        return { aiMessages: browserAiMessages };
      },
      ai: {
        getSettings: async () => ({
          apiEndpoint: "",
          apiKey: "",
          model: "gpt-3.5-turbo",
          modelProfiles: [],
          promptSnippets: [],
          globalChatSystemPrompt: "",
        }),
        saveSettings: async (settings) => settings,
        chat: async () => ({
          success: false,
          error: "浏览器预览不连接 AI，请使用桌面模式。",
        }),
        cancel: async () => false,
        onChunk: () => () => {},
      },
      screenshot: {
        quick: async () => ({ success: false, error: "浏览器预览不支持截屏" }),
        region: async () => ({ success: false, error: "浏览器预览不支持截屏" }),
        onFollowUp: () => () => {},
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
      workspace: {
        list: async () => ({ root: "浏览器预览/LumenVault", tree: buildTree() }),
        read: async (path) => entries.find((item) => item.path === path)?.content || "",
        write: async (path, value) => {
          const file = entries.find((item) => item.path === path);
          file.content = value;
          file.updatedAt = Date.now();
          save();
          return { path, updatedAt: file.updatedAt };
        },
        createFile: async (parent, name) => {
          const path = unique(parent, name, "file");
          entries.push({
            type: "file",
            path,
            content: `# ${path.split("/").pop().slice(0, -3)}\n\n`,
            updatedAt: Date.now(),
          });
          save();
          return path;
        },
        createFolder: async (parent, name) => {
          const path = unique(parent, name, "folder");
          entries.push({ type: "folder", path });
          save();
          return path;
        },
        rename: async (oldPath, name) => {
          const item = entries.find((entry) => entry.path === oldPath);
          const parent = oldPath.includes("/") ? oldPath.slice(0, oldPath.lastIndexOf("/")) : "";
          const newPath = unique(parent, name, item.type);
          entries.forEach((entry) => {
            if (entry.path === oldPath || entry.path.startsWith(`${oldPath}/`)) {
              entry.path = `${newPath}${entry.path.slice(oldPath.length)}`;
            }
          });
          save();
          const zen = loadZen();
          zen.projects = window.DMZenModel.renameNoteLinks(zen.projects, oldPath, newPath);
          zen.tasks = window.DMZenModel.renameTaskSources(zen.tasks, oldPath, newPath);
          saveZen(zen);
          return newPath;
        },
        remove: async (path) => {
          entries = entries.filter((entry) => entry.path !== path && !entry.path.startsWith(`${path}/`));
          save();
          return true;
        },
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
        refresh: async () => loadLinks(),
      },
      folderSync: {
        list: async () => {
          try {
            return JSON.parse(localStorage.getItem("lumen-browser-sync") || "[]");
          } catch {
            return [];
          }
        },
        save: async (profile) => {
          let profiles = [];
          try {
            profiles = JSON.parse(localStorage.getItem("lumen-browser-sync") || "[]");
          } catch {
            profiles = [];
          }
          const next = {
            ...profile,
            id: profile.id || `sync-${Date.now().toString(36)}`,
          };
          const index = profiles.findIndex((item) => item.id === next.id);
          if (index >= 0) profiles[index] = next;
          else profiles.push(next);
          localStorage.setItem("lumen-browser-sync", JSON.stringify(profiles));
          return profiles;
        },
        remove: async (id) => {
          const profiles = JSON.parse(localStorage.getItem("lumen-browser-sync") || "[]").filter(
            (item) => item.id !== id,
          );
          localStorage.setItem("lumen-browser-sync", JSON.stringify(profiles));
          return profiles;
        },
        preview: async () => ({
          summary: "浏览器预览不执行真实同步",
          items: [],
          copyToSlaveCount: 0,
          copyToMasterCount: 0,
          deleteFromSlaveCount: 0,
          conflictCount: 0,
          totalBytes: 0,
        }),
        run: async () => ({ success: false, error: "浏览器预览不执行真实同步", profiles: [] }),
        cancel: async () => true,
        log: async () => "",
        openLog: async () => true,
        browse: async () => null,
        createFromLink: async (linkPath, linkName) => {
          const profile = {
            id: `sync-${Date.now().toString(36)}`,
            name: linkName || "同步任务",
            masterPath: linkPath,
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
          };
          const profiles = JSON.parse(localStorage.getItem("lumen-browser-sync") || "[]");
          profiles.push(profile);
          localStorage.setItem("lumen-browser-sync", JSON.stringify(profiles));
          return { profiles, profile };
        },
      },
      getAppVersion: async () => "",
      window: {
        minimize: async () => undefined,
        isMaximized: async () => false,
        toggleMaximize: async () => false,
        onMaximized: () => () => {},
        close: async () => {
          location.hash = "";
          location.reload();
        },
      },
    };
  }

  function esc(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  function attr(value) {
    return esc(value).replaceAll('"', "&quot;");
  }

  function flatten(nodes, type = null) {
    const result = [];
    for (const node of nodes) {
      if (!type || node.type === type) result.push(node);
      if (node.children) result.push(...flatten(node.children, type));
    }
    return result;
  }

  function parentPath(path) {
    return path?.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  }

  function selectedFolder() {
    const selected = flatten(tree).find((node) => node.path === selectedPath);
    return selected?.type === "folder" ? selected.path : parentPath(activePath);
  }

  function renderMarkdown(value) {
    if (!window.marked || !window.DOMPurify) return `<pre>${esc(value)}</pre>`;
    return window.DOMPurify.sanitize(
      window.marked.parse(value, { gfm: true, breaks: false }),
      { USE_PROFILES: { html: true } },
    );
  }

  function renderTreeNodes(nodes, depth = 0) {
    return nodes
      .map((node) => {
        const open = expanded.has(node.path);
        const icon =
          node.type === "folder"
            ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="none"><path d="M3.5 6.5h6l1.5 2h9.5v9H3.5Z" stroke="currentColor" stroke-width="1.4"/></svg>'
            : '<svg viewBox="0 0 24 24" width="14" height="14" fill="none"><path d="M6 3.5h8l4 4v13H6Z" stroke="currentColor" stroke-width="1.4"/><path d="M14 3.5v4h4" stroke="currentColor" stroke-width="1.4"/></svg>';
        const row = `<div class="tree-row ${node.path === selectedPath || node.path === activePath ? "active" : ""}"
          data-type="${node.type}" data-path="${attr(node.path)}" style="padding-left:${5 + depth * 14}px">
          <span class="tree-expander">${node.type === "folder" ? (open ? "▾" : "›") : ""}</span>
          <span class="tree-icon">${icon}</span>
          <button class="tree-name" data-action="tree-open" title="${attr(node.path)}">${esc(node.name)}</button>
          <span class="tree-actions">
            <button class="tree-action" data-action="rename" title="重命名">✎</button>
            <button class="tree-action danger" data-action="delete" title="删除">×</button>
          </span>
        </div>`;
        const children =
          node.type === "folder" && open ? renderTreeNodes(node.children || [], depth + 1) : "";
        return row + children;
      })
      .join("");
  }

  function renderShell() {
    const lightTheme = LIGHT_THEMES.has(theme) ? "light" : "";
    root.className = `workspace-root effect-${effect} theme-${theme} ${lightTheme} ${maximized ? "maximized" : ""}`;
    root.style.setProperty("--editor-width", `${editorWidth}%`);
    root.style.setProperty("--ws-opacity", String(backgroundOpacity / 100));
    const isNotes = section === "notes";
    const title =
      section === "ai"
        ? "AI 问答"
        : section === "tasks"
          ? "Zen Task"
          : section === "projects"
            ? "项目管理"
            : section === "links"
              ? "快速访问"
              : section === "sync"
                ? "文件同步"
                : section === "settings"
                ? "软件设置"
                : activePath || vaultRoot || "本地知识库";
    root.innerHTML = `<main class="workspace-frame">
      <header class="ws-titlebar">
        <div class="ws-brand">DM <span>DanceMonkey${appVersion ? ` v${esc(appVersion)}` : ""}</span></div>
        <div class="ws-current-path">${esc(title)}</div>
        <div class="ws-title-actions">
          <button class="ws-effect ${effect === "glass" ? "active" : ""}" data-action="effect" data-value="glass">玻璃</button>
          <button class="ws-effect ${effect === "solid" ? "active" : ""}" data-action="effect" data-value="solid">纯色</button>
          <button class="ws-effect ${effect === "paper" ? "active" : ""}" data-action="effect" data-value="paper">纸张</button>
          <label class="ws-theme-label"><span class="visually-hidden">工作区主题</span><select class="ws-theme-select" aria-label="工作区主题">${THEMES.map(([value, label]) => `<option value="${value}" ${theme === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>
          <label class="ws-opacity-label" title="调整工作区背景不透明度"><span>透明度</span><input class="ws-opacity" type="range" min="35" max="100" step="1" value="${backgroundOpacity}" aria-label="工作区背景不透明度" aria-valuetext="${backgroundOpacity}%"><output>${backgroundOpacity}%</output></label>
        </div>
        <div class="ws-window-actions">
          <button class="ws-window-btn" data-action="minimize" title="最小化">−</button>
          <button class="ws-window-btn" data-action="maximize" title="最大化">□</button>
          <button class="ws-window-btn close" data-action="close-window" title="关闭">×</button>
        </div>
      </header>
      <nav class="ws-nav">
        ${SECTIONS.map(
          ([id, label]) =>
            `<button class="ws-nav-btn ${section === id ? "active" : ""}" data-action="section" data-value="${id}">${label}</button>`,
        ).join("")}
      </nav>
      <div class="ws-body">
        ${
          isNotes
            ? `<aside class="ws-sidebar">
          <div class="ws-sidebar-head">
            <strong>文件</strong>
            <button class="ws-tool" data-action="new-file" title="新建笔记">＋</button>
            <button class="ws-tool" data-action="new-folder" title="新建文件夹">⌑</button>
            <button class="ws-tool" data-action="refresh" title="刷新">↻</button>
          </div>
          <div class="ws-tree">${renderTreeNodes(tree)}</div>
          <div class="ws-vault-path" title="${attr(vaultRoot)}">${esc(vaultRoot)}</div>
        </aside>
        <div class="ws-resizer" role="separator" aria-label="调整文件树宽度" tabindex="0"></div>
        <section class="ws-main">
          ${
            activePath
              ? `<div class="ws-docbar">
                  <div class="ws-doc-name">${esc(activePath.split("/").pop())}</div>
                  <span class="ws-save-state">已保存</span>
                  <button class="ws-mode" data-action="note-to-tasks" title="选中文字生成候选任务；未选中时读取整篇笔记">生成项目任务</button>
                  <div class="ws-mode-group">
                    <button class="ws-mode ${viewMode === "edit" ? "active" : ""}" data-action="view" data-value="edit">编辑</button>
                    <button class="ws-mode ${viewMode === "split" ? "active" : ""}" data-action="view" data-value="split">分栏</button>
                    <button class="ws-mode ${viewMode === "preview" ? "active" : ""}" data-action="view" data-value="preview">预览</button>
                  </div>
                </div>
                <div class="ws-editor-area view-${viewMode}">
                  <textarea class="ws-editor" spellcheck="false" aria-label="Markdown 编辑器">${esc(content)}</textarea>
                  <div class="ws-editor-resizer" role="separator" aria-label="调整编辑与预览宽度" tabindex="0"></div>
                  <article class="ws-preview">${renderMarkdown(content)}</article>
                </div>`
              : `<div class="ws-empty">
                  <strong>从左侧选择或新建一篇 Markdown 笔记</strong>
                  <p>Ctrl+S 保存 · Ctrl+P 快速查找 · 也可切换到「AI」开始问答</p>
                </div>`
          }
        </section>`
            : `<section class="ws-main module-main" id="module-root">${
                modulesReady ? modulesInstance.render(section) : '<div class="module-empty">正在加载模块…</div>'
              }</section>`
        }
      </div>
      <footer class="ws-statusbar">
        <span>${
          isNotes
            ? "Markdown"
            : section === "ai"
              ? "AI Chat"
              : section === "tasks"
                ? "Zen Task"
                : section === "projects"
                  ? "Projects"
                  : section === "sync"
                    ? "Folder Sync"
                    : section === "settings"
                    ? "Settings"
                    : "Quick Access"
        }</span>
        <span class="ws-count">${
          isNotes
            ? `${content.length} 字符`
            : section === "ai"
              ? "与快捷面板共用对话与配置"
              : section === "sync"
                ? "本地 / UNC 文件夹同步"
                : section === "settings"
                ? "强制代理与全局快捷键"
                : "与旧版 NoteVault / config 同步"
        }</span>
        <span>${isElectron ? "本地文件" : "浏览器预览存储"}</span>
        <span class="right">${
          isNotes
            ? "Ctrl+S 保存 · Ctrl+P 查找"
            : section === "ai"
              ? "Enter 发送 · Shift+Enter 换行"
              : "完整工作台"
        }</span>
      </footer>
    </main>${!isNotes && modulesReady ? modulesInstance.renderModal() : ""}`;
    bindShell();
    if (!isNotes && modulesReady) {
      modulesInstance.bindSearch(root);
    }
  }

  async function setSection(next) {
    if (activePath && content !== savedContent) {
      await api.workspace.write(activePath, content);
      savedContent = content;
    }
    section = next;
    const hash = next === "notes" ? "#workspace" : `#workspace/${next}`;
    if (location.hash !== hash) history.replaceState(null, "", hash);
    if (next !== "notes" && modulesReady) await modulesInstance.loadAll();
    renderShell();
  }

  async function openNoteTaskDialog() {
    const editor = root.querySelector(".ws-editor");
    if (!editor || !activePath) return;
    const selected = editor.selectionStart !== editor.selectionEnd;
    const text = selected ? editor.value.slice(editor.selectionStart, editor.selectionEnd) : editor.value;
    const candidates = window.DMZenModel.taskCandidatesFromNote(text);
    const sourcePath = activePath;
    await saveActive();
    const state = await api.zenTask.load();
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
        await api.zenTask.addTasksBatch(payload);
        form.innerHTML = `<h2>已创建 ${payload.length} 项任务</h2><p class="pm-muted">整批保存成功，来源笔记与项目关联已一并保留。</p><div class="module-modal-actions"><button type="button" data-note-task-source>返回来源笔记</button><button type="button" class="module-primary" data-note-task-project>查看项目任务</button></div>`;
        form.querySelector("[data-note-task-source]").onclick = () => overlay.remove();
        form.querySelector("[data-note-task-project]").onclick = async () => { overlay.remove(); await setSection("projects"); await modulesInstance?.openProject?.(targetProjectId); };
      } catch (error) {
        showError(`${error?.message || "创建失败"}。本次未保存任何任务，可修改后安全重试。`);
      } finally { submit.disabled = false; }
    };
  }

  function bindShell() {
    root.onclick = async (event) => {
      if (modulesReady && section !== "notes") {
        const handled = await modulesInstance.handleClick(event, setSection);
        if (handled) return;
      }
      const control = event.target.closest("[data-action]");
      if (!control) return;
      const action = control.dataset.action;

      if (action === "effect") {
        effect = control.dataset.value;
        localStorage.setItem("lumen-workspace-effect", effect);
        renderShell();
      }
      if (action === "section") {
        void setSection(control.dataset.value);
        return;
      }
      if (action === "minimize") void api.window.minimize();
      if (action === "maximize") void api.window.toggleMaximize();
      if (action === "close-window") void api.window.close();
      if (action === "refresh") await refreshTree();
      if (action === "new-file") openDialog("file");
      if (action === "new-folder") openDialog("folder");
      if (action === "note-to-tasks") { try { await openNoteTaskDialog(); } catch (error) { alert(error?.message || "无法生成项目任务"); } }
      if (action === "view") {
        viewMode = control.dataset.value;
        localStorage.setItem("lumen-workspace-view", viewMode);
        renderShell();
      }

      if (["tree-open", "rename", "delete"].includes(action)) {
        const row = control.closest(".tree-row");
        const path = row.dataset.path;
        const type = row.dataset.type;
        selectedPath = path;
        if (action === "tree-open") {
          if (type === "folder") {
            if (expanded.has(path)) expanded.delete(path);
            else expanded.add(path);
            renderShell();
          } else {
            await openFile(path);
          }
        }
        if (action === "rename") openDialog("rename", path, type);
        if (action === "delete") openDialog("delete", path, type);
      }
    };

    const themeSelect = root.querySelector(".ws-theme-select");
    if (themeSelect) {
      themeSelect.onchange = () => {
        theme = themeSelect.value;
        if (theme === "frost-yellow" || theme === "frost-green") {
          effect = "glass";
          localStorage.setItem("lumen-workspace-effect", effect);
        }
        localStorage.setItem("lumen-workspace-theme", theme);
        renderShell();
      };
    }

    const opacityInput = root.querySelector(".ws-opacity");
    if (opacityInput) {
      opacityInput.oninput = () => {
        backgroundOpacity = Number(opacityInput.value);
        root.style.setProperty("--ws-opacity", String(backgroundOpacity / 100));
        opacityInput.setAttribute("aria-valuetext", `${backgroundOpacity}%`);
        opacityInput.parentElement.querySelector("output").textContent = `${backgroundOpacity}%`;
      };
      opacityInput.onchange = () => {
        localStorage.setItem("lumen-workspace-opacity", String(backgroundOpacity));
      };
    }

    const editor = root.querySelector(".ws-editor");
    if (editor) {
      editor.oninput = () => {
        content = editor.value;
        root.querySelector(".ws-preview").innerHTML = renderMarkdown(content);
        root.querySelector(".ws-count").textContent = `${content.length} 字符`;
        root.querySelector(".ws-save-state").textContent = "保存中…";
        clearTimeout(saveTimer);
        saveTimer = setTimeout(saveActive, 650);
      };
      editor.onkeydown = (event) => {
        if (event.key === "Tab") {
          event.preventDefault();
          const start = editor.selectionStart;
          editor.setRangeText("  ", start, editor.selectionEnd, "end");
          editor.dispatchEvent(new Event("input"));
        }
      };
    }

    const resizer = root.querySelector(".ws-resizer");
    const sidebar = root.querySelector(".ws-sidebar");
    if (resizer && sidebar) {
      resizer.onmousedown = (event) => {
        event.preventDefault();
        resizer.classList.add("dragging");
        const startX = event.clientX;
        const startWidth = sidebar.getBoundingClientRect().width;
        const move = (moveEvent) => {
          sidebar.style.width = `${Math.max(160, Math.min(420, startWidth + moveEvent.clientX - startX))}px`;
        };
        const up = () => {
          resizer.classList.remove("dragging");
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
      };
      resizer.onkeydown = (event) => {
        if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
        event.preventDefault();
        const width = sidebar.getBoundingClientRect().width + (event.key === "ArrowRight" ? 16 : -16);
        sidebar.style.width = `${Math.max(160, Math.min(420, width))}px`;
      };
    }

    const editorResizer = root.querySelector(".ws-editor-resizer");
    const editorArea = root.querySelector(".ws-editor-area");
    if (editorResizer && editorArea) {
      editorResizer.onmousedown = (event) => {
        event.preventDefault();
        editorResizer.classList.add("dragging");
        const bounds = editorArea.getBoundingClientRect();
        const move = (moveEvent) => {
          editorWidth = Math.max(25, Math.min(75, ((moveEvent.clientX - bounds.left) / bounds.width) * 100));
          root.style.setProperty("--editor-width", `${editorWidth}%`);
        };
        const up = () => {
          editorResizer.classList.remove("dragging");
          localStorage.setItem("lumen-workspace-editor-width", String(editorWidth));
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
      };
      editorResizer.onkeydown = (event) => {
        if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
        event.preventDefault();
        editorWidth = Math.max(25, Math.min(75, editorWidth + (event.key === "ArrowRight" ? 5 : -5)));
        root.style.setProperty("--editor-width", `${editorWidth}%`);
        localStorage.setItem("lumen-workspace-editor-width", String(editorWidth));
      };
    }
  }

  async function refreshTree(preferredPath = null) {
    const result = await api.workspace.list();
    tree = result.tree;
    vaultRoot = result.root;
    if (preferredPath) selectedPath = preferredPath;
    renderShell();
  }

  async function openFile(path) {
    await saveActive();
    const nextContent = await api.workspace.read(path);
    activePath = path;
    selectedPath = path;
    content = nextContent;
    savedContent = content;
    renderShell();
  }

  async function saveActive() {
    clearTimeout(saveTimer);
    if (!activePath || content === savedContent) return;
    await api.workspace.write(activePath, content);
    savedContent = content;
    const status = root.querySelector(".ws-save-state");
    if (status) status.textContent = "已保存";
  }

  function openDialog(kind, target = "", targetType = "") {
    dialog = { kind, target, targetType };
    const isDelete = kind === "delete";
    const labels = {
      file: "新建 Markdown 笔记",
      folder: "新建文件夹",
      rename: "重命名",
      delete: "确认删除",
    };
    root.insertAdjacentHTML(
      "beforeend",
      `<div class="ws-dialog-backdrop">
        <div class="ws-dialog">
          <strong>${labels[kind]}</strong>
          ${
            isDelete
              ? `<div>将删除「${esc(target.split("/").pop())}」${targetType === "folder" ? "及其全部子项" : ""}，此操作不可恢复。</div>`
              : `<input class="ws-dialog-input" value="${
                  kind === "rename" ? attr(target.split("/").pop()) : ""
                }" placeholder="${kind === "folder" ? "文件夹名称" : "笔记名称"}" />`
          }
          <div class="ws-dialog-actions">
            <button class="ws-btn" data-dialog="cancel">取消</button>
            <button class="ws-btn primary" data-dialog="confirm">${isDelete ? "删除" : "确定"}</button>
          </div>
        </div>
      </div>`,
    );
    const input = root.querySelector(".ws-dialog-input");
    input?.focus();
    input?.select();
    root.querySelector(".ws-dialog-backdrop").onclick = async (event) => {
      const button = event.target.closest("[data-dialog]");
      if (event.target.classList.contains("ws-dialog-backdrop") || button?.dataset.dialog === "cancel") {
        closeDialog();
      }
      if (button?.dataset.dialog === "confirm") await confirmDialog();
    };
    if (input) {
      input.onkeydown = async (event) => {
        if (event.key === "Enter") await confirmDialog();
        if (event.key === "Escape") closeDialog();
      };
    }
  }

  function closeDialog() {
    root.querySelector(".ws-dialog-backdrop")?.remove();
    dialog = null;
  }

  async function confirmDialog() {
    if (!dialog) return;
    const current = dialog;
    const value = root.querySelector(".ws-dialog-input")?.value.trim();
    closeDialog();
    let nextPath = null;

    if (current.kind === "file" && value) {
      nextPath = await api.workspace.createFile(selectedFolder(), value);
      expanded.add(parentPath(nextPath));
      await refreshTree(nextPath);
      await openFile(nextPath);
    }
    if (current.kind === "folder" && value) {
      nextPath = await api.workspace.createFolder(selectedFolder(), value);
      expanded.add(nextPath);
      expanded.add(parentPath(nextPath));
      await refreshTree(nextPath);
    }
    if (current.kind === "rename" && value) {
      nextPath = await api.workspace.rename(current.target, value);
      if (activePath === current.target) activePath = nextPath;
      if (activePath?.startsWith(`${current.target}/`)) {
        activePath = `${nextPath}${activePath.slice(current.target.length)}`;
      }
      await refreshTree(nextPath);
    }
    if (current.kind === "delete") {
      await api.workspace.remove(current.target);
      if (activePath === current.target || activePath?.startsWith(`${current.target}/`)) {
        activePath = null;
        content = "";
        savedContent = "";
      }
      selectedPath = "";
      await refreshTree();
    }
  }

  function openPalette() {
    if (paletteOpen) return;
    paletteOpen = true;
    paletteQuery = "";
    root.insertAdjacentHTML(
      "beforeend",
      `<div class="ws-palette-backdrop">
        <div class="ws-palette">
          <input class="ws-palette-input" placeholder="快速查找 Markdown 文件" />
          <div class="ws-palette-list"></div>
        </div>
      </div>`,
    );
    renderPalette();
    const input = root.querySelector(".ws-palette-input");
    input.focus();
    input.oninput = () => {
      paletteQuery = input.value;
      renderPalette();
    };
    root.querySelector(".ws-palette-backdrop").onclick = async (event) => {
      if (event.target.classList.contains("ws-palette-backdrop")) closePalette();
      const item = event.target.closest("[data-palette-path]");
      if (item) {
        const path = item.dataset.palettePath;
        closePalette();
        await openFile(path);
      }
    };
  }

  function renderPalette() {
    const q = paletteQuery.trim().toLowerCase();
    const files = flatten(tree, "file")
      .filter((file) => !q || file.path.toLowerCase().includes(q))
      .slice(0, 30);
    root.querySelector(".ws-palette-list").innerHTML = files
      .map(
        (file) => `<button class="palette-item" data-palette-path="${attr(file.path)}">
          ${esc(file.name)}<small>${esc(parentPath(file.path) || "根目录")}</small>
        </button>`,
      )
      .join("");
  }

  function closePalette() {
    root.querySelector(".ws-palette-backdrop")?.remove();
    paletteOpen = false;
  }

  window.addEventListener("keydown", async (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      await saveActive();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "p") {
      event.preventDefault();
      openPalette();
    }
    if (event.key === "Escape") {
      if (dialog) closeDialog();
      else if (paletteOpen) closePalette();
      else if (modulesReady && modulesInstance.closeModal()) return;
    }
  });

  window.addEventListener("beforeunload", () => {
    if (activePath && content !== savedContent) {
      // Electron IPC 无法阻塞 beforeunload，日常编辑已由 650ms 自动保存覆盖。
      void api.workspace.write(activePath, content);
    }
  });

  // 快速便签中新建、编辑或改名后，完整笔记即时同步对应文件
  api.onWorkspaceChanged?.((change = {}) => {
    void (async () => {
      const rename = change.renames?.find((item) => item.from === activePath);
      if (rename) {
        activePath = rename.to;
        selectedPath = rename.to;
      }
      await refreshTree(activePath);
      if (activePath && content === savedContent) {
        content = await api.workspace.read(activePath);
        savedContent = content;
        renderShell();
      }
    })();
  });

  api.onState?.((next) => {
    if (section === "ai" && modulesInstance?.syncAiMessages && Array.isArray(next?.aiMessages)) {
      modulesInstance.syncAiMessages(next.aiMessages);
    }
  });

  (async () => {
    const [runtimeVersion, initialMaximized] = await Promise.all([
      api.getAppVersion?.().catch(() => "") || "",
      api.window.isMaximized?.().catch(() => false) || false,
    ]);
    appVersion = String(runtimeVersion || "");
    maximized = Boolean(initialMaximized);
    api.window.onMaximized?.((next) => {
      maximized = Boolean(next);
      root.classList.toggle("maximized", maximized);
    });
    modulesInstance = window.DMWorkspaceModules?.create(api, {
      esc,
      attr,
      rerender: () => renderShell(),
      openNote: async (path) => {
        await openFile(path);
        const result = await api.workspace.list();
        tree = result.tree;
        let parent = parentPath(path);
        while (parent) { expanded.add(parent); parent = parentPath(parent); }
        await setSection("notes");
      },
    });
    modulesReady = Boolean(modulesInstance);
    const result = await api.workspace.list();
    tree = result.tree;
    vaultRoot = result.root;
    flatten(tree, "folder").forEach((folder) => expanded.add(folder.path));
    const first = flatten(tree, "file")[0];
    if (first) {
      activePath = first.path;
      selectedPath = first.path;
      content = await api.workspace.read(first.path);
      savedContent = content;
    }
    if (section !== "notes" && modulesInstance) await modulesInstance.loadAll();
    renderShell();
  })();

  api.onWorkspaceSection?.((next) => {
    void setSection(next || "notes");
  });
})();
