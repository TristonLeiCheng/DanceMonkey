const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("regionCapture", {
  onImage: (cb) => {
    const listener = (_event, dataUrl) => cb(dataUrl);
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
