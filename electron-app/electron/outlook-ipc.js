function registerOutlookIpc({ ipcMain, trusted, auth, importer }) {
  const owners = new Map();
  const check = (event) => { if (!trusted(event)) throw new Error("此操作只能从 DM 主窗口发起。"); };
  const handle = (method, fn) => ipcMain.handle("outlook:" + method, async (event, input) => { check(event); return fn(event, input); });
  handle("status", () => auth.status());
  handle("configure", (_event, input) => { importer.cancelAll(); return auth.configure(input); });
  handle("connect", () => { importer.cancelAll(); return auth.connect(); });
  handle("disconnect", () => { importer.cancelAll(); return auth.disconnect(); });
  handle("cancel", (event, requestId) => owners.get(requestId) === event.sender ? importer.cancel(requestId) : false);
  handle("importAndGenerate", async (event, input) => {
    if (!input || typeof input.requestId !== "string" || !/^[\w-]{1,120}$/.test(input.requestId)) throw new Error("邮件导入请求无效。");
    if (owners.has(input.requestId)) throw new Error("该请求正在执行。");
    owners.set(input.requestId, event.sender);
    const cancel = () => importer.cancel(input.requestId);
    event.sender.once("destroyed", cancel);
    try {
      return await importer.importAndGenerate(input, (message) => {
        if (event.sender.isDestroyed() || !trusted(event)) { cancel(); throw new Error("导入窗口已关闭。"); }
        event.sender.send("outlook:progress", { requestId: input.requestId, message });
      });
    } finally {
      event.sender.removeListener("destroyed", cancel); owners.delete(input.requestId);
    }
  });
}

module.exports = { registerOutlookIpc };
