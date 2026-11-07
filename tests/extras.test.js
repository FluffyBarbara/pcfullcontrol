'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseArp, subnetHosts, vendorOf, isRandomMac } = require('../src/main/system/network');
const { parseSmi, parsePresentHeader, FpsMonitor } = require('../src/main/system/gpu');
const { assess, normalize } = require('../src/main/system/disk-health');
const { parseFailedLogons } = require('../src/main/intruder');
const weekly = require('../src/main/weekly');
const { FileManager } = require('../src/main/system/files');
const { makeCtx } = require('./helpers');

test('сеть: разбор таблицы ARP Windows и Linux', () => {
  const win = `
Интерфейс: 192.168.1.10 --- 0x7
  адрес в Интернете      Физический адрес      Тип
  192.168.1.1           50-c7-bf-12-34-56     динамический
  192.168.1.23          a6-11-22-33-44-55     динамический
  192.168.1.255         ff-ff-ff-ff-ff-ff     статический
  224.0.0.22            01-00-5e-00-00-16     статический`;
  assert.deepEqual(parseArp(win), [{ ip: '192.168.1.1', mac: '50:C7:BF:12:34:56' }, { ip: '192.168.1.23', mac: 'A6:11:22:33:44:55' }]);
  const lin = '192.168.0.1 dev eth0 lladdr 04:d4:c4:aa:bb:cc REACHABLE\n192.168.0.7 dev eth0  FAILED';
  assert.deepEqual(parseArp(lin), [{ ip: '192.168.0.1', mac: '04:D4:C4:AA:BB:CC' }]);
  assert.equal(subnetHosts('192.168.1.10', '255.255.255.0').length, 254);
  assert.equal(subnetHosts('10.0.0.5', '255.0.0.0').length, 1022, 'большие сети ограничены 1024 адресами');
  assert.equal(vendorOf('50:C7:BF:00:00:00'), 'TP-Link');
  assert.ok(isRandomMac('A6:11:22:33:44:55'));
  assert.match(vendorOf('DA:11:22:33:44:55'), /телефон/);
});

test('видеокарта: разбор nvidia-smi и заголовка PresentMon', () => {
  const g = parseSmi('NVIDIA GeForce GTX 1070, 64, 37, 12, 2048, 8192, 1683, 4006, 1911, 85.40, 151.00, 45, 560.94\n');
  assert.equal(g.length, 1);
  assert.equal(g[0].name, 'NVIDIA GeForce GTX 1070');
  assert.equal(g[0].temp, 64);
  assert.equal(g[0].memTotal, 8192 * 1048576);
  assert.equal(g[0].power, 85.4);
  assert.equal(parseSmi('Foo, [N/A], [N/A]')[0].temp, null);
  const h = parsePresentHeader('Application,ProcessID,SwapChainAddress,Runtime,SyncInterval,PresentFlags,MsBetweenPresents,MsBetweenDisplayChange');
  assert.deepEqual(h, { app: 0, pid: 1, ms: 6, displayed: 7 });
  // Подсчёт кадров: 60 кадров по 16.67 мс → 60 к/с, браузер — в конце списка
  const f = new FpsMonitor({ exePath: null });
  for (let i = 0; i < 60; i++) f.onLine(`game.exe,1,0,DXGI,0,0,16.667,16.667`, h);
  for (let i = 0; i < 90; i++) f.onLine(`chrome.exe,2,0,DXGI,0,0,11.1,11.1`, h);
  const cur = f.current();
  assert.equal(cur[0].app, 'game.exe');
  assert.equal(cur[0].fps, 60);
  assert.equal(cur[1].ignored, true);
});

