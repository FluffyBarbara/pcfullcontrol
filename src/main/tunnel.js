'use strict';
// Доступ к ПК из любой точки (мобильный интернет, чужой Wi-Fi) без настройки роутера:
// защищённый туннель Cloudflare (cloudflared, бесплатно, без регистрации) к серверу программы.
// Вход — только по одноразовой ссылке из Telegram (действует 15 минут). Привязать новый телефон
// через интернет нельзя — только дома по QR-коду.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { IS_WIN } = require('./system/exec');
const { E } = require('./telegram-api');

const DOWNLOAD_URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const CODE_TTL = 15 * 60 * 1000;

class RemoteAccess {
  constructor(ctx) {
    this.ctx = ctx;
    this.proc = null;
    this.url = null;
    this.status = 'off';   // off | downloading | starting | online | error
    this.error = '';
    this.progress = 0;
    this.codes = new Map(); // код → { expires, by }
    this.restartTimer = null;
    this.fails = 0;
    this.menuKey = null;       // ключ кнопки «Мой ПК» в Telegram — действует, пока не сменится адрес
    this.healthTimer = null;
    this.healthFails = 0;
  }

  get enabled() { return !!(this.ctx.config.remote && this.ctx.config.remote.enabled); }
  get binDir() { return path.join(this.ctx.dataDir || process.cwd(), 'bin'); }
  get binPath() {
    if (process.env.PCFC_CLOUDFLARED) return process.env.PCFC_CLOUDFLARED;
    return path.join(this.binDir, IS_WIN ? 'cloudflared.exe' : 'cloudflared');
  }

  state() {
    return { enabled: this.enabled, status: this.status, url: this.url, error: this.error, progress: this.progress, installed: fs.existsSync(this.binPath) };
  }

  emit() { this.ctx.emit('remote-access', this.state()); }

