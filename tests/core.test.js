'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Database } = require('../src/main/db');
const { makeCtx } = require('./helpers');
const { parseTime, parseDuration, parseWeekdays, isDue, describeWeekdays } = require('../src/main/scheduler');
const { cleanOutput } = require('../src/main/system/exec');
const { FileManager, FileAccessError, safeFilename } = require('../src/main/system/files');
const { cmpVersions } = require('../src/main/app-updater');
const { deepMerge, DEFAULTS } = require('../src/main/config');

test('база сохраняется на диск и читается обратно', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcc-'));
  const file = path.join(dir, 'db.sqlite');
  const db = await Database.open(file);
  db.setSetting('x', { a: 1 });
  const id = db.addTask({ action: 'lock', kind: 'once', runAt: 123 });
  assert.ok(id > 0);
  db.close();
  const db2 = await Database.open(file);
  assert.deepEqual(db2.getSetting('x'), { a: 1 });
  assert.equal(db2.getTask(id).action, 'lock');
  assert.equal(db2.deleteTask(id), true);
  assert.equal(db2.deleteTask(id), false);
  db2.close();
});

test('настройки: слияние с умолчаниями, массивы заменяются', () => {
  const cfg = deepMerge(DEFAULTS, { monitor: { cpuPercent: 50 }, apps: [] });
  assert.equal(cfg.monitor.cpuPercent, 50);
  assert.equal(cfg.monitor.ramPercent, 90);
  assert.deepEqual(cfg.apps, []);
});

test('разбор времени, длительности и дней недели', () => {
  assert.deepEqual(parseTime('23:30'), [23, 30]);
  assert.throws(() => parseTime('25:00'));
  assert.equal(parseDuration('30'), 1800);
  assert.equal(parseDuration('1h30m'), 5400);
  assert.equal(parseDuration('2ч'), 7200);
  assert.equal(parseDuration('45мин'), 2700);
  assert.throws(() => parseDuration('soon'));
  assert.deepEqual(parseWeekdays('пн-пт'), [0, 1, 2, 3, 4]);
  assert.deepEqual(parseWeekdays('сб,вс'), [5, 6]);
  assert.deepEqual(parseWeekdays('пт-пн'), [0, 4, 5, 6]);
  assert.deepEqual(parseWeekdays('будни'), [0, 1, 2, 3, 4]);
  assert.equal(parseWeekdays('shutdown'), null);
  assert.equal(describeWeekdays('0,1,2,3,4'), 'по будням');
});

test('isDue: ежедневные и разовые задачи', () => {
  const now = new Date(2026, 10, 4, 23, 5); // среда
  const daily = { kind: 'daily', time_of_day: '23:00', weekdays: '0,1,2,3,4', last_run: null };
  assert.equal(isDue(daily, now), 'run');
  assert.equal(isDue({ ...daily, last_run: now.getTime() / 1000 }, now), null);
  assert.equal(isDue({ ...daily, weekdays: '5,6' }, now), null);
  assert.equal(isDue({ ...daily, time_of_day: '20:00' }, now), null);
  const ts = now.getTime() / 1000;
  assert.equal(isDue({ kind: 'once', run_at: ts - 60 }, now), 'run');
  assert.equal(isDue({ kind: 'once', run_at: ts - 7200 }, now), 'missed');
  assert.equal(isDue({ kind: 'once', run_at: ts + 60 }, now), null);
});

test('планировщик выполняет задачу и выключает разовую', async () => {
  const ctx = await makeCtx();
  const id = ctx.scheduler.addOnce('notify', 'Привет', Date.now() / 1000 - 5);
  await ctx.scheduler.tick();
  const t = ctx.db.getTask(id);
  assert.equal(t.enabled, 0);
  assert.ok(t.last_run);
  assert.equal(ctx.db.recentCommands(1)[0].action, 'notify');
});

test('задача проверки обновлений создаётся один раз', async () => {
  const ctx = await makeCtx();
  ctx.scheduler.ensureDefaultTasks();
  ctx.scheduler.ensureDefaultTasks();
  const tasks = ctx.db.listTasks();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].action, 'check_updates');
});

test('действия: терминал выключен по умолчанию, параметры обязательны', async () => {
  const ctx = await makeCtx();
  let r = await ctx.actions.run('shell', 'echo hi');
  assert.equal(r.ok, false);
  assert.match(r.result, /отключено/);
  r = await ctx.actions.run('kill', '');
  assert.equal(r.ok, false);
  r = await ctx.actions.run('nope');
  assert.equal(r.ok, false);
  ctx.updateConfig({ security: { allowShell: true } });
  r = await ctx.actions.run('shell', 'echo привет');
  assert.equal(r.ok, true);
  assert.match(r.result, /привет/);
});

test('завершение несуществующего процесса', async () => {
  const ctx = await makeCtx();
  const r = await ctx.actions.run('kill', 'definitely_not_running_xyz');
  assert.equal(r.ok, false);
  assert.match(r.result, /не найден/);
});

test('очистка вывода от прогресса и ANSI', () => {
  assert.equal(cleanOutput('Progress \r - \r\\ \rDone\r\n\x1b[32mOK\x1b[0m\r\n'), 'Done\nOK');
});

test('файлы: ограничение папками и безопасные имена', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcc-files-'));
  const allowed = path.join(dir, 'allowed');
  fs.mkdirSync(allowed);
  fs.writeFileSync(path.join(allowed, 'a.txt'), 'x');
  const fm = new FileManager(() => ({ files: { allowedRoots: [allowed], uploadDir: path.join(dir, 'up') } }));
  assert.deepEqual(fm.listDir(allowed).map((e) => e.name), ['a.txt']);
  assert.throws(() => fm.listDir(dir), FileAccessError);
  assert.throws(() => fm.listDir(path.join(allowed, '..', '..')), FileAccessError);
  assert.equal(fm.parent(allowed), null);
  assert.equal(safeFilename('../../evil.txt'), 'evil.txt');
  const p1 = fm.saveUpload('../x.txt', Buffer.from('1'));
  const p2 = fm.saveUpload('x.txt', Buffer.from('2'));
  assert.notEqual(p1, p2);
  assert.equal(fs.readFileSync(p1, 'utf8'), '1');
});

test('сравнение версий', () => {
  assert.equal(cmpVersions('v1.2.0', '1.1.9'), 1);
  assert.equal(cmpVersions('1.0.0', '1.0.0'), 0);
  assert.equal(cmpVersions('1.0.0', '1.0.1'), -1);
});

test('у текущей версии есть запись в истории изменений', () => {
  const { CHANGELOG, between } = require('../src/shared/changelog');
  const { version } = require('../package.json');
  assert.ok(CHANGELOG.some((v) => v.version === version), `нет записи для ${version}`);
  assert.deepEqual(between('1.0.0', '1.1.0').map((v) => v.version), ['1.1.0']);
  assert.deepEqual(between('1.1.0', '1.2.0').map((v) => v.version), ['1.2.0']);
  assert.equal(between(null, '1.0.0').length, 1);
});
