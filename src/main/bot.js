'use strict';
// Telegram-бот: управление ПК кнопками и командами.
const crypto = require('crypto');
const { inlineKb, replyKb, E, TelegramError } = require('./telegram-api');
const { IS_WIN } = require('./system/exec');
const info = require('./system/info');
const processes = require('./system/processes');
const screen = require('./system/screen');
const media = require('./system/media');
const updates = require('./system/updates');
const { FileAccessError, TELEGRAM_UPLOAD_LIMIT } = require('./system/files');
const { parseDuration, parseTime, parseWeekdays, nextTimeOfDay } = require('./scheduler');
const { parseVoiceCommand, EXAMPLES: VOICE_EXAMPLES } = require('./voice-commands');
const { LEVEL_TEXT } = require('./system/disk-health');

const MAIN_KB = replyKb([
  ['📊 Статус', '📸 Скриншот'],
  ['⚡ Питание', '🔊 Медиа'],
  ['🧩 Процессы', '🔄 Обновления'],
  ['📁 Файлы', '⏰ Планировщик'],
  ['🛠 Ещё', '📜 Журнал'],
]);

const BOT_COMMANDS = [
  ['start', 'Главное меню'], ['status', 'Состояние ПК'], ['screen', 'Скриншот'], ['power', 'Питание'],
  ['shutdown', 'Выключить [через N мин]'], ['reboot', 'Перезагрузить'], ['sleep', 'Спящий режим'],
  ['lock', 'Заблокировать экран'], ['cancel', 'Отменить выключение'], ['media', 'Звук и медиа'],
  ['vol', 'Громкость 0–100'], ['ps', 'Процессы'], ['kill', 'Завершить процесс'], ['updates', 'Обновления ПО'],
  ['files', 'Файлы'], ['get', 'Скачать файл по пути'], ['tasks', 'Планировщик'], ['at', 'Задача на время'],
  ['in', 'Задача через N минут'], ['daily', 'Задача по расписанию'], ['msg', 'Сообщение на экран'],
  ['say', 'Озвучить текст'], ['open', 'Открыть ссылку'], ['run', 'Запустить программу'],
  ['clip', 'Буфер обмена ПК'], ['cmd', 'Выполнить команду'], ['ip', 'IP-адреса'], ['webcam', 'Фото с веб-камеры'],
  ['log', 'Журнал'], ['notify', 'Вкл/выкл уведомления'], ['actions', 'Список действий'],
  ['gpu', 'Видеокарта и FPS'], ['disks', 'Здоровье дисков'], ['net', 'Интернет'], ['speedtest', 'Замер скорости'],
  ['devices', 'Устройства в сети'], ['week', 'Отчёт за неделю'], ['voice', 'Голосовые команды'],
  ['music', 'Что играет + управление'], ['mixer', 'Громкость программ'], ['games', 'Игры за неделю'], ['temps', 'Температуры за сутки'],
  ['crashes', 'Синие экраны и сбои'], ['usb', 'Подключённые USB'], ['panic', 'Тревожная кнопка'], ['panic_off', 'Снять тревогу'],
  ['help', 'Справка'],
];

const HELP = `<b>PC Full Control — управление компьютером</b>

Пользуйтесь кнопками внизу или командами:

<b>Питание:</b> /shutdown [мин], /reboot [мин], /sleep, /lock, /cancel
<b>Медиа:</b> /media, /vol 50
<b>Процессы:</b> /ps [имя], /kill &lt;PID или имя&gt;
<b>Файлы:</b> /files, /get &lt;путь&gt;; отправьте боту файл — он сохранится на ПК
<b>Обновления:</b> /updates
<b>Разное:</b> /msg текст, /say текст, /open ссылка, /run программа, /clip [текст], /ip, /webcam
<b>Терминал:</b> /cmd команда (если разрешено в настройках приложения)

<b>Планировщик</b> (/tasks):
• <code>/at 23:30 shutdown</code> — разово в указанное время
• <code>/in 45m shutdown</code> — через 45 минут (форматы: 30, 2h, 1h30m)
• <code>/daily 08:00 будни notify Пора вставать!</code> — по расписанию
  (дни: будни, выходные, пн-пт, сб,вс; можно не указывать)
• /actions — названия действий для задач

<b>Музыка:</b> /music — что играет (с обложкой) и управление, /mixer — громкость программ
<b>Железо и сеть:</b> /gpu, /disks, /temps, /games, /crashes, /net, /speedtest, /devices
<b>Безопасность:</b> /panic — тревожная кнопка, /panic_off — снять тревогу, /usb — подключённые устройства
<b>Отчёт за неделю:</b> /week (приходит сам по воскресеньям в 20:00)
<b>🎙 Голосом:</b> отправьте голосовое сообщение — например, «выключи компьютер через полчаса». Подробнее: /voice

<b>Прочее:</b> /log, /notify (вкл/выкл уведомления), /myid`;

const ACTION_ALIASES = {
  выключить: 'shutdown', выкл: 'shutdown', перезагрузить: 'reboot', перезагрузка: 'reboot', сон: 'sleep',
  гибернация: 'hibernate', блок: 'lock', заблокировать: 'lock', напомнить: 'notify', напоминание: 'notify',
  скриншот: 'screenshot', отчёт: 'status_report', отчет: 'status_report', обновления: 'check_updates',
  обновить: 'upgrade_all', сообщение: 'message', сказать: 'say', открыть: 'open_url', запустить: 'launch',
};