  async download() {
    if (fs.existsSync(this.binPath)) return;
    if (!IS_WIN && !process.env.PCFC_CLOUDFLARED) throw new Error('Доступ из интернета сейчас поддерживается только в Windows');
    this.status = 'downloading';
    this.progress = 0;
    this.emit();
    fs.mkdirSync(this.binDir, { recursive: true });
    const tmp = this.binPath + '.part';
    const r = await fetch(DOWNLOAD_URL, { redirect: 'follow' });
    if (!r.ok) throw new Error(`Не удалось скачать модуль туннеля (${r.status})`);
    const total = Number(r.headers.get('content-length')) || 0;
    const out = fs.createWriteStream(tmp);
    let got = 0;
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      if (!out.write(Buffer.from(value))) await new Promise((res) => out.once('drain', res));
      const pct = total ? Math.floor((got / total) * 100) : 0;
      if (pct !== this.progress) { this.progress = pct; if (pct % 5 === 0) this.emit(); }
    }
    await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));
    const head = Buffer.alloc(2);
    const fd = fs.openSync(tmp, 'r');
    fs.readSync(fd, head, 0, 2, 0);
    fs.closeSync(fd);
    if (head.toString() !== 'MZ' || got < 5e6) { fs.rmSync(tmp, { force: true }); throw new Error('Скачанный файл повреждён — попробуйте ещё раз'); }
    fs.renameSync(tmp, this.binPath);
  }

  async start() {
    if (this.proc) return this.state();
    clearTimeout(this.restartTimer);
    this.error = '';
    try {
      await this.download();
    } catch (e) {
      this.status = 'error';
      this.error = e.message;
      this.emit();
      throw e;
    }
    this.status = 'starting';
    this.url = null;
    this.emit();
    const port = this.ctx.config.mobile.port || 8765;
    // Журнал туннеля — в папке данных программы (cloudflared.log), чтобы при сбое было видно причину
    const logFile = path.join(this.ctx.dataDir || process.cwd(), 'cloudflared.log');
    // Новый запуск — новый журнал (иначе в нём остался бы адрес прошлого запуска); прошлый сохраняем рядом
    try { fs.renameSync(logFile, logFile.replace(/\.log$/, '.prev.log')); } catch (e) { /* журнала ещё нет */ }
    const p = spawn(this.binPath, ['tunnel', '--no-autoupdate', '--logfile', logFile, '--loglevel', 'info', '--url', `http://127.0.0.1:${port}`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = p;
    const onData = (d) => {
      const m = URL_RE.exec(String(d));
      if (m && m[0] !== this.url) {
        this.url = m[0];
        this.status = 'online';
        this.fails = 0;
        this.emit();
        this.onNewUrl().catch(() => {});
      }
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('error', (e) => { this.error = e.message; });
    p.on('exit', (code) => {
      if (this.proc !== p) return;
      this.proc = null;
      this.url = null;
      if (!this.enabled) { this.status = 'off'; this.emit(); return; }
      this.status = 'error';
      this.error = this.error || `Туннель остановился (код ${code}) — переподключаюсь`;
      this.emit();
      this.fails++;
      this.restartTimer = setTimeout(() => this.start().catch(() => {}), Math.min(300000, 5000 * 2 ** Math.min(this.fails, 6)));
    });
    // Ждём адрес до 60 секунд
    for (let i = 0; i < 120 && this.proc === p && !this.url; i++) {
      await new Promise((r) => setTimeout(r, 500));
      // Адрес мог попасть только в журнал — ищем и там
      if (!this.url && i % 2 === 1) {
        try {
          const st = fs.statSync(logFile);
          const fd = fs.openSync(logFile, 'r');
          const len = Math.min(st.size, 65536);
          const buf = Buffer.alloc(len);
          fs.readSync(fd, buf, 0, len, st.size - len);
          fs.closeSync(fd);
          const all = String(buf).match(new RegExp(URL_RE.source, 'gi'));
          if (all && all.length) onData(all[all.length - 1]);
        } catch (e) { /* журнала ещё нет */ }
      }
    }
    if (!this.url && this.proc === p) { this.error = 'Не удалось открыть туннель — проверьте интернет'; }
    return this.state();
  }

  /**
   * Адрес бесплатного туннеля меняется при каждом перезапуске. Чтобы ссылка никогда не терялась,
   * кнопка «🖥 Мой ПК» в чате бота (рядом с полем ввода) сразу перенастраивается на новый адрес.
   */
  async onNewUrl() {
    this.menuKey = crypto.randomBytes(24).toString('base64url');
    this.ctx.db.addEvent('info', 'remote', 'Доступ из интернета: новый адрес');
    const ok = await this.updateMenuButtons();
    this.ctx.notifier.notify(ok
      ? '🌍 <b>Доступ из интернета работает</b>\nНажмите кнопку <b>«🖥 Мой ПК»</b> внизу этого чата — она всегда ведёт на актуальный адрес (он меняется после перезапуска ПК).'
      : '🌍 <b>Доступ из интернета работает</b>\nСсылка для входа — командой /remote.', { category: 'security', level: 'info' });
    this.startHealth();
  }

  /** Ссылка для кнопки «Мой ПК»: многоразовая, но только до следующей смены адреса. */
  menuUrl() { return this.url && this.menuKey ? `${this.url}/#/login/${this.menuKey}` : null; }

  async updateMenuButtons() {
    const tg = this.ctx.tg;
    if (!tg) return false;
    const url = this.menuUrl();
    let ok = false;
    for (const id of this.ctx.authorizedIds()) {
      try {
        await tg.call('setChatMenuButton', { chat_id: id, menu_button: url ? { type: 'web_app', text: '🖥 Мой ПК', web_app: { url } } : { type: 'commands' } });
        ok = true;
      } catch (e) { /* чат недоступен */ }
    }
    return ok;
  }

  /** Раз в 3 минуты проверяем, что программу видно из интернета; завис туннель — перезапускаем. */
  startHealth() {
    clearInterval(this.healthTimer);
    this.healthFails = 0;
    this.healthTimer = setInterval(async () => {
      if (!this.url || !this.proc) return;
      // Считаем сбоем только явный ответ Cloudflare «туннель не найден» (530/502–504).
      // Сетевые ошибки (нет интернета, DNS ещё не знает адрес) — не повод перезапускать.
      let dead = false;
      try {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 15000);
        const r = await fetch(`${this.url}/api/hello`, { signal: ac.signal, cache: 'no-store' });
        clearTimeout(t);
        dead = [502, 503, 504, 530].includes(r.status);
      } catch (e) { return; }
      this.healthFails = dead ? this.healthFails + 1 : 0;
      if (this.healthFails >= 2) {
        this.healthFails = 0;
        this.ctx.db.addEvent('warning', 'remote', 'Туннель не отвечал — перезапускаю');
        const p = this.proc;
        this.proc = null;
        this.url = null;
        try { if (p) p.kill(); } catch (e) { /* ignore */ }
        this.start().catch(() => {});
      }
    }, 3 * 60 * 1000);
  }

  stop() {
    clearTimeout(this.restartTimer);
    clearInterval(this.healthTimer);
    this.menuKey = null;
    this.updateMenuButtons().catch(() => {});
    const p = this.proc;
    this.proc = null;
    if (p) { try { p.kill(); } catch (e) { /* ignore */ } }
    this.url = null;
    this.status = 'off';
    this.emit();
  }

  async setEnabled(on) {
    this.ctx.updateConfig({ remote: { enabled: !!on } });
    if (on) return this.start();
    this.stop();
    this.ctx.notifier.notify('🌍 Доступ из интернета выключен', { category: 'security' });
    return this.state();
  }

  /** Одноразовая ссылка для входа через интернет (действует 15 минут). */
  loginLink(by = '') {
    if (!this.url) throw new Error(this.enabled ? 'Туннель ещё подключается — повторите через минуту' : 'Доступ из интернета выключен');
    for (const [c, v] of this.codes) if (v.expires < Date.now()) this.codes.delete(c);
    const code = crypto.randomBytes(18).toString('base64url');
    this.codes.set(code, { expires: Date.now() + CODE_TTL, by });
    return { url: `${this.url}/#/login/${code}`, expires: Date.now() + CODE_TTL };
  }

  /** Проверяет и «гасит» одноразовый код. */
  useCode(code) {
    const c = String(code || '');
    if (this.menuKey && c.length === this.menuKey.length && crypto.timingSafeEqual(Buffer.from(c), Buffer.from(this.menuKey))) return { by: 'кнопка «Мой ПК»' };
    const v = this.codes.get(c);
    if (!v || v.expires < Date.now()) return null;
    this.codes.delete(String(code));
    return v;
  }

  notifyLogin(name, ip) {
    this.ctx.notifier.notify(`🌍 Вход через интернет: <b>${E(name)}</b>${ip ? ` (IP ${E(ip)})` : ''}`, { category: 'security', level: 'warning' });
  }
}

module.exports = { RemoteAccess, URL_RE };
