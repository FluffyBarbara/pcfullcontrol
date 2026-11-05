'use strict';
// Уведомления в Telegram. Каждое уведомление также пишется в локальный журнал событий.
const { E } = require('./telegram-api');

const stripHtml = (t) => String(t).replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Notifier {
  constructor(ctx) {
    this.ctx = ctx;
    this.queue = [];
    this.busy = false;
  }

  get muted() { return !!this.ctx.db.getSetting('notificationsMuted', false); }
  setMuted(v) { this.ctx.db.setSetting('notificationsMuted', !!v); }

  /**
   * text — HTML. level: info | warning | critical (critical приходит даже при выключенных уведомлениях).
   * opts: { category, level, photo (Buffer), document: {name, data}, log: true }
   */
  notify(text, { category = 'info', level = 'info', photo = null, document = null, log = true } = {}) {
    if (log) {
      try { this.ctx.db.addEvent(level, category, stripHtml(text)); } catch (e) { /* база недоступна */ }
    }
    this.ctx.emit('event');
    if (!this.ctx.tg) return;
    if (this.muted && level !== 'critical') return;
    const header = `🖥 <b>${E(this.ctx.pcName)}</b>\n`;
    this.queue.push({ text: header + text, photo, document, silent: level === 'info' });
    this._drain();
  }

  async _drain() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length) {
        const item = this.queue.shift();
        for (const chatId of this.ctx.authorizedIds()) {
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const tg = this.ctx.tg;
              if (!tg) break;
              if (item.photo) await tg.sendPhoto(chatId, item.photo, { caption: item.text.slice(0, 1024), silent: item.silent });
              else if (item.document) {
                await tg.sendDocument(chatId, item.document.data, item.document.name, { caption: item.text.slice(0, 1024), silent: item.silent });
              } else await tg.sendMessage(chatId, item.text, { silent: item.silent });
              break;
            } catch (e) {
              if (e.code === 400 || e.code === 403) break;
              await sleep(2000 * (attempt + 1));
            }
          }
        }
      }
    } finally {
      this.busy = false;
    }
  }

  /** Подождать отправки очереди (например, перед выключением ПК). */
  async flush(timeoutMs = 8000) {
    const end = Date.now() + timeoutMs;
    while ((this.queue.length || this.busy) && Date.now() < end) await sleep(200);
  }
}

module.exports = { Notifier, stripHtml };
