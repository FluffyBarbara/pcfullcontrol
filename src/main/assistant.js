'use strict';
// Голосовой ассистент в приложении на телефоне: фраза (голосом или текстом) → команда → ответ,
// который телефон ещё и произносит вслух. Опасные действия (выключение, тревога…) — только после подтверждения.
const { parseVoiceCommand, EXAMPLES } = require('./voice-commands');
const info = require('./system/info');

const DANGEROUS_EXTRA = new Set(['panic']);

class Assistant {
  constructor(ctx) { this.ctx = ctx; }

  isDangerous(action) {
    const a = this.ctx.actions.get(action);
    return DANGEROUS_EXTRA.has(action) || !!(a && a.dangerous);
  }

  /**
   * text — распознанная или набранная фраза. confirm — повтор после «Да, выполнить».
   * → { heard, title, reply, ok, needConfirm, action, arg }
   */
  async handle(text, { source = 'mobile', user = '', confirm = false } = {}) {
    const heard = String(text || '').trim().slice(0, 500);
    if (!heard) return { heard, ok: false, reply: 'Не расслышал — повторите, пожалуйста.' };
    const cmd = parseVoiceCommand(heard, { apps: this.ctx.config.apps });
    if (!cmd) {
      this.ctx.db.logCommand(source, user, 'assistant', heard, false, 'не понял');
      return { heard, ok: false, reply: `Не понял, что сделать. Например: ${EXAMPLES.slice(0, 3).join(', ')}.` };
    }
    if (this.isDangerous(cmd.action) && !confirm) {
      return { heard, ok: true, needConfirm: true, action: cmd.action, arg: cmd.arg || '', title: cmd.title, reply: `${cmd.title}?` };
    }
    let reply;
    let ok = true;
    try {
      reply = await this.execute(cmd, { source, user });
    } catch (e) {
      ok = false;
      reply = `Не получилось: ${e.message}`;
    }
    this.ctx.db.logCommand(source, user, 'assistant', heard, ok, `${cmd.title}: ${String(reply).slice(0, 200)}`);
    return { heard, ok, title: cmd.title, action: cmd.action, reply: String(reply || 'Готово') };
  }

  async execute(cmd, { source, user }) {
    const ctx = this.ctx;
    switch (cmd.action) {
      case 'remind': {
        ctx.scheduler.addOnce('notify', cmd.text, Date.now() / 1000 + cmd.minutes * 60);
        ctx.emit('event');
        return `Хорошо, напомню «${cmd.text}» через ${cmd.minutes} мин.`;
      }
      case 'now_playing': {
        const st = await ctx.media.state();
        const s = (st.sessions || [])[0];
        if (!s || !s.title) return 'Сейчас ничего не играет.';
        return `${s.playing ? 'Сейчас играет' : 'На паузе'}: ${s.artist ? s.artist + ' — ' : ''}${s.title}, в ${s.appName}.`;
      }
      case 'temps': {
        const status = await info.getStatus().catch(() => null);
        const g = (await ctx.gpu().catch(() => ({ gpus: [] }))).gpus[0];
        const parts = [];
        if (status && status.temp != null) parts.push(`процессор ${Math.round(status.temp)}°`);
        if (g && g.temp != null) parts.push(`видеокарта ${Math.round(g.temp)}°`);
        return parts.length ? `Температура: ${parts.join(', ')}.` : 'Датчики температуры недоступны.';
      }
      case 'gpu': {
        const r = await ctx.gpu();
        const g = r.gpus[0];
        if (!g) return 'Видеокарта не отдаёт данные.';
        return `${g.name}: ${g.temp != null ? Math.round(g.temp) + '°, ' : ''}загрузка ${Math.round(g.util || 0)}%${r.fps ? `, ${r.fps.fps} кадров в секунду в ${r.fps.app.replace(/\.exe$/i, '')}` : ''}.`;
      }
      case 'speedtest': {
        const r = await ctx.net.speedTest();
        return `Скачивание ${r.down} мегабит в секунду, загрузка ${r.up}, задержка ${r.ping} миллисекунд.`;
      }
      case 'weekly_report': {
        const { build } = require('./weekly');
        ctx.notifier.notify(build(ctx).text, { category: 'report' });
        return 'Отчёт за неделю отправил в Telegram.';
      }
      case 'panic': {
        await ctx.panic.trigger(user || 'голосовая команда');
        return 'Тревога включена: компьютер заблокирован, микрофон и камера выключены.';
      }
      case 'status_report': {
        const s = await info.getStatus();
        return `Процессор ${Math.round(s.cpu.percent)}%, память ${s.ram.percent}%${s.temp != null ? `, температура ${Math.round(s.temp)}°` : ''}.`;
      }
      default: {
        const r = await ctx.actions.run(cmd.action, cmd.arg || '', source, user);
        if (!r.ok) throw new Error(String(r.result).replace(/^Ошибка:\s*/, ''));
        return r.result && r.result !== 'Готово' ? r.result : `${cmd.title} — готово.`;
      }
    }
  }

  async handleAudio(buf, opts = {}) {
    if (this.ctx.config.voice && this.ctx.config.voice.enabled === false) throw new Error('Голосовые команды выключены в настройках программы на ПК');
    const r = await this.ctx.speech.transcribe(buf);
    return this.handle(r.text, opts);
  }
}

module.exports = { Assistant };
