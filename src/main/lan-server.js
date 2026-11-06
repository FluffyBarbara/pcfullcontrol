'use strict';
// Сервер для приложения на телефоне (работает в домашней сети Wi-Fi).
// Раздаёт мобильное приложение (PWA) и HTTP API. Доступ — только для привязанных телефонов (токен).
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const info = require('./system/info');
const poweron = require('./system/poweron');
const processes = require('./system/processes');
const screen = require('./system/screen');
const media = require('./system/media');
const { FileAccessError, TELEGRAM_UPLOAD_LIMIT } = require('./system/files');
const { E } = require('./telegram-api');
const { ScreenStream } = require('./stream');

const MOBILE_DIR = path.join(__dirname, '..', 'mobile');
const SHARED_DIR = path.join(__dirname, '..', 'shared');
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_JSON = 1024 * 1024;
const MAX_UPLOAD = 4 * 1024 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.mp4': 'video/mp4', '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
  '.opus': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.webm': 'video/webm',
  '.m4v': 'video/mp4', '.mov': 'video/quicktime',
};

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** Адреса ПК в локальной сети: сначала домашние сети, без виртуальных адаптеров. */
function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (/virtual|vmware|vbox|hyper-v|vethernet|wsl|docker|loopback|bluetooth/i.test(name)) continue;
    for (const a of addrs || []) {
      if (!(a.family === 'IPv4' || a.family === 4) || a.internal || a.address.startsWith('169.254.')) continue;
      const rank = a.address.startsWith('192.168.') ? 0 : a.address.startsWith('10.') ? 1
        : /^172\.(1[6-9]|2\d|3[01])\./.test(a.address) ? 2 : a.address.startsWith('100.') ? 3 : 4;
      out.push({ address: a.address, iface: name, rank });
    }
  }
  return out.sort((a, b) => a.rank - b.rank).map((a) => a.address);
}

class LanServer {
  constructor(ctx) {
    this.ctx = ctx;
    this.server = null;
    this.status = 'stopped';   // stopped | running | error
    this.error = '';
    this.code = null;
    this.codeExpires = 0;
    this.failed = new Map();   // ip -> [время неудачных попыток]
    this.tickets = new Map();  // одноразовые ссылки для плеера: ticket -> { path, expires }
  }

  get port() {
    if (this.server && this.server.listening) return this.server.address().port;
    const p = Number(this.ctx.config.mobile.port);
    return Number.isInteger(p) && p >= 0 ? p : 8765;
  }

  // ---------------- запуск ----------------
  start() {
    this.stop();
    if (!this.ctx.config.mobile.enabled) return Promise.resolve();
    this.server = http.createServer((req, res) => this.handle(req, res));
    // Туннель Cloudflare держит соединение с программой до 90 с. Если программа закроет его раньше,
    // запрос, пришедший в этот момент, обрывается и Cloudflare показывает «502 Bad gateway».
    this.server.keepAliveTimeout = 120 * 1000;
    this.server.headersTimeout = 125 * 1000;
    // Видеопоток экрана через WebSocket (работает и через туннель из интернета)
    this.server.on('error', (e) => {
      this.status = 'error';
      this.error = e.code === 'EADDRINUSE' ? `Порт ${this.port} занят другой программой` : e.message;
      this.ctx.emit('event');
    });
    return new Promise((resolve) => {
      this.server.once('error', () => resolve());
      this.server.listen(this.port, '0.0.0.0', () => {
        this.status = 'running';
        this.error = '';
        this.ctx.emit('event');
        resolve();
      });
    });
  }

  stop() {
    if (this.server) this.server.close();
    this.server = null;
    this.status = 'stopped';
  }

  // ---------------- привязка ----------------
  pairCode(regenerate = false) {
    // Только для автоматических проверок: фиксированный код из переменной окружения
    if (process.env.PCFC_TEST_PAIR_CODE) return { code: process.env.PCFC_TEST_PAIR_CODE, expires: Date.now() + CODE_TTL_MS };
    if (regenerate || !this.code || Date.now() > this.codeExpires) {
      this.code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      this.codeExpires = Date.now() + CODE_TTL_MS;
    }
    return { code: this.code, expires: this.codeExpires };
  }

