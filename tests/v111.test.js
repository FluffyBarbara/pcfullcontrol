'use strict';
// v1.11: музыка, игры, синие экраны, USB, виджет, ассистент, место на диске, команды бота.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeCtx, makeBot } = require('./helpers');
const { LanServer } = require('../src/main/lan-server');

test('синие экраны: разбор журнала, объединение BugCheck и Kernel-Power, понятные причины', () => {
  const { parseEvents, buildCrashes, normCode } = require('../src/main/crashes');
  const xml = `
<Event><System><Provider Name='Microsoft-Windows-Kernel-Power'/><EventID>41</EventID><TimeCreated SystemTime='2026-11-03T05:30:10.0Z'/><EventRecordID>500</EventRecordID></System>
<EventData><Data Name='BugcheckCode'>278</Data><Data Name='PowerButtonTimestamp'>0</Data></EventData></Event>
<Event><System><Provider Name='Microsoft-Windows-WER-SystemErrorReporting'/><EventID Qualifiers='16384'>1001</EventID><TimeCreated SystemTime='2026-11-03T05:31:40.0Z'/><EventRecordID>501</EventRecordID></System>
<EventData><Data>0x00000116 (0xffff8a8f3b2e7010, 0xfffff8063a4b1234, 0x0000000000000000, 0x000000000000000d)</Data><Data>C:\\Windows\\MEMORY.DMP</Data><Data>abc</Data></EventData></Event>
<Event><System><Provider Name='Microsoft-Windows-Kernel-Power'/><EventID>41</EventID><TimeCreated SystemTime='2026-10-17T05:00:00.0Z'/><EventRecordID>300</EventRecordID></System>
<EventData><Data Name='BugcheckCode'>0</Data><Data Name='PowerButtonTimestamp'>0</Data></EventData></Event>`;
  const ev = parseEvents(xml);
  assert.equal(ev.length, 3);
  const list = buildCrashes(ev);
  assert.equal(list.length, 2, 'два события одного сбоя — одна запись');
  assert.equal(list[0].code, '0x00000116');
  assert.equal(list[0].name, 'VIDEO_TDR_FAILURE');
  assert.match(list[0].text, /Видеокарта/);
  assert.match(list[0].advice, /драйвер/);
  assert.equal(list[1].kind, 'power');
  assert.equal(normCode('0x1000007E'), 0x7E);
});

test('USB: несколько записей Windows → одно понятное уведомление', () => {
  const { summarize } = require('../src/main/usbwatch');
  const s = summarize([
    { name: 'Запоминающее устройство для USB', cls: 'USB', id: 'USB\\VID_0951&PID_1666\\1', mfr: '' },
    { name: 'Kingston DataTraveler 3.0 USB Device', cls: 'DiskDrive', id: 'USBSTOR\\DISK&VEN_KINGSTON\\1', mfr: '(Стандартные дисковые накопители)' },
  ]);
  assert.equal(s.kind, 'disk');
  assert.equal(s.name, 'Kingston DataTraveler 3.0');
  assert.equal(summarize([{ name: 'x', cls: 'Bluetooth', id: 'BTHENUM\\x' }]), null, 'Bluetooth-службы не спамят');
});

test('музыка: понятное имя плеера, окно, позиция с учётом времени', () => {
  const { appInfo, describe } = require('../src/main/system/mediainfo');
  assert.equal(appInfo('Spotify.exe').name, 'Spotify');
  assert.equal(appInfo('308046B0AF4A39CB').name, 'Firefox');
  assert.equal(appInfo('Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic').name, 'Медиаплеер Windows');
  const d = describe({ app: 'chrome.exe', title: 'Song', artist: 'Band', status: 'Playing', position: 10, duration: 200, updated: 1000, hasThumb: true, canNext: true },
    [{ pid: 7, name: 'chrome', title: 'Band - Song - YouTube — Google Chrome', path: 'C:\\chrome.exe' }], 6000);
  assert.equal(d.appName, 'Google Chrome');
  assert.equal(d.window, 'Band - Song - YouTube — Google Chrome');
  assert.equal(d.position, 15);
  assert.ok(d.cover);
  assert.equal(d.can.next, true);
});

test('игры: время и средний FPS по дням, отчёт за неделю с играми', async () => {
  const ctx = await makeCtx();
  const { localDay } = require('../src/main/activity');
  ctx.db.addGameUsage(localDay(), 'cs2', 'Counter-Strike 2', 15, 240);
  ctx.db.addGameUsage(localDay(), 'cs2', 'Counter-Strike 2', 15, 260);
  ctx.db.addGameUsage(localDay(), 'eldenring', 'ELDEN RING', 15, null);
  const g = ctx.games(7);
  assert.equal(g.total, 45);
  assert.equal(g.games[0].title, 'Counter-Strike 2');
  assert.equal(g.games[0].avgFps, 250);
  assert.equal(g.games[1].avgFps, null);
  assert.match(require('../src/main/weekly').build(ctx).text, /Игры: .*\n• Counter-Strike 2/);
});

