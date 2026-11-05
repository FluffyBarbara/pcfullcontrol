'use strict';
// Фото того, кто сел за компьютер: при неверном пароле на экране входа (событие Windows 4625)
// и, по желанию, при каждой разблокировке. Работает, только если у компьютера есть веб-камера.
const { IS_WIN, run, powershell } = require('./system/exec');
const { webcamPhoto } = require('./system/screen');
const { E } = require('./telegram-api');

// Подкатегория аудита «Вход в систему» (GUID не зависит от языка Windows)
const LOGON_AUDIT = '{0CCE9215-69AE-11D9-BED3-505054503030}';
const INTERACTIVE = new Set(['2', '7', '11']); // за компьютером, разблокировка, кэшированный вход

/** Разбор XML событий 4625 из wevtutil. */
function parseFailedLogons(xml) {
  const out = [];
  const re = /<Event[\s\S]*?<\/Event>/g;
  let m;
  while ((m = re.exec(String(xml)))) {
    const ev = m[0];
    const id = Number((/<EventRecordID>(\d+)<\/EventRecordID>/.exec(ev) || [])[1] || 0);
    const field = (n) => ((new RegExp(`<Data Name=['"]${n}['"]>([^<]*)</Data>`).exec(ev)) || [])[1] || '';
    const time = (/SystemTime=['"]([^'"]+)['"]/.exec(ev) || [])[1] || '';
    out.push({ id, user: field('TargetUserName'), domain: field('TargetDomainName'), logonType: field('LogonType'), ip: field('IpAddress'), time });
  }
  return out;
}

class IntruderWatch {
  constructor(ctx) {
    this.ctx = ctx;
    this.timer = null;
    this.lastId = 0;
    this.lastPhoto = 0;
    this.hasCamera = null;
  }

  get cfg() { return this.ctx.config.security; }

  async detectCamera() {
    if (!IS_WIN) { this.hasCamera = false; return false; }
    const r = await powershell("@(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.Class -in 'Camera','Image' -and $_.Status -eq 'OK' }).Count", 30000);
    this.hasCamera = (parseInt(r.out, 10) || 0) > 0;
    return this.hasCamera;
  }

  async start() {
    if (!IS_WIN) return;
    await this.detectCamera().catch(() => {});
    if (!this.hasCamera) return;
    if (this.cfg.photoOnFailedLogin) {
      // Windows по умолчанию может не записывать неудачные входы — включаем запись
      await run('auditpol.exe', ['/set', `/subcategory:${LOGON_AUDIT}`, '/failure:enable'], { timeout: 15000 }).catch(() => {});
    }
    // Запоминаем последнее событие, чтобы не присылать старые попытки
    const first = await this.query(24 * 3600 * 1000);
    this.lastId = first.reduce((mx, e) => Math.max(mx, e.id), 0);
    this.timer = setInterval(() => this.poll().catch(() => {}), 8000);
  }

  stop() { clearInterval(this.timer); this.timer = null; }

  async query(ms) {
    const q = `*[System[(EventID=4625) and TimeCreated[timediff(@SystemTime) <= ${ms}]]]`;
    const r = await run('wevtutil.exe', ['qe', 'Security', `/q:${q}`, '/f:xml', '/rd:true', '/c:20'], { timeout: 15000 });
    return r.code === 0 ? parseFailedLogons(r.out) : [];
  }

  async poll() {
    if (!this.cfg.photoOnFailedLogin || !this.hasCamera) return;
    const events = (await this.query(120000)).filter((e) => e.id > this.lastId && INTERACTIVE.has(e.logonType));
    if (!events.length) return;
    this.lastId = Math.max(this.lastId, ...events.map((e) => e.id));
    const users = [...new Set(events.map((e) => e.user).filter(Boolean))].join(', ');
    await this.snap(`🚨 <b>Неверный пароль при входе в Windows</b>${users ? `\nУчётная запись: ${E(users)}` : ''}\nПопыток: ${events.length}`, 'failed');
  }

  /** Разблокировка или вход — фото, если включено «при каждом входе». */
  async onUnlock() {
    if (!this.cfg.photoOnUnlock || !this.hasCamera) return;
    await this.snap('🔓 <b>Компьютер разблокировали</b> — кто сейчас за ним:', 'unlock');
  }

  async snap(text, kind) {
    if (Date.now() - this.lastPhoto < 30000) return; // не чаще раза в 30 секунд
    this.lastPhoto = Date.now();
    let photo = null;
    try { photo = await webcamPhoto(); } catch (e) { text += `\n(фото не получилось: ${E(e.message)})`; }
    this.ctx.db.addEvent('warning', 'security', kind === 'failed' ? 'Неверный пароль при входе в Windows — сделано фото' : 'Разблокировка — сделано фото');
    this.ctx.notifier.notify(text, { category: 'security', level: 'warning', photo });
  }
}

module.exports = { IntruderWatch, parseFailedLogons };
