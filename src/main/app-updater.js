'use strict';
// Обновление программы прямо из неё: electron-updater скачивает новую версию из релизов GitHub
// (с проверкой контрольной суммы), устанавливает её тихо и сразу запускает новую версию.
const fs = require('fs');
const path = require('path');
const { E } = require('./telegram-api');

function cmpVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
}

function humanError(e) {
  const msg = String((e && e.message) || e || '');
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|net::ERR|getaddrinfo/i.test(msg)) return 'нет связи с GitHub';
  if (/sha512|checksum/i.test(msg)) return 'файл обновления повреждён, попробуйте ещё раз';
  if (/404/.test(msg)) return 'файл обновления не найден в релизе';
  if (/403|rate limit/i.test(msg)) return 'GitHub временно ограничил число проверок, попробуйте через час';
  return msg.split('\n')[0].slice(0, 200) || 'неизвестная ошибка';
}

class AppUpdater {
  constructor(ctx) {
    this.ctx = ctx;
    this.updater = null;
    this.state = { status: 'idle', current: ctx.version, latest: null, percent: 0, transferred: 0, total: 0, speed: 0, error: '' };
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.ctx.emit('update-state', this.state);
  }

  log(level, msg) {
    try {
      const dir = this.ctx.dataDir;
      if (dir) fs.appendFileSync(path.join(dir, 'update.log'), `${new Date().toISOString()} [${level}] ${msg}\n`);
    } catch (e) { /* ignore */ }
  }

  /** electron-updater работает только в установленной программе (не при запуске из исходников). */
  get() {
    if (this.updater) return this.updater;
    let autoUpdater;
    try {
      ({ autoUpdater } = require('electron-updater'));
    } catch (e) {
      return null;
    }
    if (!autoUpdater || !autoUpdater.isUpdaterActive()) return null;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.disableDifferentialDownload = true;
    autoUpdater.logger = {
      info: (m) => this.log('info', m), warn: (m) => this.log('warn', m),
      error: (m) => this.log('error', m), debug: () => {},
    };
    // Для автоматических проверок (e2e): свой адрес с обновлениями
    if (process.env.PCFC_UPDATE_FEED) autoUpdater.setFeedURL({ provider: 'generic', url: process.env.PCFC_UPDATE_FEED });

    autoUpdater.on('download-progress', (p) => {
      this.setState({ status: 'downloading', percent: Math.round(p.percent || 0), transferred: p.transferred, total: p.total, speed: p.bytesPerSecond });
    });
    autoUpdater.on('update-downloaded', (info) => {
      this.setState({ status: 'downloaded', percent: 100 });
      this.install(info.version).catch((e) => this.fail(e));
    });
    autoUpdater.on('error', (e) => {
      if (['downloading', 'downloaded', 'installing', 'checking'].includes(this.state.status)) this.fail(e);
    });
    this.updater = autoUpdater;
    return autoUpdater;
  }

  fail(e) {
    const msg = humanError(e);
    this.log('error', msg);
    const wasUpdating = ['downloading', 'downloaded', 'installing'].includes(this.state.status);
    this.setState({ status: 'error', error: msg });
    if (wasUpdating) this.ctx.notifier.notify(`❌ Обновление не удалось: ${E(msg)}`, { category: 'update', level: 'warning' });
  }

  async check() {
    const current = this.ctx.version;
    const u = this.get();
    if (!u) {
      const info = { current, latest: null, hasUpdate: false, message: 'Обновление работает только в установленной программе' };
      this.ctx.updateInfo = info;
      return info;
    }
    const busy = ['downloading', 'downloaded', 'installing'].includes(this.state.status);
    if (!busy) this.setState({ status: 'checking', error: '' });
    let r;
    try {
      r = await u.checkForUpdates();
    } catch (e) {
      if (!busy) this.setState({ status: 'error', error: humanError(e) });
      throw new Error(humanError(e));
    }
    const latest = r && r.updateInfo ? r.updateInfo.version : null;
    const hasUpdate = !!latest && cmpVersions(latest, current) > 0;
    const info = { current, latest, hasUpdate, notes: parseNotes(r && r.updateInfo && r.updateInfo.releaseNotes), checkedAt: Date.now() };
    this.ctx.updateInfo = info;
    if (!busy) this.setState({ status: hasUpdate ? 'available' : 'latest', latest });
    return info;
  }

  /** «Обновить PC Full Control»: сразу отвечает, есть ли новая версия; скачивание и установка идут в фоне. */
  async startUpdate() {
    const s = this.state.status;
    if (s === 'downloading') return `Обновление до ${this.state.latest} уже скачивается (${this.state.percent}%).`;
    if (s === 'downloaded' || s === 'installing') return `Обновление до ${this.state.latest} устанавливается — программа скоро перезапустится.`;
    const c = await this.check();
    if (!c.hasUpdate) return c.latest ? `У вас последняя версия — ${c.current}. Обновлений нет.` : `Обновлений нет (${c.message || 'релизы не найдены'}).`;
    this.setState({ status: 'downloading', latest: c.latest, percent: 0, error: '' });
    this.ctx.notifier.notify(`⬇️ Скачиваю PC Full Control <b>${E(c.latest)}</b>…`, { category: 'update' });
    this.get().downloadUpdate().catch((e) => this.fail(e));
    return `Найдена версия ${c.latest} (у вас ${c.current}). Скачиваю — после загрузки программа сама установит обновление и откроется уже новой версией.`;
  }

  async install(version) {
    this.setState({ status: 'installing' });
    this.log('info', `Устанавливаю ${version}`);
    this.ctx.db.setSetting('updateInProgress', { from: this.ctx.version, to: version, ts: Date.now() / 1000 });
    this.ctx.notifier.notify(`🔄 Устанавливаю PC Full Control <b>${E(version)}</b> — программа перезапустится через минуту.`, { category: 'update' });
    await this.ctx.notifier.flush(5000);
    this.ctx.prepareForUpdate();
    // Тихая установка (/S) и запуск новой версии после неё (--force-run)
    this.get().quitAndInstall(true, true);
  }
}

/**
 * Описание релиза с GitHub (HTML или Markdown) → заголовок и список изменений для окна «Доступно обновление».
 * Раздел «Скачать» отбрасывается.
 */
function parseNotes(raw) {
  if (Array.isArray(raw)) raw = raw.map((n) => (n && n.note) || '').join('\n');
  let s = String(raw || '');
  const cut = s.search(/(<h\d[^>]*>|#+\s*)Скачать/i);
  if (cut >= 0) s = s.slice(0, cut);
  const decode = (t) => t.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  let title = '';
  const items = [];
  const h = /<h\d[^>]*>([\s\S]*?)<\/h\d>/i.exec(s) || /^#+\s*(.+)$/m.exec(s);
  if (h) title = decode(h[1]);
  const li = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = li.exec(s))) items.push(decode(m[1]));
  if (!items.length) {
    for (const line of s.split(/\r?\n/)) {
      const mm = /^\s*[-*•]\s+(.+)$/.exec(line);
      if (mm) items.push(decode(mm[1]));
    }
  }
  return { title, items: items.filter(Boolean).slice(0, 12) };
}

module.exports = { AppUpdater, cmpVersions, humanError, parseNotes };
