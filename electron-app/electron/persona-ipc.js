const fs = require("node:fs/promises");
const path = require("node:path");
const { parseSourceFile, MAX_IMPORT_BYTES } = require("./persona-sources");

const MAX_FILES = 20;

async function readImportFile(filename) {
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("请选择普通文件，不支持文件夹或符号链接。");
  if (stat.size > MAX_IMPORT_BYTES) throw new Error("单个文件不能超过 1 MiB。");
  const file = await fs.open(filename, "r");
  try {
    const current = await file.stat();
    if (!current.isFile() || current.size > MAX_IMPORT_BYTES) throw new Error("文件已变化或超过 1 MiB。");
    const buffer = Buffer.alloc(MAX_IMPORT_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await file.read(buffer, length, buffer.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > MAX_IMPORT_BYTES) throw new Error("单个文件不能超过 1 MiB。");
    return buffer.subarray(0, length);
  } finally { await file.close(); }
}

function registerPersonaIpc({ ipcMain, dialog, BrowserWindow, service, trusted, getWorkspace }) {
  const requests = new Map();
  function check(event) {
    if (!trusted(event)) throw new Error("此操作只能从 DM 主窗口发起。");
  }
  const handle = (method, fn) => ipcMain.handle(`personas:${method}`, async (event, input) => {
    check(event);
    return fn(event, input);
  });
  for (const method of ["list", "create", "get", "updateProfile", "addSources", "removeSource", "saveCard",
    "newConversation", "selectConversation", "deleteConversation", "restoreCard", "remove"]) {
    handle(method, (_event, input) => service[method](input));
  }
  handle("importFiles", async (event, input = {}) => {
    await service.get(input.id);
    const parent = BrowserWindow.fromWebContents(event.sender);
    const options = { title: "导入人物资料", properties: ["openFile", "multiSelections"],
      filters: [{ name: "文章、笔记与聊天记录", extensions: ["txt", "md", "markdown", "json", "jsonl"] }] };
    const answer = await (parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options));
    check(event);
    if (answer.canceled || !answer.filePaths?.length) return { canceled: true };
    if (answer.filePaths.length > MAX_FILES) throw new Error(`每次最多导入 ${MAX_FILES} 个文件。`);
    const sources = [];
    const errors = [];
    for (const filename of answer.filePaths) {
      try {
        sources.push(parseSourceFile({ name: path.basename(filename), buffer: await readImportFile(filename),
          kind: input.kind, speaker: input.speaker }));
      } catch (error) {
        errors.push({ name: path.basename(filename), message: error.message });
      }
    }
    check(event);
    const persona = sources.length ? await service.addSources({ id: input.id, sources }) : await service.get(input.id);
    return { persona, canceled: false, errors };
  });
  handle("importNotes", async (_event, input = {}) => {
    if (!Array.isArray(input.paths) || !input.paths.length || input.paths.length > MAX_FILES) {
      throw new Error(`请选择 1 至 ${MAX_FILES} 篇笔记。`);
    }
    const workspace = getWorkspace();
    if (input.root && input.root !== workspace.root) throw new Error("笔记库已切换，请重新选择笔记。");
    const sources = [];
    for (const relative of [...new Set(input.paths)]) {
      if (typeof relative !== "string" || path.isAbsolute(relative) || relative.includes("\\") ||
          relative.split("/").some((part) => !part || part === "." || part === ".." || part === ".git") ||
          !relative.toLowerCase().endsWith(".md")) throw new Error("无效的笔记路径。");
      // Check size before workspace.read, which also validates containment and symlinks.
      const stat = await fs.lstat(path.join(workspace.root, relative));
      if (!stat.isFile() || stat.size > MAX_IMPORT_BYTES) throw new Error("笔记必须为不超过 1 MiB 的普通文件。");
      sources.push({ title: relative, kind: "note", text: workspace.read(relative) });
    }
    if (getWorkspace() !== workspace) throw new Error("笔记库已切换，请重新选择笔记。");
    return service.addSources({ id: input.id, sources });
  });
  async function run(event, input, method) {
    if (!input || typeof input.requestId !== "string" || !/^[\w-]{1,120}$/.test(input.requestId)) {
      throw new Error("请求标识无效，请重试。");
    }
    if (requests.has(input.requestId)) throw new Error("该请求正在执行。");
    requests.set(input.requestId, event.sender);
    const onDestroyed = () => service.cancel(input.requestId);
    event.sender.once("destroyed", onDestroyed);
    const send = (channel, payload) => {
      if (!event.sender.isDestroyed()) event.sender.send(channel, { requestId: input.requestId, ...payload });
    };
    try {
      if (method === "chat") return await service.chat(input, (chunk) => send("personas:chunk", { chunk }));
      send("personas:progress", { message: "正在分析选中的资料…" });
      return await service.generate(input, (value) => send("personas:progress", { message: typeof value === "string" ? value : value.message }));
    } finally {
      requests.delete(input.requestId);
      event.sender.removeListener("destroyed", onDestroyed);
    }
  }
  handle("generate", (event, input) => run(event, input, "generate"));
  handle("chat", (event, input) => run(event, input, "chat"));
  handle("cancel", (event, requestId) => requests.get(requestId) === event.sender ? service.cancel(requestId) : false);
}

module.exports = { registerPersonaIpc, readImportFile };