test('диски: оценка здоровья', () => {
  assert.equal(assess({ health: 'Healthy', wear: 5, temp: 40, media: 'SSD' }).level, 'ok');
  assert.equal(assess({ health: 'Healthy', wear: 75, media: 'SSD' }).level, 'warn');
  assert.equal(assess({ health: 'Unhealthy' }).level, 'bad');
  assert.equal(assess({ predictFailure: true }).level, 'bad');
  assert.equal(assess({ media: 'HDD', temp: 58 }).level, 'warn');
  assert.equal(assess({ kind: 'hdd', reallocated: 8 }).level, 'warn', 'переназначенные сектора — «Тревога», как в CrystalDiskInfo');
  assert.equal(assess({ kind: 'hdd', crcErrors: 3 }).level, 'ok', 'ошибки кабеля — только замечание');
  assert.equal(assess({ kind: 'nvme', temp: 72 }).level, 'ok', 'NVMe при 72°C — норма');
  assert.equal(assess({ kind: 'nvme', temp: 82 }).level, 'warn');
  assert.equal(assess({ kind: 'ssd', temp: 72 }).level, 'warn');
  const n = normalize([{ id: '0', model: 'Samsung SSD 970', media: 'SSD', bus: 'NVMe', size: 500e9, health: 'Healthy', wear: '3', temp: 41, hours: 8000 }]);
  assert.equal(n[0].level, 'ok');
  assert.equal(n[0].wear, 3);
  assert.equal(n[0].kind, 'nvme');
  // Жёсткий диск, который Windows называет «Unspecified»: тип — по скорости вращения, износа у HDD нет
  const h = normalize([{ id: '2', model: 'ST1000DM010-2EP102', media: 'Unspecified', bus: 'SATA', spindle: 7200, size: 1e12, health: 'Healthy', wear: 0 }]);
  assert.equal(h[0].kind, 'hdd');
  assert.equal(h[0].media, 'HDD');
  assert.equal(h[0].rpm, 7200);
  assert.equal(h[0].wear, null);
});

const { SMART_HDD, SMART_SSD, SMART_NVME } = require('./fixtures/smart-samples');

test('диски: разбор SMART (smartctl) — HDD, SATA SSD и NVMe, как в CrystalDiskInfo', () => {
  const { parseSmart, merge, fromWindows, sdIndex } = require('../src/main/system/disk-health');
  const hdd = parseSmart(SMART_HDD);
  assert.equal(hdd.kind, 'hdd');
  assert.equal(hdd.rpm, 7200);
  assert.equal(hdd.life, null, 'у жёсткого диска нет «ресурса»');
  assert.equal(hdd.pending, 16);
  assert.equal(hdd.written, 20000000000 * 512);
  assert.equal(hdd.attrs.find((a) => a.id === 'C5').status, 'warn');
  assert.equal(hdd.attrs.find((a) => a.id === '05').name, 'Переназначенные сектора');
  const ssd = parseSmart(SMART_SSD);
  assert.equal(ssd.kind, 'ssd');
  assert.equal(ssd.life, 94, 'ресурс — из статистики устройства (100 − 6)');
  assert.equal(ssd.trim, true);
  assert.equal(ssd.written, 46875000000 * 512);
  const nv = parseSmart(SMART_NVME);
  assert.equal(nv.kind, 'nvme');
  assert.equal(nv.life, 96);
  assert.equal(nv.written, 50000000 * 512000);
  assert.equal(nv.unsafeShutdowns, 77);
  assert.ok(nv.attrs.some((a) => a.name === 'Использовано ресурса' && a.raw === '4%'));
  assert.equal(sdIndex('/dev/sdc'), 2);
  assert.equal(sdIndex('/dev/sdaa'), 26);
  // Windows путает типы и серийные номера: сопоставляем по номеру, серийнику и модели
  const win = [
    { id: '0', model: 'Samsung SSD 860 EVO 500GB', serial: 'S3Z1NB0K123456X', media: 'SSD', bus: 'SATA', size: 500107862016, health: 'Healthy', parts: [{ letter: 'C:', label: '', size: 499e9, free: 120e9 }] },
    { id: '1', model: 'Samsung SSD 970 EVO Plus 1TB', serial: '0025_3880_91B2_1234.', media: 'SSD', bus: 'NVMe', size: 1000204886016, health: 'Healthy', parts: { letter: 'D:', label: 'Игры', size: 1e12, free: 3e11 } },
    { id: '2', model: 'ST1000DM010-2EP102', serial: 'Z9A1B2C3', media: 'SSD', bus: 'SATA', size: 1000204886016, health: 'Healthy', wear: 0, parts: [] },
  ].map(fromWindows);
  const all = merge(win, [hdd, ssd, nv]);
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((d) => d.kind), ['ssd', 'nvme', 'hdd'], 'жёсткий диск определён как HDD, хотя Windows назвала его SSD');
  assert.equal(all[2].media, 'HDD');
  assert.equal(all[2].level, 'warn');
  assert.match(all[2].reasons.join(' '), /нестабильные сектора: 16/);
  assert.equal(all[0].life, 94);
  assert.equal(all[0].volumes, 'C:');
  assert.equal(all[1].parts[0].label, 'Игры');
  assert.equal(all[1].level, 'ok');
  assert.equal(all[1].hours, 9000);
});

