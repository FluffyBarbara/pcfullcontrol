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
const { diskHealth, forecast } = require('./system/disk-health');
const { NetWatch } = require('./netwatch');
const { IntruderWatch } = require('./intruder');
const { ActivityTracker, localDay } = require('./activity');
const { SpeechRecognizer } = require('./speech');
const { MediaInfo } = require('./system/mediainfo');
const { PanicMode } = require('./panic');
const { UsbWatch } = require('./usbwatch');
const { CrashWatch } = require('./crashes');
const { SpaceScanner } = require('./system/space');
const { Assistant } = require('./assistant');
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
    this.media = new MediaInfo(this);
    this.panic = new PanicMode(this);
    this.usb = new UsbWatch(this);
    this.crashes = new CrashWatch(this);
    this.space = new SpaceScanner(this);
    this.assistant = new Assistant(this);
    this._diskHealth = null;
    this.monitor = null;
    this.bot = null;
  }

  /** Игры за N дней: время, средний FPS, по дням. */
  games(days = 7) {
    const since = localDay(new Date(Date.now() - (days - 1) * 86400000));
    const list = this.db.gameUsageSince(since).map((g) => ({ exe: g.exe, title: g.title || g.exe, seconds: g.seconds, avgFps: g.fps_n ? Math.round(g.fps_sum / g.fps_n) : null, days: g.days, last: g.last }));
    const byDay = this.db.gameDaysSince(since);
    const total = list.reduce((s, g) => s + g.seconds, 0);
    const now = this.activity.lastGame && Date.now() - this.activity.lastGame.ts < 60000 ? this.activity.lastGame : null;
    return { days, since, total, games: list, byDay, now };
  }

  /** Данные для виджета на главном экране телефона. */
  async widgetData() {
    const m = this.monitor && this.monitor.latest;
    const gpu = (await this.gpu().catch(() => ({ gpus: [] }))).gpus[0];
    let media = null;
    try { const st = this.media.last && Date.now() - this.media.last.ts < 30000 ? this.media.last : await this.media.state(); const s = (st.sessions || [])[0]; if (s && s.title) media = { title: s.title, artist: s.artist, playing: s.playing, app: s.appName }; } catch (e) { /* без музыки */ }
    return {
      app: 'pc-full-control', pcName: this.pcName, online: true, ts: Date.now(),
      cpu: m ? m.cpu : null, ram: m ? m.ram : null, cpuTemp: m && m.temp != null ? Math.round(m.temp) : null,
      gpuTemp: gpu && gpu.temp != null ? Math.round(gpu.temp) : null, gpuUtil: gpu && gpu.util != null ? Math.round(gpu.util) : null,
      uptime: Math.round(os.uptime()), media,
    };
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
    // Снимок раз в день — для прогноза износа SSD
    const day = localDay();
    for (const d of data) {
      if (!d.serial || (d.life == null && d.written == null)) continue;
      try { this.db.addDiskHistory(day, d.serial, d.life, d.written, d.hours); } catch (e) { /* база закрыта */ }
      d.forecast = forecast(d, this.db.diskHistory(d.serial));
    }
    this._diskHealth = { ts: Date.now(), data };
    return data;
  }

  /** История температур за N часов: процессор, видеокарта, диски (до ~360 точек на линию). */
  tempHistory(hours = 24) {
    const since = Date.now() / 1000 - hours * 3600;
    const bucket = Math.max(60, Math.round((hours * 3600) / 360));
    const series = (rows, key) => {
      const m = new Map();
      for (const r of rows) {
        const v = r[key];
        if (v == null || !(v > 0 && v < 130)) continue;
        const b = Math.floor(r.ts / bucket) * bucket;
        const x = m.get(b) || { sum: 0, n: 0, max: 0 };
        x.sum += v; x.n++; x.max = Math.max(x.max, v);
        m.set(b, x);
      }
      return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([t, x]) => [t, Math.round((x.sum / x.n) * 10) / 10, Math.round(x.max)]);
    };
    const disks = {};
    const byDisk = new Map();
    for (const r of this.db.diskTempsSince(since)) { if (!byDisk.has(r.disk)) byDisk.set(r.disk, []); byDisk.get(r.disk).push(r); }
    for (const [name, rows] of byDisk) disks[name] = series(rows, 'temp');
    const cpu = series(this.db.metricsSince(since), 'temp');
    const gpu = series(this.db.gpuMetricsSince(since), 'temp');
    const stat = (arr) => (arr.length ? { avg: Math.round(arr.reduce((a, p) => a + p[1], 0) / arr.length), max: Math.max(...arr.map((p) => p[2])), maxAt: arr.reduce((a, p) => (p[2] > a[2] ? p : a))[0] } : null);
    const limits = { cpu: 90, gpu: Number(this.config.monitor.gpuTempCelsius) || 85, hdd: 55, ssd: 70, nvme: 80 };
    return { hours, since, cpu, gpu, disks, stats: { cpu: stat(cpu), gpu: stat(gpu), disks: Object.fromEntries(Object.entries(disks).map(([k, v]) => [k, stat(v)])) }, limits };
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
