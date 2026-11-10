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
const { NetGuard, PHYSICAL_PS, OPEN_WIFI_PS, PROFILES_PS, openWifiNames } = require('./net-guard');
const Sig = require('../shared/sig');
const { IS_WIN, powershell } = require('./system/exec');

const MOBILE_DIR = path.join(__dirname, '..', 'mobile');
const SHARED_DIR = path.join(__dirname, '..', 'shared');
const CODE_TTL_MS = 10 * 60 * 1000;
// Привязка открыта, только пока на ПК открыт раздел «Телефон» (и 3 минуты после); иначе код не принимается
const PAIR_WINDOW_MS = 3 * 60 * 1000;
const PAIR_GLOBAL_FAILS = 10;
const X25519_SPKI = Buffer.from('302a300506032b656e032100', 'hex'); // столько неверных кодов от кого угодно за 10 минут — привязка закрывается
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
const { Writable } = require('stream');

// ---- Шифрование содержимого (то же, что src/shared/sig.js, но средствами Node) ----
const hm = (key, msg) => crypto.createHmac('sha256', key).update(msg).digest();
function encKeys(key, dir, nonce) {
  return { enc: hm(key, 'pcfc-enc'), mac: hm(key, 'pcfc-mac'), iv: hm(key, `iv:${dir}:${nonce}`).subarray(0, 12), head: Buffer.from(`${dir}:${nonce}:`) };
}
// ChaCha20 — своя реализация (src/shared/sig.js): в Electron (BoringSSL) этого шифра нет
const CHUNK = 1024 * 1024; // кратно 64 байтам — блоку ChaCha20
async function encryptBody(key, dir, nonce, data) {
  const k = encKeys(key, dir, nonce);
  const ct = Buffer.alloc(data.length);
  for (let off = 0; off < data.length; off += CHUNK) {
    ct.set(Sig.chacha20(k.enc, k.iv, data.subarray(off, off + CHUNK), off / 64), off);
    if (off + CHUNK < data.length) await new Promise((r) => setImmediate(r)); // большой файл — не замораживаем программу
  }
  return Buffer.concat([ct, crypto.createHmac('sha256', k.mac).update(k.head).update(ct).digest()]);
}
function decryptBody(key, dir, nonce, box) {
  if (box.length < 32) throw new HttpError(400, 'Повреждённые данные');
  const k = encKeys(key, dir, nonce);
  const ct = box.subarray(0, box.length - 32);
  const want = crypto.createHmac('sha256', k.mac).update(k.head).update(ct).digest();
  if (!crypto.timingSafeEqual(want, box.subarray(box.length - 32))) throw new HttpError(400, 'Данные подменены или повреждены');
  return Buffer.from(Sig.chacha20(k.enc, k.iv, ct));
}

/**
 * Ответ, который шифруется целиком перед отправкой (ключом телефона и одноразовым числом его запроса).
 * Ведёт себя как обычный ответ: writeHead / setHeader / end / pipe.
 */
class EncResponse extends Writable {
  constructor(res, req) {
    super();
    this.res = res; this.req = req; this.chunks = []; this.statusCode = 200; this.hdrs = {}; this.headersSent = false;
  }
  setHeader(k, v) { this.hdrs[String(k).toLowerCase()] = v; }
  getHeader(k) { return this.hdrs[String(k).toLowerCase()]; }
  writeHead(status, h = {}) { this.statusCode = status; for (const [k, v] of Object.entries(h || {})) this.setHeader(k, v); this.headersSent = true; return this; }
  _write(chunk, enc, cb) { this.chunks.push(Buffer.from(chunk, enc)); cb(); }
  _final(cb) { this.finish().then(() => cb(), (e) => cb(e)); }

