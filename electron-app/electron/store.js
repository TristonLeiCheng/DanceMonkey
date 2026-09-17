const fs = require("node:fs");
const path = require("node:path");

function createDefaultState() {
  const now = Date.now();
  return {
    // 每次写入递增，渲染层据此丢弃迟到的旧快照
    revision: 0,
    theme: "dark",
    pinned: false,
    activeNotebookId: "inbox",
    activeNoteId: "welcome",
    notebooks: [
      { id: "inbox", name: "收件箱", system: true, createdAt: now },
      { id: "todos", name: "待办", system: true, createdAt: now },
    ],
    notes: [
      {
        id: "welcome",
        notebookId: "inbox",
        title: "欢迎使用 DM",
        body: "从屏幕右缘唤出快捷轨，记下此刻的想法。\n\nCtrl+Enter 保存并收起，Esc 收起但保留草稿。内容会自动写入本地。",
        createdAt: now,
        updatedAt: now,
      },
    ],
    todos: [
      {
        id: "todo-1",
        notebookId: "todos",
        title: "把 DM 钉在桌面右侧试试",
        done: false,
        createdAt: now,
      },
    ],
    aiMessages: [],
  };
}

function createStore(userDataPath) {
  const file = path.join(userDataPath, "lumen-store.json");

  function read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      const fallback = createDefaultState();
      return {
        ...fallback,
        ...parsed,
        revision: typeof parsed.revision === "number" ? parsed.revision : 0,
        notebooks: parsed.notebooks?.length ? parsed.notebooks : fallback.notebooks,
        notes: parsed.notes ?? fallback.notes,
        todos: parsed.todos ?? fallback.todos,
        aiMessages: parsed.aiMessages ?? fallback.aiMessages,
      };
    } catch {
      return createDefaultState();
    }
  }

  function write(state) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tmp, file);
  }

  let state = read();
  write(state);

  return {
    get() {
      return state;
    },
    set(partial) {
      state = { ...state, ...partial, revision: state.revision + 1 };
      write(state);
      return state;
    },
  };
}

module.exports = { createStore, createDefaultState };
