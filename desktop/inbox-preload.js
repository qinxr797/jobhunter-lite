// 收件箱页在 HR Desk 里打开时多出来的本事（在普通浏览器里打开就没有 window.hrdesk，页面照旧能用）
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('hrdesk', {
  shell: 2,            // v0.6.0 新外壳：状态在顶栏、找岗位在顶栏，页面据此收起自己的状态卡和海投入口
  getCheck: (name) => ipcRenderer.invoke('desk:getCheck', name),
  check: (name) => ipcRenderer.invoke('desk:check', name),
  onCheckProgress: (fn) => ipcRenderer.on('desk:checkProgress', (_e, name, text) => fn(name, text)),
});
