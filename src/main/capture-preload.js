'use strict';
// Мост для скрытого окна, которое делает снимок с веб-камеры.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('capture', {
  done: (data) => ipcRenderer.send('webcam-result', { data }),
  fail: (error) => ipcRenderer.send('webcam-result', { error }),
});