  pairInfo() {
    const { code, expires } = this.pairCode();
    const ips = lanAddresses();
    const urls = ips.map((ip) => `http://${ip}:${this.port}`);
    return {
      status: this.status, error: this.error, port: this.port, code, expires, addresses: urls,
      pairUrl: urls[0] ? `${urls[0]}/#/pair/${code}` : null,
    };
  }

  checkPairAttempts(ip) {
    const recent = (this.failed.get(ip) || []).filter((t) => Date.now() - t < 10 * 60 * 1000);
    this.failed.set(ip, recent);
    if (recent.length >= 5) throw new HttpError(429, 'Слишком много неверных попыток. Подождите 10 минут.');
  }

  pair(body, ip) {
    this.checkPairAttempts(ip);
    const given = Buffer.from(String(body.code || '').trim());
    const { code } = this.pairCode();
    const ok = given.length === code.length && crypto.timingSafeEqual(given, Buffer.from(code));
    if (!ok) {
      this.failed.get(ip).push(Date.now());
      throw new HttpError(403, 'Неверный или устаревший код. Посмотрите новый код в программе на ПК.');
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const name = String(body.name || 'Телефон').slice(0, 60);
    const platform = String(body.platform || '').slice(0, 20);
    this.ctx.db.addDevice(name, platform, sha256(token), ip);
    this.pairCode(true);
    this.ctx.notifier.notify(`📱 Привязан телефон с приложением: <b>${E(name)}</b> (${E(ip)})`, { category: 'security', level: 'warning' });
    this.ctx.emit('event');
    return { token, pcName: this.ctx.pcName, version: this.ctx.version };
  }

  /** Ключ виджета для телефона (один на телефон; новый заменяет старый). */
  widgetKey(device) {
    const key = crypto.randomBytes(24).toString('base64url');
    const list = (this.ctx.db.getSetting('widgetKeys') || []).filter((w) => w.deviceId !== device.id);
    list.push({ hash: sha256(key), deviceId: device.id, created: Date.now() / 1000 });
    this.ctx.db.setSetting('widgetKeys', list);
    return { key, pcName: this.ctx.pcName };
  }

  widgetDevice(key) {
    if (!key) throw new HttpError(401, 'Нужен ключ виджета');
    const h = sha256(String(key));
    const w = (this.ctx.db.getSetting('widgetKeys') || []).find((x) => x.hash === h);
    const dev = w && this.ctx.db.listDevices().find((d) => d.id === w.deviceId);
    if (!dev) throw new HttpError(401, 'Виджет отключён — добавьте его заново в приложении');
    return dev;
  }

  auth(req) {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!token) throw new HttpError(401, 'Требуется привязка');
    const dev = this.ctx.db.deviceByToken(sha256(token));
    if (!dev) throw new HttpError(401, 'Телефон отвязан от этого компьютера');
    if (Date.now() / 1000 - (dev.last_seen || 0) > 60) this.ctx.db.touchDevice(dev.id, clientIp(req));
    return dev;
  }

