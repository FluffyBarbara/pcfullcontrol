'use strict';
// PC Full Control — главный процесс Electron: окно, значок в трее, автозапуск, службы.
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, session, dialog, powerMonitor } = require('electron');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const { Database } = require('./db');
const { AppContext } = require('./context');
const { Monitor } = require('./monitor');
const { TelegramBot } = require('./bot');
const { TelegramAPI } = require('./telegram-api');
const { LanServer } = require('./lan-server');
const poweron = require('./system/poweron');
const { cleanupAfterUpdate } = require('./system/self-cleanup');
const { lock: lockScreen } = require('./system/power');
const info = require('./system/info');
const processes = require('./system/processes');
const media = require('./system/media');
const { between: changesBetween } = require('../shared/changelog');
const { E } = require('./telegram-api');
const { run, IS_WIN } = require('./system/exec');

const TASK_NAME = 'PCFullControl';
const ICON = path.join(__dirname, '..', '..', 'build', 'icon.png');
const RENDERER = path.join(__dirname, '..', 'renderer');

let ctx = null;
let mainWindow = null;
let tray = null;
let quitting = false;

// Трансляция экрана на телефон: настоящие адреса в локальной сети (без маскировки mDNS),
// иначе телефон в той же сети Wi-Fi может не найти компьютер.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(async () => {
    if (await relaunchElevated()) return;
    await init();
  }).catch((e) => {
    dialog.showErrorBox('PC Full Control', `Не удалось запустить приложение:\n${e.stack || e}`);
    app.exit(1);
  });
}

// Закрытие окна не завершает приложение — оно продолжает работать в трее
app.on('window-all-closed', () => {});
app.on('before-quit', () => {
  quitting = true;
  try { ctx && ctx.db.save(); } catch (e) { /* ignore */ }
});

// ================= Права администратора =================
// Программе нужны права администратора (выключение ПК, обновления Windows, тихая установка обновлений).
// Установщик создаёт задачу Планировщика с наивысшими правами. Если программу открыли обычным ярлыком,
// перезапускаемся через эту задачу — так права есть, а окна UAC нет.
const userFile = (name) => path.join(app.getPath('userData'), name);

async function relaunchElevated() {
  if (!IS_WIN || !app.isPackaged || process.argv.includes('--no-elevate')) return false;
  if ((await run('fltmc.exe', [], { timeout: 10000 })).code === 0) return false; // уже администратор
  // Защита от зацикливания: если недавно уже пробовали и не вышло — работаем без прав
  try {
    const last = Number(fs.readFileSync(userFile('elevate-attempt'), 'utf8'));
    if (Date.now() - last < 60000) return false;
  } catch (e) { /* первой попытки ещё не было */ }
  const q = await run('schtasks.exe', ['/Query', '/TN', TASK_NAME, '/FO', 'CSV', '/NH'], { timeout: 10000 });
  if (q.code !== 0 || /Disabled|Отключено/i.test(q.out)) return false;
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(userFile('elevate-attempt'), String(Date.now()));
  if (!process.argv.includes('--hidden')) fs.writeFileSync(userFile('show-window.flag'), '1');
  // Освобождаем «единственный экземпляр» и запускаем задачу напрямую — без консолей и окон UAC
  app.releaseSingleInstanceLock();
  const r = await run('schtasks.exe', ['/Run', '/TN', TASK_NAME], { timeout: 15000 });
  if (r.code !== 0) {
    try { fs.rmSync(userFile('show-window.flag')); } catch (e) { /* ignore */ }
    app.requestSingleInstanceLock();
    return false;
  }
  app.exit(0);
  return true;
}

