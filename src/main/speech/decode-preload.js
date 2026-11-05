'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('decoder', {
  onJob: (cb) => ipcRenderer.on('decode:job', (e, m) => cb(m)),
  done: (id, result) => ipcRenderer.send('decode:done', { id, ...result }),
  ready: () => ipcRenderer.send('decode:ready'),
});
