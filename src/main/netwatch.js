'use strict';
// Наблюдение за сетью: обрывы интернета (с уведомлением, когда связь вернулась),
// замеры скорости, новые устройства в домашней сети.
const net = require('./system/network');
const { primaryInterface } = require('./system/poweron');
const { E } = require('./telegram-api');

const fmtDur = (sec) => {
  sec = Math.round(sec);
  if (sec < 60) return `${sec} с`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} мин ${sec % 60 ? (sec % 60) + ' с' : ''}`.trim();
  return `${Math.floor(m / 60)} ч ${m % 60} мин`;
};
const clock = (ts) => new Date(ts * 1000).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

class NetWatch {
  constructor(ctx) {
    this.ctx = ctx;
    this.online = null;
    this.latency = null;
    this.downSince = null;
    this.fails = 0;
    this.timer = null;
    this.scanTimer = null;
    this.speedBusy = false;
    this.scanBusy = false;
    this.lastScan = null;
    this.speedProgress = null;
  }

  get cfg() { return this.ctx.config.network; }

  start() {
    this.timer = setInterval(() => this.tick().catch(() => {}), 30000);
    setTimeout(() => this.tick().catch(() => {}), 5000);
    this.scanTimer = setInterval(() => { if (this.cfg.watchDevices) this.scan(true).catch(() => {}); }, 15 * 60 * 1000);
    setTimeout(() => { if (this.cfg.watchDevices) this.scan(true).catch(() => {}); }, 90000);
  }

  stop() { clearInterval(this.timer); clearInterval(this.scanTimer); }

  async tick() {
    if (!this.cfg.watchInternet) return;
    const r = await net.checkInternet();
    if (r.online) {
      this.latency = r.ms;
      this.fails = 0;
      if (this.downSince) {
        const end = Date.now() / 1000;
        const dur = end - this.downSince;
        this.ctx.db.addOutage(this.downSince, end);
        this.ctx.db.addEvent('warning', 'network', `Интернет пропадал на ${fmtDur(dur)}`);
        this.ctx.notifier.notify(`📶 <b>Интернет вернулся</b>\nНе было связи ${fmtDur(dur)} (с ${clock(this.downSince)} до ${clock(end)}).`, { category: 'network', level: 'warning' });
        this.downSince = null;
      }
      this.online = true;
    } else {
      // Обрыв засчитываем после двух неудачных проверок подряд (≈1 минута)
      this.fails++;
      if (this.fails >= 2 && !this.downSince) this.downSince = Date.now() / 1000 - 30;
      if (this.fails >= 2) this.online = false;
    }
  }

  status() {
    const since = Date.now() / 1000 - 7 * 86400;
    return {
      online: this.online, latency: this.latency, downSince: this.downSince,
      outages: this.ctx.db.outagesSince(since).slice(0, 20),
      lastSpeed: this.ctx.db.lastSpeedtest() || null,
      speedBusy: this.speedBusy, speedProgress: this.speedProgress,
      devices: this.devices(), lastScan: this.lastScan, scanBusy: this.scanBusy,
    };
  }

  async speedTest() {
    if (this.speedBusy) throw new Error('Замер уже идёт');
    this.speedBusy = true;
    this.speedProgress = { stage: 'ping' };
    try {
      const r = await net.speedTest({ onProgress: (p) => { this.speedProgress = p; this.ctx.emit('net-progress', p); } });
      this.ctx.db.addSpeedtest(r);
      return r;
    } finally {
      this.speedBusy = false;
      this.speedProgress = null;
    }
  }

  devices() {
    return this.ctx.db.netDevices().map((d) => ({ ...d, online: this.lastScan ? d.last_seen >= this.lastScan - 5 : false }));
  }

  /** Поиск устройств в домашней сети. quiet — автоматический (уведомляет только о новых). */
  async scan(quiet = false) {
    if (this.scanBusy) return this.devices();
    this.scanBusy = true;
    try {
      const iface = primaryInterface();
      const found = await net.scanDevices(iface);
      const firstEver = this.ctx.db.netDevices().length === 0;
      const fresh = [];
      for (const d of found) if (this.ctx.db.upsertNetDevice(d) && !d.self) fresh.push(d);
      this.lastScan = Date.now() / 1000;
      if (fresh.length && !firstEver && this.cfg.watchDevices) {
        const lines = fresh.slice(0, 5).map((d) => `• ${E(d.name || d.vendor || 'Неизвестное устройство')} — ${E(d.ip)} (${E(d.mac)})`);
        this.ctx.notifier.notify(`📡 <b>Новое устройство в домашней сети</b>\n${lines.join('\n')}`, { category: 'network', level: 'warning' });
        this.ctx.db.addEvent('warning', 'network', `Новые устройства в сети: ${fresh.length}`);
      }
      return this.devices();
    } finally {
      this.scanBusy = false;
    }
  }
}

module.exports = { NetWatch };