  // ---------------- обработка запросов ----------------
  async handle(req, res) {
    const url = new URL(req.url, 'http://x');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      if (!url.pathname.startsWith('/api/')) return this.serveStatic(url.pathname, req, res);
      res.setHeader('Cache-Control', 'no-store');
      // Android-приложение: голосовой ассистент записывает звук на своей странице (http://localhost)
      if (/^https?:\/\/localhost(:\d+)?$/.test(req.headers.origin || '') && /^\/api\/(assistant|widget)/.test(url.pathname)) {
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return undefined; }
      }
      const result = await this.route(req, res, url);
      if (result === undefined || res.headersSent) return undefined;
      return sendJson(res, 200, result);
    } catch (e) {
      if (res.headersSent) { res.destroy(); return undefined; }
      return sendJson(res, e.status || 500, { error: e.status ? e.message : `Внутренняя ошибка: ${e.message}` });
    }
  }

  serveStatic(pathname, req, res) {
    let rel = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
    if (rel.includes('..')) rel = 'index.html';
    let file = rel.startsWith('shared/') ? path.join(SHARED_DIR, rel.slice(7)) : path.join(MOBILE_DIR, rel);
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(MOBILE_DIR, 'index.html');
    const ext = path.extname(file).toLowerCase();
    const v = this.ctx.version;
    // ETag зависит от версии программы: после обновления телефон гарантированно получит новые файлы
    const etag = `"${v}-${fs.statSync(file).size}"`;
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ETag: etag,
      'Content-Security-Policy': "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'",
    };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return; }
    let data = fs.readFileSync(file);
    if (ext === '.html') {
      // Адреса скриптов и стилей с версией — iPhone не возьмёт старые из кэша
      data = Buffer.from(data.toString('utf8')
        .replace(/(href|src)="((?:shared\/)?[\w.-]+\.(?:js|css|webmanifest))"/g, `$1="$2?v=${v}"`)
        .replace('<head>', `<head>\n  <meta name="pcfc-version" content="${v}">`), 'utf8');
    }
    res.writeHead(200, headers);
    res.end(data);
  }

  async route(req, res, url) {
    const p = url.pathname;
    const m = req.method;
    const q = (k, d = '') => url.searchParams.get(k) ?? d;
    const ctx = this.ctx;
    const ip = clientIp(req);

    // --- без авторизации ---
    if (p === '/api/hello') {
      // Открыто для Android-приложения: проверка, что по адресу отвечает именно PC Full Control
      res.setHeader('Access-Control-Allow-Origin', '*');
      const nic = poweron.primaryInterface();
      return { app: 'pc-full-control', pcName: ctx.pcName, version: ctx.version, mac: nic ? nic.mac : null, broadcast: nic ? nic.broadcast : null };
    }
    if (p === '/api/pair' && m === 'POST') {
      return this.pair(await readJson(req), ip);
    }

    // Обложка трека (ключ — отпечаток трека, выдаётся вместе с данными о музыке)
    if (p === '/api/music/cover') {
      const c = ctx.media.cover(q('k'));
      if (!c) throw new HttpError(404, 'Нет обложки');
      res.writeHead(200, { 'Content-Type': c.type, 'Content-Length': c.buf.length, 'Cache-Control': 'private, max-age=3600' });
      res.end(c.buf);
      return undefined;
    }
    // Виджет на главном экране телефона: доступ по отдельному ключу виджета (его можно отозвать)
    if (p.startsWith('/api/widget') && p !== '/api/widget/key') {
      const wdev = this.widgetDevice(q('k'));
      if (p === '/api/widget') return ctx.widgetData();
      if (p === '/api/widget/text') {
        const w = await ctx.widgetData();
        const text = [`🖥 ${w.pcName}`, `ЦП ${w.cpu ?? '—'}%${w.cpuTemp != null ? ` · ${w.cpuTemp}°` : ''}`, `ОЗУ ${w.ram ?? '—'}%`, w.gpuTemp != null ? `Видео ${w.gpuTemp}°` : null,
          w.media ? `${w.media.playing ? '▶' : '⏸'} ${w.media.artist ? w.media.artist + ' — ' : ''}${w.media.title}` : null].filter(Boolean).join('\n');
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(text);
        return undefined;
      }
      if (p === '/api/widget/action' && m === 'POST') {
        const b = await readJson(req);
        const allowed = { shutdown: 'shutdown', sleep: 'sleep', lock: 'lock', reboot: 'reboot', play_pause: 'play_pause', next: 'next_track', prev: 'prev_track', mute: 'mute' };
        const action = allowed[String(b.action || q('action'))];
        if (!action) throw new HttpError(400, 'Неизвестное действие');
        return ctx.actions.run(action, '', 'mobile', `${wdev.name} (виджет)`);
      }
      throw new HttpError(404, 'Не найдено');
    }

    // Потоковое воспроизведение (аудио/видео на телефоне): плеер не умеет передавать токен в заголовке,
    // поэтому доступ — по временной ссылке, выданной привязанному телефону.
    let mm0 = p.match(/^\/api\/media\/([\w-]+)\//);
    if (mm0) {
      const t = this.tickets.get(mm0[1]);
      if (!t || t.expires < Date.now()) throw new HttpError(403, 'Ссылка устарела');
      return this.streamFile(req, res, t.path);
    }

    const device = this.auth(req);

    if (p === '/api/info') {
      return {
        pcName: ctx.pcName, version: ctx.version, os: await info.osDescription(),
        isWin: process.platform === 'win32', allowShell: !!ctx.config.security.allowShell,
        confirmDangerous: !!ctx.config.telegram.confirmDangerous,
        actions: ctx.actions.available().map((a) => ctx.actions.toJSON(a)),
        apps: ctx.config.apps.map((a) => a.name),
        telegram: !!(ctx.bot && ctx.bot.status === 'online' && ctx.authorizedIds().length),
        monitors: (await screen.displays().catch(() => [])).length || 1,
        device: { id: device.id, name: device.name },
        update: ctx.updateInfo ? { hasUpdate: ctx.updateInfo.hasUpdate, latest: ctx.updateInfo.latest } : null,
        remote: ctx.remote.enabled,
        wol: (() => { const n = poweron.primaryInterface(); return n ? { mac: n.mac, broadcast: n.broadcast, wifi: n.wifi } : null; })(),
        autologon: !!ctx.db.getSetting('autologonEnabled'),
      };
    }
    // --- музыка и микшер громкости ---
    if (p === '/api/net/diag' && m === 'POST') return ctx.netdiag.run();
    if (p === '/api/net/fix' && m === 'POST') {
      const b = await readJson(req);
      const map = { restart: () => ctx.netdiag.restartAdapter(), energy: () => ctx.netdiag.disableEnergySaving(), energy_restore: () => ctx.netdiag.restoreEnergySaving(),
        dns: () => ctx.netdiag.setDns(undefined, false), dns_reset: () => ctx.netdiag.setDns(undefined, true),
        autofix_on: () => { ctx.updateConfig({ network: { autoFixAdapter: true } }); return { ok: true }; }, autofix_off: () => { ctx.updateConfig({ network: { autoFixAdapter: false } }); return { ok: true }; } };
      if (!map[b.action]) throw new HttpError(400, 'Неизвестное действие');
      try { ctx.db.logCommand('mobile', device.name, 'net_fix', b.action, true, ''); return await map[b.action](); } catch (e) { throw new HttpError(400, e.message); }
    }
    if (p === '/api/music') return ctx.media.state();
    if (p === '/api/music/control' && m === 'POST') { const b = await readJson(req); try { return await ctx.media.control(b.app, String(b.action), b.value); } catch (e) { throw new HttpError(400, e.message); } }
    if (p === '/api/mixer') return ctx.media.mixer();
    if (p === '/api/mixer/peaks') return ctx.media.peaks().catch(() => ({}));
    if (p === '/api/mixer/set' && m === 'POST') { const b = await readJson(req); try { return await ctx.media.setApp(b.name, { level: b.level, mute: b.mute }); } catch (e) { throw new HttpError(400, e.message); } }
    if (p === '/api/mixer/master' && m === 'POST') { const b = await readJson(req); return ctx.media.setMaster({ level: b.level, mute: b.mute }); }
    // --- игры, температуры, сбои, USB, тревожная кнопка ---
    if (p === '/api/games') return ctx.games(Number(q('days', '7')) || 7);
    if (p === '/api/temps') return ctx.tempHistory(Math.min(24 * 14, Number(q('hours', '24')) || 24));
    if (p === '/api/crashes') return ctx.crashes.list();
    if (p === '/api/usb') return ctx.db.usbEvents(50);
    if (p === '/api/panic' && m === 'GET') return ctx.panic.state();
    if (p === '/api/panic' && m === 'POST') {
      const b = await readJson(req);
      try { return b.on === false ? await ctx.panic.release(device.name) : await ctx.panic.trigger(device.name); } catch (e) { throw new HttpError(400, e.message); }
    }
    // --- место на диске ---
    if (p === '/api/space/roots') return (await info.disks()).map((d) => ({ mount: d.mount, total: d.total, free: d.free, percent: d.percent }));
    if (p === '/api/space' && m === 'GET') return ctx.space.view({ dir: q('dir') || null, topLimit: 60, dupLimit: 60 });
    if (p === '/api/space/start' && m === 'POST') { const b = await readJson(req); try { return ctx.space.start(b.root, { dups: b.dups !== false }); } catch (e) { throw new HttpError(400, e.message); } }
    if (p === '/api/space/cancel' && m === 'POST') return ctx.space.cancel();
    if (p === '/api/space/delete' && m === 'POST') { const b = await readJson(req); try { return await ctx.space.remove(b.paths, !!b.permanent, 'mobile', device.name); } catch (e) { throw new HttpError(400, e.message); } }
    // --- голосовой ассистент ---
    if (p === '/api/assistant' && m === 'POST') { const b = await readJson(req); return ctx.assistant.handle(b.text, { source: 'mobile', user: device.name, confirm: !!b.confirm }); }
    if (p === '/api/assistant/audio' && m === 'POST') {
      const buf = await readRaw(req, 8 * 1024 * 1024);
      if (buf.length < 1000) throw new HttpError(400, 'Запись слишком короткая');
      try { return await ctx.assistant.handleAudio(buf, { source: 'mobile', user: device.name, confirm: q('confirm') === '1' }); } catch (e) { throw new HttpError(400, e.message); }
    }
    // --- виджет: ключ для этого телефона ---
    if (p === '/api/widget/key' && m === 'POST') return this.widgetKey(device);
    if (p === '/api/update/state') return ctx.appUpdater.state;
    if (p === '/api/update/check') {
      let u = ctx.updateInfo;
      // Свежий результат (до 5 минут) не перепроверяем — телефон спрашивает при каждом открытии
      if (!u || !u.checkedAt || q('force') === '1' || Date.now() - u.checkedAt > 5 * 60 * 1000) {
        try { u = await ctx.appUpdater.check(); } catch (e) { throw new HttpError(502, e.message); }
      }
      return { current: u.current, latest: u.latest, hasUpdate: u.hasUpdate, message: u.message || '', notes: u.notes || null };
    }
    // --- оптимизация: анализ ничего не удаляет, очистка — только выбранные категории ---
    if (p === '/api/clean/analyze') return ctx.cleaner.analyze();
    if (p === '/api/clean/run' && m === 'POST') {
      const body = await readJson(req);
      try {
        const r = await ctx.cleaner.clean(body.ids);
        const freed = r.reduce((s, x) => s + x.freed, 0);
        ctx.db.logCommand('mobile', device.name, 'cleanup', body.ids.join(', '), true, `освобождено ${(freed / 1048576).toFixed(1)} МБ`);
        return r;
      } catch (e) { throw new HttpError(400, e.message); }
    }
    // --- удаление программ ---
    if (p === '/api/apps') {
      try { return { available: ctx.apps.available, apps: await ctx.apps.list() }; } catch (e) { throw new HttpError(500, e.message); }
    }
    const am = /^\/api\/apps\/([0-9a-f]{16})\/(uninstall|job|leftovers|remove)$/.exec(p);
    if (am) {
      const [, id, op] = am;
      try {
        if (op === 'job') return ctx.apps.job(id);
        if (m !== 'POST') throw new HttpError(405, 'Нужен POST');
        const body = await readJson(req);
        if (op === 'uninstall') return await ctx.apps.uninstall(id, { quiet: !!body.quiet });
        if (op === 'leftovers') return await ctx.apps.findLeftovers(id);
        return await ctx.apps.removeLeftovers(id, body.tokens);
      } catch (e) { throw e instanceof HttpError ? e : new HttpError(400, e.message); }
    }
    if (p === '/api/status') {
      const s = await info.getStatus();
      s.volume = await media.getVolume();
      s.muted = ctx.notifier.muted;
      return s;
    }
    if (p === '/api/metrics') {
      const hours = Math.min(Math.max(Number(q('hours', '1')) || 1, 0.1), 168);
      const rows = ctx.db.metricsSince(Date.now() / 1000 - hours * 3600);
      const step = Math.max(1, Math.floor(rows.length / 200));
      return rows.filter((_, i) => i % step === 0);
    }
    let mm = p.match(/^\/api\/action\/([a-z_]+)$/);
    if (mm && m === 'POST') {
      const body = await readJson(req);
      if (!ctx.actions.get(mm[1])) throw new HttpError(404, 'Неизвестное действие');
      return ctx.actions.run(mm[1], body.arg || '', 'mobile', device.name);
    }
    mm = p.match(/^\/api\/apps\/(\d+)$/);
    if (mm && m === 'POST') {
      const app = ctx.config.apps[Number(mm[1])];
      if (!app) throw new HttpError(404, 'Программа не найдена');
      return ctx.actions.run('launch', app.cmd, 'mobile', device.name);
    }
    if (p === '/api/processes') {
      return processes.listProcesses({ sort: q('sort', 'cpu'), query: q('q'), limit: Math.min(Number(q('limit', '80')) || 80, 400) });
    }
    // --- удалённое управление ---
    if (p === '/api/remote/info') {
      ctx.remote.warm();
      return {
        enabled: ctx.remote.enabled,
        inputReady: ctx.remote.inputReady,
        rtc: true,
        presets: ScreenStream.presets(),
        displays: ctx.remote.displays().map((d) => ({ index: d.index, width: d.phys.width, height: d.phys.height, primary: d.primary })),
      };
    }
    if (p === '/api/remote/frame') {
      let fr;
      try { fr = await ctx.remote.frame(Number(q('monitor', '1')), Number(q('w', '1280')), Number(q('q', '60')), device.name); }
      catch (e) { throw new HttpError(400, e.message); }
      res.writeHead(200, {
        'Content-Type': 'image/jpeg', 'Content-Length': fr.jpeg.length, 'Cache-Control': 'no-store',
        'X-Cursor': fr.cursor ? `${fr.cursor.x.toFixed(4)},${fr.cursor.y.toFixed(4)}` : '',
      });
      res.end(fr.jpeg);
      return undefined;
    }
    if (p === '/api/remote/rtc/start' && m === 'POST') {
      const body = await readJson(req);
      try { return await ctx.stream.start(device, { monitor: Number(body.monitor) || 1, preset: String(body.preset || 'auto'), audio: body.audio !== false }); }
      catch (e) { throw new HttpError(400, e.message); }
    }
    if (p === '/api/remote/rtc/answer' && m === 'POST') {
      const body = await readJson(req);
      try { return await ctx.stream.answer(device, body.sid, body.sdp); } catch (e) { throw new HttpError(400, e.message); }
    }
    if (p === '/api/remote/rtc/stop' && m === 'POST') {
      const body = await readJson(req);
      return ctx.stream.stop(device, body.sid);
    }
    if (p === '/api/remote/input' && m === 'POST') {
      const body = await readJson(req);
      try { return await ctx.remote.input(body, Number(body.monitor) || 1); } catch (e) { throw new HttpError(400, e.message); }
    }
    if (p === '/api/screenshot') {
      const img = await screen.screenshot(Number(q('monitor', '1')) || 1, 75);
      return sendBinary(res, img, 'image/jpeg');
    }
    if (p === '/api/webcam') {
      const img = await screen.webcamPhoto();
      ctx.db.logCommand('mobile', device.name, 'webcam', '', true, 'фото');
      return sendBinary(res, img, 'image/jpeg');
    }
    if (p === '/api/files') return this.listFiles(q('path'));
    if (p === '/api/files/download') return this.download(q('path'), res, device);
    if (p === '/api/files/delete' && m === 'POST') {
      const body = await readJson(req);
      const { shell } = require('electron');
      const res2 = await ctx.files.deletePaths(body.paths, { permanent: !!body.permanent, trash: (x) => shell.trashItem(x) });
      const ok = res2.filter((r) => r.ok).length;
      ctx.db.logCommand('mobile', device.name, 'delete_files', `${ok} из ${res2.length}${body.permanent ? ' (навсегда)' : ' (в корзину)'}`, ok === res2.length, res2.filter((r) => r.ok).map((r) => r.path).slice(0, 5).join('; '));
      return res2;
    }
    // --- железо ---
    if (p === '/api/hw') {
      const only = q('only');
      return {
        gpu: only === 'disks' ? undefined : await ctx.gpu().catch(() => ({ gpus: [] })),
        disks: only === 'gpu' ? undefined : await ctx.diskHealth(q('force') === '1').catch((e) => ({ error: e.message })),
      };
    }
    // --- сеть ---
    if (p === '/api/net') return ctx.net.status();
    if (p === '/api/net/speedtest' && m === 'POST') { try { return await ctx.net.speedTest(); } catch (e) { throw new HttpError(400, e.message); } }
    if (p === '/api/net/scan' && m === 'POST') { try { return await ctx.net.scan(false); } catch (e) { throw new HttpError(400, e.message); } }
    if (p === '/api/net/label' && m === 'POST') { const b = await readJson(req); return { ok: ctx.db.labelNetDevice(String(b.mac || ''), b.label) }; }
    // --- автозагрузка ---
    if (p === '/api/startup') { try { return { available: ctx.startup.available, items: await ctx.startup.list() }; } catch (e) { throw new HttpError(500, e.message); } }
    if (p === '/api/startup/set' && m === 'POST') {
      const b = await readJson(req);
      try {
        const r = await ctx.startup.setEnabled(b.id, !!b.enabled);
        ctx.db.logCommand('mobile', device.name, 'startup', `${b.id} → ${b.enabled ? 'вкл' : 'выкл'}`, true, '');
        return r;
      } catch (e) { throw new HttpError(400, e.message); }
    }
    // Только для автоматических проверок: распознать присланный звуковой файл (как голосовое из Telegram)
    if (process.env.PCFC_TEST_HOOKS && p === '/api/test/transcribe' && m === 'POST') {
      const body = await readJson(req);
      const r = await ctx.speech.transcribe(Buffer.from(String(body.audio || ''), 'base64'));
      const { parseVoiceCommand } = require('./voice-commands');
      return { ...r, command: parseVoiceCommand(r.text) };
    }
    // --- отчёт за неделю ---
    if (p === '/api/weekly') return { text: require('./weekly').build(ctx).text };
    if (p === '/api/weekly/send' && m === 'POST') { ctx.notifier.notify(require('./weekly').build(ctx).text, { category: 'report' }); return { ok: true }; }
    if (p === '/api/files/ticket' && m === 'POST') return this.mediaTicket((await readJson(req)).path);
    if (p === '/api/files/upload' && m === 'PUT') return this.upload(req, q('name'), q('dir'), device);
    if (p === '/api/files/telegram' && m === 'POST') return this.fileToTelegram((await readJson(req)).path, device);

    if (p === '/api/tasks' && m === 'GET') return ctx.db.listTasks().map((t) => ({ ...t, description: ctx.scheduler.describe(t) }));
    if (p === '/api/tasks' && m === 'POST') return this.addTask(await readJson(req));
    mm = p.match(/^\/api\/tasks\/(\d+)(\/toggle)?$/);
    if (mm) {
      const id = Number(mm[1]);
      const t = ctx.db.getTask(id);
      if (!t) throw new HttpError(404, 'Задача не найдена');
      if (mm[2] && m === 'POST') { ctx.db.setTaskEnabled(id, !t.enabled); ctx.emit('event'); return { enabled: !t.enabled }; }
      if (m === 'DELETE') { ctx.db.deleteTask(id); ctx.emit('event'); return { ok: true }; }
    }
    if (p === '/api/log') {
      const mode = q('mode', 'events');
      if (mode === 'commands') return ctx.db.recentCommands(100);
      if (mode === 'jobs') return ctx.db.recentJobs(20);
      return ctx.db.recentEvents(100);
    }
    if (p === '/api/notifications' && m === 'POST') {
      ctx.notifier.setMuted(!!(await readJson(req)).muted);
      ctx.emit('event');
      return { muted: ctx.notifier.muted };
    }
    if (p === '/api/unpair' && m === 'POST') {
      ctx.db.removeDevice(device.id);
      ctx.emit('event');
      return { ok: true };
    }
    throw new HttpError(404, 'Не найдено');
  }

  listFiles(p) {
    try {
      if (!p) return { path: '', parent: null, entries: this.ctx.files.roots() };
      const entries = this.ctx.files.listDir(p);
      return { path: this.ctx.files.check(p), parent: this.ctx.files.parent(p) || '', entries: entries.slice(0, 2000) };
    } catch (e) {
      if (e instanceof FileAccessError) throw new HttpError(400, e.message);
      throw e;
    }
  }

  download(p, res, device) {
    let f;
    try { f = this.ctx.files.fileForDownload(p); } catch (e) { throw new HttpError(400, e.message); }
    const ext = path.extname(f.name).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': f.size,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    });
    fs.createReadStream(f.path).pipe(res);
    this.ctx.db.logCommand('mobile', device.name, 'download', f.path, true, info.fmtBytes(f.size));
    return undefined;
  }

  mediaTicket(p) {
    let f;
    try { f = this.ctx.files.fileForDownload(p); } catch (e) { throw new HttpError(400, e.message); }
    const now = Date.now();
    for (const [k, v] of this.tickets) if (v.expires < now) this.tickets.delete(k);
    const ticket = crypto.randomBytes(18).toString('base64url');
    this.tickets.set(ticket, { path: f.path, expires: now + 3 * 3600 * 1000 });
    return { url: `/api/media/${ticket}/${encodeURIComponent(f.name)}`, size: f.size };
  }

  /** Отдача файла с поддержкой Range (перемотка; без неё iPhone не воспроизводит аудио и видео). */
  streamFile(req, res, filePath) {
    let st;
    try { st = fs.statSync(filePath); } catch (e) { throw new HttpError(404, 'Файл не найден'); }
    const total = st.size;
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range && (range[1] !== '' || range[2] !== '')) {
      let start; let end;
      if (range[1] === '') { start = Math.max(0, total - Number(range[2])); end = total - 1; }
      else { start = Number(range[1]); end = range[2] === '' ? total - 1 : Math.min(Number(range[2]), total - 1); }
      if (start > end || start >= total) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` });
        res.end();
        return undefined;
      }
      res.writeHead(206, {
        'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${total}`, 'Cache-Control': 'no-store',
      });
      if (req.method === 'HEAD') { res.end(); return undefined; }
      fs.createReadStream(filePath, { start, end }).pipe(res);
      return undefined;
    }
    res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': total, 'Cache-Control': 'no-store' });
    if (req.method === 'HEAD') { res.end(); return undefined; }
    fs.createReadStream(filePath).pipe(res);
    return undefined;
  }

  upload(req, name, dir, device) {
    let target;
    try {
      // Пустой файл-заглушка, чтобы получить безопасное уникальное имя
      target = this.ctx.files.saveUpload(name || `file_${Date.now()}`, Buffer.alloc(0), dir || null);
    } catch (e) {
      throw new HttpError(400, e.message);
    }
    return new Promise((resolve, reject) => {
      let size = 0;
      const out = fs.createWriteStream(target);
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_UPLOAD) { req.destroy(); out.destroy(); fs.rmSync(target, { force: true }); reject(new HttpError(413, 'Файл слишком большой')); }
      });
      req.pipe(out);
      out.on('finish', () => {
        this.ctx.db.logCommand('mobile', device.name, 'upload', target, true, info.fmtBytes(size));
        this.ctx.emit('event');
        resolve({ ok: true, path: target, size });
      });
      out.on('error', (e) => reject(new HttpError(500, e.message)));
      req.on('aborted', () => { out.destroy(); fs.rmSync(target, { force: true }); });
    });
  }

  async fileToTelegram(p, device) {
    const ctx = this.ctx;
    if (!ctx.tg || !ctx.authorizedIds().length) throw new HttpError(400, 'Telegram не подключён в программе на ПК');
    let f;
    try { f = ctx.files.fileForDownload(p); } catch (e) { throw new HttpError(400, e.message); }
    if (f.size > TELEGRAM_UPLOAD_LIMIT) throw new HttpError(400, 'Файл больше 50 МБ — Telegram не примет его');
    ctx.notifier.notify(`📄 <code>${E(f.path)}</code>`, { category: 'files', document: { name: f.name, data: fs.readFileSync(f.path) }, log: false });
    ctx.db.logCommand('mobile', device.name, 'file_to_telegram', f.path, true, info.fmtBytes(f.size));
    return { ok: true };
  }

  addTask(t) {
    const sch = this.ctx.scheduler;
    try {
      let id;
      if (t.kind === 'in') {
        const mins = Number(t.delayMinutes);
        if (!(mins > 0)) throw new Error('Укажите, через сколько минут');
        id = sch.addOnce(t.action, t.arg, Date.now() / 1000 + mins * 60);
      } else if (t.kind === 'at') {
        const ts = new Date(t.runAt).getTime() / 1000;
        if (!ts || ts <= Date.now() / 1000) throw new Error('Укажите время в будущем');
        id = sch.addOnce(t.action, t.arg, ts);
      } else {
        id = sch.addDaily(t.action, t.arg, t.timeOfDay, t.weekdays);
      }
      const task = this.ctx.db.getTask(id);
      return { ...task, description: sch.describe(task) };
    } catch (e) {
      throw new HttpError(400, e.message);
    }
  }
}

function clientIp(req) {
  return String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sendBinary(res, buf, type) {
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length });
  res.end(buf);
  return undefined;
}

function readRaw(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { req.destroy(); reject(new HttpError(413, 'Слишком большая запись')); } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_JSON) { req.destroy(); reject(new HttpError(413, 'Слишком большой запрос')); } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(new HttpError(400, 'Неверный JSON')); }
    });
    req.on('error', reject);
  });
}

module.exports = { LanServer, lanAddresses, HttpError };
