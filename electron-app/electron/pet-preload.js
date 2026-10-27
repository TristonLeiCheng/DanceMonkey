const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktopPet', {
  ready: () => ipcRenderer.send('pet:ready'),
  get: () => ipcRenderer.invoke('pet:get'),
  interactive: (value) => ipcRenderer.send('pet:interactive', Boolean(value)),
  press: () => ipcRenderer.send('pet:press'),
  release: () => ipcRenderer.send('pet:release'),
  cancel: () => ipcRenderer.send('pet:cancel'),
  menu: () => ipcRenderer.send('pet:menu'),
  tasks: () => ipcRenderer.send('pet:tasks'),
  key: (code, down) => ipcRenderer.send('pet:key', { code, down }),
  exitControl: () => ipcRenderer.send('pet:control-exit'),
  reminderAct: (token, action) => ipcRenderer.invoke('pet:reminder-act', { token, action }),
  reducedMotion: value => ipcRenderer.send('pet:reduced-motion', Boolean(value)),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('pet:state', listener);
    return () => ipcRenderer.removeListener('pet:state', listener);
  },
});
