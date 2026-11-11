'use strict';
// Описание релиза (Markdown) из src/shared/changelog.js.
// Версия x.y.0 — большое обновление (свой релиз на GitHub); x.y.1, x.y.2… — исправления: публикуются
// в тот же релиз x.y.0, а в описании появляется раздел «Исправления».
const { CHANGELOG, cmp } = require('../src/shared/changelog');
const { version } = require('../package.json');

const [maj, min] = version.split('.');
const base = `${maj}.${min}.0`;
const main = CHANGELOG.find((v) => v.version === base);
const fixes = CHANGELOG.filter((v) => { const p = v.version.split('.'); return p[0] === maj && p[1] === min && Number(p[2]) > 0 && cmp(v.version, version) <= 0; })
  .sort((a, b) => cmp(b.version, a.version));
const repo = 'https://github.com/FluffyBarbara/pcfullcontrol';
const lines = [];
if (main) {
  lines.push(`## ${main.title}`, '');
  for (const [, text] of main.items) lines.push(`- ${text}`);
  lines.push('');
}
if (fixes.length) {
  lines.push('## 🔧 Исправления', '');
  for (const f of fixes) {
    lines.push(`**${f.version}** — ${f.title}`);
    for (const [, text] of f.items) lines.push(`- ${text}`);
    lines.push('');
  }
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
  'Установщик пока без платной цифровой подписи: Windows может показать «Неизвестный издатель». Перед запуском сверьте SHA-256 файла (`Get-FileHash PCFullControl-Setup.exe` в PowerShell) с суммой ниже — совпала: «Подробнее» → «Выполнить в любом случае». Не совпала — не запускайте.',
  'На Android разрешите установку из неизвестных источников для браузера или файлового менеджера.',
);
process.stdout.write(lines.join('\n') + '\n');
