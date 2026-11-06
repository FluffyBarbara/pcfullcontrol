'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Cleaner, isUnsafeRoot, OWN_INSTALLER_RE } = require('../src/main/system/cleaner');
const { parseCommand, cleanName, safeLeftoverDir } = require('../src/main/system/apps');
const { parseNotes } = require('../src/main/app-updater');
const Tips = require('../src/shared/tips');
const { makeCtx } = require('./helpers');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'pcc-opt-')); }
function file(p, size, ageMs = 0) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(size, 1));
  if (ageMs) { const t = new Date(Date.now() - ageMs); fs.utimesSync(p, t, t); }
}

test('очистка: анализ ничего не удаляет, удаляются только выбранные категории', async () => {
  const base = tmp();
  const a = path.join(base, 'cat-a');
  const b = path.join(base, 'cat-b');
  file(path.join(a, 'old.tmp'), 1000, 2 * 3600e3);
  file(path.join(a, 'sub', 'old2.tmp'), 500, 2 * 3600e3);
  file(path.join(a, 'fresh.tmp'), 300); // моложе часа — не трогаем
  file(path.join(b, 'keep.bin'), 700);
  const c = new Cleaner([
    { id: 'a', name: 'A', desc: '', roots: () => [a], minAgeMs: 3600e3 },
    { id: 'b', name: 'B', desc: '', roots: () => [b] },
  ]);
  const an = await c.analyze();
  assert.deepEqual(an.map((x) => [x.id, x.size, x.count]), [['a', 1500, 2], ['b', 700, 1]]);
  assert.ok(fs.existsSync(path.join(a, 'old.tmp')), 'анализ не должен удалять');

  await assert.rejects(() => c.clean([]), /Не выбрано/);
  await assert.rejects(() => c.clean(undefined), /Не выбрано/);
  await assert.rejects(() => c.clean(['zzz']), /Неизвестная категория/);

  const res = await c.clean(['a']);
  assert.equal(res[0].freed, 1500);
  assert.equal(res[0].skipped, 1);
  assert.ok(!fs.existsSync(path.join(a, 'old.tmp')));
  assert.ok(!fs.existsSync(path.join(a, 'sub')));
  assert.ok(fs.existsSync(path.join(a, 'fresh.tmp')), 'свежий файл остаётся');
  assert.ok(fs.existsSync(path.join(b, 'keep.bin')), 'невыбранная категория не тронута');
});

test('очистка: по ссылкам внутрь не заходит, фильтр имён работает', async () => {
  const base = tmp();
  const root = path.join(base, 'root');
  const outside = path.join(base, 'outside');
  file(path.join(outside, 'precious.txt'), 100);
  file(path.join(root, 'thumbcache_1.db'), 50);
  file(path.join(root, 'other.db'), 50);
  fs.symlinkSync(outside, path.join(root, 'link'), 'dir');
  const c = new Cleaner([{ id: 't', name: 'T', desc: '', roots: () => [root], match: (n) => /^thumbcache_|^link$/.test(n) }]);
  await c.clean(['t']);
  assert.ok(fs.existsSync(path.join(outside, 'precious.txt')), 'файл за ссылкой не удалён');
  assert.ok(!fs.existsSync(path.join(root, 'thumbcache_1.db')));
  assert.ok(fs.existsSync(path.join(root, 'other.db')), 'не подходящий под фильтр файл остаётся');
});

test('очистка: опасные корни запрещены', () => {
  assert.equal(isUnsafeRoot('/'), true);
  assert.equal(isUnsafeRoot(os.homedir()), true);
  assert.equal(isUnsafeRoot('relative/path'), true);
  assert.equal(isUnsafeRoot(path.join(os.homedir(), '.cache', 'thumbnails')), false);
  assert.ok(OWN_INSTALLER_RE.test('PCFullControl-Setup (2).exe'));
  assert.ok(OWN_INSTALLER_RE.test('PCControl-Android.apk'));
  assert.ok(!OWN_INSTALLER_RE.test('Setup.exe'));
});

