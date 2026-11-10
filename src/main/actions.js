'use strict';
// Единый реестр действий: им пользуются Telegram-бот, окно приложения и планировщик.
const { IS_WIN } = require('./system/exec');
const power = require('./system/power');
const media = require('./system/media');
const misc = require('./system/misc');
const processes = require('./system/processes');
const updates = require('./system/updates');
const info = require('./system/info');
const screen = require('./system/screen');
const { E } = require('./telegram-api');

const SOURCE_NAMES = { telegram: 'Telegram', app: 'окно приложения', scheduler: 'планировщик', mobile: 'приложение на телефоне' };

class ActionRegistry {
  constructor(ctx) {
    this.ctx = ctx;
    this.actions = new Map();
    this._register();
  }

  add(name, title, category, fn, opts = {}) {
    this.actions.set(name, {
      name, title, category, fn,
      dangerous: false, argHint: '', argRequired: false, requiresShell: false, windowsOnly: false, power: false,
      ...opts,
    });
  }

  _register() {
    const a = this.add.bind(this);
    // Питание
    a('shutdown', 'Выключить ПК', 'power', power.shutdown, { dangerous: true, power: true, argHint: 'задержка, мин (необязательно)' });
    a('reboot', 'Перезагрузить', 'power', power.reboot, { dangerous: true, power: true, argHint: 'задержка, мин (необязательно)' });
    a('cancel_shutdown', 'Отменить выключение', 'power', power.cancelShutdown);
    a('sleep', 'Спящий режим', 'power', power.sleep, { dangerous: true, power: true });
    a('hibernate', 'Гибернация', 'power', power.hibernate, { dangerous: true, power: true });
    a('lock', 'Заблокировать экран', 'power', power.lock);
    a('logoff', 'Выйти из системы', 'power', power.logoff, { dangerous: true });
    a('monitor_off', 'Выключить монитор', 'power', power.monitorOff);
    // Медиа
    a('volume_up', 'Громче', 'media', media.volumeUp);
    a('volume_down', 'Тише', 'media', media.volumeDown);
    a('mute', 'Вкл/выкл звук', 'media', media.mute);
    a('set_volume', 'Установить громкость', 'media', media.setVolume, { argHint: '0–100', argRequired: true });
    a('play_pause', 'Пауза/воспроизведение', 'media', media.playPause);
    a('next_track', 'Следующий трек', 'media', media.nextTrack);
    a('prev_track', 'Предыдущий трек', 'media', media.prevTrack);
    // Обновления (фоновые задания)
    a('check_updates', 'Проверить обновления программ', 'updates', this._job('check_updates', 'Проверка обновлений программ', updates.checkUpdates));
    a('upgrade_all', 'Обновить все программы', 'updates', this._job('upgrade_all', 'Обновление всех программ', updates.upgradeAll), { dangerous: true });
    a('win_update_check', 'Проверить Windows Update', 'updates', this._job('win_update_check', 'Проверка Windows Update', updates.windowsUpdateCheck), { windowsOnly: true });
    a('win_update_install', 'Установить обновления Windows', 'updates', this._job('win_update_install', 'Установка обновлений Windows', updates.windowsUpdateInstall), { dangerous: true, windowsOnly: true });
    a('app_update', 'Обновить PC Full Control', 'updates', () => this.ctx.appUpdater.startUpdate());
    // Система
    a('status_report', 'Отчёт о состоянии в Telegram', 'system', () => this._statusReport());
    a('screenshot', 'Скриншот в Telegram', 'system', () => this._screenshotToTg());
    a('webcam', 'Фото с веб-камеры в Telegram', 'system', () => this._webcamToTg());
    a('kill', 'Завершить процесс', 'system', processes.kill, { dangerous: true, argHint: 'PID или имя процесса', argRequired: true });
    a('empty_recycle_bin', 'Очистить корзину', 'system', misc.emptyRecycleBin, { dangerous: true });
    a('restart_app', 'Перезапустить приложение', 'system', () => this.ctx.restartApp(), { dangerous: true });
    // Разное
    a('open_url', 'Открыть ссылку', 'misc', misc.openUrl, { argHint: 'https://…', argRequired: true });
    // Запуск по пути с телефона или из Telegram — только в доступных папках (как файлы) и с подтверждением
    a('launch', 'Запустить программу', 'misc', (arg, o) => misc.launch(arg, { ...o, files: this.ctx.files, apps: this.ctx.config.apps }), { argHint: 'программа или путь', argRequired: true, dangerous: true });
    a('message', 'Сообщение на экран', 'misc', misc.showMessage, { argHint: 'текст', argRequired: true });
    a('say', 'Озвучить текст', 'misc', misc.say, { argHint: 'текст', argRequired: true });
    a('clipboard_get', 'Получить буфер обмена', 'misc', misc.clipboardGet);
    a('clipboard_set', 'Записать в буфер обмена', 'misc', misc.clipboardSet, { argHint: 'текст', argRequired: true });
    a('notify', 'Напоминание в Telegram', 'misc', (arg) => this._reminder(arg), { argHint: 'текст', argRequired: true });
    a('shell', 'Выполнить команду', 'misc', misc.shellCommand, { argHint: 'команда', argRequired: true, requiresShell: true, dangerous: true });
  }

