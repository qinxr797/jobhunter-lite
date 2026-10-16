const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('campus', {
  open: (url) => ipcRenderer.invoke('campus:open', url),
  fill: (job, fresh) => ipcRenderer.invoke('campus:fill', { job, fresh }),
  remember: () => ipcRenderer.invoke('campus:remember'),
  scrollTo: (key) => ipcRenderer.invoke('campus:scroll', key),
  nav: (what) => ipcRenderer.invoke('campus:nav', what),
  last: () => ipcRenderer.invoke('campus:last'),
  submitted: (job) => ipcRenderer.invoke('campus:submitted', job),     // 「我交了」→ 记进投递表
  goTab: (id) => ipcRenderer.invoke('campus:goTab', id),
  onProgress: (fn) => ipcRenderer.on('campus:progress', (_e, t) => fn(t)),
  onUrl: (fn) => ipcRenderer.on('campus:url', (_e, u, title) => fn(u, title)),
});
