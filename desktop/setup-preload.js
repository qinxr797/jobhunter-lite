const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('hrsetup', {
  get: () => ipcRenderer.invoke('setup:get'),
  save: (form) => ipcRenderer.invoke('setup:save', form),
  test: (apiKey) => ipcRenderer.invoke('setup:test', apiKey),
  parse: (text, apiKey) => ipcRenderer.invoke('setup:parse', text, apiKey),
  pickResume: () => ipcRenderer.invoke('setup:pickResume'),
  close: () => ipcRenderer.invoke('setup:close'),
});
