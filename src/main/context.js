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
const { RemoteControl } = require('./remote');
const { ScreenStream } = require('./stream');
const { Cleaner } = require('./system/cleaner');
const { AppsManager } = require('./system/apps');
const { StartupManager } = require('./system/startup');
const { FpsMonitor, gpuStats } = require('./system/gpu');
const { diskHealth } = require('./system/disk-health');
const { NetWatch } = require('./netwatch');
const { IntruderWatch } = require('./intruder');
const { ActivityTracker } = require('./activity');
const { SpeechRecognizer } = require('./speech');
const { RemoteAccess } = require('./tunnel');
const path = require('path');
const fs = require('fs');

/** Где лежит PresentMon (счётчик кадров в играх): в установленной программе — resources\bin. */
function presentMonPath() {
  const cands = [
    process.resourcesPath && path.join(process.resourcesPath, 'bin', 'PresentMon.exe'),
    path.join(__dirname, '..', '..', 'build', 'bin', 'PresentMon.exe'),
  ].filter(Boolean);
  return cands.find((p) => fs.existsSync(p)) || cands[0];
}

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
    this.remote = new RemoteControl(this);
    this.stream = new ScreenStream(this);
    this.cleaner = new Cleaner();
    this.apps = new AppsManager(this);
    this.startup = new StartupManager();
    this.fps = new FpsMonitor({ exePath: presentMonPath(), log: (m) => this.db.addEvent('info', 'gpu', m) });
    this.net = new NetWatch(this);
    this.intruder = new IntruderWatch(this);
    this.activity = new ActivityTracker(this);
    this.speech = new SpeechRecognizer(this);
    this.tunnel = new RemoteAccess(this);
    this._diskHealth = null;
    this.monitor = null;
    this.bot = null;
  }

  get pcName() { return this.config.pcName || os.hostname(); }

  /** Видеокарта + кадры в секунду в текущей игре (PresentMon запускается по запросу). */
  async gpu() {
    const gpus = await gpuStats();
    this.fps.touch();
    const fps = this.fps.current();
    const game = fps.find((f) => !f.ignored) || null;
    return { gpus, fps: game, fpsAvailable: this.fps.available, apps: fps.slice(0, 5) };
  }

  /** Здоровье дисков (SMART), не чаще раза в 10 минут. */
  async diskHealth(force = false) {
    if (!force && this._diskHealth && Date.now() - this._diskHealth.ts < 600000) return this._diskHealth.data;
    const data = await diskHealth();
    this._diskHealth = { ts: Date.now(), data };
    return data;
  }

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
