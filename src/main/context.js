'use strict';
// Общий контекст приложения: база, настройки, Telegram, действия, службы.
const crypto = require('crypto');
const os = require('os');
const { EventEmitter } = require('events');
const { loadConfig, saveConfig, deepMerge } = require('./config');
const { TelegramAPI } = require('./telegram-api');
const { Notifier } = require('./notifier');
const { JobManager } = require('./jobs');
const { ActionRegistry } = require('./actions');
const { FileManager } = require('./system/files');
const { Scheduler } = require('./scheduler');
const { AppUpdater } = require('./app-updater');

class AppContext extends EventEmitter {
  constructor(db, { version = '0.0.0', quitApp = () => {}, restartApp = () => {}, dataDir = null, prepareForUpdate = () => {} } = {}) {
    super();
    this.setMaxListeners(50);
    this.db = db;
    this.version = version;
    this.dataDir = dataDir;
    this.prepareForUpdate = prepareForUpdate;
    this.startedAt = Date.now() / 1000;
    this.quitApp = quitApp;
    this.restartAppImpl = restartApp;
    this.config = loadConfig(db);
    this.tg = this.config.telegram.token ? new TelegramAPI(this.config.telegram.token) : null;
    this.files = new FileManager(() => this.config);
    this.notifier = new Notifier(this);
    this.jobs = new JobManager(this);
    this.actions = new ActionRegistry(this);
    this.scheduler = new Scheduler(this);
    this.appUpdater = new AppUpdater(this);
    this.monitor = null;
    this.bot = null;
  }

  get pcName() { return this.config.pcName || os.hostname(); }

  updateConfig(patch) {
    this.config = deepMerge(this.config, patch);
    saveConfig(this.db, this.config);
    this.emit('config');
    return this.config;
  }

  authorizedIds() {
    return this.db.listTgUsers().map((u) => Number(u.user_id));
  }

  isAuthorized(id) {
    return this.authorizedIds().includes(Number(id));
  }

  pairingCode(regenerate = false) {
    let code = this.db.getSetting('pairCode');
    if (regenerate || !code) {
      code = crypto.randomBytes(4).toString('hex').toUpperCase();
      this.db.setSetting('pairCode', code);
    }
    return code;
  }

  setTelegram(api) {
    this.tg = api;
  }

  async restartApp() {
    setTimeout(() => this.restartAppImpl(), 2000);
    return 'Приложение перезапускается…';
  }
}

module.exports = { AppContext };