  async finish() {
    const plain = Buffer.concat(this.chunks);
    this.chunks = [];
    const a = this.req.pcfc;
    const h = { ...this.hdrs };
    delete h['content-length'];
    let body = plain;
    if (a && a.enc) {
      body = await encryptBody(a.key, 'res', a.nonce, plain);
      h['x-pcfc-type'] = h['content-type'] || 'application/octet-stream';
      h['content-type'] = 'application/octet-stream';
      h['x-pcfc-enc'] = '1';
      delete h['content-disposition'];
    }
    h['content-length'] = body.length;
    try { this.res.writeHead(this.statusCode, h); this.res.end(body); } catch (e) { /* соединение закрыто */ }
  }
  _destroy(err, cb) { try { this.res.destroy(); } catch (e) { /* ignore */ } cb(err); }
}

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
    this.pairOpenUntil = 0;
    this.globalFails = [];
    this.guard = new NetGuard();
    this.blocked = new Map();  // ip -> когда последний раз сообщали о блокировке
    this.guardTimer = null;
    this.nonces = new Map();   // одноразовые числа подписанных запросов: id|nonce -> время
    this.rate = new Map();     // ограничение частоты: устройство|запрос -> { start, count }
    this.widgetFails = new Map(); // ip -> время неверных ключей виджета
  }

  // ---------------- кто может подключаться ----------------
  async refreshGuard(force = false) {
    const changed = this.guard.refresh(force);
    this.guardTicks = (this.guardTicks || 0) + 1;
    if (IS_WIN && (changed || force || this.guardTicks % 10 === 0)) {
      try { this.guard.openWifi = new Set(openWifiNames((await powershell(OPEN_WIFI_PS, 20000)).out)); } catch (e) { /* без проверки Wi-Fi */ }
      try {
        let list = JSON.parse((await powershell(PROFILES_PS, 20000)).out || '[]');
        list = Array.isArray(list) ? list : [list];
        this.profiles = list.filter(Boolean);
        this.guard.publicNets = new Set(this.profiles.filter((x) => x.category === 'Public').map((x) => x.alias));
      } catch (e) { /* без проверки типа сети */ }
    }
    if (!IS_WIN || (!changed && this.guard.physical)) return;
    try {
      const r = await powershell(PHYSICAL_PS, 30000);
      const list = JSON.parse(r.out || '[]');
      this.guard.setPhysical((Array.isArray(list) ? list : [list]).filter((x) => typeof x === 'string'));
    } catch (e) { /* остаётся проверка по названиям адаптеров */ }
  }

  onConnection(sock) {
    this.guard.refresh();
    const v = this.guard.check(sock.localAddress, sock.remoteAddress);
    if (v.ok) return;
    sock.destroy();
    if (v.publicNet && !this.publicWarned) {
      this.publicWarned = true;
      this.ctx.notifier.notify(`🛡 <b>Телефон не может подключиться</b>: сеть «${E(v.iface)}» отмечена в Windows как общественная, а в таких сетях программа никого не пускает. Если это ваша домашняя сеть — откройте PC Full Control → «Телефон» → «Сделать сеть домашней».`, { category: 'security', level: 'warning' });
      return;
    }
    const ip = String(sock.remoteAddress || '').replace(/^::ffff:/, '');
    const last = this.blocked.get(ip) || 0;
    if (Date.now() - last < 3600e3) return;
    this.blocked.set(ip, Date.now());
    if (this.blocked.size > 500) this.blocked.clear();
    try {
      this.ctx.db.addEvent('warning', 'security', `Заблокировано подключение с ${ip}: ${v.reason}`);
      this.ctx.notifier.notify(`🛡 <b>Заблокировано подключение к PC Full Control</b>\nС адреса <code>${E(ip)}</code> — ${E(v.reason)}.\nТелефон подключается только из вашей домашней сети Wi-Fi.`, { category: 'security', level: 'warning' });
    } catch (e) { /* ignore */ }
  }

  /** Раздел «Телефон» открыт на ПК — можно привязывать. */
  openPairing() { this.pairOpenUntil = Date.now() + PAIR_WINDOW_MS; }
  get pairingOpen() { return !!process.env.PCFC_TEST_PAIR_CODE || Date.now() < this.pairOpenUntil; }

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
    this.server.on('connection', (sock) => this.onConnection(sock));
    this.refreshGuard(true).catch(() => {});
    clearInterval(this.guardTimer);
    this.guardTimer = setInterval(() => this.refreshGuard().catch(() => {}), 30000);
    if (this.guardTimer.unref) this.guardTimer.unref();
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
    clearInterval(this.guardTimer);
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
      // Секрет только в QR-коде (после «#» — в сеть не уходит): им телефон доказывает знание кода
      // и получает свой ключ доступа в зашифрованном виде
      this.pairSecret = crypto.randomBytes(16).toString('hex');
      this.codeExpires = Date.now() + CODE_TTL_MS;
    }
    return { code: this.code, expires: this.codeExpires };
  }

  pairInfo() {
    const { code, expires } = this.pairCode();
    this.guard.refresh();
    const allowed = new Set(this.guard.nets.map((n) => n.address));
    const ips = lanAddresses().filter((ip) => allowed.has(ip));
    const urls = ips.map((ip) => `http://${ip}:${this.port}`);
    const publicNets = (this.profiles || []).filter((x) => x.category === 'Public').map((x) => ({ alias: x.alias, name: x.name }));
    return {
      publicNets,
      status: this.status, error: this.error, port: this.port, code, expires, addresses: urls,
      pairUrl: urls[0] ? `${urls[0]}/#/pair/${code}/${this.pairSecret || ''}` : null,
    };
  }

  checkPairAttempts(ip) {
    const recent = (this.failed.get(ip) || []).filter((t) => Date.now() - t < 10 * 60 * 1000);
    this.failed.set(ip, recent);
    if (recent.length >= 5) throw new HttpError(429, 'Слишком много неверных попыток. Подождите 10 минут.');
  }

  pair(body, ip) {
    if (!this.pairingOpen) throw new HttpError(403, 'Привязка закрыта. Откройте на компьютере раздел «Телефон» и отсканируйте QR-код.');
    this.checkPairAttempts(ip);
    this.globalFails = this.globalFails.filter((t) => Date.now() - t < 10 * 60 * 1000);
    if (this.globalFails.length >= PAIR_GLOBAL_FAILS) throw new HttpError(429, 'Привязка временно закрыта из-за подбора кода.');
    const { code } = this.pairCode();
    const salt = /^[0-9a-f]{16,64}$/.test(String(body.salt || '')) ? String(body.salt) : null;
    const epub = /^[0-9a-f]{64}$/.test(String(body.epub || '')) ? String(body.epub) : null;
    const eq = (hexStr, want) => { const got = Buffer.from(String(hexStr || ''), 'hex'); return got.length === want.length && crypto.timingSafeEqual(got, want); };
    let ok;
    let mode;
    if (body.proof && salt && epub) {
      // Код введён вручную: телефон доказывает знание кода, не пересылая его, и вместе с ПК
      // вырабатывает общий ключ (X25519) — подслушавший сеть не узнает ни код, ни ключ доступа
      mode = 'ecdh';
      ok = eq(body.proof, crypto.createHmac('sha256', code).update(`pair:${salt}:${epub}`).digest());
    } else if (body.proof && salt && this.pairSecret) {
      mode = 'qr';
      ok = eq(body.proof, crypto.createHmac('sha256', this.pairSecret).update('pair:' + salt).digest());
    } else if (process.env.PCFC_TEST_HOOKS) {
      // Только для автоматических проверок: код и ключ открытым текстом
      mode = 'plain';
      const given = Buffer.from(String(body.code || '').trim());
      ok = given.length === code.length && crypto.timingSafeEqual(given, Buffer.from(code));
    } else {
      throw new HttpError(400, 'Обновите страницу приложения на телефоне и привяжите его заново');
    }
    if (!ok) {
      this.failed.get(ip).push(Date.now());
      this.globalFails.push(Date.now());
      if (this.globalFails.length >= PAIR_GLOBAL_FAILS) {
        // Кто-то подбирает код — закрываем привязку и меняем код
        this.pairOpenUntil = 0;
        this.pairCode(true);
        this.ctx.notifier.notify(`🚨 <b>Кто-то подбирает код привязки телефона</b> (последний адрес <code>${E(ip)}</code>). Привязка закрыта, код заменён.`, { category: 'security', level: 'warning' });
      }
      throw new HttpError(403, 'Неверный или устаревший код. Посмотрите новый код в программе на ПК.');
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const secret = this.pairSecret;
    const name = String(body.name || 'Телефон').slice(0, 60);
    const platform = String(body.platform || '').slice(0, 20);
    this.ctx.db.addDevice(name, platform, sha256(token), ip);
    this.pairCode(true);
    this.ctx.notifier.notify(`📱 Привязан телефон с приложением: <b>${E(name)}</b> (${E(ip)})`, { category: 'security', level: 'warning' });
    this.ctx.emit('event');
    // По QR-коду ключ уходит зашифрованным секретом из QR, по коду — общим ключом X25519
    if (mode === 'qr') return { sealed: Sig.seal(secret, salt, token), pcName: this.ctx.pcName, version: this.ctx.version };
    if (mode === 'ecdh') {
      const kp = crypto.generateKeyPairSync('x25519');
      const peer = crypto.createPublicKey({ key: Buffer.concat([X25519_SPKI, Buffer.from(epub, 'hex')]), format: 'der', type: 'spki' });
      const shared = crypto.diffieHellman({ privateKey: kp.privateKey, publicKey: peer });
      const sealKey = crypto.createHmac('sha256', shared).update('seal:' + code).digest('hex');
      const spub = kp.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
      return { spub, sealed: Sig.seal(sealKey, salt, token), pcName: this.ctx.pcName, version: this.ctx.version };
    }
    return { token, pcName: this.ctx.pcName, version: this.ctx.version };
  }

  /**
   * Ключ виджета: «android» — для виджета Android-приложения (подписывает запросы, ключ по сети не идёт),
   * «shortcuts» — для «Команд» iPhone (они умеют только простые ссылки; ключ виден в домашней сети).
   * На каждый телефон — по одному ключу каждого вида; новый заменяет старый.
   */
  widgetKey(device, kind = 'android') {
    const k = kind === 'shortcuts' ? 'shortcuts' : 'android';
    const key = crypto.randomBytes(24).toString('base64url');
    const list = (this.ctx.db.getSetting('widgetKeys') || []).filter((w) => !(w.deviceId === device.id && (w.kind || 'android') === k));
    list.push({ hash: sha256(key), deviceId: device.id, kind: k, created: Date.now() / 1000 });
    this.ctx.db.setSetting('widgetKeys', list);
    return { key, pcName: this.ctx.pcName };
  }

  widgetDevice(req, res, ip, queryKey) {
    // Подбор ключей с одного адреса ограничен (ключ — 192 бита, но и шум в журнале не нужен)
    this.rateLimit({ id: 'wip' + ip }, 'widget-auth', 120);
    const fails = (this.widgetFails.get(ip) || []).filter((t) => Date.now() - t < 10 * 60 * 1000);
    if (fails.length >= 10) throw new HttpError(429, 'Слишком много неверных ключей — подождите 10 минут');
    const fail = (msg) => { fails.push(Date.now()); this.widgetFails.set(ip, fails); if (this.widgetFails.size > 1000) this.widgetFails.clear(); return new HttpError(401, msg); };
    const list = this.ctx.db.getSetting('widgetKeys') || [];
    let w;
    const signed = req.headers['x-widget-auth'];
    if (signed) {
      const [id, tsS, nonce, sig] = String(signed).split('.');
      const ts = Number(tsS);
      if (!/^[0-9a-f]{16}$/.test(id || '') || !/^[0-9a-f]{16,64}$/.test(nonce || '') || !/^[0-9a-f]{64}$/.test(sig || '')) throw fail('Неверная подпись виджета');
      if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 5 * 60 * 1000) { res.setHeader('X-PCFC-Time', String(Date.now())); throw new HttpError(401, 'Часы телефона и компьютера расходятся'); }
      w = list.find((x) => Sig.deviceId(x.hash) === id);
      if (!w) throw fail('Виджет отключён — добавьте его заново в приложении');
      const want = crypto.createHmac('sha256', w.hash).update(Sig.message(req.method, req.url, ts, nonce)).digest();
      const got = Buffer.from(sig, 'hex');
      if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) throw fail('Неверная подпись виджета');
      const nk = `w${id}|${nonce}`;
      if (this.nonces.has(nk)) throw new HttpError(401, 'Повтор запроса отклонён');
      this.nonces.set(nk, Date.now());
      if (!w.signs) { w.signs = true; this.ctx.db.setSetting('widgetKeys', list); }
    } else {
      const key = req.headers['x-widget-key'] || queryKey;
      if (!key) throw fail('Нужен ключ виджета');
      const h = sha256(String(key));
      w = list.find((x) => x.hash === h);
      if (!w) throw fail('Виджет отключён — добавьте его заново в приложении');
      // Виджет, который уже подписывает запросы, ключ открытым текстом не шлёт — значит, ключ перехвачен
      if (w.signs) throw fail('Запрос виджета без подписи отклонён');
    }
    const dev = this.ctx.db.listDevices().find((d) => d.id === w.deviceId);
    if (!dev) throw fail('Виджет отключён — добавьте его заново в приложении');
    return dev;
  }

  auth(req, res, pathname = '') {
    const signed = req.headers['x-pcfc-auth'];
    let dev;
    if (signed) dev = this.authSigned(req, res, String(signed));
    else {
      const h = req.headers.authorization || '';
      const token = h.startsWith('Bearer ') ? h.slice(7) : '';
      if (!token) throw new HttpError(401, 'Требуется привязка');
      dev = this.ctx.db.deviceByToken(sha256(token));
      if (!dev) throw new HttpError(401, 'Телефон отвязан от этого компьютера');
      // Ключ открытым текстом по сети больше не принимается — только у голосового помощника старых
      // Android-приложений (и в автоматических проверках)
      if (!process.env.PCFC_TEST_HOOKS && !/^\/api\/assistant(\/|$)/.test(pathname)) throw new HttpError(401, 'Обновите приложение на телефоне: запросы без подписи не принимаются');
      // Телефон, который уже подписывает запросы, ключ открытым текстом не шлёт: такой запрос — подделка
      // (исключение — голосовой помощник старой версии Android-приложения)
      if (this.signedIds().includes(dev.id) && !/^\/api\/assistant\//.test(pathname)) throw new HttpError(401, 'Запрос без подписи отклонён');
    }
    if (Date.now() / 1000 - (dev.last_seen || 0) > 60) this.ctx.db.touchDevice(dev.id, clientIp(req));
    return dev;
  }

  signedIds() { return this.ctx.db.getSetting('signedDevices') || []; }

  /** Проверка подписи «номер.время.одноразовое.подпись» (src/shared/sig.js). */
  authSigned(req, res, header) {
    const [id, tsS, nonce, sig] = header.split('.');
    const ts = Number(tsS);
    if (!/^[0-9a-f]{16}$/.test(id || '') || !/^[0-9a-f]{16,64}$/.test(nonce || '') || !/^[0-9a-f]{64}$/.test(sig || '') || !Number.isFinite(ts)) throw new HttpError(401, 'Неверная подпись');
    if (Math.abs(Date.now() - ts) > 5 * 60 * 1000) {
      res.setHeader('X-PCFC-Time', String(Date.now())); // часы телефона расходятся с ПК — телефон подстроится
      throw new HttpError(401, 'Часы телефона и компьютера расходятся');
    }
    const rows = this.ctx.db.all('SELECT * FROM devices');
    const dev = rows.find((d) => Sig.deviceId(d.token_hash) === id);
    if (!dev) throw new HttpError(401, 'Телефон отвязан от этого компьютера');
    // Флаг шифрования входит в подпись: убрать его по дороге, чтобы получить открытый ответ, нельзя
    const enc = req.headers['x-pcfc-enc'] === '1';
    const want = crypto.createHmac('sha256', dev.token_hash).update(Sig.message(req.method, req.url, ts, nonce) + (enc ? '\nE' : '')).digest();
    const got = Buffer.from(sig, 'hex');
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) throw new HttpError(401, 'Неверная подпись');
    // Повтор перехваченного запроса не пройдёт: каждое одноразовое число принимается один раз
    const now = Date.now();
    if (this.nonces.size > 20000) for (const [k, t] of this.nonces) if (now - t > 11 * 60 * 1000) this.nonces.delete(k);
    const key = `${id}|${nonce}`;
    if (this.nonces.has(key)) throw new HttpError(401, 'Повтор запроса отклонён');
    this.nonces.set(key, now);
    const ids = this.signedIds();
    if (!ids.includes(dev.id)) this.ctx.db.setSetting('signedDevices', [...ids, dev.id]);
    req.pcfc = { key: dev.token_hash, nonce, enc };
    return dev;
  }

  /** Ограничение частоты «тяжёлых» запросов на одно устройство. */
  rateLimit(dev, route, max, windowMs = 60000) {
    const key = `${dev.id}|${route}`;
    const now = Date.now();
    let r = this.rate.get(key);
    if (!r || now - r.start > windowMs) { r = { start: now, count: 0 }; this.rate.set(key, r); }
    if (++r.count > max) throw new HttpError(429, 'Слишком часто — подождите немного');
    // Старые записи убираем по времени (а не все разом — иначе лимиты можно было бы обнулить)
    if (this.rate.size > 5000) for (const [k, v] of this.rate) if (now - v.start > 10 * 60 * 1000) this.rate.delete(k);
  }

  // ---------------- обработка запросов ----------------
  async handle(req, rawRes) {
    let res = rawRes;
    // Защита от «DNS rebinding»: чужой сайт в браузере не сможет обратиться к программе под своим именем
    const host = String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
    if (!/^(\d{1,3}(\.\d{1,3}){3}|localhost|::1)$/.test(host)) { res.writeHead(421); res.end(); return undefined; }
    const url = new URL(req.url, 'http://x');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      if (!url.pathname.startsWith('/api/')) return this.serveStatic(url.pathname, req, res);
      res.setHeader('Cache-Control', 'no-store');
      // Android-приложение: голосовой ассистент записывает звук на своей странице (http://localhost)
      if (/^https?:\/\/localhost(:\d+)?$/.test(req.headers.origin || '') && /^\/api\/(assistant|widget)/.test(url.pathname)) {
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-PCFC-Auth, X-PCFC-Enc, X-PCFC-Type, X-Widget-Key, X-Widget-Auth');
        res.setHeader('Access-Control-Expose-Headers', 'X-PCFC-Time, X-PCFC-Enc, X-PCFC-Type');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return undefined; }
      }
      // Подписанный запрос с шифрованием — ответ тоже шифруется
      if (req.headers['x-pcfc-auth'] && req.headers['x-pcfc-enc'] === '1') res = new EncResponse(res, req);
      const result = await this.route(req, res, url);
      if (result === undefined || res.headersSent) return undefined;
      return sendJson(res, 200, result);
    } catch (e) {
      if (res.headersSent) { res.destroy(); return undefined; }
      if (!e.status) {
        // Подробности — только в журнал на ПК, наружу — без путей и внутренностей
        try { this.ctx.db.addEvent('warning', 'mobile', `Ошибка запроса ${url.pathname}: ${e.message}`); } catch (e2) { /* ignore */ }
        return sendJson(res, 500, { error: 'Внутренняя ошибка на компьютере. Подробности — в журнале программы.' });
      }
      return sendJson(res, e.status, { error: e.message });
    }
  }

  serveStatic(pathname, req, res) {
    let rel = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
    if (rel.includes('..')) rel = 'index.html';
    let file = rel.startsWith('shared/') ? path.join(SHARED_DIR, rel.slice(7)) : path.join(MOBILE_DIR, rel);
    const inside = (dir) => path.resolve(file).startsWith(path.resolve(dir) + path.sep);
    if (!inside(MOBILE_DIR) && !inside(SHARED_DIR)) file = path.join(MOBILE_DIR, 'index.html');
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
      // Для Android-приложения (страница http://localhost): проверка, что по адресу отвечает PC Full Control.
      // Чужие сайты в браузере ответ прочитать не могут — разрешён только адрес самого приложения.
      const origin = String(req.headers.origin || '');
      const appOrigin = /^(https?|capacitor):\/\/localhost(:\d+)?$/.test(origin);
      if (origin && !appOrigin) return { app: 'pc-full-control' };
      if (appOrigin) res.setHeader('Access-Control-Allow-Origin', origin);
      // MAC-адрес и адрес рассылки (для включения ПК с телефона) — только привязанным телефонам:
      // запрос пришёл с адреса, с которого уже работает привязанный телефон
      const known = ctx.db.listDevices().some((d) => d.ip && d.ip === ip);
      const nic = known ? poweron.primaryInterface() : null;
      return { app: 'pc-full-control', version: ctx.version, pcName: known ? ctx.pcName : null, mac: nic ? nic.mac : null, broadcast: nic ? nic.broadcast : null };
    }
    if (p === '/api/pair' && m === 'POST') {
      return this.pair(await readJson(req), ip);
    }

    // Виджет на главном экране телефона: доступ по отдельному ключу виджета (его можно отозвать)
    if (p.startsWith('/api/widget') && p !== '/api/widget/key') {
      const wdev = this.widgetDevice(req, res, ip, q('k'));
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
        // Выключение, перезагрузка и сон — только после подтверждения на телефоне
        if (['shutdown', 'reboot', 'sleep'].includes(action) && b.confirm !== true && q('confirm') !== '1') throw new HttpError(428, 'Нужно подтверждение — обновите приложение на телефоне');
        this.rateLimit({ id: 'w' + wdev.id }, 'widget', 30);
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

    const device = this.auth(req, res, p);
    // Ограничения частоты: обычной работе не мешают, но не дают загрузить ПК бесконечными запросами
    this.rateLimit(device, 'all', 3000);
    const HEAVY = [[/^\/api\/net\/speedtest/, 3], [/^\/api\/space\/(start|scan)/, 5], [/^\/api\/net\/(diag|fix|scan)/, 10], [/^\/api\/(cleanup|clean|updates|apps\/[^/]+\/(uninstall|remove))/, 10],
      [/^\/api\/webcam/, 20], [/^\/api\/screenshot/, 60], [/^\/api\/files\/(upload|delete|telegram)/, 60], [/^\/api\/action\//, 120]];
    for (const [re, max] of HEAVY) if (re.test(p)) this.rateLimit(device, re.source, max);

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
    // Обложка трека — только привязанному телефону (запрос подписан, ответ зашифрован)
    if (p === '/api/music/cover') {
      const c = ctx.media.cover(q('k'));
      if (!c) throw new HttpError(404, 'Нет обложки');
      res.writeHead(200, { 'Content-Type': c.type, 'Content-Length': c.buf.length });
      res.end(c.buf);
      return undefined;
    }
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
    if (p === '/api/widget/key' && m === 'POST') return this.widgetKey(device, (await readJson(req)).kind);
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

/** Тело запроса (расшифрованное, если телефон его зашифровал). Слишком большое — чистый ответ 413. */
function readBody(req, max, tooBig) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      if (over) return; // дочитываем молча, чтобы клиент получил ответ 413, а не обрыв связи
      size += c.length;
      if (size > max + 64) { over = true; chunks.length = 0; reject(new HttpError(413, tooBig)); } else chunks.push(c);
    });
    req.on('end', () => {
      if (over) return;
      let buf = Buffer.concat(chunks);
      try { if (req.pcfc && req.pcfc.enc && buf.length) buf = decryptBody(req.pcfc.key, 'req', req.pcfc.nonce, buf); } catch (e) { reject(e); return; }
      resolve(buf);
    });
    req.on('error', reject);
  });
}
const readRaw = (req, max) => readBody(req, max, 'Слишком большая запись');
async function readJson(req) {
  const buf = await readBody(req, MAX_JSON, 'Слишком большой запрос');
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch (e) { throw new HttpError(400, 'Неверный JSON'); }
}

module.exports = { LanServer, lanAddresses, HttpError };
