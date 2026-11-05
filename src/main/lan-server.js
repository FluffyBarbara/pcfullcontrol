'use strict';
// Сервер для приложения на телефоне (работает в домашней сети Wi-Fi).
// Раздаёт мобильное приложение (PWA) и HTTP API. Доступ — только для привязанных телефонов (токен).
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const info = require('./system/info');
const processes = require('./system/processes');
const screen = require('./system/screen');
const media = require('./system/media');
const { FileAccessError, TELEGRAM_UPLOAD_LIMIT } = require('./system/files');
const { E } = require('./telegram-api');

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
  '.pdf': 'application/pdf', '.mp3': 'audio/mpeg',
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
      if (!url.pathname.startsWith('/api/')) return this.serveStatic(url.pathname, res);
      res.setHeader('Cache-Control', 'no-store');
      const result = await this.route(req, res, url);
      if (result === undefined || res.headersSent) return undefined;
      return sendJson(res, 200, result);
    } catch (e) {
      if (res.headersSent) { res.destroy(); return undefined; }
      return sendJson(res, e.status || 500, { error: e.status ? e.message : `Внутренняя ошибка: ${e.message}` });
    }
  }

  serveStatic(pathname, res) {
    let rel = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
    if (rel.includes('..')) rel = 'index.html';
    let file = rel.startsWith('shared/') ? path.join(SHARED_DIR, rel.slice(7)) : path.join(MOBILE_DIR, rel);
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(MOBILE_DIR, 'index.html');
    const data = fs.readFileSync(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': /\.(html|webmanifest)$/.test(file) || file.endsWith('sw.js') ? 'no-cache' : 'max-age=3600',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'",
    });
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
      return { app: 'pc-full-control', pcName: ctx.pcName, version: ctx.version };
    }
    if (p === '/api/pair' && m === 'POST') return this.pair(await readJson(req), ip);

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
      };
    }
    if (p === '/api/update/check') {
      let u;
      try { u = await ctx.appUpdater.check(); } catch (e) { throw new HttpError(502, e.message); }
      return { current: u.current, latest: u.latest, hasUpdate: u.hasUpdate, message: u.message || '' };
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
