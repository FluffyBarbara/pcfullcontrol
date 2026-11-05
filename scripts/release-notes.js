'use strict';
// Печатает описание релиза (Markdown) для текущей версии из src/shared/changelog.js.
const { CHANGELOG } = require('../src/shared/changelog');
const { version } = require('../package.json');

const entry = CHANGELOG.find((v) => v.version === version);
const repo = 'https://github.com/FluffyBarbara/pcfullcontrol';
const lines = [];
if (entry) {
  lines.push(`## ${entry.title}`, '');
  for (const [, text] of entry.items) lines.push(`- ${text}`);
  lines.push('');
}
lines.push(
  '## Скачать',
  '',
  '| Устройство | Файл |',
  '|---|---|',
  `| 💻 Компьютер (Windows 10/11) | [PCFullControl-Setup.exe](${repo}/releases/latest/download/PCFullControl-Setup.exe) |`,
  `| 🤖 Телефон Android | [PCControl-Android.apk](${repo}/releases/latest/download/PCControl-Android.apk) |`,
  '| 🍏 iPhone | Отсканируйте камерой QR-код в программе на ПК → откроется Safari → «Поделиться» → «На экран Домой» |',
  '',
  'Если Windows покажет «Неизвестный издатель» — «Подробнее» → «Выполнить в любом случае».',
  'На Android разрешите установку из неизвестных источников для браузера или файлового менеджера.',
);
process.stdout.write(lines.join('\n') + '\n');
