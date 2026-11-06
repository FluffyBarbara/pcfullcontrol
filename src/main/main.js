'use strict';
// PC Full Control — главный процесс Electron: окно, значок в трее, автозапуск, службы.
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, session, dialog, powerMonitor, nativeTheme } = require('electron');
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
  if (process.env.PCFC_TEST_HOOKS) global.__pcfc = ctx; // только для автоматических проверок
  ctx.monitor = new Monitor(ctx);
  ctx.monitor.start();
  ctx.scheduler.start();
  ctx.lan = new LanServer(ctx);
  ctx.lan.start();
  ctx.net.start();
  // Фоновые помощники — чуть позже, чтобы не нагружать компьютер в первые секунды после входа
  setTimeout(() => ctx.activity.start(), 30000);
  setTimeout(() => ctx.intruder.start().catch(() => {}), 20000);
  setTimeout(() => ctx.usb.start().catch(() => {}), 25000);
  ctx.crashes.start();
  setTimeout(() => removeInternetAccessLeftovers().catch(() => {}), 15000);
  startWeeklyReports();
  startBot();
  createTray();
  registerIpc();
  watchPower();
  await ensureAutostartOnFirstRun();

  ctx.on('event', () => send('refresh'));
  ctx.on('bot-status', () => { send('refresh'); updateTray(); });
  ctx.on('metrics', (m) => send('metrics', m));
  ctx.on('update-state', (st) => { send('update-state', st); updateTray(); });
  ctx.on('net-progress', (p) => send('net-progress', p));
  ctx.on('space', (p) => send('space', p));
  ctx.on('usb', (p) => send('usb', p));
  ctx.on('netdiag', (p) => send('netdiag', p));
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
    cleanupPromise = cleanupAfterUpdate({ exeDir: path.dirname(process.execPath), electronSession: session.defaultSession, dataDir: app.getPath('userData'), version, log: (m) => ctx.appUpdater.log('info', m) })
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
    stopServices();
    ctx.db.save();
  } catch (e) { /* ignore */ }
}

let lastUpdateCheck = 0;
/** Останавливает фоновые службы (перед выходом и обновлением). */
function stopServices() {
  for (const fn of [() => ctx.net.stop(), () => ctx.activity.stop(), () => ctx.intruder.stop(), () => ctx.speech.stop(), () => ctx.fps.stop(), () => ctx.media.stop(), () => ctx.usb.stop(), () => ctx.crashes.stop(), () => ctx.space.stopProc()]) {
    try { fn(); } catch (e) { /* ignore */ }
  }
}

// ================= Отчёт за неделю =================
function startWeeklyReports() {
  const weekly = require('./weekly');
  const tick = () => {
    if (!ctx.config.reports || !ctx.config.reports.weekly || !ctx.tg) return;
    if (!weekly.isDue(ctx.db.getSetting('lastWeeklyReport'))) return;
    ctx.db.setSetting('lastWeeklyReport', Date.now() / 1000);
    ctx.notifier.notify(weekly.build(ctx).text, { category: 'report' });
  };
  setTimeout(tick, 60000);
  setInterval(tick, 15 * 60 * 1000);
}

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

/**
 * Доступ из интернета (туннель Cloudflare) убран в версии 1.9.0. Один раз после обновления:
 * возвращаем обычное меню в чатах Telegram вместо кнопки «Мой ПК» и удаляем скачанный программой
 * модуль туннеля и его журналы (это файлы самой программы в её папке данных).
 */
