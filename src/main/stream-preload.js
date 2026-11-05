'use strict';
// Мост для скрытого окна трансляции экрана.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('host', {
  onCommand: (cb) => ipcRenderer.on('stream:cmd', (e, m) => cb(m)),
  reply: (rid, ok, data, error) => ipcRenderer.send('stream:reply', { rid, ok, data, error }),
  input: (sid, cmd) => ipcRenderer.send('stream:input', { sid, cmd }),
  closed: (sid) => ipcRenderer.send('stream:closed', { sid }),
  monitor: (sid, index) => ipcRenderer.send('stream:monitor', { sid, index }),
  chunk: (sid, meta, data) => ipcRenderer.send('stream:chunk', { sid, ...meta, data }),
  wsinfo: (sid, info) => ipcRenderer.send('stream:wsinfo', { sid, info }),
  source: (monitor) => ipcRenderer.invoke('stream:source', monitor),
  log: (msg) => ipcRenderer.send('stream:log', String(msg)),
  ready: () => ipcRenderer.send('stream:ready'),
  platform: process.platform,
});
