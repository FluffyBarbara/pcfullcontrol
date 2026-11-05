'use strict';
// Минимальный клиент Telegram Bot API на встроенном fetch.

const MAX_TEXT = 4096;
const E = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

class TelegramError extends Error {
  constructor(message, code = null) {
    super(message);
    this.code = code;
  }
}

class TelegramAPI {
  constructor(token) {
    this.token = token;
    this.base = `https://api.telegram.org/bot${token}/`;
    this.fileBase = `https://api.telegram.org/file/bot${token}/`;
  }

  async call(method, params = {}, { files = null, timeoutMs = 30000, signal = null } = {}) {
    let body;
    const headers = {};
    if (files) {
      body = new FormData();
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null) continue;
        body.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
      }
      for (const [field, { data, filename, type }] of Object.entries(files)) {
        body.append(field, new Blob([data], { type: type || 'application/octet-stream' }), filename);
      }
    } else {
      const clean = {};
      for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) clean[k] = v;
      body = JSON.stringify(clean);
      headers['Content-Type'] = 'application/json';
    }
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (signal) signals.push(signal);
    let res;
    try {
      res = await fetch(this.base + method, { method: 'POST', body, headers, signal: AbortSignal.any(signals) });
    } catch (e) {
      // URL содержит токен — не выводим его
      throw new TelegramError(`сетевая ошибка (${e.name})`);
    }
    let payload;
    try {
      payload = await res.json();
    } catch (e) {
      throw new TelegramError(`HTTP ${res.status}`, res.status);
    }
    if (!payload.ok) throw new TelegramError(payload.description || 'ошибка', payload.error_code);
    return payload.result;
  }

  getMe() { return this.call('getMe'); }

  getUpdates(offset, timeout = 25, signal = null) {
    return this.call('getUpdates', { offset, timeout, allowed_updates: ['message', 'callback_query'] },
      { timeoutMs: (timeout + 15) * 1000, signal });
  }

  async sendMessage(chatId, text, { kb = null, silent = false, html = true } = {}) {
    if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT - 20) + '\n…(обрезано)';
    const params = {
      chat_id: chatId, text, reply_markup: kb, disable_notification: silent,
      link_preview_options: { is_disabled: true },
    };
    if (html) params.parse_mode = 'HTML';
    try {
      return await this.call('sendMessage', params);
    } catch (e) {
      if (html && /parse/i.test(e.message)) return this.sendMessage(chatId, text, { kb, silent, html: false });
      throw e;
    }
  }

  async editMessage(chatId, messageId, text, kb = null) {
    if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT - 20) + '\n…(обрезано)';
    try {
      await this.call('editMessageText', {
        chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', reply_markup: kb,
        link_preview_options: { is_disabled: true },
      });
    } catch (e) {
      if (!/not modified/i.test(e.message)) throw e;
    }
  }

  sendPhoto(chatId, data, { caption = null, kb = null, silent = false } = {}) {
    return this.call('sendPhoto', { chat_id: chatId, caption, parse_mode: 'HTML', reply_markup: kb, disable_notification: silent },
      { files: { photo: { data, filename: 'photo.jpg', type: 'image/jpeg' } }, timeoutMs: 120000 });
  }

  sendDocument(chatId, data, filename, { caption = null, silent = false } = {}) {
    return this.call('sendDocument', { chat_id: chatId, caption, parse_mode: 'HTML', disable_notification: silent },
      { files: { document: { data, filename } }, timeoutMs: 600000 });
  }

  answerCallback(id, text = null, alert = false) {
    return this.call('answerCallbackQuery', { callback_query_id: id, text, show_alert: alert }).catch(() => {});
  }

  chatAction(chatId, action = 'typing') {
    return this.call('sendChatAction', { chat_id: chatId, action }).catch(() => {});
  }

  setCommands(commands) {
    return this.call('setMyCommands', { commands: commands.map(([command, description]) => ({ command, description })) });
  }

  async downloadFile(fileId) {
    const info = await this.call('getFile', { file_id: fileId });
    const res = await fetch(this.fileBase + info.file_path, { signal: AbortSignal.timeout(300000) });
    if (!res.ok) throw new TelegramError(`HTTP ${res.status}`, res.status);
    return Buffer.from(await res.arrayBuffer());
  }

  /** Короткий текст — сообщением в <pre>, длинный — файлом. */
  async sendLong(chatId, title, text, filename = 'output.txt') {
    text = text || '(нет вывода)';
    if (text.length <= 3500) return this.sendMessage(chatId, `${title}\n<pre>${E(text)}</pre>`);
    return this.sendDocument(chatId, Buffer.from(text, 'utf8'), filename, { caption: title });
  }
}

/** [[["Текст", "data"], ...], ...] → inline-клавиатура. Если data — ссылка, кнопка открывает её. */
function inlineKb(rows) {
  return {
    inline_keyboard: rows.map((row) => row.map(([text, data]) => (/^https?:/.test(data)
      ? { text, url: data }
      : { text, callback_data: Buffer.from(data).subarray(0, 64).toString() }))),
  };
}

function replyKb(rows) {
  return { keyboard: rows.map((r) => r.map((text) => ({ text }))), resize_keyboard: true, is_persistent: true };
}

module.exports = { TelegramAPI, TelegramError, inlineKb, replyKb, E };