async function removeInternetAccessLeftovers() {
  if (ctx.db.getSetting('internetAccessRemoved')) return;
  if (ctx.tg) {
    for (const id of ctx.authorizedIds()) {
      try { await ctx.tg.call('setChatMenuButton', { chat_id: id, menu_button: { type: 'commands' } }); } catch (e) { return; /* нет связи — попробуем при следующем запуске */ }
    }
  }
  if (ctx.dataDir) {
    for (const f of ['bin/cloudflared.exe', 'bin/cloudflared.exe.part', 'cloudflared.log', 'cloudflared.prev.log']) {
      try { fs.rmSync(path.join(ctx.dataDir, f), { force: true }); } catch (e) { /* файл занят — не страшно */ }
    }
  }
  ctx.db.setSetting('internetAccessRemoved', true);
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
  mainWindow.once('ready-to-show', () => { applyTitleBar(); mainWindow.show(); });
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
      stopServices();
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
    ctx.intruder.onUnlock().catch(() => {});
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

/** Исправления сети — только по кнопке пользователя. */
async function netFix(action) {
  const d = ctx.netdiag;
  switch (action) {
    case 'restart': return d.restartAdapter();
    case 'energy': return d.disableEnergySaving();
    case 'energy_restore': return d.restoreEnergySaving();
    case 'dns': return d.setDns(undefined, false);
    case 'dns_reset': return d.setDns(undefined, true);
    case 'autofix_on': case 'autofix_off': ctx.updateConfig({ network: { autoFixAdapter: action === 'autofix_on' } }); return { ok: true };
    default: throw new Error('Неизвестное действие');
  }
}

/** Цвет строки заголовка под выбранную тему. */
function applyTitleBar() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const ui = ctx.config.ui || {};
  const light = ui.theme === 'light' || (ui.theme === 'system' && !nativeTheme.shouldUseDarkColors);
  try { mainWindow.setTitleBarOverlay({ color: light ? '#f3f5fa' : '#0d1017', symbolColor: light ? '#2a3142' : '#cfd6e4', height: 44 }); } catch (e) { /* не Windows */ }
  mainWindow.setBackgroundColor(light ? '#f3f5fa' : '#090b10');
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
  // Железо: видеокарта (с кадрами в игре) и здоровье дисков
  handle('hw-info', async ({ force, only } = {}) => ({
    gpu: only === 'disks' ? undefined : await ctx.gpu().catch(() => ({ gpus: [] })),
    disks: only === 'gpu' ? undefined : await ctx.diskHealth(!!force).catch((e) => ({ error: e.message })),
  }));
  // Музыка и звук
  handle('media-state', () => ctx.media.state());
  handle('media-control', ({ app, action, value }) => ctx.media.control(app, action, value));
  handle('media-cover', ({ key }) => { const c = ctx.media.cover(key); return c ? `data:${c.type};base64,${c.buf.toString('base64')}` : null; });
  handle('mixer', () => ctx.media.mixer());
  handle('mixer-peaks', () => ctx.media.peaks().catch(() => ({})));
  handle('mixer-set', ({ name, level, mute }) => ctx.media.setApp(name, { level, mute }));
  handle('mixer-master', ({ level, mute }) => ctx.media.setMaster({ level, mute }));
  // Игры, температуры, сбои, USB, тревожная кнопка
  handle('games', ({ days } = {}) => ctx.games(Number(days) || 7));
  handle('temps', ({ hours } = {}) => ctx.tempHistory(Math.min(24 * 14, Number(hours) || 24)));
  handle('crashes', () => ctx.crashes.list());
  handle('usb-events', () => ctx.db.usbEvents(50));
  handle('panic-state', () => ctx.panic.state());
  handle('panic-trigger', () => ctx.panic.trigger('ПК'));
  handle('panic-release', () => ctx.panic.release('ПК'));
  // Место на диске
  handle('space-roots', async () => (await require('./system/info').disks()).map((d) => ({ mount: d.mount, total: d.total, free: d.free, percent: d.percent })));
  handle('space-start', ({ root, dups }) => ctx.space.start(root, { dups: dups !== false }));
  handle('space-cancel', () => ctx.space.cancel());
  handle('space-view', ({ dir } = {}) => ctx.space.view({ dir }));
  handle('space-delete', ({ paths, permanent }) => ctx.space.remove(paths, !!permanent, 'local', 'ПК'));
  // Оформление: тема и цвет акцента (строка заголовка окна — в тон)
  handle('set-theme', ({ theme, accent }) => {
    ctx.updateConfig({ ui: { theme: theme || 'dark', accent: accent || 'indigo' } });
    applyTitleBar();
    return ctx.config.ui;
  });
  // Сеть
  handle('net-status', () => ctx.net.status());
  handle('netdiag-run', () => ctx.netdiag.run());
  handle('net-fix', ({ action }) => netFix(action));
  handle('net-speedtest', () => ctx.net.speedTest());
  handle('net-scan', () => ctx.net.scan(false));
  handle('net-label', ({ mac, label }) => ctx.db.labelNetDevice(mac, label));
  // Автозагрузка (включение/выключение обратимо)
  handle('startup-list', async () => ({ available: ctx.startup.available, items: await ctx.startup.list() }));
  handle('startup-set', async ({ id, enabled }) => {
    const r = await ctx.startup.setEnabled(id, !!enabled);
    ctx.db.logCommand('local', 'ПК', 'startup', `${id} → ${enabled ? 'вкл' : 'выкл'}`, true, '');
    return r;
  });
  // Отчёт за неделю и прочее
  handle('weekly-preview', () => require('./weekly').build(ctx).text);
  handle('weekly-send', () => { ctx.notifier.notify(require('./weekly').build(ctx).text, { category: 'report' }); return true; });
  handle('extras-state', () => ({ hasCamera: ctx.intruder.hasCamera, voiceModel: ctx.speech.modelReady }));
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
