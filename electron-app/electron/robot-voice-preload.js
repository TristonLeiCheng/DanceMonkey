const { contextBridge, ipcRenderer } = require("electron");
const names = ["status", "import", "chooseCA", "save", "select", "start", "stop", "notes", "copy", "test", "cancelTest", "discover", "renameDevice", "forgetDevice", "controlDevice"];
contextBridge.exposeInMainWorld("robotVoice", Object.fromEntries(names.map(name =>
  [name, value => ipcRenderer.invoke("robotVoice:" + name, value)])));
