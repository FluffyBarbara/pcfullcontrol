'use strict';
// Атаки из отчётов аудита 1.12.3 (PCFC-01…14): каждая должна быть отражена.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { makeCtx, makeBot } = require('./helpers');
const { LanServer } = require('../src/main/lan-server');
const { FileManager, FileAccessError } = require('../src/main/system/files');
const { seal, unseal } = require('../src/main/config');
const Sig = require('../src/shared/sig');

async function setup(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcc-audit-'));
  const ctx = await makeCtx({ mobile: { port: 0 }, files: { uploadDir: path.join(dir, 'up'), ...files } });
  const lan = new LanServer(ctx);
  await lan.start();
  lan.openPairing();
  const base = `http://127.0.0.1:${lan.port}`;
  const raw = (p, { method = 'GET', headers = {}, body } = {}) => fetch(base + p, { method, headers, body });
  return { ctx, lan, base, raw, dir };
}
const json = (o) => ({ 'Content-Type': 'application/json', body: JSON.stringify(o) });

test('PCFC-04: привязка по QR — код и ключ не идут по сети открытым текстом', async () => {
  const { lan, raw } = await setup();
  try {
    const info = lan.pairInfo();
    lan.pairCode();
    const secret = lan.pairSecret;
    assert.match(String(info.pairUrl || `#/pair/${lan.code}/${secret}`), /#\/pair\/\d{6}\/[0-9a-f]{32}$/);
    const salt = crypto.randomBytes(16).toString('hex');
    // Неверное доказательство — отказ
    let r = await raw('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ salt, proof: '00'.repeat(32) }) });
    assert.equal(r.status, 403);
    const proof = Sig.hex(Sig.hmac(secret, 'pair:' + salt));
    r = await raw('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ salt, proof, name: 'QR' }) });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.token, undefined, 'ключ не передаётся открытым текстом');
    const token = Sig.unseal(secret, salt, body.sealed);
    assert.ok(token.length > 30);
    // Подслушавший видит sealed, но без секрета из QR ключ не получить
    assert.notEqual(Sig.unseal('0'.repeat(32), salt, body.sealed), token);
    // Подписанные запросы работают
    const ok = await raw('/api/info', { headers: { 'X-PCFC-Auth': Sig.authHeader(token, 'GET', '/api/info') } });
    assert.equal(ok.status, 200);
  } finally { lan.stop(); }
});

test('PCFC-04: подписанные запросы — повтор, подделка, чужие часы, ключ открытым текстом', async () => {
  const { lan, raw } = await setup();
  try {
    const { token } = await (await raw('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: lan.pairCode().code }) })).json();
    const h = Sig.authHeader(token, 'GET', '/api/status');
    assert.equal((await raw('/api/status', { headers: { 'X-PCFC-Auth': h } })).status, 200);
    assert.equal((await raw('/api/status', { headers: { 'X-PCFC-Auth': h } })).status, 401, 'перехваченный запрос нельзя повторить');
    assert.equal((await raw('/api/info', { headers: { 'X-PCFC-Auth': h } })).status, 401, 'подпись от другого адреса не подходит');
    const forged = h.replace(/[0-9a-f]{64}$/, 'ab'.repeat(32));
    assert.equal((await raw('/api/status', { headers: { 'X-PCFC-Auth': forged } })).status, 401);
    const old = await raw('/api/status', { headers: { 'X-PCFC-Auth': Sig.authHeader(token, 'GET', '/api/status', Date.now() - 3600e3) } });
    assert.equal(old.status, 401);
    assert.ok(Number(old.headers.get('x-pcfc-time')) > 0, 'ПК подсказывает своё время');
    // Телефон уже подписывает — открытый ключ (как если бы его украли из старого трафика) не принимается
    assert.equal((await raw('/api/status', { headers: { Authorization: 'Bearer ' + token } })).status, 401);
    // Подпись с адресом, где есть русские буквы и пробелы — как отправит браузер
    const u = new URL('/api/files?path=' + encodeURIComponent('C:\\Мои файлы'), 'http://x');
    const fr = await raw(u.pathname + u.search, { headers: { 'X-PCFC-Auth': Sig.authHeader(token, 'GET', u.pathname + u.search) } });
    assert.notEqual(fr.status, 401);
  } finally { lan.stop(); }
});

test('PCFC-07/02/03: файлы — только папка пользователя, данные программы закрыты, запись — только в загрузки', async () => {
  const home = os.homedir();
  const dataDir = path.join(home, '.pcfc-test-data-' + process.pid);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'pcontrol.sqlite'), 'secret');
  const up = path.join(home, 'Downloads', 'PCControl-test-' + process.pid);
  const alarms = [];
  const fm = new FileManager(() => ({ files: { allowedRoots: [], uploadDir: up } }), { dataDir: () => dataDir, onAlarm: (p) => alarms.push(p) });
  try {
    assert.throws(() => fm.listDir(process.platform === 'win32' ? 'C:\\Windows' : '/etc'), /папка пользователя/);
    assert.throws(() => fm.fileForDownload(path.join(dataDir, 'pcontrol.sqlite')), /Данные программы/);
    assert.equal(alarms.length, 1, 'попытка открыть базу — тревога владельцу');
    assert.throws(() => fm.listDir(path.join(home, '.ssh')), FileAccessError);
    assert.throws(() => fm.saveUpload('a.txt', Buffer.from('x'), home), /только в папку загрузок/);
    assert.throws(() => fm.saveUpload('evil.exe', Buffer.from('x')), /Программы и скрипты/);
    assert.throws(() => fm.saveUpload('run.ps1', Buffer.from('x')), /Программы и скрипты/);
    assert.throws(() => fm.saveUpload('x.lnk', Buffer.from('x')), /Программы и скрипты/);
    const ok = fm.saveUpload('photo.jpg', Buffer.from('x'));
    assert.ok(ok.startsWith(up));
    // Даже с разрешением писать куда угодно — не в данные программ и не в систему
    const any = new FileManager(() => ({ files: { allowedRoots: [], uploadDir: up, uploadAnywhere: true, fullDiskAccess: true } }), { dataDir: () => dataDir });
    assert.throws(() => any.saveUpload('a.txt', Buffer.from('x'), dataDir), /Данные программы/);
    if (process.env.APPDATA) assert.throws(() => any.saveUpload('a.txt', Buffer.from('x'), path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')), /нужна системе/);
    // Выход из разрешённой папки через символическую ссылку
    if (process.platform !== 'win32') {
      const link = path.join(up, 'escape');
      try { fs.symlinkSync('/etc', link); } catch (e) { /* уже есть */ }
      assert.throws(() => fm.listDir(link), FileAccessError);
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(up, { recursive: true, force: true });
  }
});

test('PCFC-03: токен бота в базе зашифрован, код привязки бота в базе не хранится', async () => {
  const fake = { encryptString: (s) => Buffer.from('X' + Buffer.from(s).toString('base64')), decryptString: (b) => Buffer.from(String(b).slice(1), 'base64').toString() };
  const sealed = seal({ telegram: { token: '123:ABC' } }, fake);
  assert.match(sealed.telegram.token, /^enc:/);
  assert.ok(!JSON.stringify(sealed).includes('123:ABC'));
  assert.equal(unseal(sealed, fake).telegram.token, '123:ABC');
  assert.equal(unseal(seal({ telegram: { token: '1:A' } }, fake), null).telegram.token, '', 'на чужом ПК не расшифровывается');
  const ctx = await makeCtx();
  const code = ctx.pairingCode();
  assert.equal(ctx.db.getSetting('pairCode'), null);
  assert.ok(!JSON.stringify(ctx.db.all('SELECT * FROM settings')).includes(code));
});

test('PCFC-06/12: привязка бота закрыта по умолчанию, счётчик ошибок не вечный', async () => {
  const { ctx, bot, fake } = await makeBot();
  ctx.botPairUntil = 0;
  const msg = (text, id = 999) => ({ chat: { id, type: 'private' }, from: { id, first_name: 'X' }, text });
  await bot.onMessage(msg(`/pair ${ctx.pairingCode()}`));
  assert.match(fake.last().text, /Привязка закрыта/);
  ctx.openBotPairing();
  for (let i = 0; i < 5; i++) await bot.onMessage(msg('/pair WRONG'));
  await bot.onMessage(msg(`/pair ${ctx.pairingCode()}`));
  assert.match(fake.last().text, /Подождите 10 минут/);
  bot.pairFails.set(999, bot.pairFails.get(999).map((t) => t - 11 * 60 * 1000));
  await bot.onMessage(msg(`/pair ${ctx.pairingCode()}`));
  assert.equal(ctx.isAuthorized(999), true, 'через 10 минут можно снова');
});

test('PCFC-11/13: /api/hello не читается чужими сайтами, ошибки без подробностей', async () => {
  const { lan, raw, ctx } = await setup();
  try {
    let r = await raw('/api/hello', { headers: { Origin: 'https://evil.example' } });
    assert.equal(r.headers.get('access-control-allow-origin'), null);
    assert.deepEqual(await r.json(), { app: 'pc-full-control' });
    r = await raw('/api/hello', { headers: { Origin: 'http://localhost' } });
    assert.equal(r.headers.get('access-control-allow-origin'), 'http://localhost');
    const { token } = await (await raw('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: lan.pairCode().code }) })).json();
    ctx.crashes.list = () => { throw new Error('C:\\Users\\secret\\path сломалось'); };
    r = await raw('/api/crashes', { headers: { Authorization: 'Bearer ' + token } });
    assert.equal(r.status, 500);
    assert.ok(!(await r.text()).includes('secret'));
  } finally { lan.stop(); }
});

test('PCFC-09/10: ограничение частоты и подтверждение кнопок виджета', async () => {
  const { lan, raw, ctx } = await setup();
  try {
    const { token } = await (await raw('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: lan.pairCode().code }) })).json();
    const auth = { Authorization: 'Bearer ' + token };
    ctx.net.speedTest = async () => ({ down: 1 });
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await raw('/api/net/speedtest', { method: 'POST', headers: auth })).status);
    assert.ok(codes.includes(429), 'замер скорости — не чаще 3 раз в минуту');
    const { key } = await (await raw('/api/widget/key', { method: 'POST', headers: auth })).json();
    let ran = null;
    ctx.actions.run = async (name) => { ran = name; return { ok: true }; };
    let r = await raw('/api/widget/action', { method: 'POST', headers: { 'X-Widget-Key': key }, ...json({ action: 'shutdown' }) });
    assert.equal(r.status, 428);
    assert.equal(ran, null, 'без подтверждения не выключает');
    r = await raw('/api/widget/action', { method: 'POST', headers: { 'X-Widget-Key': key }, ...json({ action: 'shutdown', confirm: true }) });
    assert.equal(r.status, 200);
    assert.equal(ran, 'shutdown');
  } finally { lan.stop(); }
});

test('PCFC-04: открытая сеть Wi-Fi без пароля — подключения не принимаются', () => {
  const { NetGuard, openWifiNames } = require('../src/main/net-guard');
  const g = new NetGuard({ interfaces: () => ({ 'Wi-Fi': [{ address: '192.168.1.5', netmask: '255.255.255.0', family: 'IPv4', internal: false }] }) });
  assert.equal(g.check('192.168.1.5', '192.168.1.9').ok, true);
  g.openWifi = new Set(openWifiNames('    Name : Wi-Fi\n    State : connected\n    SSID : Cafe\n    Authentication : Open\n    Cipher : None\n'));
  const v = g.check('192.168.1.5', '192.168.1.9');
  assert.equal(v.ok, false);
  assert.match(v.reason, /открытая сеть/);
});

test('подпись: собственный SHA-256 совпадает с эталоном', () => {
  for (const s of ['', 'abc', 'x'.repeat(63), 'x'.repeat(64), 'привет'.repeat(40)]) {
    assert.equal(Sig.hex(Sig.sha256(s)), crypto.createHash('sha256').update(s).digest('hex'));
  }
  assert.equal(Sig.hex(Sig.hmac('k'.repeat(100), 'm')), crypto.createHmac('sha256', 'k'.repeat(100)).update('m').digest('hex'));
});