async function init() {
  app.setAppUserModelId('com.pcfullcontrol.app');
  // Доступ к веб-камере только для собственных окон приложения
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(perm === 'media'));
  session.defaultSession.setPermissionCheckHandler((wc, perm) => perm === 'media');

  const db = await Database.open(path.join(app.getPath('userData'), 'pcontrol.sqlite'));
  ctx = new AppContext(db, {
    version: app.getVersion(),
    dataDir: app.getPath('userData'),
    prepareForUpdate,
    quitApp: quit,
    restartApp: () => {
      quitting = true;
      ctx.db.save();
      app.relaunch({ args: process.argv.slice(1).filter((a) => a !== '--hidden').concat('--hidden') });
      app.exit(0);
    },
  });
  trackVersion();
  ctx.monitor = new Monitor(ctx);
  ctx.monitor.start();
  ctx.scheduler.start();
  ctx.lan = new LanServer(ctx);
  ctx.lan.start();
  startBot();
  createTray();
  registerIpc();
  watchPower();
  await ensureAutostartOnFirstRun();

  ctx.on('event', () => send('refresh'));
  ctx.on('bot-status', () => { send('refresh'); updateTray(); });
  ctx.on('metrics', (m) => send('metrics', m));
  ctx.on('update-state', (st) => { send('update-state', st); updateTray(); });
  guardAutologon(true);

  let showFlag = false;
  try { fs.rmSync(userFile('show-window.flag')); showFlag = true; } catch (e) { /* флага нет */ }
  if (!process.argv.includes('--hidden') || showFlag || ctx.db.getSetting('pendingWhatsNew')) showWindow();

  // Для автоматической проверки обновления в CI: один раз сразу запустить обновление
  if (process.env.PCFC_UPDATE_AUTO && !fs.existsSync(userFile('e2e-auto-update.done'))) {
    fs.writeFileSync(userFile('e2e-auto-update.done'), '1');
    setTimeout(() => ctx.appUpdater.startUpdate().then((m) => ctx.appUpdater.log('info', m)).catch((e) => ctx.appUpdater.log('error', e.message)), 8000);
  }
  // Проверка новой версии сразу при запуске, затем каждые 6 часов и при каждом открытии окна
  setTimeout(checkAppUpdate, 4000);
  setInterval(checkAppUpdate, 6 * 3600 * 1000);
}

// ================= Версии и обновления =================
let cleanupPromise = null;
function trackVersion() {
  const db = ctx.db;
  const version = app.getVersion();
  // PCFC_TEST_PREV_VERSION — только для автоматической проверки уборки после обновления
  const prev = process.env.PCFC_TEST_PREV_VERSION || db.getSetting('lastSeenVersion');
  // В версии 1.0.0 lastSeenVersion ещё не сохранялась — узнаём её по другим настройкам
  const from = prev || (db.getSetting('autostartInitialized') ? '1.0.0' : null);
  db.setSetting('lastSeenVersion', version);
  const pending = db.getSetting('updateInProgress');
  db.setSetting('updateInProgress', null);
  if (pending && from === version && Date.now() / 1000 - pending.ts < 3600) {
    ctx.notifier.notify(`⚠️ Обновление до ${E(pending.to)} не установилось — работает версия ${E(version)}.\n`
      + 'Скачайте установщик вручную: https://github.com/FluffyBarbara/pcfullcontrol/releases/latest', { category: 'update', level: 'warning' });
  }
  if (!from || from === version) return;
  db.setSetting('pendingWhatsNew', { from, to: version });
  // Уборка после обновления: данные старой версии, старые копии и скачанные установщики программы
  if (IS_WIN && app.isPackaged) {
    cleanupPromise = cleanupAfterUpdate({ exeDir: path.dirname(process.execPath), electronSession: session.defaultSession, dataDir: app.getPath('userData') })
      .then((report) => {
        db.setSetting('lastCleanup', { ...report, ts: Date.now() / 1000, version });
        const n = report.items.filter((x) => x.freed > 0 || /копия|запись/.test(x.what)).length;
        db.addEvent('info', 'update', `После обновления удалены данные старой версии: ${report.items.length} поз., освобождено ${(report.total / 1048576).toFixed(1)} МБ`);
        if (n) ctx.notifier.notify(`🧹 После обновления удалены данные старой версии и старые установщики — освобождено ${(report.total / 1048576).toFixed(0)} МБ`, { category: 'update' });
        return report;
      })
      .catch(() => null);
  }
  const changes = changesBetween(from, version);
  const lines = changes.flatMap((v) => v.items.map(([, t]) => `• ${E(t)}`));
  ctx.notifier.notify(`⬆️ <b>PC Full Control обновлён: ${E(from)} → ${E(version)}</b>\n\n${lines.join('\n')}`, { category: 'update' });
}

