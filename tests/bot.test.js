'use strict';
// Проверка Telegram-бота на поддельном API (без сети).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeBot } = require('./helpers');

const OWNER = { id: 111, username: 'owner', first_name: 'Хозяин' };
const STRANGER = { id: 999, username: 'stranger', first_name: 'Чужой' };
const msg = (text, user = OWNER) => ({ message_id: 1, chat: { id: user.id, type: 'private' }, from: user, text });
const cb = (data, user = OWNER) => ({ id: 'cb', from: user, data, message: { message_id: 5, chat: { id: user.id, type: 'private' } } });

test('чужой пользователь не получает доступа', async () => {
  const { bot, fake } = await makeBot();
  await bot.onMessage(msg('/status', STRANGER));
  assert.match(fake.texts()[0], /Нет доступа/);
  await bot.onCallback(cb('a|shutdown', STRANGER));
  assert.match(fake.last().text, /Нет доступа/);
});

test('привязка по QR-ссылке (/start pair_КОД) и одноразовый код', async () => {
  const { ctx, bot, fake } = await makeBot();
  await bot.onMessage(msg('/start pair_WRONG', STRANGER));
  assert.match(fake.last().text, /Неверный код/);
  assert.equal(ctx.isAuthorized(999), false);
  const code = ctx.pairingCode();
  await bot.onMessage(msg(`/start pair_${code}`, STRANGER));
  assert.equal(ctx.isAuthorized(999), true);
  assert.notEqual(ctx.pairingCode(), code);
  assert.ok(fake.sent.some((m) => m.chatId === 999 && /Телефон привязан/.test(m.text)));
  await ctx.notifier.flush(2000);
  assert.ok(fake.sent.some((m) => m.chatId === 111 && /Привязан новый телефон/.test(m.text)));
});

test('привязка командой /pair', async () => {
  const { ctx, bot } = await makeBot();
  await bot.onMessage(msg(`/pair ${ctx.pairingCode().toLowerCase()}`, STRANGER));
  assert.equal(ctx.isAuthorized(999), true);
});

test('привязка Telegram закрыта, если QR-код не открывали в программе', async () => {
  const { ctx, bot, fake } = await makeBot();
  ctx.botPairUntil = 0;
  await bot.onMessage(msg(`/pair ${ctx.pairingCode()}`, STRANGER));
  assert.equal(ctx.isAuthorized(999), false);
  assert.match(fake.last().text, /Привязка закрыта/);
});

test('меню и статус', async () => {
  const { bot, fake } = await makeBot();
  await bot.onMessage(msg('/start'));
  assert.match(fake.last().text, /на связи/);
  await bot.onMessage(msg('📊 Статус'));
  assert.match(fake.last().text, /CPU/);
  for (const b of ['⚡ Питание', '🔊 Медиа', '🔄 Обновления', '🛠 Ещё', '📜 Журнал', '⏰ Планировщик', '🧩 Процессы']) {
    await bot.onMessage(msg(b));
    assert.ok(fake.last().kb, b);
  }
});

test('опасное действие требует подтверждения, повторное нажатие не срабатывает', async () => {
  const { ctx, bot, fake } = await makeBot();
  const called = [];
  ctx.actions.get('shutdown').fn = async (arg) => { called.push(arg); return 'ок'; };
  await bot.onMessage(msg('/shutdown 30'));
  assert.match(fake.last().text, /Подтвердите/);
  assert.equal(called.length, 0);
  const key = fake.last().kb.inline_keyboard[0][0].callback_data;
  await bot.onCallback(cb(key));
  assert.deepEqual(called, ['30']);
  assert.equal(ctx.db.getSetting('lastPowerAction').action, 'shutdown');
  await bot.onCallback(cb(key));
  assert.deepEqual(called, ['30']);
});

test('ввод параметра после нажатия кнопки', async () => {
  const { ctx, bot, fake } = await makeBot();
  const got = [];
  ctx.actions.get('message').fn = async (arg) => { got.push(arg); return 'показано'; };
  await bot.onCallback(cb('in|message'));
  assert.match(fake.last().text, /Введите/);
  await bot.onMessage(msg('Ужин готов!'));
  assert.deepEqual(got, ['Ужин готов!']);
});

test('планировщик из Telegram', async () => {
  const { ctx, bot, fake } = await makeBot();
  await bot.onMessage(msg('/in 30m shutdown'));
  assert.match(fake.last().text, /добавлена/);
  await bot.onMessage(msg('/at 23:30 перезагрузка'));
  assert.match(fake.last().text, /Перезагрузить/);
  await bot.onMessage(msg('/daily 08:00 будни notify Подъём!'));
  assert.match(fake.last().text, /по будням/);
  await bot.onMessage(msg('/daily 08:00 notify'));
  assert.match(fake.last().text, /нужен параметр/);
  await bot.onMessage(msg('/in soon shutdown'));
  assert.match(fake.last().text, /❌/);
  assert.equal(ctx.db.listTasks().length, 3);
  await bot.onCallback(cb('td|1'));
  assert.equal(ctx.db.listTasks().length, 2);
});

test('файлы: просмотр, скачивание и загрузка с телефона', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcc-bot-'));
  const { ctx, bot, fake } = await makeBot({ files: { uploadDir: path.join(dir, 'up'), fullDiskAccess: true } });
  fs.writeFileSync(path.join(dir, 'doc.txt'), 'содержимое');
  await bot.onMessage(msg(`/files ${dir}`));
  assert.match(JSON.stringify(fake.last().kb), /doc\.txt/);
  await bot.onCallback(cb('f|0'));
  assert.equal(fake.last().kind, 'document');
  assert.equal(fake.last().filename, 'doc.txt');

  const upload = msg('');
  upload.document = { file_id: 'x', file_name: 'from_phone.txt', file_size: 10 };
  await bot.onMessage(upload);
  assert.equal(fs.readFileSync(path.join(dir, 'up', 'from_phone.txt'), 'utf8'), 'hello from phone');
  assert.equal(ctx.db.recentCommands(1)[0].action, 'upload');
});

test('журнал и задания', async () => {
  const { bot, fake } = await makeBot();
  await bot.onCallback(cb('log|commands'));
  assert.match(fake.last().text, /Последние команды/);
  await bot.onCallback(cb('jl'));
  assert.match(fake.last().text, /Фоновые задания/);
});

test('непонятный текст и групповые чаты', async () => {
  const { bot, fake } = await makeBot();
  await bot.onMessage(msg('абракадабра'));
  assert.match(fake.last().text, /Не понял/);
  const n = fake.sent.length;
  const g = msg('/status');
  g.chat.type = 'group';
  await bot.onMessage(g);
  assert.equal(fake.sent.length, n);
});

test('уведомления уходят привязанным пользователям', async () => {
  const { ctx, fake } = await makeBot();
  ctx.notifier.notify('Тест <b>жирный</b>');
  await ctx.notifier.flush(2000);
  const m = fake.sent.find((x) => x.kind === 'message' && /Тест/.test(x.text));
  assert.ok(m);
  assert.equal(m.chatId, 111);
  assert.match(ctx.db.recentEvents(1)[0].message, /Тест жирный/);
  ctx.notifier.setMuted(true);
  const before = fake.sent.length;
  ctx.notifier.notify('тихо');
  ctx.notifier.notify('важно', { level: 'critical' });
  await ctx.notifier.flush(2000);
  assert.equal(fake.sent.length, before + 1);
});
