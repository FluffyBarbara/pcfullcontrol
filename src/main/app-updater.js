'use strict';
// Обновление программы прямо из неё: electron-updater скачивает новую версию из релизов GitHub
// (с проверкой контрольной суммы), устанавливает её тихо и сразу запускает новую версию.
const fs = require('fs');
const path = require('path');
const { E } = require('./telegram-api');
const fastDownload = require('./fast-download');
const { differential, fetchBlockmap } = require('./diff-download');

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
      if (!dir) return;
      const f = path.join(dir, 'update.log');
      // Журнал не растёт бесконечно: больше 2 МБ — старая часть уходит в update.old.log
      try { if (fs.statSync(f).size > 2 * 1024 * 1024) fs.renameSync(f, path.join(dir, 'update.old.log')); } catch (e) { /* файла ещё нет */ }
      fs.appendFileSync(f, `${new Date().toISOString()} [${level}] ${msg}\n`);
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
    // Описания всех версий новее установленной, а не только последней
    autoUpdater.fullChangelog = true;
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
    this.lastUpdateInfo = (r && r.updateInfo) || null;
    const latest = r && r.updateInfo ? r.updateInfo.version : null;
    const hasUpdate = !!latest && cmpVersions(latest, current) > 0;
    const info = { current, latest, hasUpdate, notes: parseNotes(r && r.updateInfo && r.updateInfo.releaseNotes), checkedAt: Date.now(), releaseDate: (r && r.updateInfo && r.updateInfo.releaseDate) || null };
    this.ctx.updateInfo = info;
    if (!busy) this.setState({ status: hasUpdate ? 'available' : 'latest', latest });
    return info;
  }

  /** «Обновить PC Full Control»: сразу отвечает, есть ли новая версия; скачивание и установка идут в фоне. */
  async startUpdate({ silent = false } = {}) {
    this.silent = silent;
    const s = this.state.status;
    if (s === 'downloading') return `Обновление до ${this.state.latest} уже скачивается (${this.state.percent}%).`;
    if (s === 'downloaded' || s === 'installing') return `Обновление до ${this.state.latest} устанавливается — программа скоро перезапустится.`;
    const c = await this.check();
    if (!c.hasUpdate) return c.latest ? `У вас последняя версия — ${c.current}. Обновлений нет.` : `Обновлений нет (${c.message || 'релизы не найдены'}).`;
    this.setState({ status: 'downloading', latest: c.latest, percent: 0, error: '', diff: false });
    if (!silent) this.ctx.notifier.notify(`⬇️ Скачиваю PC Full Control <b>${E(c.latest)}</b>…`, { category: 'update' });
    this.download(c.latest).catch((e) => this.fail(e));
    return `Найдена версия ${c.latest} (у вас ${c.current}). Скачиваю — после загрузки программа сама установит обновление и откроется уже новой версией.`;
  }

  /**
   * Сначала — быстрая загрузка в 8 соединений прямо в папку, откуда electron-updater берёт готовое обновление
   * (он сам ещё раз сверит контрольную сумму). Не получилось — обычная загрузка одним соединением.
   */
  async download(version) {
    const u = this.get();
    try {
      await this.fastDownload(u, version);
    } catch (e) {
      this.log('warn', `быстрая загрузка не удалась: ${e.message} — качаю обычным способом`);
    }
    await u.downloadUpdate();
  }

  async fastDownload(u, version) {
    const info = this.lastUpdateInfo;
    const file = info && (info.files || []).find((f) => /\.exe$/i.test(f.url));
    if (!file || !file.sha512) throw new Error('нет сведений о файле обновления');
    const helper = await u.getOrCreateDownloadHelper();
    const dir = helper.cacheDirForPendingUpdate;
    const name = path.basename(String(file.url).split('?')[0]);
    let url = file.url;
    const feed = process.env.PCFC_UPDATE_FEED;
    const cfg = feed ? null : await u.configOnDisk.value;
    const rel = (tag) => (feed ? feed.replace(/\/+$/, '') : `https://github.com/${cfg.owner}/${cfg.repo}/releases/download/${tag}`);
    // Исправления x.y.1, x.y.2… публикуются в релиз vx.y.0 — берём папку того релиза, где лежит обновление
    const tag = info.tag || `v${version}`;
    if (!/^https?:/i.test(url)) url = `${rel(tag)}/${encodeURIComponent(name)}`;
    const newMaps = [`${rel(tag)}/PCFullControl-Setup-${version}.blockmap`, `${rel(tag)}/${encodeURIComponent(name)}.blockmap`];
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `fast-${name}`);
    const target = path.join(dir, name);
    const finish = (blockmap) => {
      fs.rmSync(target, { force: true });
      fs.renameSync(tmp, target);
      fs.writeFileSync(path.join(dir, 'update-info.json'), JSON.stringify({ fileName: name, sha512: file.sha512, isAdminRightsRequired: false }));
      // Карта блоков этой версии понадобится для следующего обновления по разнице
      if (blockmap) { try { fs.writeFileSync(target + '.blockmap', blockmap); } catch (e) { /* не страшно */ } }
    };
    // 1) Только изменения: нужен установщик текущей версии, сохранённый после прошлого обновления
    const base = this.baseInstaller();
    if (base && !feed) {
      const t0 = Date.now();
      try {
        const cur = this.ctx.version;
        const [mj, mn] = cur.split('.');
        let oldBlockmap = null;
        try { oldBlockmap = fs.readFileSync(base + '.blockmap'); } catch (e) { /* возьмём из релиза */ }
        this.log('info', `обновление по разнице: ${cur} → ${version}`);
        const r = await differential({
          url, oldFile: base, dest: tmp, sha512: file.sha512, size: Number(file.size) || 0, connections: 6, oldBlockmap,
          oldBlockmapUrl: [`${rel(`v${mj}.${mn}.0`)}/PCFullControl-Setup-${cur}.blockmap`, `${rel(`v${cur}`)}/${encodeURIComponent(name)}.blockmap`],
          newBlockmapUrl: newMaps,
          log: (m) => this.log('info', m),
          onProgress: (p) => this.setState({ status: 'downloading', diff: true, percent: Math.min(99, Math.floor(p.percent)), transferred: p.transferred, total: p.total, speed: p.speed }),
        });
        finish(r.blockmap);
        this.log('info', `скачано только ${(r.downloaded / 1048576).toFixed(1)} МБ из ${(r.total / 1048576).toFixed(1)} МБ за ${((Date.now() - t0) / 1000).toFixed(1)} с, контрольная сумма совпала`);
        return;
      } catch (e) {
        try { fs.rmSync(tmp, { force: true }); } catch (er) { /* ignore */ }
        this.log('warn', `по разнице не получилось (${e.message}) — качаю целиком`);
      }
    }
    const started = Date.now();
    this.log('info', `быстрая загрузка ${url} в 8 соединений`);
    try {
      const r = await fastDownload.download(url, tmp, {
        sha512: file.sha512, size: Number(file.size) || 0, connections: 8, log: (m) => this.log('info', m),
        onProgress: (p) => this.setState({ status: 'downloading', percent: Math.min(99, Math.floor(p.percent)), transferred: p.transferred, total: p.total, speed: p.speed }),
      });
      let bm = null;
      if (!feed) { try { bm = (await fetchBlockmap(newMaps)).buf; } catch (e) { /* без карты — следующее обновление скачается целиком */ } }
      finish(bm);
      const sec = (Date.now() - started) / 1000;
      this.log('info', `скачано ${r.total} байт за ${sec.toFixed(1)} с (${(r.total / sec / 1048576).toFixed(1)} МБ/с), контрольная сумма совпала`);
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch (er) { /* ignore */ }
      throw e;
    }
  }

  /** Установщик текущей версии (сохраняется после обновления) — основа для загрузки «по разнице». */
  baseInstaller() {
    if (!this.ctx.dataDir) return null;
    const f = path.join(this.ctx.dataDir, 'updates', 'base-installer.exe');
    try {
      const meta = JSON.parse(fs.readFileSync(f + '.json', 'utf8'));
      return meta.version === this.ctx.version && fs.existsSync(f) ? f : null;
    } catch (e) { return null; }
  }

  async install(version) {
    this.setState({ status: 'installing' });
    this.log('info', `Устанавливаю ${version}`);
    this.ctx.db.setSetting('updateInProgress', { from: this.ctx.version, to: version, ts: Date.now() / 1000 });
    if (!this.silent) this.ctx.notifier.notify(`🔄 Устанавливаю PC Full Control <b>${E(version)}</b> — программа перезапустится через минуту.`, { category: 'update' });
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
function parseOne(raw) {
  let s = String(raw || '');
  // В ленте GitHub описание бывает экранированным HTML (&lt;li&gt;…)
  if (/&lt;(li|h\d|p|ul)/i.test(s)) s = s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  const cut = s.search(/(<h\d[^>]*>|#+\s*)Скачать/i);
  if (cut >= 0) s = s.slice(0, cut);
  const decode = (t) => t.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
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
  return { title, items: items.filter(Boolean).slice(0, 15) };
}

/**
 * Описание релизов (HTML или Markdown, одно или по версиям) → { title, items, versions: [{version, title, items}] }.
 * Раздел «Скачать» отбрасывается.
 */
function parseNotes(raw) {
  if (Array.isArray(raw)) {
    const versions = raw.map((n) => ({ version: String((n && n.version) || ''), ...parseOne(n && n.note) }))
      .filter((v) => v.items.length || v.title)
      .sort((a, b) => cmpVersions(b.version, a.version));
    const top = versions[0] || { title: '', items: [] };
    return { title: top.title, items: versions.flatMap((v) => v.items).slice(0, 30), versions };
  }
  const one = parseOne(raw);
  return { ...one, versions: [] };
}

module.exports = { AppUpdater, cmpVersions, humanError, parseNotes };