// ================= Вход без пароля, если ПК включили с телефона =================
// Windows входит автоматически (автовход). Сразу после входа или выхода из сна программа проверяет,
// чем разбудили ПК: если не сетевой картой (с телефона), а кнопкой — экран тут же блокируется.
async function guardAutologon(afterLogon) {
  if (!IS_WIN || !ctx.db.getSetting('autologonEnabled')) return;
  let src;
  try { src = await poweron.wakeSource(afterLogon); } catch (e) { src = 'other'; }
  if (src === 'skip') return;
  if (src === 'network') {
    ctx.notifier.notify('🔓 Компьютер включили с телефона — вход выполнен без пароля', { category: 'security', level: 'warning' });
  } else {
    await lockScreen().catch(() => {});
    ctx.notifier.notify('🔒 Компьютер включили не с телефона — экран заблокирован', { category: 'security', level: 'warning' });
  }
}

/** Перед установкой обновления: останавливаем службы, сохраняем базу; выход сделает electron-updater. */
function prepareForUpdate() {
  quitting = true;
  try {
    ctx.monitor && ctx.monitor.stop();
    ctx.scheduler.stop();
    ctx.bot && ctx.bot.stop();
    ctx.lan && ctx.lan.stop();
    ctx.remote && ctx.remote.stopAgent();
    ctx.stream && ctx.stream.stopAll();
    ctx.db.save();
  } catch (e) { /* ignore */ }
}

let lastUpdateCheck = 0;
async function checkAppUpdate() {
  lastUpdateCheck = Date.now();
  try {
    ctx.updateInfo = await ctx.appUpdater.check();
  } catch (e) {
    return;
  }
  const u = ctx.updateInfo;
  // Окно программы предложит обновиться (если не идёт установка)
  if (u.hasUpdate && !['downloading', 'downloaded', 'installing'].includes(ctx.appUpdater.state.status)) send('update-available', u);
  if (u.hasUpdate && ctx.db.getSetting('notifiedUpdate') !== u.latest) {
    ctx.db.setSetting('notifiedUpdate', u.latest);
    ctx.notifier.notify(`✨ Доступна новая версия PC Full Control <b>${E(u.latest)}</b>.\nУстановить: «🔄 Обновления → 🤖 Обновить PC Full Control» или в программе на ПК.`, { category: 'update' });
  }
  send('refresh');
}

function startBot() {
  if (ctx.bot) ctx.bot.stop();
  ctx.bot = null;
  if (!ctx.tg) return;
  ctx.bot = new TelegramBot(ctx);
  ctx.bot.start();
}

function send(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
}

// ================= Окно и трей =================
function showWindow() {
  if (ctx && Date.now() - lastUpdateCheck > 10 * 60 * 1000) setTimeout(checkAppUpdate, 1500);
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  mainWindow = new BrowserWindow({
    width: 1240, height: 820, minWidth: 900, minHeight: 600,
    title: 'PC Full Control', icon: ICON, backgroundColor: '#090b10', show: false, autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0d1017', symbolColor: '#cfd6e4', height: 44 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(RENDERER, 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    mainWindow.hide();
    if (tray && IS_WIN && !ctx.db.getSetting('trayHintShown')) {
      ctx.db.setSetting('trayHintShown', true);
      tray.displayBalloon({ title: 'PC Full Control', content: 'Приложение продолжает работать в трее и принимать команды с телефона.' });
    }
  });
}

function createTray() {
  let img = nativeImage.createFromPath(ICON);
  if (!img.isEmpty()) img = img.resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
  updateTray();
}

function botStatusText() {
  if (!ctx.tg) return 'Telegram не подключён';
  const b = ctx.bot;
  if (!b) return 'Бот остановлен';
  return { online: `Бот @${b.username} на связи`, connecting: 'Подключение к Telegram…', error: `Ошибка: ${b.lastError}` }[b.status] || 'Бот остановлен';
}

