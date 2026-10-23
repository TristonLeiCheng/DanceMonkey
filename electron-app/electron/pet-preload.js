const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktopPet', {
  get: () => ipcRenderer.invoke('pet:get'),
  interactive: (value) => ipcRenderer.send('pet:interactive', Boolean(value)),
  press: () => ipcRenderer.send('pet:press'),
  release: () => ipcRenderer.send('pet:release'),
  cancel: () => ipcRenderer.send('pet:cancel'),
  menu: () => ipcRenderer.send('pet:menu'),
  tasks: () => ipcRenderer.send('pet:tasks'),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('pet:state', listener);
    return () => ipcRenderer.removeListener('pet:state', listener);
  },
});
