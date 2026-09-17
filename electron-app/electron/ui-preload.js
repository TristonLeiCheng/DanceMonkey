const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("regionCapture", {
  onImage: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on("region:image", listener);
    return () => ipcRenderer.removeListener("region:image", listener);
  },
  submit: (payload) => ipcRenderer.send("region:submit", payload),
});

contextBridge.exposeInMainWorld("screenshotResult", {
  onInit: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on("screenshot-result:init", listener);
    return () => ipcRenderer.removeListener("screenshot-result:init", listener);
  },
  copy: () => ipcRenderer.invoke("screenshot-result:copy"),
  saveNote: () => ipcRenderer.invoke("screenshot-result:save-note"),
  analyze: () => ipcRenderer.invoke("screenshot-result:analyze"),
  continueChat: (markdown) => ipcRenderer.send("screenshot-result:continue", markdown),
  close: () => ipcRenderer.send("screenshot-result:close"),
});

contextBridge.exposeInMainWorld("screenshotChoice", {
  onInit: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on("screenshot-choice:init", listener);
    return () => ipcRenderer.removeListener("screenshot-choice:init", listener);
  },
  choose: (action) => ipcRenderer.invoke("screenshot-choice:action", action),
});

contextBridge.exposeInMainWorld("screenshotEditor", {
  onInit: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on("screenshot-editor:init", listener);
    return () => ipcRenderer.removeListener("screenshot-editor:init", listener);
  },
  saveImage: (payload) => ipcRenderer.invoke("screenshot-editor:save", payload),
  copyImage: (payload) => ipcRenderer.invoke("screenshot-editor:copy", payload),
  saveNote: () => ipcRenderer.invoke("screenshot-result:save-note"),
  analyze: () => ipcRenderer.invoke("screenshot-result:analyze"),
  continueChat: (markdown) => ipcRenderer.send("screenshot-result:continue", markdown),
  close: () => ipcRenderer.send("screenshot-editor:close"),
});
