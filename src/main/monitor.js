'use strict';
// Фоновый мониторинг: метрики в базу и уведомления о важных событиях.
const os = require('os');
const si = require('systeminformation');
const info = require('./system/info');
const { listProcesses } = require('./system/processes');
const { E } = require('./telegram-api');

const POWER_TITLES = {
  shutdown: 'выключен по команде', reboot: 'перезагружен по команде',
  sleep: 'переведён в сон по команде', hibernate: 'переведён в гибернацию по команде',
};

class Monitor {
  constructor(ctx) {
    this.ctx = ctx;
    this.lastAlert = {};
    this.cpuHigh = 0;
    this.prevUsers = null;
    this.prevIps = null;
    this.prevPlugged = null;
    this.prevWatched = null;
    this.batteryAlerted = false;
    this.lastPrune = 0;
    this.lastIpCheck = 0;
    this.latest = null;
    this.timer = null;
    this.busy = false;
  }

  get cfg() { return this.ctx.config.monitor; }

  start() {
    this.startupReport();
    const interval = Math.max(5, Number(this.cfg.intervalSec) || 30) * 1000;
    this.timer = setInterval(() => this.check().catch(() => {}), interval);
    setTimeout(() => this.check().catch(() => {}), 3000);
  }

  stop() { clearInterval(this.timer); }

  startupReport() {
    const db = this.ctx.db;
    const lastHb = db.getSetting('lastHeartbeat');
    const lastPower = db.getSetting('lastPowerAction');
    const boot = Date.now() / 1000 - os.uptime();
    db.setSetting('lastPowerAction', null);
    db.setSetting('lastHeartbeat', Date.now() / 1000);
    if (!this.cfg.notifyStart) return;
    const lines = [];
    if (lastHb && boot > lastHb) {
      lines.push('🟢 <b>Компьютер включён</b>');
      lines.push(`Загрузка системы: ${info.fmtDate(boot)}`);
      lines.push(`Был не в сети: ${info.fmtDate(lastHb)} → ${info.fmtDate(boot)} (${info.fmtDuration(boot - lastHb)})`);
      if (lastPower && lastPower.ts >= lastHb - 120 && POWER_TITLES[lastPower.action]) {
        lines.push(`Перед этим ПК был ${POWER_TITLES[lastPower.action]}.`);
      }
    } else if (lastHb) {
      lines.push('🔄 <b>PC Full Control перезапущен</b>');
      lines.push(`ПК работает ${info.fmtDuration(os.uptime())}`);
    } else {
      lines.push('🎉 <b>PC Full Control установлен и запущен</b>');
    }
    const ips = info.localIps();
    if (ips.length) lines.push(`🌐 Локальный IP: ${E(ips.join(', '))}`);
    this.ctx.notifier.notify(lines.join('\n'), { category: 'startup' });
  }

  alert(key, text, level = 'warning', cooldown = true) {
    const now = Date.now();
    const cd = (Number(this.cfg.cooldownMin) || 30) * 60000;
    if (cooldown && now - (this.lastAlert[key] || 0) < cd) return;
    this.lastAlert[key] = now;
    this.ctx.notifier.notify(text, { category: 'alert', level });
  }

  async topProcesses(sort) {
    try {
      const top = await listProcesses({ sort, limit: 3 });
      return 'Топ процессов:\n' + top.map((p) => `• ${E(p.name)} — CPU ${p.cpu}%, RAM ${info.fmtBytes(p.mem)}`).join('\n');
    } catch (e) {
      return '';
    }
  }

