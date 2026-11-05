'use strict';
// Мост между окном приложения и главным процессом. Окну доступны только перечисленные каналы.
const { contextBridge, ipcRenderer } = require('electron');

const INVOKE = new Set([
  'get-state', 'get-status', 'get-metrics', 'set-token', 'regen-pair', 'remove-user', 'test-notify',
  'save-config', 'set-muted', 'set-autostart', 'run-action', 'get-tasks', 'add-task', 'toggle-task',
  'delete-task', 'get-log', 'check-app-update', 'open-external', 'open-data-dir', 'quit',
]);
const EVENTS = new Set(['refresh', 'metrics']);

contextBridge.exposeInMainWorld('pcc', {
  async invoke(channel, data) {
    if (!INVOKE.has(channel)) throw new Error('Недопустимый канал');
    const res = await ipcRenderer.invoke(channel, data);
    if (!res.ok) throw new Error(res.error);
    return res.data;
  },
  on(channel, fn) {
    if (EVENTS.has(channel)) ipcRenderer.on(channel, (_e, data) => fn(data));
  },
});
