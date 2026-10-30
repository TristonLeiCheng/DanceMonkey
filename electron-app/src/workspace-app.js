(() => {
  if (!location.hash.startsWith("#workspace")) return;

  const root = document.getElementById("root");
  const isElectron = Boolean(window.lumen?.workspace);
  const api = window.lumen || createBrowserApi();
  const SECTIONS = [
    ["ai", "AI"],
    ["personas", "人物分身"],
    ["notes", "笔记"],
    ["tasks", "Zen Task"],
    ["projects", "项目"],
    ["links", "快速访问"],
    ["sync", "文件同步"],
    ["reminders", "定时提醒"],
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
    return ["ai", "personas", "notes", "tasks", "projects", "links", "sync", "reminders", "settings"].includes(part)
      ? part
      : "notes";
  }

  let tree = [];
  let vaultRoot = "";
  let activePath = null;
  let homeQuery = "";
  let homeSort = "updatedAt";
  let noteNavigation = 0;
  let selectedPath = "";
  let content = "";
  let savedContent = "";
  let vaults = [];
  let vaultSwitching = false;
  let expanded = new Set();
  let expandedRestored = false;
  let viewMode = localStorage.getItem("lumen-workspace-view") || "live";
  let effect = localStorage.getItem("lumen-workspace-effect") || "glass";
  let theme = localStorage.getItem("lumen-workspace-theme") || "dark";
  if (!THEMES.some(([value]) => value === theme)) theme = "dark";
  const storedBackgroundOpacity = localStorage.getItem("lumen-workspace-opacity");
  let backgroundOpacity = storedBackgroundOpacity === null ? 82 : Number(storedBackgroundOpacity);
  if (!Number.isFinite(backgroundOpacity)) backgroundOpacity = 82;
  backgroundOpacity = Math.max(35, Math.min(100, Math.round(backgroundOpacity)));
  let editorWidth = Number(localStorage.getItem("lumen-workspace-editor-width")) || 50;
  let sidebarWidth = window.DMTreeState.restoreWidth(localStorage);
  let appVersion = "";
  let maximized = false;
  let saveTimer = null;
  let saveInFlight = Promise.resolve();
  let syncPaused = false;
  let syncDraftBlocked = false;
  let dialog = null;
  let paletteOpen = false;
  let paletteQuery = "";
  let section = sectionFromHash();
  let modulesReady = false;
  let modulesInstance = null;
  let pendingProject = null;
  api.onWorkspaceProject?.(async id => {
    if (!modulesReady) { pendingProject = id; return; }
    await setSection("projects");
    await modulesInstance.openProject(id);
  });

  const updateUI = window.DMAppUpdateUI.create(api, { esc, beforeApply: async () => {
    await saveActive();
    // Flush a final snapshot if typing continued while the previous save was pending.
    await saveActive();
  } });

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
    for (const entry of entries) if (entry.type === "file" && !entry.createdAt) entry.createdAt = entry.updatedAt || Date.now();
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
            createdAt: entry.createdAt || entry.updatedAt,
            size: new TextEncoder().encode(entry.content || "").length,
            title: entry.title,
            appearance: entry.appearance,
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
        inspect: async (path, text) => {
          const files = entries.filter(item => item.type === 'file' && (item.path === path || window.DMNotesHome.isPersonal(item))).map(item => ({ ...item, content: item.path === path ? text : item.content }));
          const file = entries.find(item => item.path === path);
          if (!file) throw new Error('笔记已不存在');
          return { path, root: '浏览器预览/LumenVault', ...file, ...window.DMNoteDetails.model.buildRelations(files, path), omitted: 0, unreadable: 0 };
        },
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
            createdAt: Date.now(),
          });
          save();
          return path;
        },
        createNote: async ({ type, title }) => {
          const kind = window.DMNotesHome.kind(type);
          const resolvedTitle = String(title || "").trim() || (type === "daily" ? window.DMNotesHome.localDay() : `未命名${kind.label}`);
          if (!entries.some(entry => entry.path === kind.folder)) entries.push({ type: "folder", path: kind.folder });
          const path = unique(kind.folder, resolvedTitle, "file");
          entries.push({ type: "file", path, title: resolvedTitle, content: window.DMNotesHome.compose(type, resolvedTitle, crypto.randomUUID()), createdAt: Date.now(), updatedAt: Date.now() });
          save();
          return { path };
        },
        createFolder: async (parent, name) => {
          const path = unique(parent, name, "folder");
          entries.push({ type: "folder", path });
          save();
          return path;
        },
        setAppearance: async (path, value) => {
          const entry = entries.find(item => item.path === path);
          if (!entry) throw new Error("笔记或文件夹已不存在，请刷新后重试");
          entry.appearance = window.DMNoteAppearance.normalize(value);
          save();
          return entry.appearance;
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
    if (!selectedPath) return "";
    const selected = flatten(tree).find((node) => node.path === selectedPath);
    return selected?.type === "folder" ? selected.path : parentPath(selectedPath);
  }

  function persistExpanded() {
    window.DMTreeState.saveForVault(localStorage, vaultRoot, expanded);
  }

  function restoreExpanded() {
    expanded = window.DMTreeState.restoreForVault(localStorage, vaultRoot, tree);
    expandedRestored = true;
    persistExpanded();
  }

  function reconcileExpanded() {
    if (!expandedRestored) return restoreExpanded();
    expanded = window.DMTreeState.restore(tree, [...expanded]);
    persistExpanded();
  }

  function toggleFolder(path) {
    if (expanded.has(path)) expanded.delete(path);
    else expanded.add(path);
    persistExpanded();
  }

  function expandAncestors(path) {
    let parent = parentPath(path);
    while (parent) {
      expanded.add(parent);
      parent = parentPath(parent);
    }
    persistExpanded();
  }

  function renderMarkdown(value) {
    const source = String(value || "");
    const parts = window.DMNoteDetails.model.splitMetadata(source);
    let frontmatter = false;
    if (parts.exists) { try { window.DMNoteDetails.model.validateMetadata(parts.yaml); frontmatter = true; } catch {} }
    const body = frontmatter ? parts.body : source;
    const header = frontmatter ? `<details class="ws-note-metadata"><summary>笔记元数据</summary><pre>${esc(parts.yaml)}</pre></details>` : "";
    if (!window.marked || !window.DOMPurify) return `${header}<pre>${esc(body)}</pre>`;
    return header + window.DOMPurify.sanitize(
      window.marked.parse(body, { gfm: true, breaks: false }),
      { USE_PROFILES: { html: true } },
    );
  }

  function treeIcon(name) {
    const paths = {
      chevron: '<path d="m9 5 7 7-7 7"/>',
      folder: '<path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z"/>',
      file: '<path d="M14 3H5v18h14V8l-5-5Z"/><path d="M14 3v5h5M8 13h8M8 17h5"/>',
      newFile: '<path d="M13 3H5v18h14V9M13 3v6h6M17 2v6M14 5h6"/>',
      newFolder: '<path d="M21 13v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5l2 3h3M19 4v6M16 7h6"/>',
      refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1"/>',
      edit: '<path d="m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-4-4L5 15l-1 5Z"/>',
      palette: '<path d="M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1-3.7c-.8-.5-.5-1.8.5-1.8H17a4 4 0 0 0 4-4A9 9 0 0 0 12 3Z"/><path d="M7 10h.01M10 6.5h.01M15 7h.01M17.5 11h.01"/>',
      trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6"/>',
      vault: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 13h8"/>',
    };
    return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.folder}</svg>`;
  }

  function renderTreeNodes(nodes, depth = 0) {
    return nodes
      .map((node) => {
        const open = expanded.has(node.path);
        const appearance = window.DMNoteAppearance.get(node);
        const row = `<div class="tree-row ${node.path === selectedPath ? "active" : ""} ${node.path === activePath ? "current-note" : ""}"
          data-type="${node.type}" data-path="${attr(node.path)}" style="padding-left:${5 + depth * 16}px;${window.DMNoteAppearance.style(node)}">
          ${node.type === "folder"
            ? `<button class="tree-expander ${open ? "expanded" : "collapsed"}" data-action="tree-toggle" aria-label="${open ? "折叠" : "展开"}文件夹 ${attr(node.name)}" aria-expanded="${open}" title="${open ? "折叠文件夹" : "展开文件夹"}">${treeIcon("chevron")}</button>`
            : '<span class="tree-expander-placeholder" aria-hidden="true"></span>'}
          <button class="tree-icon" data-action="appearance" title="设置颜色和表情" aria-label="设置 ${attr(node.name)} 的颜色和表情">${appearance.emoji ? esc(appearance.emoji) : treeIcon(node.type)}</button>
          <button class="tree-name" data-action="tree-open" title="${attr(node.path)}">${esc(node.name)}</button>
          <span class="tree-actions">
            <button class="tree-action" data-action="appearance" title="颜色和表情" aria-label="设置 ${attr(node.name)} 的颜色和表情">${treeIcon("palette")}</button>
            <button class="tree-action" data-action="rename" title="重命名" aria-label="重命名 ${attr(node.name)}">${treeIcon("edit")}</button>
            <button class="tree-action danger" data-action="delete" title="删除" aria-label="删除 ${attr(node.name)}">${treeIcon("trash")}</button>
          </span>
        </div>`;
        const children =
          node.type === "folder" && open ? renderTreeNodes(node.children || [], depth + 1) : "";
        return row + children;
      })
      .join("");
  }

  let markdownEditor, noteImageTransfer, noteDetails;
  function renderShell() {
    if (noteImageTransfer?.busy) { void noteImageTransfer.flush().then(renderShell); return; }
    noteImageTransfer?.destroy(); noteImageTransfer = null;
    noteDetails?.destroy(); noteDetails = null;
    markdownEditor?.text(); markdownEditor?.destroy(); markdownEditor = null;
    const lightTheme = LIGHT_THEMES.has(theme) ? "light" : "";
    root.className = `workspace-root effect-${effect} theme-${theme} ${lightTheme} ${maximized ? "maximized" : ""}`;
    root.style.setProperty("--editor-width", `${editorWidth}%`);
    root.style.setProperty("--sidebar-width", `${sidebarWidth}px`);
    root.style.setProperty("--ws-opacity", String(backgroundOpacity / 100));
    const isNotes = section === "notes";
    const title =
      section === "reminders" ? "定时提醒" :
      section === "ai"
        ? "AI 问答"
        : section === "personas"
          ? "人物分身"
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
                : activePath || "笔记主页";
    modulesInstance?.disposePreviews?.();
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
        <div data-app-update-slot="title" class="ws-update-slot">${updateUI.renderButton()}</div>
        <div class="ws-window-actions">
          ${isElectron ? '<button class="ws-quit-btn" data-action="quit-app" title="完全退出软件" aria-label="退出软件">退出</button>' : ""}
          <button class="ws-window-btn" data-action="minimize" title="最小化">−</button>
          <button class="ws-window-btn" data-action="maximize" title="最大化">□</button>
          <button class="ws-window-btn close" data-action="close-window" title="关闭窗口（程序继续运行）">×</button>
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
          <button class="ws-home-button ${activePath ? "" : "active"}" data-action="notes-home" aria-current="${activePath ? "false" : "page"}">${treeIcon("vault")} 笔记主页</button>
          <div class="ws-sidebar-head">
            <strong>文件</strong>
            ${api.note ? `<button class="ws-tool" data-action="open-local-md" title="打开本机 MD 文件" aria-label="打开本机 MD 文件"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8V5a2 2 0 0 1 2-2h5l3 3h6a2 2 0 0 1 2 2v2M3 8h7l3 3h8l-3 9H5L3 8Z"/></svg></button>` : ''}
            <button class="ws-tool" data-action="new-file" title="在所选位置新建笔记" aria-label="新建笔记">${treeIcon("newFile")}</button>
            <button class="ws-tool" data-action="new-folder" title="在所选位置新建文件夹" aria-label="新建文件夹">${treeIcon("newFolder")}</button>
            <button class="ws-tool" data-action="refresh" title="刷新目录树" aria-label="刷新目录树">${treeIcon("refresh")}</button>
          </div>
          <div class="ws-tree" aria-label="笔记文件目录">
            <div class="tree-root-row ${selectedPath === "" ? "active" : ""}">
              <button class="tree-root-name" data-action="select-root" title="选择根目录，新内容将创建在这里">${treeIcon("vault")}<span>根目录</span></button>
              <button class="tree-action" data-action="new-root-file" title="在根目录新建笔记" aria-label="在根目录新建笔记">${treeIcon("newFile")}</button>
              <button class="tree-action" data-action="new-root-folder" title="在根目录新建文件夹" aria-label="在根目录新建文件夹">${treeIcon("newFolder")}</button>
            </div>
            ${renderTreeNodes(tree)}
            ${tree.length ? "" : '<div class="ws-tree-empty">笔记库还是空的<br>点击上方图标新建笔记或文件夹</div>'}
          </div>
          <details class="ws-vault-options">
            <summary aria-label="笔记选项：切换笔记库、模板与知识库设置" title="切换笔记库、模板与知识库设置"><span>${esc(vaults.find(vault => vault.root === vaultRoot)?.name || vaultRoot.split(/[\\/]/).pop() || "笔记选项")}</span><span class="ws-vault-options-more" aria-hidden="true">···</span></summary>
            <div class="ws-vault-options-panel">
          <div class="ws-vault-bar">
            <span class="ws-vault-icon">${treeIcon("vault")}</span>
            <label class="ws-vault-label"><span>笔记库</span>
              <select class="ws-vault-select" aria-label="切换笔记库" title="${attr(vaultRoot)}" ${vaultSwitching || !api.vaults ? "disabled" : ""}>
                ${(vaults.length ? vaults : [{ root: vaultRoot, name: vaultRoot.split(/[\\/]/).pop() || "本地笔记库" }]).map((vault) => `<option value="${attr(vault.root)}" title="${attr(vault.root)}" ${vault.root === vaultRoot ? "selected" : ""}>${esc(vault.name)}${vaults.filter((item) => item.name === vault.name).length > 1 ? ` — ${esc(vault.root)}` : ""}</option>`).join("")}
                ${api.vaults ? '<option value="__open-vault__">打开其他笔记库…</option>' : ""}
              </select>
            </label>
            <button class="ws-tool" data-action="open-vault" title="打开或新建笔记库" aria-label="打开或新建笔记库" ${vaultSwitching || !api.vaults ? "disabled" : ""}>${treeIcon("newFolder")}</button>
          </div>
          ${api.pkb ? `<div class="ws-vault-tools" aria-label="个人知识库工具">
            <button class="ws-mode" data-action="pkb-setup" title="预览并建立标准目录，不移动旧笔记">PKB 设置</button>
            <button class="ws-mode" data-action="pkb-note" title="从模板创建笔记、日记、会议或人物档案">模板</button>
            <button class="ws-mode" data-action="pkb-search" title="搜索笔记正文">全文搜索</button>
          </div>` : ""}
          <div class="ws-vault-path" title="${attr(vaultRoot)}">${esc(vaultRoot)}</div>
            </div>
          </details>
        </aside>
        <div class="ws-resizer" role="separator" aria-label="调整文件树宽度" aria-orientation="vertical" aria-valuemin="160" aria-valuemax="420" aria-valuenow="${sidebarWidth}" tabindex="0"></div>
        <section class="ws-main">
          ${
            activePath
              ? `<div class="ws-docbar" style="${appearanceStyle(activePath)}">
                  <button class="ws-note-appearance-button" data-action="note-appearance" title="设置颜色和表情" aria-label="设置当前笔记的颜色和表情" style="${appearanceStyle(activePath)}">${esc(window.DMNoteAppearance.get(flatten(tree).find(node => node.path === activePath)).emoji) || treeIcon('file')}</button>
                  <div class="ws-doc-name" style="${appearanceStyle(activePath)}">${esc(activePath.split("/").pop())}</div>
                  <span class="ws-save-state">${content === savedContent ? "已保存" : "待保存"}</span>
                  <button class="ws-mode" data-action="note-to-tasks" title="选中文字生成候选任务；未选中时读取整篇笔记">生成项目任务</button>
                  <button class="ws-mode" data-action="popout-note">弹出窗口 ↗</button>
                  <div class="ws-mode-group">
                    <button class="ws-mode ${viewMode === "live" ? "active" : ""}" data-action="view" data-value="live">实时预览</button>
                    <button class="ws-mode ${viewMode === "edit" ? "active" : ""}" data-action="view" data-value="edit">编辑</button>
                    <button class="ws-mode ${viewMode === "split" ? "active" : ""}" data-action="view" data-value="split">分栏</button>
                    <button class="ws-mode ${viewMode === "preview" ? "active" : ""}" data-action="view" data-value="preview">预览</button>
                  </div>
                </div>
                ${window.DMMarkdownTools.toolbar(viewMode === "preview")}
                <div class="note-workarea"><div class="ws-editor-area view-${viewMode}" style="${appearanceStyle(activePath)}">
                  ${viewMode === "live" ? '<div class="note-editor ws-live-editor"></div>' : `<textarea class="ws-editor" spellcheck="false" aria-label="Markdown 编辑器">${esc(content)}</textarea>`}
                  <div class="ws-editor-resizer" role="separator" aria-label="调整编辑与预览宽度" tabindex="0"></div>
                  <article class="ws-preview">${renderMarkdown(content)}</article>
                </div>${window.DMNoteDetails.markup()}</div>`
              : window.DMNotesHome.render({ tree, vaultRoot, query: homeQuery, sort: homeSort, fullText: Boolean(api.pkb) })
          }
        </section>`
            : `<section class="ws-main module-main" id="module-root">${
                modulesReady ? modulesInstance.render(section) : '<div class="module-empty">正在加载模块…</div>'
              }</section>`
        }
      </div>
      <footer class="ws-statusbar">
        ${isNotes && activePath ? `<span class="note-file-path" title="${attr(vaultRoot + '/' + activePath)}" aria-label="文档路径">${esc(vaultRoot + '/' + activePath)}</span>` : ""}
        <span>${
          isNotes
            ? "Markdown"
            : section === "ai"
              ? "AI Chat"
              : section === "personas"
                ? "人物分身"
              : section === "tasks"
                ? "Zen Task"
                : section === "projects"
                  ? "Projects"
                  : section === "reminders"
                    ? "Reminders"
                  : section === "sync"
                    ? "Folder Sync"
                    : section === "settings"
                    ? "Settings"
                    : "Quick Access"
        }</span>
        <span class="ws-count">${
          isNotes
            ? activePath ? `${content.length} 字符` : `${window.DMNotesHome.filesFromTree(tree).length} 篇个人笔记`
            : section === "ai"
              ? "与快捷面板共用对话与配置"
              : section === "personas"
                ? "人物资料与对话独立保存"
              : section === "reminders"
                ? "喝水、久坐与自定义桌面提醒"
              : section === "sync"
                ? "本地 / UNC 文件夹同步"
                : section === "settings"
                ? "快捷键、桌面宠物与应用配置"
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

  async function setSection(next, { preserveNote = false } = {}) {
    if (syncPaused || vaultSwitching) return;
    const navigation = ++noteNavigation;
    const origin = vaultRoot;
    await saveActive();
    if (syncPaused || vaultSwitching || navigation !== noteNavigation) return;
    if (next === "notes" && !preserveNote) {
      const result = await api.workspace.list();
      await saveActive();
      if (syncPaused || vaultSwitching || navigation !== noteNavigation || origin !== vaultRoot || content !== savedContent) return;
      applyTree(result);
      activePath = null; selectedPath = ""; content = ""; savedContent = "";
      homeQuery = "";
    }
    if (next !== "settings") modulesInstance?.pauseGitHub?.();
    section = next;
    const hash = next === "notes" ? "#workspace" : `#workspace/${next}`;
    if (location.hash !== hash) history.replaceState(null, "", hash);
    if (next !== "notes" && modulesReady) await modulesInstance.loadAll();
    renderShell();
  }

  async function openNoteTaskDialog() {
    const editor = root.querySelector(".ws-editor");
    if ((!editor && !markdownEditor) || !activePath) return;
    const sel = markdownEditor?.view.state.selection.main;
    const selected = sel ? !sel.empty : editor.selectionStart !== editor.selectionEnd;
    const text = sel ? (selected ? markdownEditor.view.state.sliceDoc(sel.from, sel.to) : content) : (selected ? editor.value.slice(editor.selectionStart, editor.selectionEnd) : editor.value);
    const sourcePath = activePath;
    await saveActive();
    return window.DMNoteTasks.open({ root, text, sourcePath, selected, api: api.zenTask, esc, attr,
      onProjects: async id => { await setSection("projects"); await modulesInstance?.openProject?.(id); } });
  }

  function bindShell() {
    const formatbar = root.querySelector('.md-formatbar');
    if (formatbar) {
      formatbar.onmousedown = event => { if (event.target.closest('button')) event.preventDefault(); };
      formatbar.onclick = async event => {
        const button = event.target.closest('[data-md-command]');
        if (!button || button.disabled || syncPaused || vaultSwitching) return;
        const action = button.dataset.mdCommand, currentEditor = markdownEditor;
        const textarea = root.querySelector('.ws-editor'), selection = markdownEditor?.view.state.selection.main;
        let options;
        if (action === 'link' || action === 'image') {
          const label = selection ? markdownEditor.view.state.sliceDoc(selection.from, selection.to) : textarea.value.slice(textarea.selectionStart, textarea.selectionEnd);
          options = await window.DMMarkdownTools.askDestination(root, action === 'image', label);
          if (!options || !formatbar.isConnected || syncPaused || vaultSwitching) return;
        }
        if (currentEditor) currentEditor.command(action, options);
        else if (textarea) window.DMMarkdownTools.applyTextarea(textarea, action, options);
      };
    }
    root.onclick = async (event) => {
      if (syncPaused || vaultSwitching) return;
      if (modulesReady && section !== "notes") {
        const handled = await modulesInstance.handleClick(event, setSection);
        if (handled) return;
      }
      const options = root.querySelector(".ws-vault-options[open]");
      if (options && !event.target.closest(".ws-vault-options")) options.open = false;
      const control = event.target.closest("[data-action]");
      if (!control) return;
      if (options && control.closest(".ws-vault-options-panel")) options.open = false;
      const action = control.dataset.action;
      if (syncPaused || vaultSwitching) return;

      if (action === "app-update-check" || action === "app-update-apply") {
        await updateUI.handleAction(action);
        return;
      }

      if (action === "open-local-md") { try { await api.note.choose(); } catch (error) { alert(error?.message || "无法打开文件"); } return; }
      if (action === "pkb-setup") { await openPkbSetup(); return; }
      if (action === "pkb-note") { await openPkbNote(); return; }
      if (action === "pkb-search") { openPkbSearch(); return; }
      if (action === "notes-home") { try { await setSection("notes"); } catch (error) { alert(error?.message || "无法返回主页，请先保存笔记。"); } return; }
      if (action === "home-new") { openHomeNote(control.dataset.value); return; }
      if (action === "home-open") { try { await openFile(control.dataset.path); } catch (error) { alert(error?.message || "无法打开笔记，请刷新主页。"); } return; }
      if (action === "home-sort") { homeSort = control.dataset.value === "createdAt" ? "createdAt" : "updatedAt"; renderShell(); return; }
      if (action === "home-fulltext") { openPkbSearch(homeQuery); return; }
      if (action === "open-vault") { await changeVault(); return; }
      if (action === "select-root") { selectedPath = ""; renderShell(); return; }
      if (action === "new-root-file") { openDialog("file", "", "", ""); return; }
      if (action === "new-root-folder") { openDialog("folder", "", "", ""); return; }
      if (action === "note-appearance") { openAppearance(activePath); return; }

      if (action === "effect") {
        effect = control.dataset.value;
        localStorage.setItem("lumen-workspace-effect", effect);
        renderShell();
      }
      if (action === "section") {
        void setSection(control.dataset.value).catch(error => alert(error?.message || "页面切换失败，请重试。"));
        return;
      }
      if (action === "minimize") void api.window.minimize();
      if (action === "maximize") void api.window.toggleMaximize();
      if (action === "close-window") { await saveActive(); void api.window.close(); }
      if (action === "quit-app") { void api.quitApp(); return; }
      if (action === "refresh") await refreshTree();
      if (action === "new-file") openDialog("file");
      if (action === "new-folder") openDialog("folder");
      if (action === "note-to-tasks") { try { await openNoteTaskDialog(); } catch (error) { alert(error?.message || "无法生成项目任务"); } }
      if (action === "popout-note") {
        try { await saveActive(); await api.note.open(activePath, vaultRoot); activePath = null; content = savedContent = ""; renderShell(); } catch (error) { alert(error.message); }
        return;
      }
      if (action === "view") {
        viewMode = control.dataset.value;
        localStorage.setItem("lumen-workspace-view", viewMode);
        renderShell();
      }

      if (["tree-open", "tree-toggle", "rename", "delete", "appearance"].includes(action)) {
        const row = control.closest(".tree-row");
        const path = row.dataset.path;
        const type = row.dataset.type;
        selectedPath = path;
        if (action === "tree-toggle" || (action === "tree-open" && type === "folder")) {
          toggleFolder(path);
          renderShell();
        } else if (action === "tree-open") {
          try { await openFile(path); } catch (error) { alert(error.message || '无法打开笔记，请先保存当前内容'); }
        }
        if (action === "rename") openDialog("rename", path, type);
        if (action === "delete") openDialog("delete", path, type);
        if (action === "appearance") openAppearance(path);
      }
    };

    const vaultSelect = root.querySelector(".ws-vault-select");
    if (vaultSelect) vaultSelect.onchange = () => void changeVault(vaultSelect.value === "__open-vault__" ? undefined : vaultSelect.value);
    const homeSearch = root.querySelector("[data-home-search]");
    if (homeSearch) {
      homeSearch.oninput = () => {
        homeQuery = homeSearch.value;
        root.querySelector(".notes-home-results").innerHTML = window.DMNotesHome.renderResults({ tree, query: homeQuery, sort: homeSort });
      };
      homeSearch.onkeydown = async event => {
        if (event.key === "Enter") {
          event.preventDefault();
          const file = window.DMNotesHome.select(window.DMNotesHome.filesFromTree(tree), homeQuery, homeSort)[0];
          if (file) { try { await openFile(file.path); } catch (error) { alert(error?.message || "无法打开笔记"); } }
        }
      };
    }

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

    const host = root.querySelector('.ws-live-editor');
    if (host && window.DMMarkdownEditor) {
      markdownEditor = window.DMMarkdownEditor(host, { content, mode: 'live',
        resolveImage: src => api.note.image(src, activePath, vaultRoot),
        onSave: () => { void saveActive().catch(error => alert(error.message)); },
        onChange: text => {
          content = text;
          noteDetails?.onTextChanged();
          root.querySelector('.ws-count').textContent = `${content.length} 字符`;
          root.querySelector('.ws-save-state').textContent = '待保存';
          clearTimeout(saveTimer); saveTimer = setTimeout(() => { void saveActive().catch(error => { const status = root.querySelector('.ws-save-state'); if(status) status.textContent = error.message; }); }, 650);
        } });
      host.addEventListener('md-source-request', () => { viewMode = 'edit'; renderShell(); });
    }
    const editor = root.querySelector(".ws-editor");
    if (editor) {
      editor.oninput = () => {
        content = editor.value;
        noteDetails?.onTextChanged();
        root.querySelector(".ws-preview").innerHTML = renderMarkdown(content);
        if (api.note) window.DMNoteImages.hydrateImages(root.querySelector(".ws-preview"), src => api.note.image(src, activePath, vaultRoot));
        root.querySelector(".ws-count").textContent = `${content.length} 字符`;
        root.querySelector(".ws-save-state").textContent = "保存中…";
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
          void saveActive().catch((error) => {
            const status = root.querySelector(".ws-save-state");
            if (status) status.textContent = error?.message || "保存失败，请重试";
          });
        }, 650);
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

    const detailsHost = root.querySelector('.note-workarea');
    if (detailsHost && activePath) {
      const path = activePath, origin = vaultRoot;
      noteDetails = window.DMNoteDetails.create({ host: detailsHost, path, root: origin, getText: () => content,
        replaceText: text => {
          content = text;
          if (markdownEditor) markdownEditor.replace(text);
          if (editor) editor.value = text;
          root.querySelector('.ws-preview').innerHTML = renderMarkdown(text);
          root.querySelector('.ws-count').textContent = `${text.length} 字符`;
        },
        inspect: text => api.workspace.inspect(path, text, origin), save: saveActive, openNote: openFile,
        onDraft: () => {
          const status = root.querySelector('.ws-save-state');
          if (status) status.textContent = noteDetails?.hasDraft() ? '元数据待保存' : content === savedContent ? '已保存' : '待保存';
          clearTimeout(saveTimer);
          if (!syncPaused && !vaultSwitching && noteDetails?.hasDraft()) saveTimer = setTimeout(() => { void saveActive().catch(error => { if (status?.isConnected) status.textContent = error.message; }); }, 650);
        },
      });
    }

    const imageHost = root.querySelector('.ws-editor-area');
    if (imageHost && api.note?.importImages) {
      const targetPath = activePath, targetRoot = vaultRoot;
      noteImageTransfer = window.DMNoteImages.attachImageImport(imageHost, {
        canImport: () => !syncPaused && !vaultSwitching && viewMode !== 'preview' && !root.dataset.quitting,
        getSelection: event => {
          if (!markdownEditor) return { from: editor.selectionStart, to: editor.selectionEnd };
          const cursor = event.type === 'drop' ? markdownEditor.view.posAtCoords({ x: event.clientX, y: event.clientY }) : null;
          return cursor === null ? markdownEditor.view.state.selection.main : { from: cursor, to: cursor };
        },
        importImages: images => api.note.importImages(images, targetPath, targetRoot),
        insert: (markdown, selection) => {
          if (markdownEditor) markdownEditor.insertImageMarkdown(markdown, selection);
          else { const change = window.DMNoteImages.imageInsertion(editor.value, markdown, selection); editor.setRangeText(change.insert, change.from, change.to, 'end'); editor.dispatchEvent(new Event('input', { bubbles: true })); }
        },
        onBusy: busy => { root.inert = busy || syncPaused || vaultSwitching || Boolean(root.dataset.quitting); if (busy) root.querySelector('.ws-save-state').textContent = '正在导入图片…'; },
        onError: message => { root.querySelector('.ws-save-state').textContent = message; },
      });
      window.DMNoteImages.hydrateImages(root.querySelector('.ws-preview'), src => api.note.image(src, targetPath, targetRoot));
    }

    const resizer = root.querySelector(".ws-resizer");
    const sidebar = root.querySelector(".ws-sidebar");
    if (resizer && sidebar) {
      const resizeSidebar = (value, persist = false) => {
        sidebarWidth = persist ? window.DMTreeState.saveWidth(localStorage, value) : window.DMTreeState.clampWidth(value);
        root.style.setProperty('--sidebar-width', `${sidebarWidth}px`);
        resizer.setAttribute('aria-valuenow', String(sidebarWidth));
      };
      resizer.onmousedown = (event) => {
        event.preventDefault();
        resizer.classList.add("dragging");
        const startX = event.clientX;
        const startWidth = sidebar.getBoundingClientRect().width;
        const move = (moveEvent) => {
          resizeSidebar(startWidth + moveEvent.clientX - startX);
        };
        const up = () => {
          resizeSidebar(sidebarWidth, true);
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
        resizeSidebar(width, true);
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

  function applyTree(result) {
    const changed = vaultRoot !== result.root;
    if (changed) {
      if (vaultRoot) persistExpanded();
      activePath = null;
      homeQuery = "";
      selectedPath = "";
      content = "";
      savedContent = "";
      expandedRestored = false;
      closeDialog();
      closePalette();
    }
    tree = result.tree;
    vaultRoot = result.root;
    reconcileExpanded();
    return changed;
  }

  async function loadVaults() {
    if (api.vaults) {
      const result = await api.vaults.list();
      if (result.success === false) throw new Error(result.error || "无法加载笔记库");
      vaults = result.vaults;
    }
  }

  async function changeVault(target) {
    if (!api.vaults || syncPaused || vaultSwitching || target === vaultRoot) return;
    vaultSwitching = true;
    root.inert = true;
    try {
      await saveActive();
      persistExpanded();
      const result = target ? await api.vaults.select(target) : await api.vaults.open();
      if (result.success === false && !result.canceled) throw new Error(result.error || "切换笔记库失败");
      await loadVaults();
      await reloadSyncedNotes();
    } catch (error) {
      // A renderer reload can fail after the main process has committed the switch.
      // Reconcile with the actual root instead of leaving an old document writable.
      try { await reloadSyncedNotes(); } catch {}
      alert(error?.message || "切换笔记库失败，请重试");
    } finally {
      vaultSwitching = false;
      root.inert = syncPaused;
      renderShell();
    }
  }

  async function refreshTree(preferredPath = null) {
    const origin = vaultRoot;
    const result = await api.workspace.list();
    if (syncPaused || vaultSwitching || origin !== vaultRoot) return;
    const changed = applyTree(result);
    if (preferredPath && !changed) selectedPath = preferredPath;
    renderShell();
  }

  async function openFile(path) {
    if (syncPaused || vaultSwitching) return;
    const navigation = ++noteNavigation;
    const origin = vaultRoot;
    await saveActive();
    if (syncPaused || vaultSwitching || origin !== vaultRoot || navigation !== noteNavigation) return;
    if (await api.note?.focusExisting?.(path)) return;
    const nextContent = await api.workspace.read(path);
    if (syncPaused || vaultSwitching || origin !== vaultRoot || navigation !== noteNavigation) return;
    activePath = path;
    selectedPath = path;
    content = nextContent;
    savedContent = content;
    expandAncestors(path);
    renderShell();
  }

  function saveActive() {
    markdownEditor?.text();
    clearTimeout(saveTimer);
    const request = saveInFlight.catch(() => {}).then(async () => {
      await noteImageTransfer?.flush();
      noteDetails?.flush();
      if (!activePath || content === savedContent) return;
      const target = activePath;
      const snapshot = content;
      await api.workspace.write(target, snapshot);
      if (activePath === target) savedContent = snapshot;
      const status = root.querySelector(".ws-save-state");
      if (status) status.textContent = content === savedContent ? "已保存" : "保存中…";
    });
    saveInFlight = request;
    return request;
  }

  async function reloadSyncedNotes() {
    const changed = applyTree(await api.workspace.list());
    if (changed) {
      await loadVaults();
      if (modulesReady) await modulesInstance.reloadVault();
    } else if (modulesReady) {
      await modulesInstance.reloadSyncedTasks();
    }
    if (activePath && content === savedContent) {
      if (flatten(tree, "file").some((file) => file.path === activePath)) {
        content = await api.workspace.read(activePath);
        savedContent = content;
      } else {
        activePath = null;
        selectedPath = "";
        content = "";
        savedContent = "";
      }
    }
    renderShell();
  }

  api.onBeforeQuit?.(async (phase) => {
    if (phase === "resume") {
      delete root.dataset.quitting;
      root.inert = syncPaused || vaultSwitching;
      return;
    }
    root.dataset.quitting = "true";
    root.inert = true;
    if (phase === "prepare") await saveActive();
  });

  api.githubSync?.onEditor(async ({ phase }) => {
    if (phase === "prepare") {
      syncPaused = true;
      root.inert = true;
      syncDraftBlocked = false;
      try {
        if (root.querySelector(".ws-note-task-dialog [data-candidate]")) {
          throw new Error("请先完成或关闭从笔记生成任务的窗口。");
        }
        if (modulesReady) modulesInstance.prepareSync();
      } catch (error) {
        syncDraftBlocked = true;
        throw error;
      }
      closeDialog();
      closePalette();
      await saveActive();
    } else {
      try {
        // A rejected prepare never changes the vault. Keep its unsaved form DOM.
        if (syncDraftBlocked) return;
        await reloadSyncedNotes();
      } catch (error) {
        // Never leave a saved document from an unknown root writable after a switch.
        // A dirty draft means prepare failed, so the main process kept the old vault.
        if (content === savedContent) {
          activePath = null;
          selectedPath = "";
          content = "";
          savedContent = "";
          tree = [];
          renderShell();
        }
        throw error;
      } finally {
        syncDraftBlocked = false;
        syncPaused = false;
        root.inert = root.dataset?.quitting === "true" || vaultSwitching;
      }
    }
  });

  async function openPkbSetup() {
    if (!api.pkb || syncPaused || vaultSwitching) return;
    closePalette();
    const origin = vaultRoot;
    try {
      await saveActive();
      const plan = await api.pkb.preview(origin);
      if (syncPaused || vaultSwitching || origin !== vaultRoot) return;
      closeDialog();
      dialog = { kind: "pkb" };
      root.insertAdjacentHTML("beforeend", `<div class="ws-dialog-backdrop"><div class="ws-dialog ws-pkb-dialog" role="dialog" aria-modal="true" aria-label="PKB 设置">
        <strong>${plan.status.initialized ? "PKB 已启用 · 补齐目录与模板" : "建立长期个人知识库"}</strong>
        <p>只新增缺少的文件，不覆盖、不搬迁现有笔记。旧任务和项目 JSON 保留原位。</p>
        <p>80_Vault 不是加密保险库。敏感原件请使用独立加密存储；保护目录有文件时会阻止整个同步。</p>
        <p>${plan.directories.length} 个待建目录 · ${plan.files.length} 个待建文件</p>
        <div class="ws-pkb-plan">${[...plan.warnings, ...plan.directories, ...plan.files].map((item) => `<div>${esc(item)}</div>`).join("")}</div>
        <div class="ws-dialog-actions"><button class="ws-btn" data-pkb="cancel">取消</button><button class="ws-btn primary" data-pkb="initialize">确认并建立</button></div>
      </div></div>`);
      root.querySelector('[data-pkb="cancel"]').onclick = closeDialog;
      root.querySelector('[data-pkb="initialize"]').onclick = async () => {
        if (syncPaused || vaultSwitching || origin !== vaultRoot) return;
        closeDialog();
        try {
          const result = await api.pkb.initialize(origin);
          if (result.canceled || syncPaused || vaultSwitching || origin !== vaultRoot) return;
          await refreshTree();
          expandAncestors("_System/index.md");
          await openFile("_System/index.md");
        } catch (error) { alert(error?.message || "PKB 初始化失败，原笔记未搬迁"); }
      };
    } catch (error) { alert(error?.message || "无法预览 PKB 初始化"); }
  }

  function openHomeNote(type) {
    if (syncPaused || vaultSwitching) return;
    const kind = window.DMNotesHome.kind(type);
    const origin = vaultRoot;
    const navigation = noteNavigation;
    closeDialog(); closePalette();
    dialog = { kind: "home-note" };
    const defaultTitle = type === "daily" ? window.DMNotesHome.localDay() : `未命名${kind.label}`;
    root.insertAdjacentHTML("beforeend", `<div class="ws-dialog-backdrop"><form class="ws-dialog" data-home-create role="dialog" aria-modal="true" aria-label="新建${attr(kind.label)}">
      <strong>新建${esc(kind.label)}</strong><label>笔记标题<input class="ws-dialog-input" name="title" aria-label="笔记标题" maxlength="120" value="${type === "daily" ? defaultTitle : ""}" placeholder="${attr(defaultTitle)}" /></label>
      <p>${esc(kind.hint)}。可直接创建，之后再修改标题。${type === "project" ? "此处创建项目文档，不会新增任务模块项目。" : ""}</p>
      <p class="module-error" data-home-create-error role="alert" hidden></p>
      <div class="ws-dialog-actions"><button type="button" class="ws-btn" data-home-cancel>取消</button><button type="submit" class="ws-btn primary">创建并打开</button></div>
    </form></div>`);
    const form = root.querySelector("[data-home-create]");
    const submit = form.querySelector('[type="submit"]');
    form.querySelector("[data-home-cancel]").onclick = closeDialog;
    form.onsubmit = async event => {
      event.preventDefault();
      if (submit.disabled || syncPaused || vaultSwitching || origin !== vaultRoot) return;
      submit.disabled = true;
      try {
        await saveActive();
        if (syncPaused || vaultSwitching || origin !== vaultRoot || !form.isConnected) return;
        const result = await api.workspace.createNote({ root: origin, type, title: form.elements.title.value.trim() || defaultTitle });
        if (syncPaused || vaultSwitching || origin !== vaultRoot || navigation !== noteNavigation || !form.isConnected) return;
        closeDialog();
        expandAncestors(result.path);
        await refreshTree(result.path);
        await openFile(result.path);
      } catch (error) {
        if (form.isConnected) {
          const message = form.querySelector("[data-home-create-error]");
          message.textContent = error?.message || "创建失败，请重试"; message.hidden = false;
        }
      } finally { submit.disabled = false; }
    };
    form.querySelector("input").focus();
  }

  async function openPkbNote() {
    if (!api.pkb || syncPaused || vaultSwitching) return;
    closePalette();
    const origin = vaultRoot;
    try {
      const plan = await api.pkb.preview(origin);
      if (syncPaused || vaultSwitching || origin !== vaultRoot) return;
      if (!plan.status.initialized) { await openPkbSetup(); return; }
      closeDialog();
      dialog = { kind: "pkb-note" };
      root.insertAdjacentHTML("beforeend", `<div class="ws-dialog-backdrop"><div class="ws-dialog" role="dialog" aria-modal="true" aria-label="模板笔记">
        <strong>从模板创建</strong>
        <label class="ws-create-location">类型<select class="ws-pkb-type"><option value="note">知识笔记</option><option value="daily">日记</option><option value="meeting">会议记录</option><option value="person">人物档案</option><option value="project">项目概览文档</option></select></label>
        <input class="ws-dialog-input" aria-label="笔记标题" placeholder="输入标题" />
        <p>包含稳定 ID、类型、日期和敏感等级。项目模板仅创建文档，不会新增任务模块中的项目。</p>
        <div class="ws-dialog-actions"><button class="ws-btn" data-pkb="cancel">取消</button><button class="ws-btn primary" data-pkb="create">创建</button></div>
      </div></div>`);
      root.querySelector('[data-pkb="cancel"]').onclick = closeDialog;
      root.querySelector('[data-pkb="create"]').onclick = async () => {
        const title = root.querySelector(".ws-dialog-input")?.value.trim();
        const type = root.querySelector(".ws-pkb-type")?.value;
        if (!title || syncPaused || vaultSwitching || origin !== vaultRoot) return;
        const button = root.querySelector('[data-pkb="create"]');
        button.disabled = true;
        try {
          await saveActive();
          if (syncPaused || vaultSwitching || origin !== vaultRoot) return;
          const result = await api.pkb.createNote({ root: origin, type, title });
          if (syncPaused || vaultSwitching || origin !== vaultRoot) return;
          closeDialog();
          expandAncestors(result.path);
          await refreshTree(result.path);
          await openFile(result.path);
        } catch (error) { alert(error?.message || "模板笔记创建失败"); }
        finally { button.disabled = false; }
      };
      root.querySelector(".ws-dialog-input").focus();
    } catch (error) { alert(error?.message || "无法读取 PKB 配置"); }
  }

  function openPkbSearch(initialQuery = "") {
    if (!api.pkb || syncPaused || vaultSwitching) return;
    closeDialog();
    closePalette();
    paletteOpen = true;
    const origin = vaultRoot;
    root.insertAdjacentHTML("beforeend", `<div class="ws-palette-backdrop"><div class="ws-palette" role="dialog" aria-modal="true" aria-label="全文搜索">
      <input class="ws-palette-input" aria-label="全文搜索关键词" placeholder="输入关键词，按 Enter 搜索正文" />
      <div class="ws-palette-list"><div class="palette-item">本地全文搜索，不发送给 AI。最多显示 100 条；跳过保险库、隐藏目录和超大文件。</div></div>
    </div></div>`);
    const backdrop = root.querySelector(".ws-palette-backdrop");
    const input = backdrop.querySelector(".ws-palette-input");
    const list = backdrop.querySelector(".ws-palette-list");
    let request = 0;
    input.focus();
    input.onkeydown = async (event) => {
      if (event.key !== "Enter") return;
      const query = input.value.trim();
      const current = ++request;
      if (!query) { list.textContent = "请输入关键词"; return; }
      list.textContent = "正在搜索…";
      try {
        await saveActive();
        if (syncPaused || vaultSwitching || origin !== vaultRoot || !backdrop.isConnected) return;
        const results = await api.pkb.search(origin, query);
        if (current !== request || !backdrop.isConnected || origin !== vaultRoot) return;
        list.innerHTML = results.length ? results.map((item) => `<button class="palette-item" data-palette-path="${attr(item.path)}">${esc(item.title)}<small>${esc(item.path)}</small><small>${esc(item.snippet)}</small></button>`).join("") : '<div class="palette-item">未找到匹配内容</div>';
      } catch (error) { if (backdrop.isConnected && current === request) list.textContent = error?.message || "搜索失败"; }
    };
    if (initialQuery.trim()) { input.value = initialQuery; void input.onkeydown({ key: "Enter" }); }
    backdrop.onclick = async (event) => {
      if (event.target === backdrop) { closePalette(); return; }
      const item = event.target.closest("[data-palette-path]");
      if (item && origin === vaultRoot && !syncPaused && !vaultSwitching) {
        closePalette();
        await openFile(item.dataset.palettePath);
      }
    };
  }

  function appearanceStyle(path) {
    return window.DMNoteAppearance.style(flatten(tree).find(node => node.path === path));
  }

  function openAppearance(path) {
    if (syncPaused || vaultSwitching) return;
    const node = flatten(tree).find(item => item.path === path);
    if (!node) return;
    closeDialog();
    closePalette();
    const origin = vaultRoot;
    const draft = window.DMNoteAppearance.get(node);
    const colorField = (field, label, palette) => `<fieldset><legend>${label}</legend><div class="ws-appearance-colors">
      <button type="button" data-appearance-color="" data-color-field="${field}" aria-label="默认${label}" title="默认${label}">↺</button>
      ${palette.map(([color, name]) => `<button type="button" data-appearance-color="${color}" data-color-field="${field}" style="--swatch:${color}" aria-label="${label}：${name}" title="${name}"></button>`).join('')}
      </div><label class="ws-appearance-custom-color">自定义<input type="color" data-color-input="${field}" aria-label="自定义${label}" value="${draft[field] || (field === 'color' ? '#639ce0' : '#e6effb')}"></label></fieldset>`;
    dialog = { kind: 'appearance', returnFocus: document.activeElement };
    root.insertAdjacentHTML('beforeend', `<div class="ws-dialog-backdrop ws-appearance-backdrop">
      <form class="ws-dialog ws-appearance-dialog" role="dialog" aria-modal="true" aria-labelledby="appearance-title">
        <strong id="appearance-title">${node.type === 'folder' ? '文件夹' : '笔记'}颜色和表情</strong>
        <div class="ws-appearance-preview"><span data-appearance-preview-icon aria-hidden="true"></span><span>${esc(node.name)}</span></div>
        <fieldset><legend>外观模板</legend><div class="ws-appearance-templates">${window.DMNoteAppearance.templates.map(item => `<button type="button" data-appearance-template="${item.id}" style="${window.DMNoteAppearance.style({ appearance: item })}"><span aria-hidden="true">${item.emoji}</span>${item.label}</button>`).join('')}</div></fieldset>
        <div class="ws-appearance-color-pair">${colorField('color', '文字颜色', window.DMNoteAppearance.colors)}${colorField('backgroundColor', '背景颜色', window.DMNoteAppearance.backgrounds)}</div>
        <fieldset><legend>Emoji 表情 <span class="ws-appearance-emoji-count">${window.DMNoteAppearance.emojis.length} 个可选</span></legend>
          <div class="ws-appearance-emoji-tools"><select aria-label="表情分类"><option value="all">全部表情</option>${window.DMNoteAppearance.emojiGroups.map(group => `<option value="${group.id}" ${group.id === 'common' ? 'selected' : ''}>${group.label}</option>`).join('')}</select><input type="search" aria-label="搜索表情" placeholder="搜索表情，如 猫、旅行、coffee" autocomplete="off"></div>
          <div class="ws-appearance-emojis" role="group" aria-label="表情选择"></div><div class="ws-appearance-emoji-status" role="status"></div>
          <label class="ws-appearance-custom-emoji">自定义表情<input type="text" aria-label="自定义 emoji" placeholder="输入或粘贴一个 emoji，如 🦋" value="${attr(draft.emoji)}" autocomplete="off"></label></fieldset>
        <p class="ws-appearance-error" role="alert"></p>
        <div class="ws-dialog-actions"><button type="button" class="ws-btn ws-appearance-reset" data-appearance-reset>恢复默认</button><button type="button" class="ws-btn" data-appearance-cancel>取消</button><button type="submit" class="ws-btn primary">保存</button></div>
      </form></div>`);
    const backdrop = root.querySelector('.ws-appearance-backdrop');
    const form = backdrop.querySelector('form');
    const emojiInput = form.querySelector('input[type="text"]');
    const error = form.querySelector('[role="alert"]');
    let saving = false;
    const renderEmojis = () => {
      const query = form.querySelector('input[type="search"]').value;
      const items = window.DMNoteAppearance.searchEmojis(query, form.querySelector('select').value);
      form.querySelector('.ws-appearance-emojis').innerHTML = `<button type="button" data-appearance-emoji="" aria-label="默认图标" title="默认图标" aria-pressed="${!draft.emoji}">↺</button>` +
        items.map(({emoji, label}) => `<button type="button" data-appearance-emoji="${emoji}" aria-label="${attr(label)} ${emoji}" title="${attr(label)}" aria-pressed="${draft.emoji === emoji}">${emoji}</button>`).join('');
      form.querySelector('.ws-appearance-emoji-status').textContent = items.length ? `${items.length} 个表情${query.trim() ? ' · 搜索全部分类' : ''}` : '没有匹配的表情，也可以在下方粘贴自定义 emoji';
      form.querySelector('.ws-appearance-emojis').scrollTop = 0;
    };
    const syncInputs = () => {
      emojiInput.value = draft.emoji;
      form.querySelectorAll('[data-color-input]').forEach(input => {
        const field = input.dataset.colorInput;
        input.value = draft[field] || (field === 'color' ? '#639ce0' : '#e6effb');
      });
    };
    const preview = () => {
      const sample = form.querySelector('.ws-appearance-preview');
      sample.style.setProperty('--note-accent', draft.color || 'var(--ws-text)');
      sample.style.setProperty('--note-bg', draft.backgroundColor || 'var(--ws-panel)');
      const icon = sample.querySelector('[data-appearance-preview-icon]');
      if (draft.emoji) icon.textContent = draft.emoji;
      else icon.innerHTML = treeIcon(node.type);
      form.querySelectorAll('[data-appearance-color]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.appearanceColor === draft[button.dataset.colorField])));
      form.querySelectorAll('[data-appearance-emoji]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.appearanceEmoji === draft.emoji)));
      form.querySelectorAll('[data-appearance-template]').forEach(button => {
        const item = window.DMNoteAppearance.templates.find(item => item.id === button.dataset.appearanceTemplate);
        button.setAttribute('aria-pressed', String(item.color === draft.color && item.backgroundColor === draft.backgroundColor && item.emoji === draft.emoji));
      });
      error.textContent = '';
    };
    const cancel = () => { if (!saving) closeDialog(); };
    backdrop.onclick = event => {
      event.stopPropagation();
      if (saving) return;
      if (event.target === backdrop || event.target.closest('[data-appearance-cancel]')) { cancel(); return; }
      const color = event.target.closest('[data-appearance-color]');
      const emoji = event.target.closest('[data-appearance-emoji]');
      const template = event.target.closest('[data-appearance-template]');
      if (color) draft[color.dataset.colorField] = color.dataset.appearanceColor;
      if (emoji) draft.emoji = emoji.dataset.appearanceEmoji;
      if (template) Object.assign(draft, window.DMNoteAppearance.normalize(window.DMNoteAppearance.templates.find(item => item.id === template.dataset.appearanceTemplate)));
      if (event.target.closest('[data-appearance-reset]')) {
        draft.color = ''; draft.backgroundColor = ''; draft.emoji = '';
      }
      if (color || emoji || template || event.target.closest('[data-appearance-reset]')) { syncInputs(); preview(); }
    };
    emojiInput.oninput = () => { draft.emoji = emojiInput.value.trim(); preview(); };
    form.querySelectorAll('[data-color-input]').forEach(input => {
      input.oninput = () => { draft[input.dataset.colorInput] = input.value; preview(); };
    });
    form.querySelector('input[type="search"]').oninput = renderEmojis;
    form.querySelector('input[type="search"]').onkeydown = event => { if (event.key === 'Enter') event.preventDefault(); };
    form.querySelector('select').onchange = renderEmojis;
    backdrop.onkeydown = event => {
      if (event.key === 'Escape') { event.stopPropagation(); cancel(); }
      if (event.key !== 'Tab') return;
      const controls = [...form.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled)')];
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    form.onsubmit = async event => {
      event.preventDefault();
      if (saving || syncPaused || vaultSwitching || origin !== vaultRoot) return;
      try {
        const appearance = window.DMNoteAppearance.normalize(draft);
        saving = true;
        form.querySelectorAll('button,input,select').forEach(control => { control.disabled = true; });
        await saveActive();
        if (syncPaused || vaultSwitching || origin !== vaultRoot || !backdrop.isConnected) return;
        await api.workspace.setAppearance(path, appearance, origin);
        if (syncPaused || vaultSwitching || origin !== vaultRoot) return;
        closeDialog();
        await refreshTree(path);
        const row = [...root.querySelectorAll('.tree-row')].find(item => item.dataset.path === path);
        row?.querySelector('[data-action="appearance"]')?.focus();
      } catch (failure) {
        error.textContent = failure?.message || '外观设置保存失败，请重试';
      } finally {
        saving = false;
        form.querySelectorAll('button,input,select').forEach(control => { control.disabled = false; });
      }
    };
    renderEmojis();
    preview();
    form.querySelector('[data-appearance-color][aria-pressed="true"]')?.focus();
    if (!form.contains(document.activeElement)) emojiInput.focus();
  }

  function openDialog(kind, target = "", targetType = "", parent = selectedFolder()) {
    dialog = { kind, target, targetType, parent };
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
        <div class="ws-dialog" role="dialog" aria-modal="true" aria-label="${labels[kind]}">
          <strong>${labels[kind]}</strong>
          ${["file", "folder"].includes(kind) ? `<label class="ws-create-location">创建位置<select class="ws-parent-select" aria-label="创建位置"><option value="">根目录</option>${flatten(tree, "folder").map((folder) => `<option value="${attr(folder.path)}" ${folder.path === parent ? "selected" : ""}>${esc(folder.path)}</option>`).join("")}</select></label>` : ""}
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
    const returnFocus = dialog?.returnFocus;
    root.querySelector(".ws-dialog-backdrop")?.remove();
    dialog = null;
    if (returnFocus?.isConnected) returnFocus.focus();
  }

  async function confirmDialog() {
    if (!dialog || syncPaused || vaultSwitching) return;
    const current = dialog;
    const value = root.querySelector(".ws-dialog-input")?.value.trim();
    const parent = root.querySelector(".ws-parent-select")?.value ?? current.parent;
    if (current.kind !== "delete" && !value) return;
    const origin = vaultRoot;
    closeDialog();
    try {
      await saveActive();
      if (syncPaused || vaultSwitching || origin !== vaultRoot) return;
      let nextPath = null;
      if (current.kind === "file") nextPath = await api.workspace.createFile(parent, value);
      if (current.kind === "folder") nextPath = await api.workspace.createFolder(parent, value);
      if (current.kind === "rename") nextPath = await api.workspace.rename(current.target, value);
      if (current.kind === "delete") await api.workspace.remove(current.target);
      if (syncPaused || vaultSwitching || origin !== vaultRoot) return;

      if (current.kind === "file" || current.kind === "folder") {
        if (current.kind === "folder") expanded.add(nextPath);
        expandAncestors(nextPath);
        await refreshTree(nextPath);
        if (current.kind === "file") await openFile(nextPath);
      }
      if (current.kind === "rename") {
        if (current.targetType === "folder") {
          expanded = window.DMTreeState.remap(expanded, current.target, nextPath);
          persistExpanded();
        }
        if (activePath === current.target) activePath = nextPath;
        if (activePath?.startsWith(`${current.target}/`)) {
          activePath = `${nextPath}${activePath.slice(current.target.length)}`;
        }
        await refreshTree(nextPath);
      }
      if (current.kind === "delete") {
        if (activePath === current.target || activePath?.startsWith(`${current.target}/`)) {
          activePath = null;
          content = "";
          savedContent = "";
        }
        selectedPath = "";
        await refreshTree();
      }
    } catch (error) {
      alert(error?.message || "文件操作失败，请重试");
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
    if (syncPaused || vaultSwitching) { event.preventDefault(); return; }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      await saveActive();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "p") {
      event.preventDefault();
      openPalette();
    }
    if (event.key === "Escape") {
      const options = root.querySelector(".ws-vault-options[open]");
      if (options) { options.open = false; options.querySelector("summary").focus(); return; }
      if (dialog) closeDialog();
      else if (paletteOpen) closePalette();
      else if (modulesReady && modulesInstance.closeModal()) return;
    }
  });

  window.addEventListener("beforeunload", event => {
    try { noteDetails?.flush(); }
    catch { event.preventDefault(); event.returnValue = ''; return; }
    if (activePath && content !== savedContent) {
      // Electron IPC 无法阻塞 beforeunload，日常编辑已由 650ms 自动保存覆盖。
      void api.workspace.write(activePath, content);
    }
  });

  // 快速便签中新建、编辑或改名后，完整笔记即时同步对应文件
  api.onWorkspaceChanged?.((change = {}) => {
    if (syncPaused || vaultSwitching) return;
    const origin = vaultRoot;
    void (async () => {
      for (const item of change.renames || []) {
        expanded = window.DMTreeState.remap(expanded, item.from, item.to);
      }
      if (change.renames?.length) persistExpanded();
      const rename = change.renames?.find((item) => item.from === activePath);
      if (rename) {
        activePath = rename.to;
        selectedPath = rename.to;
      }
      await refreshTree(activePath);
      if (syncPaused || vaultSwitching || origin !== vaultRoot) return;
      if (activePath && content === savedContent) {
        const target = activePath;
        const nextContent = await api.workspace.read(target);
        if (syncPaused || vaultSwitching || origin !== vaultRoot || activePath !== target || content !== savedContent) return;
        content = nextContent;
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
    await updateUI.load();
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
      updateUI,
      openNote: async (path) => {
        await openFile(path);
        const result = await api.workspace.list();
        tree = result.tree;
        expandAncestors(path);
        await setSection("notes", { preserveNote: true });
      },
    });
    modulesReady = Boolean(modulesInstance);
    await loadVaults();
    applyTree(await api.workspace.list());
    if (section !== "notes" && modulesInstance) await modulesInstance.loadAll();
    renderShell();
    if (pendingProject) { await setSection("projects"); await modulesInstance.openProject(pendingProject); pendingProject = null; }
  })();

  api.onWorkspaceSection?.((next) => {
    void setSection(next || "notes");
  });
})();
