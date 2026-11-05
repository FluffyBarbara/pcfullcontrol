'use strict';
// Планировщик: разовые задачи («в 23:30», «через 30 мин») и по расписанию (дни недели).
const { E } = require('./telegram-api');

const DAILY_GRACE_SEC = 30 * 60; // если ПК был выключен дольше — задачу по расписанию пропускаем
const ONCE_GRACE_SEC = 10 * 60;  // разовую задачу, просроченную больше чем на 10 мин, не выполняем
const WEEKDAY_NAMES = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const WD_ALIASES = { пн: 0, вт: 1, ср: 2, чт: 3, пт: 4, сб: 5, вс: 6, mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 };

function parseTime(text) {
  const m = /^\s*(\d{1,2})[:.](\d{2})\s*$/.exec(text || '');
  if (!m) throw new Error('Время в формате ЧЧ:ММ, например 23:30');
  const h = +m[1];
  const mi = +m[2];
  if (h > 23 || mi > 59) throw new Error('Неверное время');
  return [h, mi];
}

/** '30m', '2h', '1h30m', '90' (минуты), '1д', '45мин', '30s' → секунды */
function parseDuration(text) {
  const t = String(text || '').trim().toLowerCase().replace(/\s+/g, '');
  if (!t) throw new Error('Укажите время, например 30m или 2h');
  if (/^\d+$/.test(t)) return +t * 60;
  const units = { d: 86400, д: 86400, h: 3600, ч: 3600, m: 60, м: 60, мин: 60, min: 60, s: 1, с: 1, сек: 1, sec: 1 };
  const re = /(\d+)(мин|min|сек|sec|d|д|h|ч|m|м|s|с)/gy;
  let total = 0;
  let pos = 0;
  let m;
  while ((m = re.exec(t)) !== null) {
    total += +m[1] * units[m[2]];
    pos = re.lastIndex;
  }
  if (pos !== t.length || total <= 0) throw new Error(`Не понял длительность: ${text}`);
  return total;
}

/** 'пн-пт', '1-5', 'сб,вс', 'будни', 'выходные' → [0..6]; null — если это не дни недели. Пн = 0. */
function parseWeekdays(text) {
  const t = String(text || '').trim().toLowerCase();
  if (['будни', 'weekdays'].includes(t)) return [0, 1, 2, 3, 4];
  if (['выходные', 'weekend'].includes(t)) return [5, 6];
  if (['ежедневно', 'каждый', 'daily', 'все'].includes(t)) return [0, 1, 2, 3, 4, 5, 6];
  const days = new Set();
  for (const part of t.split(',').map((x) => x.trim()).filter(Boolean)) {
    const bounds = part.split('-');
    if (bounds.length > 2) return null;
    const vals = [];
    for (const b of bounds) {
      if (b in WD_ALIASES) vals.push(WD_ALIASES[b]);
      else if (/^[1-7]$/.test(b)) vals.push(+b - 1);
      else return null;
    }
    if (vals.length === 1) days.add(vals[0]);
    else {
      let [a, b] = vals;
      for (let i = 0; i < 7; i++) {
        days.add(a);
        if (a === b) break;
        a = (a + 1) % 7;
      }
    }
  }
  return days.size ? [...days].sort((x, y) => x - y) : null;
}

function describeWeekdays(spec) {
  const days = String(spec || '').split(',').filter((x) => /^\d$/.test(x)).map(Number).sort();
  const key = days.join(',');
  if (!days.length || key === '0,1,2,3,4,5,6') return 'ежедневно';
  if (key === '0,1,2,3,4') return 'по будням';
  if (key === '5,6') return 'по выходным';
  return days.map((d) => WEEKDAY_NAMES[d]).join(', ');
}

