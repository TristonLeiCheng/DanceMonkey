const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('reminderPopup', {
  get: () => ipcRenderer.invoke('reminder-popup:get'),
  expand: (expanded = true) => ipcRenderer.invoke('reminder-popup:expand', expanded),
  onInset: callback => {
    const listener = (_event, inset) => callback(inset);
    ipcRenderer.on('reminder-popup:inset', listener);
    return () => ipcRenderer.removeListener('reminder-popup:inset', listener);
  },
  act: action => ipcRenderer.invoke('reminder-popup:act', action),
});
