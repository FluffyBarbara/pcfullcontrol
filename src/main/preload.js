'use strict';
// Мост между окном приложения и главным процессом. Окну доступны только перечисленные каналы.
const { contextBridge, ipcRenderer } = require('electron');

const INVOKE = new Set([
  'get-state', 'get-status', 'get-metrics', 'set-token', 'regen-pair', 'remove-user', 'test-notify',
  'save-config', 'set-muted', 'set-autostart', 'run-action', 'get-tasks', 'add-task', 'toggle-task',
  'delete-task', 'get-log', 'check-app-update', 'open-external', 'open-data-dir', 'quit',
  'mobile-info', 'mobile-regen', 'remove-device', 'get-processes', 'whatsnew-state', 'whatsnew-ack', 'update-state', 'update-start', 'wol-info', 'wol-setup', 'autologon-enable', 'autologon-disable',
  'clean-analyze', 'clean-run', 'apps-list', 'apps-uninstall', 'apps-job', 'apps-leftovers', 'apps-remove-leftovers', 'cleanup-report',
  'hw-info', 'net-status', 'net-speedtest', 'net-scan', 'net-label', 'startup-list', 'startup-set',
  'weekly-preview', 'weekly-send', 'extras-state',
  'media-state', 'media-control', 'media-cover', 'mixer', 'mixer-peaks', 'mixer-set', 'mixer-master', 'games', 'temps', 'crashes', 'usb-events',
  'panic-state', 'panic-trigger', 'panic-release', 'space-roots', 'space-start', 'space-cancel', 'space-view', 'space-delete', 'set-theme',
]);
const EVENTS = new Set(['refresh', 'metrics', 'update-state', 'update-available', 'net-progress', 'space', 'usb']);

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
