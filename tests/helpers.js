'use strict';
const { Database } = require('../src/main/db');
const { AppContext } = require('../src/main/context');

/** Подменяет TelegramAPI: запоминает всё, что бот отправил. */
class FakeTelegram {
  constructor() { this.sent = []; }
  rec(kind, chatId, extra) { this.sent.push({ kind, chatId, ...extra }); return Promise.resolve({ message_id: this.sent.length }); }
  sendMessage(chatId, text, { kb = null } = {}) { return this.rec('message', chatId, { text, kb }); }
  editMessage(chatId, mid, text, kb = null) { return this.rec('edit', chatId, { text, kb }); }
  sendPhoto(chatId, data, { caption = null, kb = null } = {}) { return this.rec('photo', chatId, { text: caption, kb }); }
  sendDocument(chatId, data, filename, { caption = null } = {}) { return this.rec('document', chatId, { text: caption, filename, data }); }
  sendLong(chatId, title, text) { return this.rec('long', chatId, { text: title + '\n' + text }); }
  answerCallback(id, text = null) { return this.rec('callback', null, { text }); }
  chatAction() { return Promise.resolve(); }
  downloadFile() { return Promise.resolve(Buffer.from('hello from phone')); }
  texts() { return this.sent.map((m) => m.text || ''); }
  last() { return this.sent[this.sent.length - 1]; }
}

async function makeCtx(configPatch = {}) {
  const db = await Database.open(null);
  const ctx = new AppContext(db, { version: '1.0.0' });
  if (Object.keys(configPatch).length) ctx.updateConfig(configPatch);
  return ctx;
}

async function makeBot(configPatch = {}) {
  const { TelegramBot } = require('../src/main/bot');
  const ctx = await makeCtx(configPatch);
  const fake = new FakeTelegram();
  ctx.tg = fake;
  const bot = new TelegramBot(ctx);
  ctx.bot = bot;
  ctx.openBotPairing(); // как будто QR-код открыт в программе на ПК
  ctx.db.addTgUser(111, 'owner', 'Хозяин');
  return { ctx, bot, fake };
}

module.exports = { FakeTelegram, makeCtx, makeBot };