test('удаление программ: разбор строки деинсталлятора и имён', () => {
  assert.deepEqual(parseCommand('"C:\\Program Files\\App\\unins000.exe" /SILENT'), { exe: 'C:\\Program Files\\App\\unins000.exe', args: '/SILENT' });
  assert.deepEqual(parseCommand('C:\\Program Files\\App X\\uninstall.exe --remove'), { exe: 'C:\\Program Files\\App X\\uninstall.exe', args: '--remove' });
  assert.deepEqual(parseCommand('MsiExec.exe /I{12345678-1234-1234-1234-123456789ABC}'), { exe: 'msiexec.exe', args: '/x {12345678-1234-1234-1234-123456789ABC}', msi: '{12345678-1234-1234-1234-123456789ABC}' });
  assert.equal(parseCommand(''), null);
  assert.equal(cleanName('Telegram Desktop 5.1.2 (x64)'), 'Telegram Desktop');
  assert.equal(cleanName('7-Zip 24.08 (x64)'), '7-Zip');
  assert.equal(safeLeftoverDir('/opt/MyApp'), true);
  assert.equal(safeLeftoverDir('/opt/Microsoft'), false);
  assert.equal(safeLeftoverDir(os.homedir()), false);
  assert.equal(safeLeftoverDir('/'), false);
  assert.equal(safeLeftoverDir('relative'), false);
});

test('описание обновления: из HTML и Markdown, без раздела «Скачать»', () => {
  const html = '<h2>Новая версия</h2><ul><li>Первое &amp; важное</li><li><strong>Второе</strong></li></ul><h2>Скачать</h2><ul><li>ссылка</li></ul>';
  assert.deepEqual(parseNotes(html), { title: 'Новая версия', items: ['Первое & важное', 'Второе'], versions: [] });
  assert.deepEqual(parseNotes('## Заголовок\n\n- раз\n- два\n\n## Скачать\n\n- нет'), { title: 'Заголовок', items: ['раз', 'два'], versions: [] });
  // Лента GitHub: экранированный HTML и описания нескольких версий сразу
  const many = parseNotes([
    { version: '1.11.3', note: '&lt;h2&gt;Живой микшер&lt;/h2&gt;&lt;ul&gt;&lt;li&gt;Полоса в такт звуку&lt;/li&gt;&lt;/ul&gt;&lt;h2&gt;Скачать&lt;/h2&gt;' },
    { version: '1.12.0', note: '<h2>Игры и сбои</h2><ul><li>Новый раздел</li><li>Диагностика сети</li></ul>' },
  ]);
  assert.deepEqual(many.versions.map((v) => [v.version, v.title, v.items.length]), [['1.12.0', 'Игры и сбои', 2], ['1.11.3', 'Живой микшер', 1]]);
  assert.equal(many.items.length, 3);
  assert.deepEqual(parseNotes(null), { title: '', items: [], versions: [] });
});

test('у каждого действия есть описание для подсказки', async () => {
  const ctx = await makeCtx();
  for (const a of ctx.actions.actions.values()) assert.ok(Tips.ACTIONS[a.name], `нет описания для ${a.name}`);
});

test('уборка после обновления: копия программы распознаётся по файлам, чужая папка — нет', () => {
  const { isOurInstall } = require('../src/main/system/self-cleanup');
  const d = tmp();
  fs.mkdirSync(path.join(d, 'resources'));
  fs.writeFileSync(path.join(d, 'PCFullControl.exe'), 'x');
  assert.equal(isOurInstall(d), false, 'без resources/app.asar — не наша копия');
  fs.writeFileSync(path.join(d, 'resources', 'app.asar'), 'не настоящий архив');
  assert.equal(isOurInstall(d), true);
  const other = tmp();
  fs.writeFileSync(path.join(other, 'Other.exe'), 'x');
  assert.equal(isOurInstall(other), false);
});