const OUTPUT_ACTIONS = new Set(['clipboard_get', 'shell']);
const FB_PAGE = 16;
const pad = (x) => String(x).padStart(2, '0');
const stamp = () => {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
};
const fmtTs = (ts) => {
  const d = new Date(ts * 1000);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

class TelegramBot {
  constructor(ctx) {
    this.ctx = ctx;
    this.api = ctx.tg;
    this.offset = null;
    this.pending = new Map();   // chatId -> действие, ожидающее текстового параметра
    this.fb = new Map();        // chatId -> состояние файлового браузера
    this.store = new Map();     // данные кнопок, не влезающие в 64 байта
    this.pairFails = new Map();
    this.unauthSeen = new Map();
    this.running = false;
    this.abort = null;
    this.username = '';
    this.status = 'stopped';     // stopped | connecting | online | error
    this.lastError = '';

    const r = {
      '/start': this.cmdStart, '/menu': this.cmdStart, '/help': this.cmdHelp,
      '/status': this.cmdStatus, '📊 Статус': this.cmdStatus,
      '/screen': this.cmdScreenshot, '/screenshot': this.cmdScreenshot, '📸 Скриншот': this.cmdScreenshot,
      '/power': this.cmdPower, '⚡ Питание': this.cmdPower,
      '/media': this.cmdMedia, '🔊 Медиа': this.cmdMedia,
      '/ps': this.cmdProcesses, '🧩 Процессы': this.cmdProcesses,
      '/updates': this.cmdUpdates, '🔄 Обновления': this.cmdUpdates,
      '/files': this.cmdFiles, '/ls': this.cmdFiles, '📁 Файлы': this.cmdFiles,
      '/tasks': this.cmdTasks, '⏰ Планировщик': this.cmdTasks,
      '/more': this.cmdMore, '🛠 Ещё': this.cmdMore,
      '/log': this.cmdLog, '📜 Журнал': this.cmdLog,
      '/get': this.cmdGet, '/ip': this.cmdIp, '/webcam': this.cmdWebcam,
      '/at': this.cmdAt, '/in': this.cmdIn, '/daily': this.cmdDaily, '/deltask': this.cmdDelTask,
      '/actions': this.cmdActions, '/notify': this.cmdNotify, '/clip': this.cmdClip, '/users': this.cmdUsers,
      '/vol': (c, a, m) => (a ? this.runAction(c, 'set_volume', a, { user: m.from }) : this.cmdMedia(c)),
      '/gpu': this.cmdGpu, '/disks': this.cmdDisks, '/net': this.cmdNet, '/speedtest': this.cmdSpeed,
      '/devices': this.cmdDevices, '/week': this.cmdWeek, '/voice': this.cmdVoiceHelp,
      '/music': this.cmdMusic, '🎵 Музыка': this.cmdMusic, '/mixer': this.cmdMixer, '/games': this.cmdGames, '/temps': this.cmdTemps,
      '/crashes': this.cmdCrashes, '/usb': this.cmdUsb, '/panic': this.cmdPanic, '/panic_off': this.cmdPanicOff,
    };
    const simple = {
      '/shutdown': 'shutdown', '/reboot': 'reboot', '/sleep': 'sleep', '/hibernate': 'hibernate', '/lock': 'lock',
      '/logoff': 'logoff', '/cancel': 'cancel_shutdown', '/monitoroff': 'monitor_off', '/kill': 'kill',
      '/msg': 'message', '/say': 'say', '/open': 'open_url', '/run': 'launch', '/cmd': 'shell', '/mute': 'mute',
    };
    for (const [cmd, action] of Object.entries(simple)) r[cmd] = (c, a, m) => this.runAction(c, action, a, { user: m.from });
    this.routes = new Map(Object.entries(r).map(([k, fn]) => [k, fn.bind(this)]));
  }

  // ================= Цикл получения сообщений =================
  start() {
    if (this.running) return;
    this.running = true;
    this.loop().catch((e) => { this.status = 'error'; this.lastError = e.message; });
  }

  stop() {
    this.running = false;
    this.status = 'stopped';
    if (this.abort) this.abort.abort();
  }

  setStatus(status, error = '') {
    this.status = status;
    this.lastError = error;
    this.ctx.emit('bot-status');
  }

  async loop() {
    this.setStatus('connecting');
    while (this.running) {
      try {
        const me = await this.api.getMe();
        this.username = me.username;
        break;
      } catch (e) {
        if (e.code === 401) { this.setStatus('error', 'Неверный токен бота'); this.running = false; return; }
        this.setStatus('connecting', `Нет связи с Telegram: ${e.message}`);
        await this.wait(15000);
      }
    }
    if (!this.running) return;
    try { await this.api.setCommands(BOT_COMMANDS); } catch (e) { /* не критично */ }
    await this.skipOldUpdates();
    this.setStatus('online');
    while (this.running) {
      let updates;
      try {
        this.abort = new AbortController();
        updates = await this.api.getUpdates(this.offset, 25, this.abort.signal);
        if (this.status !== 'online') this.setStatus('online');
      } catch (e) {
        if (!this.running) return;
        this.setStatus(e.code === 409 ? 'error' : 'connecting',
          e.code === 409 ? 'Бот уже запущен на другом компьютере (ошибка 409)' : `Нет связи с Telegram: ${e.message}`);
        await this.wait(5000);
        continue;
      }
      for (const upd of updates) {
        this.offset = upd.update_id + 1;
        this.handle(upd);
      }
    }
  }

  wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

  /** Команды, отправленные пока ПК был выключен, не выполняем (чтобы старый /shutdown не выключил ПК). */
  async skipOldUpdates() {
    try {
      const old = await this.api.getUpdates(-1, 0);
      if (old.length) this.offset = old[old.length - 1].update_id + 1;
    } catch (e) { /* ignore */ }
  }

  async handle(upd) {
    let chatId = null;
    try {
      if (upd.callback_query) {
        chatId = upd.callback_query.message.chat.id;
        await this.onCallback(upd.callback_query);
      } else if (upd.message) {
        chatId = upd.message.chat.id;
        await this.onMessage(upd.message);
      }
    } catch (e) {
      if (chatId) await this.send(chatId, `❌ Ошибка: ${E(e.message)}`).catch(() => {});
    }
  }

  // ================= Помощники =================
  send(chatId, text, kb = null) { return this.api.sendMessage(chatId, text, { kb }); }

  async editOrSend(chatId, messageId, text, kb = null) {
    if (messageId) {
      try { await this.api.editMessage(chatId, messageId, text, kb); return; } catch (e) { /* отправим новое */ }
    }
    await this.send(chatId, text, kb);
  }

  put(...payload) {
    if (this.store.size > 2000) this.store.clear();
    const key = crypto.randomBytes(4).toString('hex');
    this.store.set(key, payload);
    return key;
  }

  static userName(u = {}) { return u.username ? '@' + u.username : String(u.id || ''); }

  // ================= Сообщения =================
  async onMessage(msg) {
    if (!msg.chat || msg.chat.type !== 'private') return;
    const chatId = msg.chat.id;
    const user = msg.from || {};
    const text = (msg.text || '').trim();
    const sp = text.indexOf(' ');
    let cmd = sp === -1 ? text : text.slice(0, sp);
    const arg = sp === -1 ? '' : text.slice(sp + 1).trim();
    if (cmd.startsWith('/')) cmd = cmd.split('@')[0].toLowerCase();

    if (cmd === '/myid') return this.send(chatId, `Ваш Telegram ID: <code>${user.id}</code>`);
    if (cmd === '/pair') return this.pair(chatId, arg, user);
    if (cmd === '/start' && arg.startsWith('pair_')) return this.pair(chatId, arg.slice(5), user);
    if (!this.ctx.isAuthorized(user.id)) return this.unauthorized(chatId, user);

    if (msg.voice || msg.video_note) return this.onVoice(chatId, msg, user);
    if (msg.document || msg.photo || msg.video || msg.audio) return this.onUpload(chatId, msg);
    if (!text) return null;

    const handler = this.routes.get(cmd) || this.routes.get(text);
    if (this.pending.has(chatId) && !handler) {
      const action = this.pending.get(chatId);
      this.pending.delete(chatId);
      return this.runAction(chatId, action, text, { user });
    }
    this.pending.delete(chatId);
    if (handler) return handler(chatId, arg, msg);
    return this.send(chatId, 'Не понял команду 🤔 Нажмите /help или используйте кнопки меню.', MAIN_KB);
  }

  async unauthorized(chatId, user) {
    await this.send(chatId, `⛔ Нет доступа.\nВаш ID: <code>${user.id}</code>\n`
      + 'Чтобы привязать телефон, отсканируйте QR-код в приложении PC Full Control на компьютере.');
    if (Date.now() - (this.unauthSeen.get(user.id) || 0) > 3600e3) {
      this.unauthSeen.set(user.id, Date.now());
      this.ctx.notifier.notify(`⚠️ Попытка доступа к боту: ${E(TelegramBot.userName(user))} (${E(user.first_name || '')}), ID <code>${user.id}</code>`,
        { category: 'security', level: 'warning' });
    }
  }

  /** Неверные коды за последние 10 минут (блокировка не вечная — хозяин, ошибившийся 5 раз, не запрёт себя). */
  failsOf(id) {
    const arr = (this.pairFails.get(id) || []).filter((t) => Date.now() - t < 10 * 60 * 1000);
    if (arr.length) this.pairFails.set(id, arr); else this.pairFails.delete(id);
    if (this.pairFails.size > 1000) this.pairFails.clear();
    return arr;
  }

  async pair(chatId, code, user) {
    if (this.ctx.isAuthorized(user.id)) return this.send(chatId, '✅ Этот аккаунт уже привязан.', MAIN_KB);
    if (this.failsOf(user.id).length >= 5) return this.send(chatId, '⛔ Слишком много неверных попыток. Подождите 10 минут.');
    if (!this.ctx.botPairingOpen) return this.send(chatId, '🔒 Привязка закрыта. Откройте PC Full Control на компьютере и отсканируйте QR-код ещё раз.');
    const expected = this.ctx.pairingCode();
    const given = Buffer.from(String(code || '').trim().toUpperCase());
    const ok = given.length === expected.length && crypto.timingSafeEqual(given, Buffer.from(expected));
    if (!ok) {
      this.pairFails.set(user.id, [...this.failsOf(user.id), Date.now()]);
      return this.send(chatId, '❌ Неверный код. Отсканируйте QR-код в приложении на компьютере.');
    }
    const hadUsers = this.ctx.authorizedIds().length > 0;
    this.ctx.db.addTgUser(user.id, user.username || '', [user.first_name, user.last_name].filter(Boolean).join(' '));
    this.ctx.pairingCode(true);
    this.ctx.emit('event');
    if (hadUsers) {
      this.ctx.notifier.notify(`🔗 Привязан новый телефон: ${E(TelegramBot.userName(user))}`, { category: 'security', level: 'warning' });
    } else {
      this.ctx.db.addEvent('info', 'security', `Привязан телефон: ${TelegramBot.userName(user)}`);
    }
    return this.send(chatId, `✅ Телефон привязан к компьютеру <b>${E(this.ctx.pcName)}</b>!\n\n${HELP}`, MAIN_KB);
  }

  // ================= Выполнение действий =================
  async runAction(chatId, name, arg = '', { confirmed = false, messageId = null, user = {}, callbackId = null } = {}) {
    const act = this.ctx.actions.get(name);
    if (!act || !this.ctx.actions.isAvailable(act)) {
      const text = act && act.requiresShell
        ? '❌ Выполнение команд отключено. Включите его в настройках приложения на ПК.'
        : '❌ Действие недоступно';
      return this.reply(chatId, text, callbackId);
    }
    if (act.argRequired && !arg) {
      this.pending.set(chatId, name);
      await this.reply(chatId, null, callbackId);
      return this.send(chatId, `✏️ <b>${E(act.title)}</b>\nВведите ${E(act.argHint)}:`, inlineKb([[['✖️ Отмена', 'x']]]));
    }
    if (act.dangerous && this.ctx.config.telegram.confirmDangerous && !confirmed) {
      const key = this.put(name, arg);
      await this.reply(chatId, null, callbackId);
      return this.send(chatId, `⚠️ Подтвердите: <b>${E(act.title)}</b>${arg ? ` <code>${E(arg)}</code>` : ''}?`,
        inlineKb([[['✅ Да', `y|${key}`], ['❌ Отмена', 'n']]]));
    }
    if (OUTPUT_ACTIONS.has(name)) this.api.chatAction(chatId);
    const { ok, result } = await this.ctx.actions.run(name, arg, 'telegram', TelegramBot.userName(user));
    if (OUTPUT_ACTIONS.has(name) && ok) {
      await this.reply(chatId, null, callbackId);
      return this.api.sendLong(chatId, `📋 <b>${E(act.title)}</b>`, result);
    }
    const text = `${ok ? '✅' : '❌'} ${E(result)}`;
    if (messageId) return this.editOrSend(chatId, messageId, text);
    if (callbackId && ok && result.length < 180 && !act.dangerous) return this.api.answerCallback(callbackId, result);
    return this.reply(chatId, text, callbackId);
  }

  async reply(chatId, text, callbackId) {
    if (callbackId) await this.api.answerCallback(callbackId);
    if (text) await this.send(chatId, text);
  }

  // ================= Команды и меню =================
  cmdStart(chatId, arg, msg) {
    const name = (msg.from || {}).first_name;
    return this.send(chatId, `👋 Привет${name ? ', ' + E(name) : ''}! Компьютер <b>${E(this.ctx.pcName)}</b> на связи.\n`
      + 'Выберите действие в меню ниже или нажмите /help.', MAIN_KB);
  }

  cmdHelp(chatId) { return this.send(chatId, HELP, MAIN_KB); }

  async cmdStatus(chatId, arg, msg, messageId = null) {
    this.api.chatAction(chatId);
    const text = info.formatStatus(await info.getStatus(), this.ctx.pcName);
    return this.editOrSend(chatId, messageId, text, inlineKb([[['🔄 Обновить', 'st'], ['📸 Скриншот', 'ss'], ['🧩 Процессы', 'ps|cpu']]]));
  }

  async cmdScreenshot(chatId, arg = '') {
    this.api.chatAction(chatId, 'upload_photo');
    let imgs;
    let ds = [];
    try {
      ds = await screen.displays();
      imgs = await screen.screenshots(/^\d+$/.test(arg) ? Number(arg) : 0);
    } catch (e) {
      return this.send(chatId, `❌ ${E(e.message)}`);
    }
    const rows = [[['🔄 Ещё раз', 'ss'], ['📄 Файлом (без сжатия)', 'ssd']]];
    if (ds.length > 1) rows.push(ds.slice(0, 4).map((d) => [`🖥 ${d.index}`, `ss|${d.index}`]));
    const now = new Date();
    for (let i = 0; i < imgs.length; i++) {
      const caption = `📸 ${now.toLocaleString('ru-RU')}${imgs.length > 1 ? ` · экран ${i + 1}` : ''}`;
      await this.api.sendPhoto(chatId, imgs[i], { caption, kb: i === imgs.length - 1 ? inlineKb(rows) : null });
    }
    return null;
  }

  cmdPower(chatId, arg, msg, messageId = null) {
    return this.editOrSend(chatId, messageId, '⚡ <b>Питание</b>', inlineKb([
      [['⏻ Выключить', 'a|shutdown'], ['🔄 Перезагрузить', 'a|reboot']],
      [['😴 Сон', 'a|sleep'], ['❄️ Гибернация', 'a|hibernate']],
      [['🔒 Заблокировать', 'a|lock'], ['🚪 Выйти из системы', 'a|logoff']],
      [['🌑 Выключить монитор', 'a|monitor_off'], ['🚫 Отмена выключения', 'a|cancel_shutdown']],
      [['⏻ через 30 мин', 'a|shutdown|30'], ['⏻ через 1 ч', 'a|shutdown|60'], ['⏻ через 2 ч', 'a|shutdown|120']],
    ]));
  }

  async cmdMedia(chatId, arg, msg, messageId = null) {
    const v = await media.getVolume();
    const vol = v ? `\nТекущая громкость: <b>${v.level}%</b>${v.muted ? ' (без звука)' : ''}` : '';
    return this.editOrSend(chatId, messageId, `🔊 <b>Звук и медиа</b>${vol}`, inlineKb([
      [['🔉 Тише', 'a|volume_down'], ['🔇', 'a|mute'], ['🔊 Громче', 'a|volume_up']],
      [['⏮', 'a|prev_track'], ['⏯', 'a|play_pause'], ['⏭', 'a|next_track']],
      [0, 25, 50, 75, 100].map((x) => [`${x}%`, `a|set_volume|${x}`]),
    ]));
  }

  async cmdProcesses(chatId, arg = '', msg = null, messageId = null) {
    const sort = arg === 'mem' ? 'mem' : 'cpu';
    const query = ['', 'cpu', 'mem'].includes(arg) ? '' : arg;
    this.api.chatAction(chatId);
    const procs = await processes.listProcesses({ sort, limit: 20, query });
    const lines = [`🧩 <b>Процессы</b> (сортировка: ${sort === 'mem' ? 'память' : 'CPU'})${query ? `, поиск: «${E(query)}»` : ''}`, ''];
    for (const p of procs) lines.push(`<code>${String(p.pid).padStart(6)}</code> ${E(p.name.slice(0, 28))} — ${p.cpu}% · ${info.fmtBytes(p.mem)}`);
    if (!procs.length) lines.push('Ничего не найдено');
    lines.push('\nЗавершить: /kill &lt;PID или имя&gt;');
    const kill = procs.slice(0, 8).map((p) => [`✖ ${p.name.slice(0, 18)}`, `k|${p.pid}`]);
    return this.editOrSend(chatId, messageId, lines.join('\n'),
      inlineKb([[['По CPU', 'ps|cpu'], ['По памяти', 'ps|mem'], ['🔄', `ps|${sort}`]], ...chunk(kill, 2)]));
  }

  async cmdUpdates(chatId, arg, msg, messageId = null) {
    const rows = [
      [['🔍 Проверить обновления программ', 'a|check_updates']],
      [['⬆️ Обновить все программы', 'a|upgrade_all']],
    ];
    if (IS_WIN) {
      rows.push([['🪟 Проверить Windows Update', 'a|win_update_check']]);
      rows.push([['🪟 Установить обновления Windows', 'a|win_update_install']]);
    }
    rows.push([['🤖 Обновить PC Full Control', 'a|app_update']], [['📋 Последние задания', 'jl']]);
    const mgrs = Object.keys(await updates.availableManagers()).join(', ') || 'не найдены';
    return this.editOrSend(chatId, messageId, `🔄 <b>Обновление ПО</b>\nМенеджеры пакетов: ${E(mgrs)}\n`
      + 'Долгие операции выполняются в фоне — результат придёт сообщением.', inlineKb(rows));
  }

  cmdMore(chatId, arg, msg, messageId = null) {
    const rows = [
      [['💬 Сообщение на экран', 'in|message'], ['🗣 Озвучить', 'in|say']],
      [['🌐 Открыть ссылку', 'in|open_url'], ['🚀 Запустить', 'in|launch']],
      [['📋 Буфер ПК', 'a|clipboard_get'], ['✏️ Текст в буфер', 'in|clipboard_set']],
      [['📷 Веб-камера', 'cam'], ['🌍 IP-адреса', 'ip']],
    ];
    if (this.ctx.config.apps.length) rows.push([['⭐ Мои программы', 'apps']]);
    if (this.ctx.config.security.allowShell) rows.push([['💻 Выполнить команду', 'in|shell']]);
    rows.push([['🎮 Видеокарта', 'gpu'], ['💽 Здоровье дисков', 'disks']]);
    rows.push([['🌐 Интернет', 'net'], ['📡 Устройства в сети', 'dev']]);
    rows.push([['🎵 Музыка', 'mu|show'], ['🎚 Микшер', 'mx']]);
    rows.push([['🕹 Игры', 'games'], ['🌡 Температуры', 'temps']]);
    rows.push([['💥 Сбои системы', 'crash'], ['🔌 USB', 'usb']]);
    rows.push([['🚨 Тревожная кнопка', 'pn'], ['📅 Отчёт за неделю', 'week']]);
    rows.push([['🗑 Очистить корзину', 'a|empty_recycle_bin'], ['♻️ Перезапуск приложения', 'a|restart_app']]);
    rows.push([[this.ctx.notifier.muted ? '🔔 Включить уведомления' : '🔕 Выключить уведомления', 'nt']]);
    return this.editOrSend(chatId, messageId, '🛠 <b>Дополнительно</b>', inlineKb(rows));
  }

  // ================= Железо, сеть, отчёты =================
  async cmdGpu(chatId) {
    this.api.chatAction(chatId);
    let r = await this.ctx.gpu();
    // Счётчику кадров нужно пару секунд, чтобы набрать статистику
    if (r.fpsAvailable && !r.fps) { await new Promise((res) => setTimeout(res, 2500)); r = await this.ctx.gpu(); }
    if (!r.gpus.length) return this.send(chatId, '🎮 Видеокарта не найдена или не отдаёт данные.');
    const L = [];
    for (const g of r.gpus) {
      L.push(`🎮 <b>${E(g.name)}</b>`);
      if (g.temp != null) L.push(`🌡 Температура: <b>${Math.round(g.temp)}°C</b>`);
      if (g.util != null) L.push(`⚙️ Загрузка: ${Math.round(g.util)}%`);
      if (g.memTotal) L.push(`🧠 Видеопамять: ${info.fmtBytes(g.memUsed || 0)} из ${info.fmtBytes(g.memTotal)}`);
      if (g.clock != null) L.push(`⏱ Частота: ${Math.round(g.clock)} МГц${g.memClock ? ` · память ${Math.round(g.memClock)} МГц` : ''}`);
      if (g.power != null) L.push(`⚡ Мощность: ${Math.round(g.power)} Вт${g.powerLimit ? ` из ${Math.round(g.powerLimit)}` : ''}`);
      if (g.fan != null) L.push(`🌀 Вентилятор: ${Math.round(g.fan)}%`);
      L.push('');
    }
    if (r.fps) L.push(`🕹 <b>${E(r.fps.app.replace(/\.exe$/i, ''))}: ${r.fps.fps} кадр/с</b> (1% низких — ${r.fps.low1})`);
    else if (r.fpsAvailable) L.push('🕹 Игра не запущена — кадры в секунду появятся, когда она будет на экране.');
    return this.send(chatId, L.join('\n'), inlineKb([[['🔄 Обновить', 'gpu']]]));
  }

  async cmdDisks(chatId) {
    this.api.chatAction(chatId);
    const disks = await this.ctx.diskHealth(true);
    if (!disks.length) return this.send(chatId, '💽 Данные о дисках недоступны (нужна Windows 10/11).');
    const icon = { ok: '✅', warn: '⚠️', bad: '🚨' };
    const word = { ok: 'Хорошо', warn: 'Тревога', bad: 'Плохо' };
    const kindIc = { hdd: '💿', ssd: '💾', nvme: '⚡' };
    const tb = (b) => (b >= 1e12 ? `${(b / 1e12).toFixed(2)} ТБ` : `${(b / 1e9).toFixed(1)} ГБ`);
    const size = (b) => (b >= 1e12 ? `${(b / 1e12).toFixed(1)} ТБ` : `${Math.round(b / 1e9)} ГБ`);
    const L = ['💽 <b>Здоровье дисков (SMART)</b>', ''];
    for (const d of disks) {
      L.push(`${kindIc[d.kind] || '💽'} <b>${E(d.model)}</b>${d.volumes ? ` (${E(d.volumes)})` : ''}`);
      L.push(E([d.kindText, d.rpm ? `${d.rpm} об/мин` : null, d.size ? size(d.size) : null].filter(Boolean).join(' · ')));
      L.push(`${icon[d.level]} <b>${word[d.level]}</b>${d.life != null ? ` · ресурс <b>${d.life}%</b>` : ''}${d.temp != null ? ` · 🌡 ${d.temp}°C` : ''}`);
      const parts = [];
      if (d.hours != null) parts.push(`наработка ${Math.round(d.hours).toLocaleString('ru-RU')} ч`);
      if (d.powerCycles != null) parts.push(`включений ${d.powerCycles.toLocaleString('ru-RU')}`);
      if (d.written != null) parts.push(`записано ${tb(d.written)}`);
      if (parts.length) L.push(E(parts.join(' · ')));
      for (const r of d.reasons) L.push(`  • ${E(r)}`);
      for (const r of d.notes || []) L.push(`  ℹ️ ${E(r)}`);
      L.push('');
    }
    return this.send(chatId, L.join('\n'));
  }

  async cmdNet(chatId) {
    const st = this.ctx.net.status();
    const L = ['🌐 <b>Интернет</b>'];
    L.push(st.online === false ? `🔴 Нет связи${st.downSince ? ` с ${new Date(st.downSince * 1000).toLocaleTimeString('ru-RU')}` : ''}` : st.online ? `🟢 Есть связь${st.latency ? ` · отклик ${st.latency} мс` : ''}` : '⏳ Проверяю…');
    const out = st.outages;
    L.push(out.length ? `Обрывов за неделю: ${out.length}` : 'Обрывов за неделю не было');
    for (const o of out.slice(0, 5)) L.push(`  • ${fmtTs(o.start)} — ${Math.max(1, Math.round((o.end - o.start) / 60))} мин`);
    if (st.lastSpeed) L.push(`\n⚡ Последний замер (${fmtTs(st.lastSpeed.ts)}): ↓ <b>${st.lastSpeed.down}</b> / ↑ <b>${st.lastSpeed.up}</b> Мбит/с, задержка ${st.lastSpeed.ping} мс`);
    return this.send(chatId, L.join('\n'), inlineKb([[['⚡ Замерить скорость', 'sp'], ['📡 Устройства', 'dev']]]));
  }

  async cmdSpeed(chatId) {
    const msg = await this.send(chatId, '⚡ Замеряю скорость интернета… (≈20 секунд)');
    try {
      const r = await this.ctx.net.speedTest();
      const text = `⚡ <b>Скорость интернета</b>\n⬇️ Скачивание: <b>${r.down} Мбит/с</b>\n⬆️ Загрузка: <b>${r.up} Мбит/с</b>\n📶 Задержка: ${r.ping} мс (разброс ${r.jitter} мс)`;
      return this.editOrSend(chatId, msg && msg.message_id, text, inlineKb([[['🔄 Ещё раз', 'sp']]]));
    } catch (e) {
      return this.editOrSend(chatId, msg && msg.message_id, '❌ ' + E(e.message));
    }
  }

  async cmdDevices(chatId) {
    const msg = await this.send(chatId, '📡 Ищу устройства в домашней сети… (≈10 секунд)');
    let list;
    try { list = await this.ctx.net.scan(false); } catch (e) { return this.editOrSend(chatId, msg && msg.message_id, '❌ ' + E(e.message)); }
    const online = list.filter((d) => d.online);
    const weekAgo = Date.now() / 1000 - 7 * 86400;
    const L = [`📡 <b>Устройства в сети: ${online.length}</b>`, ''];
    for (const d of online.slice(0, 40)) {
      const name = d.label || d.name || d.vendor || 'Неизвестное устройство';
      L.push(`${d.first_seen > weekAgo ? '🆕 ' : ''}<b>${E(name)}</b> — ${E(d.ip)}${d.vendor && d.vendor !== name ? `\n   <i>${E(d.vendor)}</i>` : ''}`);
    }
    return this.editOrSend(chatId, msg && msg.message_id, L.join('\n'), inlineKb([[['🔄 Обновить', 'dev']]]));
  }

  // ================= Музыка и звук =================
  musicCaption(s) {
    const t = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
    const L = [`🎵 <b>${E(s.title || 'Без названия')}</b>`];
    if (s.artist) L.push(`👤 ${E(s.artist)}`);
    if (s.album) L.push(`💿 ${E(s.album)}${s.track ? ` · трек ${s.track}${s.tracks ? ` из ${s.tracks}` : ''}` : ''}`);
    if (s.genres && s.genres.length) L.push(`🏷 ${E(s.genres.join(', '))}`);
    L.push(`${s.playing ? '▶️' : '⏸'} ${E(s.statusText)}${s.duration ? ` · ${t(s.position)} / ${t(s.duration)}` : ''}`);
    L.push(`🖥 ${E(s.appName)}${s.window ? `\n🪟 Окно: «${E(s.window.slice(0, 120))}»` : ''}`);
    return L.join('\n');
  }

  musicKb(s, others = 0) {
    const row = [];
    if (s.can.prev) row.push(['⏮', 'mu|prev']);
    row.push([s.playing ? '⏸ Пауза' : '▶️ Играть', 'mu|toggle']);
    if (s.can.next) row.push(['⏭', 'mu|next']);
    const rows = [row, [['🔄 Обновить', 'mu|show'], ['🎚 Микшер', 'mx']]];
    if (others) rows.push([[`📻 Другие плееры (${others})`, 'mu|all']]);
    return inlineKb(rows);
  }

  async cmdMusic(chatId) {
    this.api.chatAction(chatId, 'upload_photo');
    let st;
    try { st = await this.ctx.media.state(); } catch (e) { return this.send(chatId, '🎵 Не удалось узнать, что играет: ' + E(e.message)); }
    if (!st.available) return this.send(chatId, '🎵 Сведения о музыке доступны в Windows 10 и 11.');
    const s = st.sessions[0];
    if (!s) return this.send(chatId, '🎵 Сейчас ничего не играет.\nЗапустите музыку или видео в любом плеере или браузере — здесь появятся название, исполнитель и обложка.', inlineKb([[['🔄 Обновить', 'mu|show'], ['🎚 Микшер', 'mx']]]));
    const cover = s.cover ? this.ctx.media.cover(s.cover) : null;
    const caption = this.musicCaption(s);
    const kb = this.musicKb(s, st.sessions.length - 1);
    if (cover) return this.api.sendPhoto(chatId, cover.buf, { caption, kb });
    return this.send(chatId, caption, kb);
  }

  async onMusicButton(chatId, mid, action, cq) {
    if (action === 'show') return this.cmdMusic(chatId);
    if (action === 'all') {
      const st = await this.ctx.media.state();
      const L = ['📻 <b>Все плееры</b>', ''];
      for (const s of st.sessions) L.push(`${s.playing ? '▶️' : '⏸'} <b>${E(s.appName)}</b>: ${E(s.artist ? s.artist + ' — ' : '')}${E(s.title || '—')}`);
      return this.send(chatId, L.join('\n'));
    }
    try { await this.ctx.media.control('', action); } catch (e) { return this.send(chatId, '❌ ' + E(e.message)); }
    await new Promise((r) => setTimeout(r, 900));
    const st = await this.ctx.media.state().catch(() => null);
    const s = st && st.sessions[0];
    if (!s) return null;
    if (action === 'toggle') {
      try { await this.api.call('editMessageCaption', { chat_id: chatId, message_id: mid, caption: this.musicCaption(s), parse_mode: 'HTML', reply_markup: this.musicKb(s, st.sessions.length - 1) }); return null; } catch (e) { /* сообщение без фото */ }
      return this.editOrSend(chatId, mid, this.musicCaption(s), this.musicKb(s, st.sessions.length - 1));
    }
    // Трек сменился — новая обложка: убираем старое сообщение и присылаем новое
    this.api.call('deleteMessage', { chat_id: chatId, message_id: mid }).catch(() => {});
    return this.cmdMusic(chatId);
  }

  async mixerView() {
    const mx = await this.ctx.media.mixer();
    if (!mx.available || mx.noDevice) return { text: mx.noDevice ? '🎚 Нет устройства вывода звука.' : '🎚 Микшер доступен в Windows.', kb: null };
    const L = [`🎚 <b>Громкость программ</b>`, `🔊 Общая: <b>${mx.masterMuted ? 'без звука' : mx.master + '%'}</b>`, ''];
    const rows = [[['🔉 −10', 'mx|*|-'], [mx.masterMuted ? '🔊 Вкл' : '🔇 Выкл', 'mx|*|m'], ['🔊 +10', 'mx|*|+']]];
    for (const a of mx.apps.slice(0, 8)) {
      L.push(`${a.peak > 1 ? '🎶' : '▫️'} ${E(a.title)}: <b>${a.muted ? 'без звука' : a.volume + '%'}</b>`);
      const n = a.name.slice(0, 40);
      rows.push([[`${a.title.slice(0, 14)} −`, `mx|${n}|-`], [a.muted ? '🔊' : '🔇', `mx|${n}|m`], [`+`, `mx|${n}|+`]]);
    }
    if (!mx.apps.length) L.push('Сейчас ни одна программа не выводит звук.');
    rows.push([['🔄 Обновить', 'mx']]);
    return { text: L.join('\n'), kb: inlineKb(rows) };
  }

  async cmdMixer(chatId) {
    const v = await this.mixerView();
    return this.send(chatId, v.text, v.kb);
  }

  async onMixerButton(chatId, mid, rest) {
    if (rest) {
      const i = rest.lastIndexOf('|');
      const name = rest.slice(0, i);
      const op = rest.slice(i + 1);
      try {
        const mx = await this.ctx.media.mixer();
        if (name === '*') {
          if (op === 'm') await this.ctx.media.setMaster({ mute: !mx.masterMuted });
          else await this.ctx.media.setMaster({ level: Math.max(0, Math.min(100, mx.master + (op === '+' ? 10 : -10))), mute: false });
        } else {
          const a = mx.apps.find((x) => x.name === name);
          if (!a) throw new Error('Программа больше не выводит звук');
          if (op === 'm') await this.ctx.media.setApp(name, { mute: !a.muted });
          else await this.ctx.media.setApp(name, { level: Math.max(0, Math.min(100, a.volume + (op === '+' ? 10 : -10))), mute: false });
        }
      } catch (e) { return this.send(chatId, '❌ ' + E(e.message)); }
    }
    const v = await this.mixerView();
    return this.editOrSend(chatId, rest ? mid : null, v.text, v.kb);
  }

  // ================= Игры, температуры, сбои, USB, тревога =================
  async cmdGames(chatId) {
    const g = this.ctx.games(7);
    const dur = (s) => { const h = Math.floor(s / 3600); const m = Math.round((s % 3600) / 60); return h ? `${h} ч ${m} мин` : `${m} мин`; };
    if (!g.games.length) return this.send(chatId, '🕹 За неделю игр не было (или программа их ещё не видела — время считается, пока игра на экране).');
    const L = ['🕹 <b>Игры за 7 дней</b>', `Всего: <b>${dur(g.total)}</b>`, ''];
    for (const x of g.games.slice(0, 10)) L.push(`• <b>${E(x.title)}</b> — ${dur(x.seconds)}${x.avgFps ? ` · в среднем ${x.avgFps} FPS` : ''}`);
    if (g.now) L.push('', `▶️ Сейчас: ${E(g.now.title)}${g.now.fps ? ` (${g.now.fps} FPS)` : ''}`);
    return this.send(chatId, L.join('\n'));
  }

  async cmdTemps(chatId) {
    const t = this.ctx.tempHistory(24);
    const fmt = (st, lim) => (st ? `в среднем ${st.avg}°, максимум <b>${st.max}°</b> в ${new Date(st.maxAt * 1000).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}${st.max >= lim ? ' 🔥' : ''}` : 'нет данных');
    const L = ['🌡 <b>Температуры за сутки</b>', '', `🧠 Процессор: ${fmt(t.stats.cpu, t.limits.cpu)}`, `🎮 Видеокарта: ${fmt(t.stats.gpu, t.limits.gpu)}`];
    for (const [name, st] of Object.entries(t.stats.disks)) L.push(`💽 ${E(name)}: ${fmt(st, 60)}`);
    L.push('', 'Графики — в приложении на ПК и телефоне (раздел «Железо»).');
    return this.send(chatId, L.join('\n'));
  }

  async cmdCrashes(chatId) {
    this.api.chatAction(chatId);
    const list = await this.ctx.crashes.list(90);
    if (!list.length) return this.send(chatId, '✅ За 90 дней синих экранов и внезапных выключений не было.');
    const L = [`💥 <b>Сбои за 90 дней: ${list.length}</b>`, ''];
    for (const c of list.slice(0, 6)) {
      const when = new Date(c.ts * 1000).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      L.push(`${c.kind === 'bsod' ? '💥' : '⚡'} <b>${when}</b> — ${E(c.title)}${c.code ? ` <code>${E(c.code)}</code>` : ''}`);
      if (c.name) L.push(`   ${E(c.name)}`);
      L.push(`   ${E(c.text)}`);
    }
    const last = list[0];
    L.push('', `💡 ${E(last.advice)}`);
    return this.send(chatId, L.join('\n'));
  }

  async cmdUsb(chatId) {
    const list = this.ctx.db.usbEvents(10);
    if (!list.length) return this.send(chatId, '🔌 Новых USB-устройств пока не подключали.');
    const L = ['🔌 <b>Последние подключения</b>', ''];
    for (const e of list) L.push(`${e.kind === 'add' ? '➕' : '➖'} ${new Date(e.ts * 1000).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} — ${E(e.name)}${e.info ? ` · ${E(e.info)}` : ''}`);
    return this.send(chatId, L.join('\n'));
  }

  async cmdPanic(chatId, arg, msg, messageId = null) {
    const st = this.ctx.panic.state();
    if (st.active) return this.editOrSend(chatId, messageId, `🚨 Тревога уже включена (${new Date(st.since * 1000).toLocaleTimeString('ru-RU')}).`, inlineKb([[['✅ Снять тревогу', 'pnoff']]]));
    return this.editOrSend(chatId, messageId, '🚨 <b>Тревожная кнопка</b>\nКомпьютер сделает фото с веб-камеры (кто за ним сидит), выключит микрофон, отключит веб-камеры и заблокируется. Всё обратимо — кнопкой «Снять тревогу».',
      inlineKb([[['🚨 Включить тревогу', 'pny']], [['Отмена', 'n']]]));
  }

  async cmdPanicOff(chatId, arg, msg) {
    if (!this.ctx.panic.state().active) return this.send(chatId, 'Тревога не включена.');
    await this.ctx.panic.release(TelegramBot.userName((msg && msg.from) || {}));
    return null;
  }

  async cmdWeek(chatId) {
    const { build } = require('./weekly');
    return this.send(chatId, build(this.ctx).text);
  }

  cmdVoiceHelp(chatId) {
    const ready = this.ctx.speech.modelReady;
    return this.send(chatId, `🎙 <b>Голосовые команды</b>\nЗапишите голосовое сообщение — программа распознает речь прямо на компьютере (без облака) и выполнит команду.\n\nПримеры:\n${VOICE_EXAMPLES.map((x) => '• ' + x).join('\n')}\n\nОпасные действия (выключение, перезагрузка) — с подтверждением.${ready ? '' : '\n\n⏬ При первом голосовом программа скачает модель распознавания речи (≈250 МБ) — это один раз.'}`);
  }

  /** Голосовое сообщение → текст (Whisper на ПК) → команда. */
  async onVoice(chatId, msg, user) {
    if (this.ctx.config.voice && this.ctx.config.voice.enabled === false) return this.send(chatId, '🎙 Голосовые команды выключены в настройках программы на ПК.');
    const f = msg.voice || msg.video_note;
    if (f.duration > 120) return this.send(chatId, '🎙 Голосовое слишком длинное — запишите команду до 2 минут.');
    const first = !this.ctx.speech.modelReady;
    const status = await this.send(chatId, first ? '⏬ Первое голосовое: скачиваю модель распознавания речи (≈250 МБ, один раз)…' : '🎙 Распознаю…');
    const mid = status && status.message_id;
    let lastEdit = 0;
    let text;
    try {
      const data = await this.api.downloadFile(f.file_id);
      const r = await this.ctx.speech.transcribe(data, {
        onProgress: (p) => {
          if (Date.now() - lastEdit < 3000) return;
          lastEdit = Date.now();
          this.editOrSend(chatId, mid, `⏬ Скачиваю модель распознавания речи: ${p.pct}% (один раз)`).catch(() => {});
        },
      });
      text = r.text;
    } catch (e) {
      return this.editOrSend(chatId, mid, '❌ Не удалось распознать: ' + E(e.message));
    }
    if (!text) return this.editOrSend(chatId, mid, '🎙 Не расслышал — попробуйте сказать чётче.');
    const cmd = parseVoiceCommand(text, { apps: this.ctx.config.apps });
    this.ctx.db.logCommand('telegram', TelegramBot.userName(user), 'voice', text, !!cmd, cmd ? cmd.title : 'не понял');
    if (!cmd) {
      return this.editOrSend(chatId, mid, `🎙 «${E(text)}»\n\nНе понял, что сделать 🤔 Примеры: ${VOICE_EXAMPLES.slice(0, 4).join(', ')}. Все примеры — /voice`);
    }
    await this.editOrSend(chatId, mid, `🎙 «${E(text)}»\n➡️ ${E(cmd.title)}`);
    switch (cmd.action) {
      case 'remind': {
        const id = this.ctx.scheduler.addOnce('notify', cmd.text, Date.now() / 1000 + cmd.minutes * 60);
        this.ctx.emit('event');
        return this.send(chatId, `⏰ Напомню «${E(cmd.text)}» через ${cmd.minutes} мин (задача #${id}).`);
      }
      case 'weekly_report': return this.cmdWeek(chatId);
      case 'speedtest': return this.cmdSpeed(chatId);
      case 'gpu': return this.cmdGpu(chatId);
      case 'now_playing': return this.cmdMusic(chatId);
      case 'temps': return this.cmdTemps(chatId);
      case 'panic': return this.cmdPanic(chatId, '', { from: user });
      default: return this.runAction(chatId, cmd.action, cmd.arg || '', { user });
    }
  }

  cmdApps(chatId, messageId = null) {
    const btns = this.ctx.config.apps.slice(0, 30).map((a, i) => [`🚀 ${a.name}`, `app|${i}`]);
    return this.editOrSend(chatId, messageId, '⭐ <b>Мои программы</b> (настраиваются в приложении на ПК)',
      inlineKb([...chunk(btns, 2), [['⬅️ Назад', 'more']]]));
  }

  async cmdIp(chatId) {
    const pub = await info.publicIp();
    return this.send(chatId, `🌍 <b>IP-адреса</b>\nЛокальные: ${E(info.localIps().join(', ') || '—')}\nВнешний: ${E(pub || 'не удалось определить')}`);
  }

  async cmdWebcam(chatId) {
    this.api.chatAction(chatId, 'upload_photo');
    try {
      const img = await screen.webcamPhoto();
      this.ctx.db.logCommand('telegram', '', 'webcam', '', true, 'фото отправлено');
      return this.api.sendPhoto(chatId, img, { caption: '📷 Веб-камера' });
    } catch (e) {
      return this.send(chatId, `❌ ${E(e.message)}`);
    }
  }

  cmdClip(chatId, arg, msg) {
    return arg ? this.runAction(chatId, 'clipboard_set', arg, { user: msg.from }) : this.runAction(chatId, 'clipboard_get', '', { user: msg.from });
  }

  cmdNotify(chatId) {
    const muted = !this.ctx.notifier.muted;
    this.ctx.notifier.setMuted(muted);
    this.ctx.emit('event');
    return this.send(chatId, muted ? '🔕 Уведомления выключены (кроме критических).' : '🔔 Уведомления включены.');
  }

  cmdLog(chatId, arg, msg, messageId = null, mode = 'events') {
    const icons = { info: 'ℹ️', warning: '⚠️', critical: '🚨' };
    let lines;
    if (mode === 'commands') {
      lines = ['📜 <b>Последние команды</b>', ...this.ctx.db.recentCommands(20).map((r) =>
        `${r.ok ? '✅' : '❌'} ${fmtTs(r.ts)} [${E(r.source)}] ${E(r.action)}${r.arg ? ` «${E(r.arg.slice(0, 30))}»` : ''}`)];
    } else {
      lines = ['📜 <b>Последние события</b>', ...this.ctx.db.recentEvents(20).map((r) =>
        `${icons[r.level] || '•'} ${fmtTs(r.ts)} ${E(r.message.slice(0, 120))}`)];
    }
    if (lines.length === 1) lines.push('пока пусто');
    return this.editOrSend(chatId, messageId, lines.join('\n'),
      inlineKb([[['События', 'log|events'], ['Команды', 'log|commands'], ['Задания', 'jl']]]));
  }

  cmdJobs(chatId, messageId = null) {
    const jobs = this.ctx.db.recentJobs(10);
    const icons = { running: '⏳', done: '✅', error: '❌' };
    const lines = ['📋 <b>Фоновые задания</b>'];
    const btns = [];
    for (const j of jobs) {
      lines.push(`${icons[j.status] || '•'} #${j.id} ${fmtTs(j.started)} — ${E(j.title)}`);
      if (j.status !== 'running') btns.push([`#${j.id}`, `j|${j.id}`]);
    }
    if (!jobs.length) lines.push('заданий ещё не было');
    return this.editOrSend(chatId, messageId, lines.join('\n'), inlineKb([...chunk(btns, 5), [['🔄 Обновить', 'jl']]]));
  }

  cmdActions(chatId) {
    const lines = ['🧰 <b>Действия для планировщика</b>'];
    for (const a of this.ctx.actions.available()) {
      lines.push(`<code>${a.name}</code>${a.argHint ? ` &lt;${E(a.argHint)}&gt;` : ''} — ${E(a.title)}`);
    }
    lines.push('\nПример: <code>/at 23:00 shutdown</code>');
    return this.send(chatId, lines.join('\n'));
  }

  cmdUsers(chatId) {
    const users = this.ctx.db.listTgUsers();
    return this.send(chatId, ['👥 <b>Привязанные телефоны</b>',
      ...users.map((u) => `• ${E(u.name || '')} @${E(u.username || '—')} (<code>${u.user_id}</code>)`),
      '\nОтвязать можно в приложении на ПК.'].join('\n'));
  }

  // ================= Планировщик =================
  cmdTasks(chatId, arg, msg, messageId = null) {
    const tasks = this.ctx.db.listTasks();
    const lines = ['⏰ <b>Планировщик</b>'];
    const rows = [];
    for (const t of tasks) {
      lines.push(E(this.ctx.scheduler.describe(t)));
      rows.push([[`${t.enabled ? '⏸' : '▶️'} #${t.id}`, `tt|${t.id}`], [`🗑 #${t.id}`, `td|${t.id}`]]);
    }
    if (!tasks.length) lines.push('Задач нет.');
    lines.push('\nДобавить:\n<code>/at 23:30 shutdown</code>\n<code>/in 1h reboot</code>\n<code>/daily 09:00 будни notify Работаем!</code>');
    rows.push([['🧰 Список действий', 'acts'], ['🔄 Обновить', 'tl']]);
    return this.editOrSend(chatId, messageId, lines.join('\n'), inlineKb(rows));
  }

  parseAction(tokens) {
    if (!tokens.length) throw new Error('Укажите действие, например shutdown. Список: /actions');
    const name = ACTION_ALIASES[tokens[0].toLowerCase()] || tokens[0].toLowerCase();
    const act = this.ctx.actions.get(name);
    if (!act || !this.ctx.actions.isAvailable(act)) throw new Error(`Неизвестное действие «${tokens[0]}». Список: /actions`);
    return [name, tokens.slice(1).join(' ')];
  }

  async addTask(chatId, fn) {
    try {
      const id = fn();
      return this.send(chatId, `✅ Задача добавлена:\n${E(this.ctx.scheduler.describe(this.ctx.db.getTask(id)))}`);
    } catch (e) {
      return this.send(chatId, `❌ ${E(e.message)}`);
    }
  }

  cmdAt(chatId, arg) {
    return this.addTask(chatId, () => {
      const t = arg.split(/\s+/).filter(Boolean);
      if (!t.length) throw new Error('Пример: /at 23:30 shutdown');
      const [h, m] = parseTime(t[0]);
      const [name, a] = this.parseAction(t.slice(1));
      return this.ctx.scheduler.addOnce(name, a, nextTimeOfDay(h, m));
    });
  }

  cmdIn(chatId, arg) {
    return this.addTask(chatId, () => {
      const t = arg.split(/\s+/).filter(Boolean);
      if (!t.length) throw new Error('Пример: /in 30m shutdown');
      const secs = parseDuration(t[0]);
      const [name, a] = this.parseAction(t.slice(1));
      return this.ctx.scheduler.addOnce(name, a, Date.now() / 1000 + secs);
    });
  }

  cmdDaily(chatId, arg) {
    return this.addTask(chatId, () => {
      const t = arg.split(/\s+/).filter(Boolean);
      if (!t.length) throw new Error('Пример: /daily 23:00 shutdown или /daily 08:00 будни notify Подъём');
      parseTime(t[0]);
      const days = t.length > 1 ? parseWeekdays(t[1]) : null;
      const [name, a] = this.parseAction(days ? t.slice(2) : t.slice(1));
      return this.ctx.scheduler.addDaily(name, a, t[0], days);
    });
  }

  cmdDelTask(chatId, arg) {
    const id = Number(String(arg).replace('#', ''));
    if (id && this.ctx.db.deleteTask(id)) {
      this.ctx.emit('event');
      return this.send(chatId, `🗑 Задача #${id} удалена.`);
    }
    return this.send(chatId, 'Укажите номер задачи: /deltask 3');
  }

  // ================= Файлы =================
  cmdFiles(chatId, arg) { return this.fbShow(chatId, arg || null); }

  fbShow(chatId, dir, page = 0, messageId = null) {
    const fm = this.ctx.files;
    let entries;
    try {
      entries = dir ? fm.listDir(dir) : fm.roots();
    } catch (e) {
      return this.editOrSend(chatId, messageId, `❌ ${E(e.message)}`);
    }
    this.fb.set(chatId, { dir, entries });
    const pages = Math.max(1, Math.ceil(entries.length / FB_PAGE));
    page = Math.max(0, Math.min(page, pages - 1));
    const rows = entries.slice(page * FB_PAGE, (page + 1) * FB_PAGE).map((e, i) => [[
      (e.isDir ? `📁 ${e.name}` : `📄 ${e.name} · ${info.fmtBytes(e.size)}`).slice(0, 60), `f|${page * FB_PAGE + i}`]]);
    const nav = [];
    if (dir) {
      nav.push(['⬆️ Вверх', fm.parent(dir) ? 'fu' : 'fr']);
      nav.push(['💽 Диски', 'fr']);
    }
    if (page > 0) nav.push(['◀️', `fp|${page - 1}`]);
    if (page < pages - 1) nav.push(['▶️', `fp|${page + 1}`]);
    if (nav.length) rows.push(nav);
    const dirs = entries.filter((e) => e.isDir).length;
    const title = dir ? `📁 <code>${E(dir)}</code>` : '📁 <b>Файлы</b> — выберите расположение';
    const text = `${title}\nПапок: ${dirs}, файлов: ${entries.length - dirs}${pages > 1 ? ` · стр. ${page + 1}/${pages}` : ''}\n\n`
      + 'Нажмите на файл, чтобы скачать. Отправьте файл в чат — он сохранится на ПК.';
    return this.editOrSend(chatId, messageId, text, rows.length ? inlineKb(rows) : null);
  }

  fbOpen(chatId, idx, messageId) {
    const st = this.fb.get(chatId);
    if (!st || idx >= st.entries.length) return this.fbShow(chatId, null, 0, messageId);
    const e = st.entries[idx];
    return e.isDir ? this.fbShow(chatId, e.path, 0, messageId) : this.sendFile(chatId, e.path);
  }

  cmdGet(chatId, arg) {
    if (!arg) return this.send(chatId, 'Укажите путь: /get C:\\Users\\me\\file.txt');
    return this.sendFile(chatId, arg.replace(/^"(.*)"$/, '$1'));
  }

  async sendFile(chatId, p) {
    try {
      const f = this.ctx.files.fileForDownload(p);
      if (f.size > TELEGRAM_UPLOAD_LIMIT) {
        return this.send(chatId, `❌ Файл слишком большой для Telegram (${info.fmtBytes(f.size)} &gt; 50 МБ).`);
      }
      this.api.chatAction(chatId, 'upload_document');
      await this.api.sendDocument(chatId, require('fs').readFileSync(f.path), f.name, { caption: `📄 <code>${E(f.path)}</code>` });
      this.ctx.db.logCommand('telegram', '', 'download', f.path, true, info.fmtBytes(f.size));
      return null;
    } catch (e) {
      return this.send(chatId, `❌ ${E(e.message)}`);
    }
  }

  async onUpload(chatId, msg) {
    let f;
    let name;
    if (msg.document) { f = msg.document; name = f.file_name || 'file'; }
    else if (msg.photo) { f = msg.photo[msg.photo.length - 1]; name = `photo_${stamp()}.jpg`; }
    else { f = msg.video || msg.audio; name = f.file_name || `media_${stamp()}`; }
    if ((f.file_size || 0) > 20 * 1024 * 1024) {
      return this.send(chatId, '❌ Бот может принять файл до 20 МБ (ограничение Telegram).');
    }
    const st = this.fb.get(chatId) || {};
    const target = (msg.caption || '').trim().toLowerCase() === 'сюда' ? st.dir : null;
    let saved;
    let size;
    try {
      const data = await this.api.downloadFile(f.file_id);
      size = data.length;
      saved = this.ctx.files.saveUpload(name, data, target);
    } catch (e) {
      return this.send(chatId, `❌ Не удалось сохранить файл: ${E(e.message)}`);
    }
    this.ctx.db.logCommand('telegram', '', 'upload', saved, true, info.fmtBytes(size));
    this.ctx.emit('event');
    return this.send(chatId, `✅ Сохранено на ПК:\n<code>${E(saved)}</code>\n<i>Подпись «сюда» сохранит файл в папку, открытую в /files.</i>`,
      inlineKb([[['🚀 Открыть на ПК', `op|${this.put(saved)}`]]]));
  }

  // ================= Кнопки =================
  async onCallback(cq) {
    const user = cq.from || {};
    if (!this.ctx.isAuthorized(user.id)) return this.api.answerCallback(cq.id, '⛔ Нет доступа', true);
    const chatId = cq.message.chat.id;
    const mid = cq.message.message_id;
    const data = cq.data || '';
    const bar = data.indexOf('|');
    const kind = bar === -1 ? data : data.slice(0, bar);
    const rest = bar === -1 ? '' : data.slice(bar + 1);

    if (kind === 'a') {
      const i = rest.indexOf('|');
      const name = i === -1 ? rest : rest.slice(0, i);
      const arg = i === -1 ? '' : rest.slice(i + 1);
      return this.runAction(chatId, name, arg, { user, callbackId: cq.id });
    }
    if (kind === 'y') {
      const payload = this.store.get(rest);
      this.store.delete(rest);
      if (!payload) return this.api.answerCallback(cq.id, 'Кнопка устарела, повторите команду', true);
      await this.api.answerCallback(cq.id, 'Выполняю…');
      return this.runAction(chatId, payload[0], payload[1], { confirmed: true, messageId: mid, user });
    }

    await this.api.answerCallback(cq.id);
    const num = /^\d+$/.test(rest) ? Number(rest) : null;
    switch (kind) {
      case 'n': return this.editOrSend(chatId, mid, 'Отменено.');
      case 'x': this.pending.delete(chatId); return this.editOrSend(chatId, mid, 'Отменено.');
      case 'in': return this.runAction(chatId, rest, '', { user });
      case 'st': return this.cmdStatus(chatId, '', {}, mid);
      case 'ss': return this.cmdScreenshot(chatId, rest);
      case 'ssd': {
        this.api.chatAction(chatId, 'upload_document');
        const imgs = await screen.screenshots(0, 95);
        for (let i = 0; i < imgs.length; i++) await this.api.sendDocument(chatId, imgs[i], `screenshot_${stamp()}_${i + 1}.jpg`);
        return null;
      }
      case 'ps': return this.cmdProcesses(chatId, rest || 'cpu', null, mid);
      case 'k': return this.runAction(chatId, 'kill', rest, { user });
      case 'more': return this.cmdMore(chatId, '', null, mid);
      case 'apps': return this.cmdApps(chatId, mid);
      case 'app': {
        const app = num !== null ? this.ctx.config.apps[num] : null;
        return app ? this.runAction(chatId, 'launch', app.cmd, { user }) : null;
      }
      case 'cam': return this.cmdWebcam(chatId);
      case 'gpu': return this.cmdGpu(chatId);
      case 'disks': return this.cmdDisks(chatId);
      case 'net': return this.cmdNet(chatId);
      case 'sp': return this.cmdSpeed(chatId);
      case 'dev': return this.cmdDevices(chatId);
      case 'week': return this.cmdWeek(chatId);
      case 'mu': return this.onMusicButton(chatId, mid, rest, cq);
      case 'mx': return this.onMixerButton(chatId, mid, rest);
      case 'games': return this.cmdGames(chatId);
      case 'temps': return this.cmdTemps(chatId);
      case 'crash': return this.cmdCrashes(chatId);
      case 'usb': return this.cmdUsb(chatId);
      case 'pn': return this.cmdPanic(chatId, '', { from: user }, mid);
      case 'pny': { await this.editOrSend(chatId, mid, '🚨 Включаю тревогу…'); try { await this.ctx.panic.trigger(TelegramBot.userName(user)); } catch (e) { return this.send(chatId, '❌ ' + E(e.message)); } return null; }
      case 'pnoff': return this.cmdPanicOff(chatId, '', { from: user });
      case 'ip': return this.cmdIp(chatId);
      case 'nt': await this.cmdNotify(chatId); return this.cmdMore(chatId, '', null, mid);
      case 'log': return this.cmdLog(chatId, '', null, mid, rest || 'events');
      case 'jl': return this.cmdJobs(chatId, mid);
      case 'j': {
        const job = num !== null ? this.ctx.db.getJob(num) : null;
        return job ? this.api.sendLong(chatId, `📋 <b>#${job.id} ${E(job.title)}</b>`, job.output || '', `job_${job.id}.txt`) : null;
      }
      case 'acts': return this.cmdActions(chatId);
      case 'tl': return this.cmdTasks(chatId, '', null, mid);
      case 'tt': {
        const t = num !== null ? this.ctx.db.getTask(num) : null;
        if (t) this.ctx.db.setTaskEnabled(t.id, !t.enabled);
        this.ctx.emit('event');
        return this.cmdTasks(chatId, '', null, mid);
      }
      case 'td':
        if (num !== null) this.ctx.db.deleteTask(num);
        this.ctx.emit('event');
        return this.cmdTasks(chatId, '', null, mid);
      case 'f': return num !== null ? this.fbOpen(chatId, num, mid) : null;
      case 'fu': {
        const st = this.fb.get(chatId) || {};
        return this.fbShow(chatId, st.dir ? this.ctx.files.parent(st.dir) : null, 0, mid);
      }
      case 'fr': return this.fbShow(chatId, null, 0, mid);
      case 'fp': return this.fbShow(chatId, (this.fb.get(chatId) || {}).dir || null, num || 0, mid);
      case 'op': {
        const payload = this.store.get(rest);
        return payload ? this.runAction(chatId, 'launch', payload[0], { user }) : null;
      }
      default: return null;
    }
  }
}

module.exports = { TelegramBot, BOT_COMMANDS, HELP, MAIN_KB, FileAccessError, TelegramError };
