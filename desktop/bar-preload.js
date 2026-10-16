const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desk', {
  tab: (id) => ipcRenderer.send('tab', id),
  reload: () => ipcRenderer.send('reload'),
  back: () => ipcRenderer.send('back'),
  devtools: () => ipcRenderer.send('devtools'),
  menu: (which, x, y) => ipcRenderer.send('menu', which, x, y),
  onState: (fn) => ipcRenderer.on('state', (_e, s) => fn(s)),
  onHint: (fn) => ipcRenderer.on('hint', (_e, t) => fn(t)),
});