  get(name) { return this.actions.get(name) || null; }

  isAvailable(act) {
    if (!act) return false;
    if (act.windowsOnly && !IS_WIN) return false;
    if (act.requiresShell && !this.ctx.config.security.allowShell) return false;
    return true;
  }

  available() { return [...this.actions.values()].filter((a) => this.isAvailable(a)); }

  toJSON(act) {
    const { name, title, category, dangerous, argHint, argRequired } = act;
    return { name, title, category, dangerous, argHint, argRequired };
  }

  async run(name, arg = '', source = 'app', user = '') {
    const act = this.get(name);
    if (!act) return { ok: false, result: `Неизвестное действие: ${name}` };
    if (act.requiresShell && !this.ctx.config.security.allowShell) {
      return { ok: false, result: 'Выполнение команд отключено (Настройки → «Разрешить выполнение команд»)' };
    }
    if (act.windowsOnly && !IS_WIN) return { ok: false, result: 'Это действие доступно только в Windows' };
    arg = String(arg ?? '').trim();
    if (act.argRequired && !arg) return { ok: false, result: `Нужен параметр: ${act.argHint}` };

    if (act.power) {
      this.ctx.db.setSetting('lastPowerAction', { action: name, ts: Date.now() / 1000, source });
      if (source !== 'telegram') {
        this.ctx.notifier.notify(`⚡ <b>${E(act.title)}</b> (источник: ${SOURCE_NAMES[source] || source})`, { category: 'power', level: 'warning' });
        await this.ctx.notifier.flush(5000);
      }
      this.ctx.db.save();
    }
    let ok = true;
    let result;
    try {
      result = (await act.fn(arg, { source })) || 'Готово';
    } catch (e) {
      ok = false;
      result = `Ошибка: ${e.message}`;
      if (act.power) this.ctx.db.setSetting('lastPowerAction', null);
    }
    this.ctx.db.logCommand(source, user, name, arg, ok, result);
    this.ctx.emit('event');
    return { ok, result };
  }

  _job(kind, title, fn) {
    return async () => {
      const { id, isNew } = this.ctx.jobs.start(kind, title, fn);
      if (!isNew) return `«${title}» уже выполняется (задание #${id}).`;
      return `🔄 ${title}: запущено (задание #${id}). Результат придёт уведомлением.`;
    };
  }

  async _statusReport() {
    const text = info.formatStatus(await info.getStatus(), this.ctx.pcName);
    this.ctx.notifier.notify('📊 Отчёт о состоянии\n' + text, { category: 'report', log: false });
    return 'Отчёт отправлен в Telegram';
  }

  async _screenshotToTg() {
    const img = await screen.screenshot(1);
    this.ctx.notifier.notify('📸 Скриншот', { category: 'screenshot', photo: img, log: false });
    return 'Скриншот отправлен в Telegram';
  }

  async _webcamToTg() {
    const img = await screen.webcamPhoto();
    this.ctx.notifier.notify('📷 Фото с веб-камеры', { category: 'webcam', photo: img, log: false });
    return 'Фото отправлено в Telegram';
  }

  async _reminder(arg) {
    this.ctx.notifier.notify(`⏰ ${E(arg)}`, { category: 'reminder', level: 'warning' });
    return 'Напоминание отправлено';
  }
}

module.exports = { ActionRegistry };
