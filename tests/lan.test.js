'use strict';
// Сервер для приложения на телефоне: привязка, доступ, основные запросы.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeCtx } = require('./helpers');
const { LanServer } = require('../src/main/lan-server');

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcc-lan-'));
  const ctx = await makeCtx({ mobile: { port: 0 }, files: { uploadDir: path.join(dir, 'up'), fullDiskAccess: true } });
  const lan = new LanServer(ctx);
  await lan.start();
  lan.openPairing(); // как будто на ПК открыт раздел «Телефон»
  const base = `http://127.0.0.1:${lan.port}`;
  const call = (p, { token, json, method, body } = {}) => fetch(base + p, {
    method: method || (json || body ? 'POST' : 'GET'),
    headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(json ? { 'Content-Type': 'application/json' } : {}) },
    body: json ? JSON.stringify(json) : body,
  });
  return { ctx, lan, base, call, dir };
}

test('мобильное приложение раздаётся без авторизации, API — только с токеном', async () => {
  const { lan, call } = await setup();
  try {
    const page = await call('/');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /PC Full Control/);
    assert.equal((await call('/shared/icons.js')).status, 200);
    assert.equal((await call('/app.js')).status, 200);
    assert.equal((await call('/api/hello')).status, 200);
    assert.equal((await call('/api/status')).status, 401);
    assert.equal((await call('/api/status', { token: 'nope' })).status, 401);
  } finally { lan.stop(); }
});

test('привязка по коду: неверный код, верный код, одноразовость, блокировка', async () => {
  const { ctx, lan, call } = await setup();
  try {
    const bad = await call('/api/pair', { json: { code: '000000x' } });
    assert.equal(bad.status, 403);
    const code = lan.pairCode().code;
    const ok = await call('/api/pair', { json: { code, name: 'Тестовый телефон', platform: 'android' } });
    assert.equal(ok.status, 200);
    const { token } = await ok.json();
    assert.ok(token.length > 30);
    assert.equal(ctx.db.listDevices()[0].name, 'Тестовый телефон');
    assert.equal((await call('/api/pair', { json: { code } })).status, 403, 'код одноразовый');
    for (let i = 0; i < 5; i++) await call('/api/pair', { json: { code: '111111' } });
    assert.equal((await call('/api/pair', { json: { code: lan.pairCode().code } })).status, 429);

    const info = await (await call('/api/info', { token })).json();
    assert.equal(info.device.name, 'Тестовый телефон');
    assert.ok(info.actions.some((a) => a.name === 'shutdown'));
    const st = await (await call('/api/status', { token })).json();
    assert.ok(st.ram.total > 0);

    const act = await (await call('/api/action/notify', { token, json: { arg: 'привет' } })).json();
    assert.equal(act.ok, true);
    assert.equal(ctx.db.recentCommands(1)[0].source, 'mobile');

    // отвязка
    assert.equal((await call('/api/unpair', { token, method: 'POST' })).status, 200);
    assert.equal((await call('/api/info', { token })).status, 401);
  } finally { lan.stop(); }
});

test('задачи и файлы через API', async () => {
  const { ctx, lan, call, dir } = await setup();
  try {
    const { token } = await (await call('/api/pair', { json: { code: lan.pairCode().code } })).json();
    let r = await call('/api/tasks', { token, json: { action: 'lock', kind: 'in', delayMinutes: 10 } });
    assert.equal(r.status, 200);
    const task = await r.json();
    assert.match(task.description, /Заблокировать/);
    r = await call('/api/tasks', { token, json: { action: 'say', kind: 'in', delayMinutes: 5 } });
    assert.equal(r.status, 400);
    assert.equal((await call(`/api/tasks/${task.id}/toggle`, { token, method: 'POST' })).status, 200);
    assert.equal((await call(`/api/tasks/${task.id}`, { token, method: 'DELETE' })).status, 200);
    assert.equal(ctx.db.listTasks().length, 0);

    r = await call(`/api/files/upload?name=${encodeURIComponent('фото.txt')}`, { token, method: 'PUT', body: 'данные с телефона' });
    assert.equal(r.status, 200);
    const up = await r.json();
    assert.equal(fs.readFileSync(up.path, 'utf8'), 'данные с телефона');
    const listing = await (await call('/api/files?path=' + encodeURIComponent(path.join(dir, 'up')), { token })).json();
    assert.ok(listing.entries.some((e) => e.name === 'фото.txt'));
    const dl = await call('/api/files/download?path=' + encodeURIComponent(up.path), { token });
    assert.equal(await dl.text(), 'данные с телефона');
    assert.equal((await call('/api/files/download?path=' + encodeURIComponent(path.join(dir, 'nope')), { token })).status, 400);
  } finally { lan.stop(); }
});

test('плеер: временная ссылка и перемотка (Range)', async () => {
  const { lan, call, dir } = await setup();
  try {
    const { token } = await (await call('/api/pair', { json: { code: lan.pairCode().code } })).json();
    const file = path.join(dir, 'song.mp3');
    fs.writeFileSync(file, Buffer.from('0123456789abcdefghij'));
    const t = await (await call('/api/files/ticket', { token, json: { path: file } })).json();
    assert.match(t.url, /^\/api\/media\/[\w-]+\/song\.mp3$/);
    // без токена, только по ссылке
    let r = await call(t.url);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'audio/mpeg');
    assert.equal(r.headers.get('accept-ranges'), 'bytes');
    r = await fetch(`http://127.0.0.1:${lan.port}${t.url}`, { headers: { Range: 'bytes=5-9' } });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-range'), 'bytes 5-9/20');
    assert.equal(await r.text(), '56789');
    r = await fetch(`http://127.0.0.1:${lan.port}${t.url}`, { headers: { Range: 'bytes=-3' } });
    assert.equal(await r.text(), 'hij');
    r = await fetch(`http://127.0.0.1:${lan.port}${t.url}`, { headers: { Range: 'bytes=50-' } });
    assert.equal(r.status, 416);
    assert.equal((await call('/api/media/nonexistent/x.mp3')).status, 403);
  } finally { lan.stop(); }
});

test('страница приложения с версией в адресах файлов и проверкой кэша', async () => {
  const { lan, call } = await setup();
  try {
    const r = await call('/');
    const html = await r.text();
    assert.match(html, /<meta name="pcfc-version" content="1\.0\.0">/);
    assert.match(html, /src="app\.js\?v=1\.0\.0"/);
    assert.match(html, /src="shared\/icons\.js\?v=1\.0\.0"/);
    const etag = r.headers.get('etag');
    assert.ok(etag);
    const again = await fetch(`http://127.0.0.1:${lan.port}/`, { headers: { 'If-None-Match': etag } });
    assert.equal(again.status, 304);
    const hello = await (await call('/api/hello')).json();
    assert.ok('mac' in hello && 'broadcast' in hello);
  } finally { lan.stop(); }
});