function fmtWhen(ts) {
  const d = new Date(ts * 1000);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function describeTask(task, title) {
  const arg = task.arg ? ` «${task.arg}»` : '';
  const off = task.enabled ? '' : ' (выкл.)';
  if (task.kind === 'once') return `#${task.id} 🕐 ${fmtWhen(task.run_at)} — ${title}${arg}${off}`;
  return `#${task.id} 🔁 ${task.time_of_day} ${describeWeekdays(task.weekdays)} — ${title}${arg}${off}`;
}

/** JS: воскресенье = 0; у нас понедельник = 0. */
const weekdayMon0 = (date) => (date.getDay() + 6) % 7;

/** 'run' — пора выполнить, 'missed' — пропущено, null — ещё рано. */
function isDue(task, now = new Date()) {
  const ts = now.getTime() / 1000;
  if (task.kind === 'once') {
    if (task.run_at === null || task.run_at === undefined || task.run_at > ts) return null;
    return ts - task.run_at <= ONCE_GRACE_SEC ? 'run' : 'missed';
  }
  if (task.kind === 'daily') {
    let h; let m;
    try { [h, m] = parseTime(task.time_of_day); } catch (e) { return null; }
    const days = String(task.weekdays || '').split(',').filter((x) => /^\d$/.test(x)).map(Number);
    const target = new Date(now);
    target.setHours(h, m, 0, 0);
    const t = target.getTime() / 1000;
    if (days.length && !days.includes(weekdayMon0(now))) return null;
    if (!(t <= ts && ts < t + DAILY_GRACE_SEC)) return null;
    if (task.last_run && task.last_run >= t) return null;
    return 'run';
  }
  return null;
}

function nextTimeOfDay(h, m, now = new Date()) {
  const t = new Date(now);
  t.setHours(h, m, 0, 0);
  if (t <= now) t.setDate(t.getDate() + 1);
  return t.getTime() / 1000;
}

const SELF_REPORTING = new Set(['notify', 'screenshot', 'status_report', 'webcam']);

class Scheduler {
  constructor(ctx) {
    this.ctx = ctx;
    this.timer = null;
  }

  start() {
    this.ensureDefaultTasks();
    this.timer = setInterval(() => this.tick().catch(() => {}), 15000);
  }

  stop() { clearInterval(this.timer); }

  ensureDefaultTasks() {
    const db = this.ctx.db;
    if (db.getSetting('defaultTasksCreated')) return;
    const t = (this.ctx.config.updates.dailyCheckTime || '').trim();
    if (t) {
      try { parseTime(t); db.addTask({ action: 'check_updates', kind: 'daily', timeOfDay: t }); } catch (e) { /* неверное время */ }
    }
    db.setSetting('defaultTasksCreated', true);
  }

  validate(action, arg) {
    const act = this.ctx.actions.get(action);
    if (!act || !this.ctx.actions.isAvailable(act)) throw new Error(`Неизвестное или недоступное действие: ${action}`);
    if (act.argRequired && !String(arg || '').trim()) throw new Error(`Для «${act.title}» нужен параметр: ${act.argHint}`);
  }

  addOnce(action, arg, runAt) {
    this.validate(action, arg);
    const id = this.ctx.db.addTask({ action, arg, kind: 'once', runAt });
    this.ctx.emit('event');
    return id;
  }

  addDaily(action, arg, timeOfDay, weekdays = null) {
    this.validate(action, arg);
    const [h, m] = parseTime(timeOfDay);
    const id = this.ctx.db.addTask({
      action, arg, kind: 'daily', timeOfDay: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
      weekdays: (weekdays && weekdays.length ? weekdays : [0, 1, 2, 3, 4, 5, 6]).join(','),
    });
    this.ctx.emit('event');
    return id;
  }

  describe(task) {
    const act = this.ctx.actions.get(task.action);
    return describeTask(task, act ? act.title : task.action);
  }

  async tick(now = new Date()) {
    for (const task of this.ctx.db.listTasks(true)) {
      const state = isDue(task, now);
      if (!state) continue;
      this.ctx.db.markTaskRun(task.id, now.getTime() / 1000);
      if (task.kind === 'once') this.ctx.db.setTaskEnabled(task.id, false);
      const desc = E(this.describe(task));
      if (state === 'missed') {
        this.ctx.notifier.notify(`⏭ Задача пропущена (ПК был выключен):\n${desc}`, { category: 'scheduler', level: 'warning' });
        continue;
      }
      const act = this.ctx.actions.get(task.action);
      const { ok, result } = await this.ctx.actions.run(task.action, task.arg || '', 'scheduler', `task#${task.id}`);
      if (!(act && act.power) && !SELF_REPORTING.has(task.action)) {
        this.ctx.notifier.notify(`⏰ Задача выполнена: ${desc}\n${ok ? '✅' : '❌'} ${E(result.slice(0, 1500))}`,
          { category: 'scheduler', level: ok ? 'info' : 'warning' });
      }
    }
  }
}

module.exports = {
  Scheduler, parseTime, parseDuration, parseWeekdays, describeWeekdays, describeTask, isDue, nextTimeOfDay,
};
