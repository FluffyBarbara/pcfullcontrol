'use strict';
// Трансляция экрана на телефон по WebRTC: видео до 120 кадр/с (аппаратное кодирование H.264,
// если есть), звук ПК и канал ввода с минимальной задержкой.
// Захват и кодирование идут в скрытом окне Electron (stream-host.html), здесь — сессии и сигнализация.
const crypto = require('crypto');
const path = require('path');
const { IS_WIN } = require('./system/exec');

const electron = () => require('electron');

// Режимы качества. bitrate — кбит/с, maxWidth — предельная ширина картинки.
const PRESETS = {
  auto: { name: 'Авто', desc: '60 кадр/с, чёткая картинка в исходном разрешении (до 2K)', fps: 60, maxWidth: 2560, bitrate: 25000, degradation: 'balanced', hint: 'detail' },
  quality: { name: 'Максимум чёткости', desc: 'Исходное разрешение до 4K, 60 кадр/с — для текста и мелких деталей', fps: 60, maxWidth: 3840, bitrate: 50000, degradation: 'maintain-resolution', hint: 'detail' },
  smooth: { name: 'Плавность 120', desc: 'До 120 кадр/с в Full HD — для видео, игр и быстрой работы', fps: 120, maxWidth: 1920, bitrate: 40000, degradation: 'maintain-framerate', hint: 'motion' },
  eco: { name: 'Экономия', desc: '30 кадр/с, HD — для слабого Wi-Fi', fps: 30, maxWidth: 1280, bitrate: 4000, degradation: 'balanced', hint: 'detail' },
};

const IDLE_CLOSE_MS = 5 * 60 * 1000;

class ScreenStream {
  constructor(ctx) {
    this.ctx = ctx;
    this.win = null;
    this.ready = null;
    this.sessions = new Map(); // sid -> { deviceId, device, monitor, started }
    this.pending = new Map();  // rid -> { resolve, reject, timer }
    this.seq = 0;
    this.bound = false;
    this.cursorTimer = null;
    this.lastCursor = '';
    this.lastCursorAt = 0;
    this.idleTimer = null;
  }

  static presets() {
    return Object.entries(PRESETS).map(([id, p]) => ({ id, name: p.name, desc: p.desc, fps: p.fps }));
  }

  // ---------------- скрытое окно ----------------
  bind() {
    if (this.bound) return;
    this.bound = true;
    const { ipcMain } = electron();
    const mine = (e) => this.win && !this.win.isDestroyed() && e.sender === this.win.webContents;
    ipcMain.on('stream:ready', (e) => { if (mine(e) && this.readyResolve) this.readyResolve(); });
    ipcMain.on('stream:reply', (e, m) => {
      if (!mine(e)) return;
      const p = this.pending.get(m.rid);
      if (!p) return;
      this.pending.delete(m.rid);
      clearTimeout(p.timer);
      if (m.ok) p.resolve(m.data); else p.reject(new Error(m.error || 'Ошибка трансляции'));
    });
    ipcMain.on('stream:input', (e, m) => { if (mine(e)) this.onInput(m.sid, m.cmd); });
    ipcMain.on('stream:closed', (e, m) => { if (mine(e)) this.onClosed(m.sid); });
    ipcMain.on('stream:monitor', (e, m) => {
      if (!mine(e)) return;
      const s = this.sessions.get(m.sid);
      if (s) s.monitor = Number(m.index) || s.monitor;
    });
    ipcMain.on('stream:log', (e, m) => { if (mine(e)) console.log('[stream]', m); });
    ipcMain.handle('stream:source', (e, monitor) => {
      if (!mine(e)) throw new Error('forbidden');
      return this.sourceFor(monitor);
    });
  }