  async check() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this._check();
    } finally {
      this.busy = false;
    }
  }

  async _check() {
    const cfg = this.cfg;
    const db = this.ctx.db;
    const now = Date.now();
    const load = await si.currentLoad().catch(() => ({ currentLoad: 0 }));
    const mem = await si.mem().catch(() => ({ total: os.totalmem(), available: os.freemem() }));
    const disks = await info.disks();
    const temp = await info.cpuTemperature();
    const cpu = Math.round(load.currentLoad || 0);
    const ram = Math.round(((mem.total - mem.available) / mem.total) * 100);
    const mainDisk = disks.length ? disks.reduce((a, b) => (b.total > a.total ? b : a)).percent : 0;
    db.addMetrics(cpu, ram, mainDisk, temp);
    db.setSetting('lastHeartbeat', now / 1000);
    this.latest = { cpu, ram, temp, disk: mainDisk, ts: now / 1000 };
    this.ctx.emit('metrics', this.latest);

    // CPU
    if (cpu >= cfg.cpuPercent) {
      this.cpuHigh += 1;
      if (this.cpuHigh >= cfg.cpuChecks) this.alert('cpu', `🔥 <b>Высокая загрузка CPU: ${cpu}%</b>\n${await this.topProcesses('cpu')}`);
    } else {
      this.cpuHigh = 0;
    }
    // RAM
    if (ram >= cfg.ramPercent) {
      this.alert('ram', `🧠 <b>Мало памяти: занято ${ram}%</b> (${info.fmtBytes(mem.available)} свободно)\n${await this.topProcesses('mem')}`);
    }
    // Диски
    for (const d of disks) {
      const freePct = 100 - d.percent;
      if (freePct <= cfg.diskFreePercent) {
        this.alert(`disk:${d.mount}`, `💽 <b>Заканчивается место на ${E(d.mount)}</b>: свободно ${info.fmtBytes(d.free)} (${Math.round(freePct)}%)`);
      }
    }
    // Температура
    if (temp !== null && temp >= cfg.tempCelsius) {
      this.alert('temp', `🌡 <b>Высокая температура CPU: ${Math.round(temp)}°C</b>`, 'critical');
    }
    // Батарея
    const bat = await info.battery();
    if (bat) {
      if (this.prevPlugged !== null && bat.plugged !== this.prevPlugged && cfg.notifyPower) {
        this.ctx.notifier.notify(bat.plugged ? '🔌 Зарядка подключена' : `🔋 Работа от батареи (${bat.percent}%)`, { category: 'power' });
      }
      this.prevPlugged = bat.plugged;
      if (!bat.plugged && bat.percent <= cfg.batteryLowPercent) {
        if (!this.batteryAlerted) {
          this.alert('battery', `🪫 <b>Низкий заряд батареи: ${bat.percent}%</b>`, 'critical', false);
          this.batteryAlerted = true;
        }
      } else {
        this.batteryAlerted = false;
      }
    }
    // Вход пользователей
    if (cfg.notifyLogin) {
      const users = new Set(await info.users());
      if (this.prevUsers) {
        for (const u of users) if (!this.prevUsers.has(u)) this.ctx.notifier.notify(`👤 Вход в систему: <b>${E(u)}</b>`, { category: 'login', level: 'warning' });
        for (const u of this.prevUsers) if (!users.has(u)) this.ctx.notifier.notify(`👋 Выход из системы: ${E(u)}`, { category: 'login' });
      }
      this.prevUsers = users;
    }
    // Смена сети
    if (cfg.notifyIp && now - this.lastIpCheck > 120000) {
      this.lastIpCheck = now;
      const ips = info.localIps().sort().join(', ');
      if (this.prevIps !== null && ips !== this.prevIps) {
        this.ctx.notifier.notify(`🌐 Сеть изменилась\nБыло: ${E(this.prevIps || 'нет сети')}\nСтало: ${E(ips || 'нет сети')}`, { category: 'network' });
      }
      this.prevIps = ips;
    }
    // Отслеживаемые процессы
    const watch = (cfg.watchProcesses || []).map((w) => String(w).toLowerCase().replace(/\.exe$/, '')).filter(Boolean);
    if (watch.length) {
      const procs = await si.processes().catch(() => ({ list: [] }));
      const running = new Set();
      for (const p of procs.list) {
        const n = (p.name || '').toLowerCase().replace(/\.exe$/, '');
        if (watch.includes(n)) running.add(n);
      }
      if (this.prevWatched) {
        for (const n of running) if (!this.prevWatched.has(n)) this.ctx.notifier.notify(`▶️ Запущен процесс: <b>${E(n)}</b>`, { category: 'process' });
        for (const n of this.prevWatched) if (!running.has(n)) this.ctx.notifier.notify(`⏹ Закрыт процесс: <b>${E(n)}</b>`, { category: 'process' });
      }
      this.prevWatched = running;
    }
    // Очистка старых данных раз в час
    if (now - this.lastPrune > 3600e3) {
      this.lastPrune = now;
      db.prune(Number(cfg.retentionDays) || 7);
    }
  }
}

module.exports = { Monitor };