function updateTray() {
  if (!tray) return;
  tray.setToolTip(`PC Full Control — ${botStatusText()}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть PC Full Control', click: showWindow },
    { label: botStatusText(), enabled: false },
    { type: 'separator' },
    {
      label: 'Уведомления в Telegram', type: 'checkbox', checked: !ctx.notifier.muted,
      click: (item) => { ctx.notifier.setMuted(!item.checked); send('refresh'); },
    },
    { type: 'separator' },
    { label: 'Выход', click: quit },
  ]));
}

async function quit() {
  quitting = true;
  try {
    if (ctx) {
      ctx.monitor && ctx.monitor.stop();
      ctx.scheduler.stop();
      ctx.bot && ctx.bot.stop();
      ctx.lan && ctx.lan.stop();
      ctx.remote && ctx.remote.stopAgent();
      ctx.stream && ctx.stream.stopAll();
      await ctx.notifier.flush(3000);
      ctx.db.close();
    }
  } catch (e) { /* ignore */ }
  app.quit();
}

// ================= Сон, блокировка =================
function watchPower() {
  powerMonitor.on('suspend', () => {
    ctx.notifier.notify('💤 Компьютер уходит в спящий режим', { category: 'power' });
    ctx.db.save();
  });
  powerMonitor.on('resume', () => {
    ctx.notifier.notify('☀️ Компьютер вышел из спящего режима', { category: 'power' });
    guardAutologon(false);
  });
  powerMonitor.on('unlock-screen', () => {
    if (ctx.config.monitor.notifyLogin) ctx.notifier.notify('🔓 Компьютер разблокирован', { category: 'login', level: 'warning' });
  });
  powerMonitor.on('shutdown', () => ctx.db.save());
}

// ================= Автозапуск =================
// Установщик создаёт задачу Планировщика Windows (с правами администратора, при входе в систему).
// Если её нет (например, запуск без установки), используем обычный автозапуск Electron.
async function getAutostart() {
  if (IS_WIN && app.isPackaged) {
    const r = await run('schtasks.exe', ['/Query', '/TN', TASK_NAME, '/FO', 'CSV', '/NH'], { timeout: 15000 });
    if (r.code === 0) return { mode: 'task', enabled: !/Disabled|Отключено/i.test(r.out) };
  }
  const s = app.getLoginItemSettings({ args: ['--hidden'] });
  return { mode: 'login', enabled: !!s.openAtLogin };
}

async function setAutostart(on) {
  const a = await getAutostart();
  if (a.mode === 'task') {
    const r = await run('schtasks.exe', ['/Change', '/TN', TASK_NAME, on ? '/ENABLE' : '/DISABLE'], { timeout: 15000 });
    if (r.code !== 0) throw new Error(r.out || 'не удалось изменить автозапуск');
  } else {
    app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] });
  }
  return getAutostart();
}

async function ensureAutostartOnFirstRun() {
  if (ctx.db.getSetting('autostartInitialized')) return;
  ctx.db.setSetting('autostartInitialized', true);
  if (!app.isPackaged) return;
  const a = await getAutostart();
  if (a.mode === 'login' && !a.enabled) app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] });
}

// ================= Связь с окном (IPC) =================
async function pairingInfo() {
  const code = ctx.pairingCode();
  const username = ctx.bot && ctx.bot.username;
  if (!username) return { code, link: null, qr: null };
  const link = `https://t.me/${username}?start=pair_${code}`;
  const qr = await QRCode.toDataURL(link, { margin: 1, width: 240, color: { dark: '#101318', light: '#ffffff' } });
  return { code, link, qr };
}

function taskView(t) {
  return { ...t, description: ctx.scheduler.describe(t) };
}

function registerIpc() {
  const handle = (ch, fn) => ipcMain.handle(ch, async (event, data) => {
    try {
      return { ok: true, data: await fn(data || {}) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  handle('get-state', async () => ({
    version: app.getVersion(),
    pcName: ctx.pcName,
    hostname: require('os').hostname(),
    isWin: IS_WIN,
    config: ctx.config,
    bot: {
      configured: !!ctx.tg,
      status: ctx.bot ? ctx.bot.status : 'stopped',
      username: ctx.bot ? ctx.bot.username : '',
      error: ctx.bot ? ctx.bot.lastError : '',
    },
    users: ctx.db.listTgUsers(),
    pairing: await pairingInfo(),
    muted: ctx.notifier.muted,
    autostart: await getAutostart(),
    actions: ctx.actions.available().map((a) => ctx.actions.toJSON(a)),
    dataDir: app.getPath('userData'),
    mobile: {
      enabled: !!ctx.config.mobile.enabled, status: ctx.lan ? ctx.lan.status : 'stopped',
      error: ctx.lan ? ctx.lan.error : '', devices: ctx.db.listDevices().length,
    },
    update: ctx.updateInfo || null,
  }));

  handle('get-status', async () => {
    const s = await info.getStatus();
    s.volume = await media.getVolume();
    return s;
  });
  handle('get-processes', ({ sort = 'cpu', query = '' }) => processes.listProcesses({ sort, query, limit: 150 }));
  handle('whatsnew-state', async () => {
    const pending = ctx.db.getSetting('pendingWhatsNew');
    let cleanup = null;
    if (pending && cleanupPromise) cleanup = await Promise.race([cleanupPromise, new Promise((r) => setTimeout(() => r(null), 20000))]);
    return { pending, cleanup };
  });
  handle('whatsnew-ack', () => { ctx.db.setSetting('pendingWhatsNew', null); return true; });
  handle('get-metrics', ({ hours = 1 }) => {
    const rows = ctx.db.metricsSince(Date.now() / 1000 - Math.min(Math.max(hours, 0.1), 168) * 3600);
    const step = Math.max(1, Math.floor(rows.length / 400));
    return rows.filter((_, i) => i % step === 0);
  });

  handle('set-token', async ({ token }) => {
    token = String(token || '').trim();
    if (!token) {
      ctx.updateConfig({ telegram: { token: '' } });
      ctx.setTelegram(null);
      startBot();
      updateTray();
      return { username: '' };
    }
    if (!/^\d+:[\w-]{20,}$/.test(token)) throw new Error('Это не похоже на токен бота. Он выглядит так: 123456789:AAH…');
    const api = new TelegramAPI(token);
    let me;
    try {
      me = await api.getMe();
    } catch (e) {
      throw new Error(e.code === 401 ? 'Telegram отклонил токен — проверьте, что скопировали его полностью' : `Не удалось связаться с Telegram: ${e.message}`);
    }
    ctx.updateConfig({ telegram: { token } });
    ctx.setTelegram(api);
    startBot();
    ctx.db.addEvent('info', 'telegram', `Подключён бот @${me.username}`);
    updateTray();
    return { username: me.username };
  });

  handle('regen-pair', () => { ctx.pairingCode(true); return pairingInfo(); });

  // --- приложение на телефоне ---
  handle('mobile-info', async () => {
    const i = ctx.lan.pairInfo();
    const qr = i.pairUrl ? await QRCode.toDataURL(i.pairUrl, { margin: 1, width: 260, color: { dark: '#0b0d12', light: '#ffffff' } }) : null;
    return { ...i, qr, devices: ctx.db.listDevices(), enabled: !!ctx.config.mobile.enabled };
  });
  handle('mobile-regen', () => { ctx.lan.pairCode(true); return true; });
  handle('remove-device', ({ id }) => {
    ctx.db.removeDevice(id);
    ctx.db.addEvent('warning', 'security', `Телефон с приложением отвязан (#${id})`);
    return true;
  });
  handle('remove-user', ({ userId }) => {
    ctx.db.removeTgUser(userId);
    ctx.db.addEvent('warning', 'security', `Телефон отвязан: ${userId}`);
    return true;
  });
  handle('test-notify', () => {
    if (!ctx.authorizedIds().length) throw new Error('Сначала привяжите телефон');
    ctx.notifier.notify('🔔 Тестовое уведомление. Всё работает!', { category: 'test', level: 'warning' });
    return true;
  });

  handle('save-config', (patch) => {
    const before = ctx.config.monitor.intervalSec;
    const mobileBefore = JSON.stringify(ctx.config.mobile);
    const cfg = ctx.updateConfig(patch);
    if (cfg.monitor.intervalSec !== before) { ctx.monitor.stop(); ctx.monitor.start(); }
    if (JSON.stringify(cfg.mobile) !== mobileBefore) ctx.lan.start();
    updateTray();
    return cfg;
  });
  handle('set-muted', ({ muted }) => { ctx.notifier.setMuted(muted); updateTray(); return true; });
  handle('set-autostart', ({ enabled }) => setAutostart(!!enabled));

  handle('run-action', ({ name, arg }) => ctx.actions.run(name, arg || '', 'app', 'ПК'));
  handle('get-tasks', () => ctx.db.listTasks().map(taskView));
  handle('add-task', (t) => {
    let id;
    if (t.kind === 'in') {
      const mins = Number(t.delayMinutes);
      if (!(mins > 0)) throw new Error('Укажите, через сколько минут');
      id = ctx.scheduler.addOnce(t.action, t.arg, Date.now() / 1000 + mins * 60);
    } else if (t.kind === 'at') {
      const ts = new Date(t.runAt).getTime() / 1000;
      if (!ts || ts <= Date.now() / 1000) throw new Error('Укажите время в будущем');
      id = ctx.scheduler.addOnce(t.action, t.arg, ts);
    } else {
      id = ctx.scheduler.addDaily(t.action, t.arg, t.timeOfDay, t.weekdays);
    }
    return taskView(ctx.db.getTask(id));
  });
  handle('toggle-task', ({ id }) => {
    const t = ctx.db.getTask(id);
    if (t) ctx.db.setTaskEnabled(id, !t.enabled);
    return true;
  });
  handle('delete-task', ({ id }) => ctx.db.deleteTask(id));
  handle('get-log', ({ mode = 'events', limit = 150 }) => {
    if (mode === 'commands') return ctx.db.recentCommands(limit);
    if (mode === 'jobs') return ctx.db.recentJobs(30);
    return ctx.db.recentEvents(limit);
  });
  handle('check-app-update', async () => { ctx.updateInfo = await ctx.appUpdater.check(); return ctx.updateInfo; });
  handle('update-state', () => ctx.appUpdater.state);

  // --- включение с телефона ---
  handle('wol-info', async () => ({ iface: poweron.primaryInterface(), autologon: await poweron.autologonState(), isWin: IS_WIN }));
  handle('wol-setup', () => poweron.setupWindows());
  // Оптимизация: анализ ничего не удаляет; очистка — только выбранные пользователем категории
  handle('clean-analyze', () => ctx.cleaner.analyze());
  handle('clean-run', async ({ ids }) => {
    if (Array.isArray(ids) && ids.includes('own-installers') && ['downloading', 'downloaded', 'installing'].includes(ctx.appUpdater.state.status)) {
      throw new Error('Сейчас идёт обновление программы — очистите установщики после него');
    }
    const r = await ctx.cleaner.clean(ids);
    const freed = r.reduce((s, x) => s + x.freed, 0);
    ctx.db.logCommand('local', 'ПК', 'cleanup', ids.join(', '), true, `освобождено ${(freed / 1048576).toFixed(1)} МБ`);
    return r;
  });
  // Удаление программ: всё только по выбору пользователя
  handle('apps-list', async () => ({ available: ctx.apps.available, apps: await ctx.apps.list() }));
  handle('apps-uninstall', ({ id, quiet }) => ctx.apps.uninstall(id, { quiet: !!quiet }));
  handle('apps-job', ({ id }) => ctx.apps.job(id));
  handle('apps-leftovers', ({ id }) => ctx.apps.findLeftovers(id));
  handle('apps-remove-leftovers', ({ id, tokens }) => ctx.apps.removeLeftovers(id, tokens));
  handle('cleanup-report', () => ctx.db.getSetting('lastCleanup'));
  handle('autologon-enable', async ({ password }) => {
    const r = await poweron.enableAutologon(password);
    ctx.db.setSetting('autologonEnabled', true);
    ctx.notifier.notify('🔑 Включён вход без пароля при включении ПК с телефона', { category: 'security', level: 'warning' });
    return r;
  });
  handle('autologon-disable', async () => {
    const r = await poweron.disableAutologon();
    ctx.db.setSetting('autologonEnabled', false);
    return r;
  });
  handle('update-start', () => ctx.appUpdater.startUpdate());
  handle('open-external', ({ url }) => {
    if (!/^https:\/\/(t\.me|telegram\.me|github\.com)\//.test(url)) throw new Error('Ссылка не разрешена');
    return shell.openExternal(url);
  });
  handle('open-data-dir', () => shell.openPath(app.getPath('userData')));
  handle('quit', () => quit());
}