  ensureWindow() {
    if (this.win && !this.win.isDestroyed()) return this.ready;
    const { BrowserWindow } = electron();
    this.bind();
    const win = new BrowserWindow({
      show: false, width: 320, height: 240, skipTaskbar: true, focusable: false,
      webPreferences: {
        preload: path.join(__dirname, 'stream-preload.js'), contextIsolation: true, sandbox: true, // песочница Chromium: окно без прав, даже если программа — администратор
        backgroundThrottling: false,
      },
    });
    this.win = win;
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Модуль трансляции не запустился')), 20000);
      this.readyResolve = () => { clearTimeout(timer); resolve(); };
      win.loadFile(path.join(__dirname, '..', 'renderer', 'stream-host.html')).catch((e) => { clearTimeout(timer); reject(e); });
    });
    win.on('closed', () => {
      if (this.win !== win) return;
      this.win = null;
      this.ready = null;
      for (const sid of [...this.sessions.keys()]) this.onClosed(sid);
    });
    this.ready.catch(() => { if (!win.isDestroyed()) win.destroy(); });
    return this.ready;
  }

  call(type, payload = {}, timeout = 20000) {
    const rid = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(rid); reject(new Error('Трансляция не ответила')); }, timeout);
      this.pending.set(rid, { resolve, reject, timer });
      this.win.webContents.send('stream:cmd', { rid, type, ...payload });
    });
  }

  post(type, payload = {}) {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send('stream:cmd', { type, ...payload });
  }

  /** Источник захвата для экрана с номером monitor. */
  async sourceFor(monitor) {
    const { desktopCapturer } = electron();
    const d = this.ctx.remote.display(monitor);
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    const src = sources.find((s) => s.display_id === d.id) || sources[d.index - 1] || sources[0];
    if (!src) throw new Error('Не удалось получить изображение экрана');
    return { id: src.id, index: d.index, width: d.phys.width, height: d.phys.height };
  }

  // ---------------- сессии ----------------
  async start(device, { monitor = 1, preset = 'auto', audio = true } = {}) {
    if (!this.ctx.remote.enabled) throw new Error('Удалённое управление выключено в настройках программы');
    clearTimeout(this.idleTimer);
    await this.ensureWindow();
    const source = await this.sourceFor(monitor);
    const sid = crypto.randomBytes(12).toString('hex');
    const name = PRESETS[preset] ? preset : 'auto';
    const offer = await this.call('start', {
      sid, source, preset: name, presets: PRESETS, audio: IS_WIN && audio !== false,
    });
    this.sessions.set(sid, { deviceId: device.id, device: device.name, monitor: source.index, started: Date.now() });
    this.ctx.remote.noteSession(device.name);
    this.ctx.remote.warm();
    this.startCursor();
    return { sid, sdp: offer.sdp, monitor: source.index, preset: name, audio: offer.audio };
  }

  own(sid, device) {
    const s = this.sessions.get(String(sid || ''));
    if (!s || s.deviceId !== device.id) throw new Error('Сеанс трансляции не найден');
    return s;
  }

  async answer(device, sid, sdp) {
    this.own(sid, device);
    if (typeof sdp !== 'string' || sdp.length > 200000) throw new Error('Неверный ответ');
    await this.call('answer', { sid, sdp });
    return { ok: true };
  }

  async stop(device, sid) {
    try { this.own(sid, device); } catch (e) { return { ok: true }; }
    this.post('stop', { sid });
    this.onClosed(sid);
    return { ok: true };
  }

  stopAll() {
    for (const sid of [...this.sessions.keys()]) { this.post('stop', { sid }); this.onClosed(sid); }
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }

  onInput(sid, cmd) {
    const s = this.sessions.get(sid);
    if (!s || !cmd || typeof cmd !== 'object') return;
    const monitor = Number(cmd.monitor) || s.monitor;
    this.ctx.remote.input(cmd, monitor).catch((e) => this.post('notify', { sid, error: e.message }));
  }

  onClosed(sid) {
    if (!this.sessions.delete(sid)) return;
    if (!this.sessions.size) {
      this.stopCursor();
      clearTimeout(this.idleTimer);
      // Окно трансляции держим ещё 5 минут — повторное подключение будет мгновенным
      this.idleTimer = setTimeout(() => {
        if (!this.sessions.size && this.win && !this.win.isDestroyed()) { this.win.destroy(); this.win = null; }
      }, IDLE_CLOSE_MS);
    }
  }

  // Положение курсора (0..1) для каждого сеанса — телефон рисует метку и следует за ним при увеличении
  startCursor() {
    if (this.cursorTimer) return;
    this.cursorTimer = setInterval(() => {
      if (!this.sessions.size) return;
      const { screen } = electron();
      const c = screen.getCursorScreenPoint();
      const out = {};
      for (const [sid, s] of this.sessions) {
        const d = this.ctx.remote.display(s.monitor);
        const b = d.bounds;
        out[sid] = c.x >= b.x && c.x < b.x + b.width && c.y >= b.y && c.y < b.y + b.height
          ? [+((c.x - b.x) / b.width).toFixed(4), +((c.y - b.y) / b.height).toFixed(4)] : null;
      }
      const key = JSON.stringify(out);
      // Без изменений — повторяем раз в секунду (новый телефон сразу видит курсор)
      if (key === this.lastCursor && Date.now() - this.lastCursorAt < 1000) return;
      this.lastCursor = key;
      this.lastCursorAt = Date.now();
      this.post('cursor', { cursors: out });
    }, 33);
  }

  stopCursor() {
    clearInterval(this.cursorTimer);
    this.cursorTimer = null;
    this.lastCursor = '';
  }
}

module.exports = { ScreenStream, PRESETS };
