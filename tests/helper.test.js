'use strict';
// Фоновый помощник: разбор строк, перезапуск с нужными частями, команда «вернуть память».
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Helper } = require('../src/main/system/helper');

// Оболочка, а не node: дочерний node внутри «node --test» ведёт себя как часть тестов
const FAKE = `#!/bin/sh
echo ready
case "$*" in *activity*) printf '%s\\n' 'A|chrome|3|C:\\Program Files\\Google\\chrome.exe|0|Google Chrome';; esac
case "$*" in *usb*) echo 'U|ready'; printf '%s\\n' 'U|{"kind":"add","name":"Kingston DataTraveler","cls":"DiskDrive","id":"USBSTOR\\\\DISK","mfr":""}';; esac
while read -r l; do echo "echo $l"; done
`;

test('помощник: учёт программ, USB и возврат памяти через один процесс', { skip: process.platform === 'win32' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcfc-helper-'));
  const exe = path.join(dir, 'fake-helper');
  fs.writeFileSync(exe, FAKE, { mode: 0o755 });
  const h = new Helper({ exe });
  t.after(() => { h.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.equal(h.available, true);
  const got = { activity: [], usb: [], echo: [] };
  h.on('activity', (l) => got.activity.push(l));
  h.on('usb', (e) => got.usb.push(e));
  h.use('activity');
  h.use('usb');
  h.use('usb'); // повторное включение не перезапускает
  for (let i = 0; i < 50 && (!got.activity.length || !got.usb.length); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(got.activity[0], 'chrome|3|C:\\Program Files\\Google\\chrome.exe|0|Google Chrome');
  assert.equal(got.usb.length, 1);
  assert.equal(got.usb[0].name, 'Kingston DataTraveler');
  h.proc.stdout.on('data', (d) => got.echo.push(String(d)));
  assert.equal(h.trim([101, 202]), true);
  for (let i = 0; i < 30 && !got.echo.join('').includes('trim'); i++) await new Promise((r) => setTimeout(r, 100));
  assert.match(got.echo.join(''), /echo trim 101 202/);
  const p = h.proc;
  h.stop();
  await new Promise((r) => (p.exitCode !== null ? r() : p.on('exit', r)));
  assert.equal(h.proc, null);
  assert.equal(h.trim([1]), false);
});

test('помощник: без файла — недоступен, модули работают по-старому', () => {
  const h = new Helper({ exe: null });
  assert.equal(h.available, false);
  assert.equal(h.use('activity'), false);
  assert.equal(h.trim([1]), false);
});
