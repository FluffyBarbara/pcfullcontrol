'use strict';
// Атаки из аудита 1.12.4 (F-01…F-21): каждая должна быть отражена.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { makeCtx } = require('./helpers');
const { LanServer } = require('../src/main/lan-server');
const Sig = require('../src/shared/sig');

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcc-a2-'));
  const ctx = await makeCtx({ mobile: { port: 0 }, files: { uploadDir: path.join(dir, 'up'), fullDiskAccess: true } });
  ctx.media.state = async () => ({ available: true, sessions: [] });
  const lan = new LanServer(ctx);
  await lan.start();
  lan.openPairing();
  const base = `http://127.0.0.1:${lan.port}`;
  return { ctx, lan, base, dir };
}
const noLegacy = async (fn) => { const v = process.env.PCFC_TEST_HOOKS; delete process.env.PCFC_TEST_HOOKS; try { return await fn(); } finally { process.env.PCFC_TEST_HOOKS = v; } };

/** Пара по QR-коду (как настоящий телефон) → ключ. */
async function pairQr(lan, base) {
  lan.pairCode();
  const secret = lan.pairSecret; // после привязки код и секрет меняются
  const salt = crypto.randomBytes(16).toString('hex');
  const r = await fetch(base + '/api/pair', { method: 'POST', body: JSON.stringify({ salt, proof: Sig.hex(Sig.hmac(secret, 'pair:' + salt)) }) });
  return Sig.unseal(secret, salt, (await r.json()).sealed);
}

/** Зашифрованный запрос, как делает приложение на телефоне. */
async function encFetch(base, token, method, url, body = null) {
  const sg = Sig.signed(token, method, url, Date.now(), true);
  const headers = { 'X-PCFC-Auth': sg.header, 'X-PCFC-Enc': '1' };
  const r = await fetch(base + url, { method, headers, body: body == null ? undefined : Buffer.from(Sig.encrypt(sg.key, 'req', sg.nonce, JSON.stringify(body))) });
  const raw = Buffer.from(await r.arrayBuffer());
  return { r, sg, raw, plain: r.headers.get('x-pcfc-enc') === '1' ? Buffer.from(Sig.decrypt(sg.key, 'res', sg.nonce, raw)) : raw };
}

test('F-01: запросы и ответы зашифрованы, подмена ответа обнаруживается', async () => {
  const { lan, base } = await setup();
  try {
    const token = await pairQr(lan, base);
    const { r, raw, plain } = await encFetch(base, token, 'GET', '/api/info');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-pcfc-enc'), '1');
    assert.ok(!raw.toString('latin1').includes('pcName'), 'по сети не видно содержимого');
    assert.ok(JSON.parse(plain.toString()).pcName);
    // Зашифрованное тело запроса (как у команд с телефона)
    const t = await encFetch(base, token, 'POST', '/api/assistant', { text: 'привет' });
    assert.notEqual(t.r.status, 400, 'тело запроса расшифровано');
    // Подмена одного байта ответа — расшифровка отказывает
    const again = await encFetch(base, token, 'GET', '/api/status');
    const bad = Buffer.from(again.raw); bad[0] ^= 1;
    assert.throws(() => Sig.decrypt(again.sg.key, 'res', again.sg.nonce, bad), /подменены/);
  } finally { lan.stop(); }
});

test('F-01: убрать флаг шифрования по дороге нельзя — подпись не сходится', async () => {
  const { lan, base } = await setup();
  try {
    const token = await pairQr(lan, base);
    const sg = Sig.signed(token, 'GET', '/api/info', Date.now(), true);
    const r = await fetch(base + '/api/info', { headers: { 'X-PCFC-Auth': sg.header } }); // посредник удалил X-PCFC-Enc
    assert.equal(r.status, 401);
  } finally { lan.stop(); }
});

