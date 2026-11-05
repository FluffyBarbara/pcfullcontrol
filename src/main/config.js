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
  },
  voice: {
    enabled: true,               // голосовые команды в Telegram
  },
  network: {
    watchInternet: true,         // следить за обрывами интернета
    watchDevices: true,          // следить за новыми устройствами в домашней сети
  },
  reports: {
    weekly: true,                // отчёт за неделю в Telegram (воскресенье, 20:00)
  },
  remote: {
    enabled: false,              // доступ из интернета (туннель Cloudflare)
  },
  files: {
    allowedRoots: [],            // ограничить файловый менеджер папками; пусто = весь диск
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

function loadConfig(db) {
  return deepMerge(DEFAULTS, db.getSetting('config', {}) || {});
}

function saveConfig(db, cfg) {
  db.setSetting('config', cfg);
  return cfg;
}

module.exports = { DEFAULTS, deepMerge, loadConfig, saveConfig };
