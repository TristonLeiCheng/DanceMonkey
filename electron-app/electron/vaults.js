const fs = require("node:fs");
const path = require("node:path");

function canonicalRoot(input) {
  if (typeof input !== "string" || !path.isAbsolute(input)) throw new Error("请选择有效的笔记库目录。");
  try {
    const root = fs.realpathSync(input);
    if (!fs.statSync(root).isDirectory()) throw new Error();
    return root;
  } catch { throw new Error("笔记库目录不存在或无法访问，请重新选择目录。"); }
}

function overlaps(left, right) {
  const within = (parent, child) => {
    const relative = path.relative(parent, child);
    return !relative || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  };
  return within(left, right) || within(right, left);
}

function createVaultRegistry({ config, root, protectedRoots = [] }) {
  let activeRoot = canonicalRoot(root);
  const normalize = (value) => {
    try { return fs.realpathSync(value); } catch { return path.resolve(value); }
  };
  const protectedPaths = protectedRoots.map(normalize);
  const entries = Array.isArray(config.read().notesVaults) ? config.read().notesVaults : [];
  let vaults = [];
  for (const item of [{ root: activeRoot }, ...entries]) {
    if (!item || typeof item.root !== "string" || !path.isAbsolute(item.root)) continue;
    const nextRoot = normalize(item.root);
    const existing = vaults.find((vault) => vault.root === nextRoot);
    if (existing) { if (item.name) existing.name = String(item.name); continue; }
    if (vaults.some((vault) => overlaps(vault.root, nextRoot))) continue;
    vaults.push({ root: nextRoot, name: String(item.name || path.basename(nextRoot) || "本地笔记库") });
  }
  config.write({ notesRootPath: activeRoot, notesVaults: vaults });

  function prepare(input, registeredOnly = false) {
    const nextRoot = canonicalRoot(input);
    if (registeredOnly && !vaults.some((vault) => vault.root === nextRoot)) throw new Error("笔记库尚未登记，请先通过「打开其他笔记库」选择目录。");
    if (nextRoot === activeRoot) return nextRoot;
    if (protectedPaths.some((directory) => overlaps(directory, nextRoot))) throw new Error("笔记库不能包含应用数据或同步记录目录。");
    if (vaults.some((vault) => vault.root !== nextRoot && overlaps(vault.root, nextRoot))) throw new Error("笔记库不能互相嵌套，请选择独立目录。");
    fs.accessSync(nextRoot, fs.constants.R_OK | fs.constants.W_OK);
    return nextRoot;
  }

  function activate(nextRoot) {
    const next = vaults.some((vault) => vault.root === nextRoot) ? vaults : [...vaults, { root: nextRoot, name: path.basename(nextRoot) || "本地笔记库" }];
    config.write({ notesRootPath: nextRoot, notesVaults: next });
    vaults = next;
    activeRoot = nextRoot;
  }

  return { prepare, activate, list: () => ({ activeRoot, vaults: vaults.map((vault) => ({ ...vault })) }) };
}

function registerVaultIpc({ ipcMain, dialog, BrowserWindow, registry, trusted, busy, switchVault }) {
  let opening = false;
  const handle = (name, operation) => ipcMain.handle(`vaults:${name}`, async (event, input) => {
    if (!trusted(event)) return { success: false, error: "此操作只能从 DM 主窗口发起。" };
    try { return { success: true, ...await operation(event, input) }; }
    catch (error) { return { success: false, error: error?.message || "无法切换笔记库，请检查目录权限。" }; }
  });
  handle("list", () => registry.list());
  handle("select", async (_event, input) => {
    if (opening || busy()) throw new Error("正在处理笔记，请稍后再切换笔记库。");
    await switchVault(registry.prepare(input, true));
    return registry.list();
  });
  handle("open", async (event) => {
    if (opening || busy()) throw new Error("正在处理笔记，请稍后再打开笔记库。");
    opening = true;
    try {
      const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
        title: "打开或新建笔记库", buttonLabel: "使用此笔记库", properties: ["openDirectory", "createDirectory"],
      });
      if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
      if (busy()) throw new Error("正在处理笔记，请稍后再切换笔记库。");
      await switchVault(registry.prepare(result.filePaths[0]));
      return registry.list();
    } finally { opening = false; }
  });
}

module.exports = { createVaultRegistry, registerVaultIpc, canonicalRoot, overlaps };