test('F-09: привязка по коду без QR — X25519, ни код, ни ключ не идут открытым текстом; старая открытая привязка выключена', async () => {
  const { lan, base } = await setup();
  try {
    await noLegacy(async () => {
      const code = lan.pairCode().code;
      const old = await fetch(base + '/api/pair', { method: 'POST', body: JSON.stringify({ code }) });
      assert.equal(old.status, 400, 'выдача ключа открытым текстом запрещена');
      const kp = Sig.x25519Keys();
      const epub = Sig.hex(kp.pub);
      const salt = crypto.randomBytes(16).toString('hex');
      const body = JSON.stringify({ salt, epub, proof: Sig.hex(Sig.hmac(code, `pair:${salt}:${epub}`)) });
      assert.ok(!body.includes(code), 'кода в запросе нет');
      const r = await fetch(base + '/api/pair', { method: 'POST', body });
      assert.equal(r.status, 200);
      const j = await r.json();
      assert.equal(j.token, undefined);
      const shared = Sig.x25519(kp.priv, Sig.fromHex(j.spub));
      const token = Sig.unseal(Sig.hex(Sig.hmac(shared, 'seal:' + code)), salt, j.sealed);
      assert.equal((await encFetch(base, token, 'GET', '/api/info')).r.status, 200);
      // Ключ открытым текстом (Bearer) больше не принимается
      assert.equal((await fetch(base + '/api/info', { headers: { Authorization: 'Bearer ' + token } })).status, 401);
    });
  } finally { lan.stop(); }
});

test('F-11/F-03: обложка только с подписью; MAC — только адресу привязанного телефона', async () => {
  const { lan, base, ctx } = await setup();
  try {
    ctx.media.cover = () => ({ type: 'image/jpeg', buf: Buffer.from('jpeg') });
    assert.equal((await fetch(base + '/api/music/cover?k=x')).status, 401);
    let h = await (await fetch(base + '/api/hello')).json();
    assert.equal(h.mac, null, 'чужому — без MAC');
    const token = await pairQr(lan, base);
    const c = await encFetch(base, token, 'GET', '/api/music/cover?k=x');
    assert.equal(c.plain.toString(), 'jpeg');
    h = await (await fetch(base + '/api/hello')).json();
    assert.ok('mac' in h);
  } finally { lan.stop(); }
});

test('F-01/F-08: виджет Android подписывает запросы; перехваченный ключ не работает; перебор ключей ограничен', async () => {
  const { lan, base, ctx } = await setup();
  try {
    const token = await pairQr(lan, base);
    const { plain } = await encFetch(base, token, 'POST', '/api/widget/key', { kind: 'android' });
    const key = JSON.parse(plain.toString()).key;
    const k = crypto.createHash('sha256').update(key).digest('hex');
    const sign = (method, p, ts = Date.now(), nonce = crypto.randomBytes(12).toString('hex')) => `${Sig.deviceId(k)}.${ts}.${nonce}.${crypto.createHmac('sha256', k).update(Sig.message(method, p, ts, nonce)).digest('hex')}`;
    ctx.widgetData = async () => ({ app: 'pc-full-control' });
    const h1 = sign('GET', '/api/widget');
    assert.equal((await fetch(base + '/api/widget', { headers: { 'X-Widget-Auth': h1 } })).status, 200);
    assert.equal((await fetch(base + '/api/widget', { headers: { 'X-Widget-Auth': h1 } })).status, 401, 'повтор не проходит');
    // Ключ открытым текстом после подписанной работы — отказ (значит, его перехватили)
    assert.equal((await fetch(base + '/api/widget', { headers: { 'X-Widget-Key': key } })).status, 401);
    const codes = [];
    for (let i = 0; i < 12; i++) codes.push((await fetch(base + '/api/widget', { headers: { 'X-Widget-Key': 'bad' + i } })).status);
    assert.ok(codes.includes(429), 'после 10 неверных ключей — пауза');
  } finally { lan.stop(); }
});

test('F-10: слишком большой запрос — ответ 413, а не обрыв', async () => {
  const { lan } = await setup();
  try {
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: lan.port, path: '/api/pair', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
      req.end(Buffer.alloc(2 * 1024 * 1024, 'a'));
    });
    assert.equal(status, 413);
  } finally { lan.stop(); }
});