test('виджет: ключ телефона, данные и кнопки без токена, отзыв при отвязке', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcc-w-'));
  const ctx = await makeCtx({ mobile: { port: 0 }, files: { uploadDir: dir } });
  const lan = new LanServer(ctx);
  await lan.start();
  const base = `http://127.0.0.1:${lan.port}`;
  try {
    const { token } = await (await fetch(base + '/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: lan.pairCode().code, name: 'Телефон' }) })).json();
    assert.equal((await fetch(base + '/api/widget?k=bad')).status, 401);
    const { key } = await (await fetch(base + '/api/widget/key', { method: 'POST', headers: { Authorization: 'Bearer ' + token } })).json();
    const w = await (await fetch(`${base}/api/widget?k=${key}`)).json();
    assert.equal(w.app, 'pc-full-control');
    const txt = await (await fetch(`${base}/api/widget/text?k=${key}`)).text();
    assert.match(txt, /ЦП/);
    let ran = null;
    ctx.actions.run = async (name) => { ran = name; return { ok: true, result: 'ok' }; };
    assert.equal((await fetch(`${base}/api/widget/action?k=${key}`, { method: 'POST', body: JSON.stringify({ action: 'rm -rf' }) })).status, 400, 'только разрешённые кнопки');
    await fetch(`${base}/api/widget/action?k=${key}&action=lock`, { method: 'POST' });
    assert.equal(ran, 'lock');
    // Android-приложение (страница http://localhost) может обращаться к ассистенту и виджету
    const pre = await fetch(base + '/api/assistant/audio', { method: 'OPTIONS', headers: { Origin: 'http://localhost' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), 'http://localhost');
    ctx.db.removeDevice(ctx.db.listDevices()[0].id);
    assert.equal((await fetch(`${base}/api/widget?k=${key}`)).status, 401, 'отвязали телефон — виджет отключён');
  } finally { lan.stop(); }
});

test('ассистент: понимает фразу, опасное — только после подтверждения', async () => {
  const ctx = await makeCtx();
  const calls = [];
  ctx.actions.run = async (name, arg) => { calls.push([name, arg]); return { ok: true, result: 'Готово' }; };
  let r = await ctx.assistant.handle('выключи компьютер через 10 минут');
  assert.equal(r.needConfirm, true);
  assert.equal(calls.length, 0, 'без подтверждения не выполняет');
  r = await ctx.assistant.handle(r.heard, { confirm: true });
  assert.deepEqual(calls[0], ['shutdown', '10']);
  r = await ctx.assistant.handle('громкость 30');
  assert.deepEqual(calls[1], ['set_volume', '30']);
  assert.equal(r.ok, true);
  r = await ctx.assistant.handle('абракадабра');
  assert.equal(r.ok, false);
  ctx.media.state = async () => ({ sessions: [{ title: 'Song', artist: 'Band', appName: 'Spotify', playing: true }] });
  r = await ctx.assistant.handle('что сейчас играет?');
  assert.match(r.reply, /Band — Song, в Spotify/);
});

test('место на диске: удаление выбранного, системное защищено', async () => {
  const ctx = await makeCtx();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcc-sp-'));
  fs.writeFileSync(path.join(dir, 'a.bin'), Buffer.alloc(2000));
  fs.writeFileSync(path.join(dir, 'b.bin'), Buffer.alloc(2000));
  const r = await ctx.space.remove([path.join(dir, 'a.bin')], true);
  assert.equal(r[0].ok, true);
  assert.ok(fs.existsSync(path.join(dir, 'b.bin')), 'невыбранный файл остался');
  await assert.rejects(() => ctx.space.remove([path.join(dir, 'b.bin')], false), /Корзина недоступна/, 'без корзины в обход неё не удаляем');
  const prot = await ctx.space.remove([os.homedir()], true);
  assert.equal(prot[0].ok, false);
});

test('бот: /music с обложкой и кнопками, /games, /crashes, /panic с подтверждением', async () => {
  const { bot, ctx, fake } = await makeBot();
  ctx.media.state = async () => ({ available: true, sessions: [{ app: 'Spotify.exe', appName: 'Spotify', title: 'Get Lucky', artist: 'Daft Punk', album: 'RAM', statusText: 'играет', playing: true, position: 30, duration: 240, genres: [], can: { next: true, prev: true }, cover: 'k', window: 'Spotify' }] });
  ctx.media.cover = () => ({ buf: Buffer.from('jpg'), type: 'image/jpeg' });
  const msg = (text) => ({ message_id: 1, chat: { id: 111, type: 'private' }, from: { id: 111, first_name: 'Хозяин' }, text });
  await bot.onMessage(msg('/music'));
  const m = fake.last();
  assert.equal(m.kind, 'photo');
  assert.match(m.text, /Get Lucky[\s\S]*Daft Punk[\s\S]*Spotify/);
  assert.ok(JSON.stringify(m.kb).includes('mu|next'));
  ctx.crashes.list = async () => [];
  await bot.onMessage(msg('/crashes'));
  assert.match(fake.last().text, /не было/);
  await bot.onMessage(msg('/games'));
  assert.match(fake.last().text, /игр не было/);
  await bot.onMessage(msg('/panic'));
  assert.match(fake.last().text, /Тревожная кнопка/);
  assert.ok(JSON.stringify(fake.last().kb).includes('pny'), 'сначала спрашивает');
});
