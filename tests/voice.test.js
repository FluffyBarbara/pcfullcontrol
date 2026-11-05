'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseVoiceCommand: p, parseDelay } = require('../src/main/voice-commands');

const cases = [
  ['Выключи компьютер.', 'shutdown', ''],
  ['Выключи компьютер через полчаса', 'shutdown', '30'],
  ['выключи комп через 2 часа', 'shutdown', '120'],
  ['Выключи компьютер через пять минут!', 'shutdown', '5'],
  ['Перезагрузи компьютер', 'reboot', ''],
  ['Отмени выключение', 'cancel_shutdown'],
  ['Громкость 30', 'set_volume', '30'],
  ['Сделай громкость на двадцать пять', 'set_volume', '25'],
  ['Громкость на максимум', 'set_volume', '100'],
  ['Сделай погромче', 'volume_up'],
  ['Потише, пожалуйста', 'volume_down'],
  ['Выключи звук', 'mute'],
  ['Заблокируй компьютер', 'lock'],
  ['Выключи монитор', 'monitor_off'],
  ['Сделай скриншот', 'screenshot'],
  ['Сфотографируй, кто за компьютером', 'webcam'],
  ['Поставь на паузу', 'play_pause'],
  ['Следующий трек', 'next_track'],
  ['Переведи в спящий режим', 'sleep'],
  ['Запусти Steam', 'launch', 'steam'],
  ['Открой ютуб', 'open_url', 'https://youtube.com'],
  ['Открой сайт habr.com', 'open_url', 'https://habr.com'],
  ['Скажи привет всем', 'say', 'привет всем'],
  ['Как там компьютер?', 'status_report'],
  ['Скорость интернета', 'speedtest'],
  ['Температура видеокарты', 'gpu'],
  ['Отчёт за неделю', 'weekly_report'],
  ['Проверь обновления', 'check_updates'],
  ['Очисти корзину', 'empty_recycle_bin'],
];

for (const [text, action, arg] of cases) {
  test(`голос: «${text}»`, () => {
    const r = p(text);
    assert.ok(r, 'не распознано');
    assert.equal(r.action, action);
    if (arg !== undefined) assert.equal(r.arg || '', arg);
  });
}

test('голос: напоминание и задержки', () => {
  const r = p('Напомни выключить духовку через 20 минут');
  assert.equal(r.action, 'remind');
  assert.equal(r.minutes, 20);
  assert.equal(r.text, 'выключить духовку');
  assert.equal(parseDelay('через полтора часа'), 90);
  assert.equal(parseDelay('через час'), 60);
  assert.equal(parseDelay('через 1 час 30 минут'), 90);
  assert.equal(parseDelay('через минуту'), 1);
  assert.equal(parseDelay('без задержки'), null);
});

test('голос: свои программы из настроек и непонятные фразы', () => {
  const apps = [{ name: 'Minecraft', cmd: 'C:\\Games\\mc.exe' }];
  assert.deepEqual(p('Запусти майнкрафт', { apps }).action, 'launch');
  assert.equal(p('Запусти minecraft', { apps }).arg, 'C:\\Games\\mc.exe');
  assert.equal(p('Какая сегодня погода'), null);
  assert.equal(p(''), null);
});
