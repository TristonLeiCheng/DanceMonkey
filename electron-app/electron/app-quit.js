const crypto = require("node:crypto");

function createAppQuitController({ getWindows, stopBackground, resumeBackground = () => {}, cleanup = async () => {},
  quit, onError = () => {}, timeoutMs = 15000 }) {
  let allowed = false;
  let pending = null;
  let waiting = null;
  function participants() {
    return getWindows().filter((win) => win && !win.isDestroyed()).map((win) => win.webContents);
  }
  function broadcast(phase) {
    for (const sender of participants()) {
      if (!sender.isDestroyed()) sender.send("app:quitting", { phase });
    }
  }
  function acknowledge(sender, payload = {}) {
    if (!waiting || payload.id !== waiting.id || !waiting.senders.has(sender)) return;
    if (payload.error) { waiting.reject(new Error("笔记保存失败，未退出。请保存成功后重试。")); return; }
    waiting.senders.delete(sender);
    if (!waiting.senders.size) waiting.resolve();
  }
  async function bounded(operation) {
    let timer;
    try {
      return await Promise.race([operation, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("退出准备超时，未关闭应用。请稍后重试。")), timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  }
  function flushEditors() {
    const senders = new Set(participants());
    if (!senders.size) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      waiting = { id, senders, resolve, reject };
      for (const sender of senders) sender.send("app:quitting", { id, phase: "prepare" });
    });
  }
  function request() {
    if (pending) return pending;
    if (allowed) return Promise.resolve({ success: true });
    pending = Promise.resolve().then(async () => {
      try {
        broadcast("waiting");
        await bounded(Promise.resolve().then(stopBackground));
        await bounded(flushEditors());
        await bounded(Promise.resolve().then(cleanup));
        allowed = true;
        quit();
        return { success: true };
      } catch (error) {
        resumeBackground();
        broadcast("resume");
        onError(error.message);
        return { success: false, error: error.message };
      } finally { waiting = null; pending = null; }
    });
    return pending;
  }
  function beforeQuit(event) {
    if (allowed) return;
    event.preventDefault();
    void request();
  }
  return { request, beforeQuit, acknowledge, get allowed() { return allowed; }, get pending() { return Boolean(pending); } };
}

module.exports = { createAppQuitController };
