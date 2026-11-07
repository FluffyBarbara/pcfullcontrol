'use strict';
// Настройки приложения. Хранятся в локальной базе (таблица settings, ключ "config").

const DEFAULTS = {
  pcName: '',
  telegram: {
    token: '',
    confirmDangerous: true,
  },
  mobile: {
    enabled: true,               // приложение на телефоне (по Wi-Fi)
    port: 8765,
    remoteControl: true,         // удалённое управление экраном с телефона
  },
  security: {
    allowShell: false,           // разрешить /cmd (выполнение команд)
    photoOnFailedLogin: true,    // фото с веб-камеры при неверном пароле на экране входа
    photoOnUnlock: false,        // фото при каждой разблокировке
    usbWatch: true,              // уведомлять о подключении флешек и USB-устройств
  },
  voice: {
    enabled: true,               // голосовые команды в Telegram
  },
  network: {
    watchInternet: true,         // следить за обрывами интернета
    watchDevices: true,          // следить за новыми устройствами в домашней сети
    autoFixAdapter: false,       // при обрыве (роутер не отвечает) сам перезапускать сетевой адаптер
  },
  reports: {
    weekly: true,                // отчёт за неделю в Telegram (воскресенье, 20:00)
  },
  files: {
    allowedRoots: [],            // ограничить файловый менеджер папками; пусто = папка пользователя
    fullDiskAccess: false,       // «весь диск» — только если пользователь включил сам
    uploadAnywhere: false,       // сохранять файлы с телефона не только в папку загрузок
    uploadDir: '',               // куда сохранять файлы с телефона (пусто = Загрузки\PCControl)
  },
  apps: [
    { name: 'Блокнот', cmd: 'notepad.exe' },
    { name: 'Диспетчер задач', cmd: 'taskmgr.exe' },
  ],
  monitor: {
    intervalSec: 30,
    retentionDays: 7,
    cpuPercent: 90,
    cpuChecks: 4,
    ramPercent: 90,
    diskFreePercent: 10,
    tempCelsius: 85,
    gpuTempCelsius: 85,          // тревога при перегреве видеокарты
    diskHealthCheck: true,       // ежедневная проверка здоровья дисков
    batteryLowPercent: 20,
    cooldownMin: 30,
    notifyStart: true,
    notifyLogin: true,
    notifyIp: true,
    notifyPower: true,
    watchProcesses: [],
  },
  updates: {
    dailyCheckTime: '12:00',
  },
  media: {
    onlineCovers: true,          // искать обложку в каталогах музыки (Deezer, iTunes), если плеер её не передал
  },
  ui: {
    theme: 'dark',               // dark | light | system
    accent: 'indigo',            // цвет акцента
  },
  appUpdate: {
    repo: 'FluffyBarbara/pcfullcontrol', // GitHub-репозиторий с релизами установщика
  },
};

function isObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, over) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

// Секреты (токен бота) хранятся в базе зашифрованными средствами Windows (DPAPI через Electron safeStorage):
// даже если файл базы украдут, на другом компьютере или под другой учётной записью его не расшифровать.
const SECRET_PATHS = [['telegram', 'token']];
function safeStorage() {
  try {
    if (!process.versions.electron) return null;
    const s = require('electron').safeStorage;
    return s && s.isEncryptionAvailable() ? s : null;
  } catch (e) { return null; }
}
function seal(cfg, store = safeStorage()) {
  const out = JSON.parse(JSON.stringify(cfg));
  if (!store) return out;
  for (const [a, b] of SECRET_PATHS) {
    const v = out[a] && out[a][b];
    if (typeof v === 'string' && v && !v.startsWith('enc:')) out[a][b] = 'enc:' + store.encryptString(v).toString('base64');
  }
  return out;
}
function unseal(cfg, store = safeStorage()) {
  for (const [a, b] of SECRET_PATHS) {
    const v = cfg[a] && cfg[a][b];
    if (typeof v !== 'string' || !v.startsWith('enc:')) continue;
    try { cfg[a][b] = store ? store.decryptString(Buffer.from(v.slice(4), 'base64')) : ''; } catch (e) { cfg[a][b] = ''; } // не расшифровался — токен введут заново
  }
  return cfg;
}

function loadConfig(db, store) {
  const stored = db.getSetting('config', {}) || {};
  const cfg = unseal(deepMerge(DEFAULTS, stored), store);
  // Токен, сохранённый раньше открытым текстом, сразу перезаписываем зашифрованным
  const t = stored.telegram && stored.telegram.token;
  if (t && !String(t).startsWith('enc:') && (store || safeStorage())) {
    saveConfig(db, cfg, store);
    if (db.vacuum) db.vacuum();
  }
  return cfg;
}

function saveConfig(db, cfg, store) {
  db.setSetting('config', seal(cfg, store));
  return cfg;
}

module.exports = { DEFAULTS, deepMerge, loadConfig, saveConfig, seal, unseal };