test('подпись и шифрование: X25519 и ChaCha20 совпадают с эталоном Node', () => {
  const key = crypto.randomBytes(32); const nonce = crypto.randomBytes(12); const data = crypto.randomBytes(777);
  const ref = crypto.createCipheriv('chacha20', key, Buffer.concat([Buffer.alloc(4), nonce])).update(data);
  assert.ok(Buffer.from(Sig.chacha20(new Uint8Array(key), new Uint8Array(nonce), new Uint8Array(data))).equals(ref));
  const a = Sig.x25519Keys();
  const nk = crypto.generateKeyPairSync('x25519');
  const npub = nk.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const s1 = Buffer.from(Sig.x25519(a.priv, new Uint8Array(npub)));
  const s2 = crypto.diffieHellman({ privateKey: nk.privateKey, publicKey: crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), Buffer.from(a.pub)]), format: 'der', type: 'spki' }) });
  assert.ok(s1.equals(s2));
});

test('F-04: «Запустить программу» по пути с телефона — только в доступных папках; «Мои программы» — можно', async () => {
  const misc = require('../src/main/system/misc');
  const { FileManager } = require('../src/main/system/files');
  const fm = new FileManager(() => ({ files: { allowedRoots: [], uploadDir: path.join(os.homedir(), 'Downloads', 'PCControl') } }));
  const outside = process.platform === 'win32' ? 'C:\\Windows\\System32\\cmd.exe' : '/bin/sh';
  await assert.rejects(misc.launch(outside, { source: 'mobile', files: fm, apps: [] }), /папка пользователя/);
  await assert.rejects(misc.launch(outside, { source: 'telegram', files: fm, apps: [] }), /папка пользователя/);
  // Программу из «Моих программ» владелец добавил сам — проверка папок к ней не применяется
  await assert.rejects(misc.launch(outside, { source: 'mobile', files: { check: () => { throw new Error('проверка не нужна'); } }, apps: [{ name: 'x', cmd: outside }] }), (e) => !/проверка не нужна/.test(e.message));
  const { ActionRegistry } = require('../src/main/actions');
  const ctx = await makeCtx();
  assert.equal(new ActionRegistry(ctx).get('launch').dangerous, true, 'запуск программ — с подтверждением');
});

test('F-05: скрытые файлы в папке пользователя закрыты даже при «весь диск»', () => {
  const { FileManager } = require('../src/main/system/files');
  const home = os.homedir();
  const fm = new FileManager(() => ({ files: { allowedRoots: [], uploadDir: path.join(home, 'Downloads', 'PCControl'), fullDiskAccess: true } }));
  for (const f of ['.netrc', '.git-credentials', '.npmrc', '.bash_history', '.putty', '.mozilla', 'NTUSER.DAT']) {
    assert.throws(() => fm.check(path.join(home, f)), /закрыта/, f);
  }
  assert.doesNotThrow(() => fm.check(path.join(home, 'Documents', 'report.docx')));
});

test('F-21: в сети, которую Windows считает общественной, подключения не принимаются', () => {
  const { NetGuard } = require('../src/main/net-guard');
  const g = new NetGuard({ interfaces: () => ({ 'Wi-Fi': [{ address: '192.168.1.5', netmask: '255.255.255.0', family: 'IPv4', internal: false }] }) });
  assert.equal(g.check('192.168.1.5', '192.168.1.9').ok, true);
  g.publicNets = new Set(['Wi-Fi']);
  const v = g.check('192.168.1.5', '192.168.1.9');
  assert.equal(v.ok, false);
  assert.equal(v.publicNet, true);
});

test('F-18: системные программы — по полному пути; на других системах путь не меняется', () => {
  const { sysPath, PS_EXE } = require('../src/main/system/exec');
  if (process.platform === 'win32') {
    assert.match(PS_EXE, /System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i);
    assert.match(sysPath('wevtutil.exe'), /System32\\wevtutil\.exe$/i);
  } else {
    assert.equal(sysPath('ls'), 'ls');
  }
});
