'use strict';
// Безопасность: подключения только из домашней сети, привязка только при открытом разделе «Телефон»,
// защита от подбора кода и от DNS rebinding, запуск программ без выполнения команд.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { makeCtx } = require('./helpers');
const { LanServer } = require('../src/main/lan-server');
const { NetGuard, isPrivate, sameSubnet } = require('../src/main/net-guard');
const misc = require('../src/main/system/misc');

const IFACES = {
  'Беспроводная сеть': [{ address: '192.168.1.50', netmask: '255.255.255.0', family: 'IPv4', internal: false }],
  Ethernet: [{ address: '10.0.0.5', netmask: '255.255.255.0', family: 'IPv4', internal: false }],
  'Happ VPN': [{ address: '172.19.0.1', netmask: '255.255.255.252', family: 'IPv4', internal: false }],
  'Ethernet 3': [{ address: '10.8.0.6', netmask: '255.255.255.0', family: 'IPv4', internal: false }], // TAP-адаптер VPN без «говорящего» имени
  wg0: [{ address: '10.66.66.2', netmask: '255.255.255.0', family: 'IPv4', internal: false }],
  'Подключение по локальной сети* 2': [{ address: '192.168.137.1', netmask: '255.255.255.0', family: 'IPv4', internal: false }],
  'Белый адрес': [{ address: '85.12.33.4', netmask: '255.255.255.0', family: 'IPv4', internal: false }],
};

test('сеть: телефон из домашнего Wi-Fi пускаем, VPN, интернет и чужие подсети — нет', () => {
  const g = new NetGuard({ interfaces: () => IFACES });
  assert.equal(g.check('192.168.1.50', '192.168.1.23').ok, true);
  assert.equal(g.check('::ffff:192.168.1.50', '::ffff:192.168.1.23').ok, true);
  assert.equal(g.check('127.0.0.1', '127.0.0.1').ok, true);
  assert.equal(g.check('192.168.1.50', '192.168.2.23').ok, false, 'другая подсеть');
  assert.equal(g.check('192.168.1.50', '85.10.1.1').ok, false, 'адрес из интернета');
  assert.equal(g.check('172.19.0.1', '172.19.0.2').ok, false, 'VPN по названию');
  assert.equal(g.check('10.66.66.2', '10.66.66.3').ok, false, 'WireGuard');
  assert.equal(g.check('85.12.33.4', '85.12.33.99').ok, false, 'белый адрес');
  // Пока Windows не сообщила список настоящих адаптеров, TAP без «говорящего» имени выглядит как обычный —
  // после ответа Windows он отсекается
  g.setPhysical(['Беспроводная сеть', 'Ethernet']);
  assert.equal(g.check('10.8.0.6', '10.8.0.7').ok, false, 'виртуальный адаптер VPN');
  assert.equal(g.check('10.0.0.5', '10.0.0.9').ok, true, 'кабель');
  assert.equal(g.check('192.168.137.1', '192.168.137.20').ok, true, 'мобильный хот-спот ПК');
  assert.match(g.check('10.8.0.6', '10.8.0.7').reason, /VPN/);
  assert.equal(isPrivate('172.32.0.1'), false);
  assert.equal(isPrivate('172.16.0.1'), true);
  assert.equal(isPrivate('100.64.0.1'), false);
  assert.equal(sameSubnet('10.0.0.1', '10.0.1.1', '255.255.0.0'), true);
});

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcc-sec-'));
  const ctx = await makeCtx({ mobile: { port: 0 }, files: { uploadDir: path.join(dir, 'up') } });
  const lan = new LanServer(ctx);
  await lan.start();
  const base = `http://127.0.0.1:${lan.port}`;
  const pair = (code, ip) => fetch(base + '/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name: ip || 'x' }) });
  return { ctx, lan, base, pair };
}

test('привязка закрыта, пока на ПК не открыт раздел «Телефон»', async () => {
  const { lan, pair } = await setup();
  try {
    const code = lan.pairCode().code;
    const r = await pair(code);
    assert.equal(r.status, 403);
    assert.match((await r.json()).error, /Привязка закрыта/);
    lan.openPairing();
    assert.equal((await pair(code)).status, 200);
  } finally { lan.stop(); }
});

test('подбор кода с разных адресов: после 10 ошибок привязка закрывается и код меняется', async () => {
  const { ctx, lan } = await setup();
  try {
    lan.openPairing();
    const code = lan.pairCode().code;
    const sent = [];
    ctx.notifier.notify = (t) => sent.push(t);
    for (let i = 0; i < 10; i++) { try { lan.pair({ code: '000000' === code ? '000001' : '000000' }, `192.168.1.${i + 10}`); } catch (e) { /* неверный код */ } }
    assert.equal(lan.pairingOpen, false);
    assert.notEqual(lan.pairCode().code, code);
    assert.ok(sent.some((t) => /подбирает код/.test(t)));
    assert.throws(() => lan.pair({ code: lan.pairCode().code }, '192.168.1.99'), /закрыта/);
  } finally { lan.stop(); }
});

test('чужое имя сайта в заголовке Host (DNS rebinding) — отказ', async () => {
  const { lan } = await setup();
  try {
    const status = (host) => new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: lan.port, path: '/api/hello', headers: { Host: host } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
    });
    assert.equal(await status('evil.example.com'), 421);
    assert.equal(await status('127.0.0.1:' + lan.port), 200);
    assert.equal(await status('192.168.1.50:' + lan.port), 200);
    assert.equal(await status('localhost'), 200);
  } finally { lan.stop(); }
});

test('подключение не из домашней сети обрывается сразу и попадает в журнал', async () => {
  const { ctx, lan } = await setup();
  try {
    const sent = [];
    ctx.notifier.notify = (t) => sent.push(t);
    let destroyed = false;
    lan.onConnection({ localAddress: '172.19.0.1', remoteAddress: '172.19.0.2', destroy: () => { destroyed = true; } });
    assert.equal(destroyed, true);
    assert.ok(sent.some((t) => /Заблокировано подключение/.test(t)));
    lan.onConnection({ localAddress: '172.19.0.1', remoteAddress: '172.19.0.2', destroy() {} });
    assert.equal(sent.length, 1, 'об одном адресе — не чаще раза в час');
    let ok = true;
    lan.onConnection({ localAddress: '127.0.0.1', remoteAddress: '127.0.0.1', destroy: () => { ok = false; } });
    assert.equal(ok, true);
  } finally { lan.stop(); }
});

test('«Запустить программу» не выполняет команды в обход запрета', async () => {
  for (const bad of ['notepad & calc', 'cmd /c del x', 'a | b', 'x > y', 'powershell -enc AAA%', '"calc"&whoami', 'notepad^&calc']) {
    await assert.rejects(misc.launch(bad), /имя программы/, bad);
  }
});
