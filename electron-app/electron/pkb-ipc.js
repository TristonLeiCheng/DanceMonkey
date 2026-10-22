const { createPkb } = require("./pkb");

function registerPkbIpc({ ipcMain, dialog, BrowserWindow, getRoot, githubNotes, refreshNotes }) {
  const check = (event, input) => {
    if (!githubNotes.trusted(event)) throw new Error("此操作只能从 DM 主窗口发起。");
    if (input?.root !== getRoot()) throw new Error("笔记库已切换，请重新打开 PKB 操作。");
    return createPkb(getRoot());
  };
  ipcMain.handle("pkb:preview", (event, input) => {
    const pkb = check(event, input);
    return { ...pkb.preview(), root: getRoot(), status: pkb.status() };
  });
  ipcMain.handle("pkb:initialize", async (event, input) => {
    const pkb = check(event, input);
    const preview = pkb.preview();
    const options = {
      type: "question", title: "建立个人知识库", buttons: ["取消", "建立 PKB"],
      defaultId: 0, cancelId: 0,
      message: "仅添加缺少的目录、模板和规范，不搬动或覆盖现有笔记。",
      detail: `${input.root}\n\n计划新增 ${preview.directories.length} 个目录、${preview.files.length} 个文件。\n保留旧任务和项目数据。80_Vault 只是分类目录，不是加密保险库。\n\n${preview.warnings.join("\n")}\n\n启用后，保护目录中有文件时将阻止 GitHub 和文件夹同步，而不是静默排除。`,
    };
    const parent = BrowserWindow.fromWebContents(event.sender);
    const answer = await (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options));
    if (answer.response !== 1) return { canceled: true };
    check(event, input);
    return githubNotes.runLocalOperation(() => {
      const current = check(event, input);
      const status = current.initialize();
      return { ...status, root: getRoot() };
    });
  });
  ipcMain.handle("pkb:createNote", (event, input, generation) => {
    const pkb = check(event, input);
    githubNotes.assertWritable(generation);
    const result = pkb.createNote(input);
    refreshNotes();
    return result;
  });
  ipcMain.handle("pkb:search", (event, input) => check(event, input).search(input.query));
}

module.exports = { registerPkbIpc };