test('безопасность: разбор неудачных входов (событие 4625)', () => {
  const xml = `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><EventID>4625</EventID><TimeCreated SystemTime='2026-11-05T10:00:00.0Z'/><EventRecordID>123</EventRecordID></System>
<EventData><Data Name='TargetUserName'>Иван</Data><Data Name='TargetDomainName'>PC</Data><Data Name='LogonType'>2</Data><Data Name='IpAddress'>-</Data></EventData></Event>
<Event><System><EventRecordID>124</EventRecordID></System><EventData><Data Name='TargetUserName'>bob</Data><Data Name='LogonType'>3</Data></EventData></Event>`;
  const ev = parseFailedLogons(xml);
  assert.equal(ev.length, 2);
  assert.deepEqual([ev[0].id, ev[0].user, ev[0].logonType], [123, 'Иван', '2']);
  assert.equal(ev[1].logonType, '3');
});

test('отчёт за неделю: данные и расписание', async () => {
  const ctx = await makeCtx();
  const now = Date.now() / 1000;
  for (let i = 0; i < 120; i++) ctx.db.db.run('INSERT INTO metrics(ts, cpu, ram, disk, temp) VALUES (?,?,?,?,?)', [now - i * 30, 20 + (i % 10), 50, 60, 55]);
  ctx.db.addAppUsage(new Date().toISOString().slice(0, 10), 'chrome', 3600);
  ctx.db.addOutage(now - 3600, now - 3000);
  ctx.db.addSpeedtest({ ts: now - 100, down: 95.5, up: 40.1, ping: 12 });
  ctx.db.addFreed(5 * 1048576, 'test');
  const r = weekly.build(ctx);
  assert.equal(r.data.onSec, 120 * 30);
  assert.match(r.text, /Компьютер работал: 1 ч 0 мин/);
  assert.match(r.text, /Google Chrome — 1 ч 0 мин/);
  assert.match(r.text, /Обрывов: 1/);
  assert.match(r.text, /95\.5/);
  assert.match(r.text, /Освобождено места: 5\.0 МБ/);
  // Воскресенье 20:30 — пора; суббота — нет; повторно в ту же неделю — нет
  assert.equal(weekly.isDue(null, new Date(2026, 10, 8, 20, 30)), true);
  assert.equal(weekly.isDue(null, new Date(2026, 10, 7, 21, 0)), false);
  assert.equal(weekly.isDue(new Date(2026, 10, 8, 20, 0).getTime() / 1000, new Date(2026, 10, 9, 9, 0)), false);
  assert.equal(weekly.isDue(new Date(2026, 10, 1, 20, 0).getTime() / 1000, new Date(2026, 10, 9, 9, 0)), true);
});

test('файлы: удаляются только выбранные, системные — никогда', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcc-del-'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'c.txt'), 'c');
  const fm = new FileManager(() => ({ files: { allowedRoots: [], uploadDir: dir, fullDiskAccess: true } }));
  await assert.rejects(() => fm.deletePaths([]), /Ничего не выбрано/);
  const trashed = [];
  const r = await fm.deletePaths([path.join(dir, 'a.txt'), path.join(dir, 'sub')], { trash: async (p) => { trashed.push(p); fs.rmSync(p, { recursive: true }); } });
  assert.deepEqual(r.map((x) => x.ok), [true, true]);
  assert.equal(trashed.length, 2, 'по умолчанию — в корзину');
  assert.ok(fs.existsSync(path.join(dir, 'b.txt')), 'невыбранный файл остался');
  const perm = await fm.deletePaths([path.join(dir, 'b.txt')], { permanent: true, trash: async () => { throw new Error('не должна вызываться'); } });
  assert.equal(perm[0].ok, true);
  const prot = await fm.deletePaths(['/', os.homedir()], { permanent: true });
  assert.ok(prot.every((x) => !x.ok && /нужна системе/.test(x.error)));
  assert.ok(fs.existsSync(os.homedir()));
});
