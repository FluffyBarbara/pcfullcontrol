'use strict';
// Отчёт за неделю в Telegram: сколько работал ПК, нагрузка и температуры, самые используемые программы,
// освобождённое место, интернет (обрывы, скорость), новые устройства в сети, безопасность.
const { E } = require('./telegram-api');
const { niceName, localDay } = require('./activity');

const DAYS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

function fmtH(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? `${h} ч ${m} мин` : `${m} мин`;
}
function fmtBytes(n) {
  const u = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i ? n.toFixed(1) : n.toFixed(0)) + ' ' + u[i];
}
function bar(v, max, len = 10) {
  const k = max > 0 ? Math.round((v / max) * len) : 0;
  return '▰'.repeat(k) + '▱'.repeat(len - k);
}

/** Собирает данные отчёта за последние `days` дней. */
function collect(ctx, days = 7, nowTs = Date.now() / 1000) {
  const db = ctx.db;
  const since = nowTs - days * 86400;
  const interval = Math.max(5, Number(ctx.config.monitor.intervalSec) || 30);
  const metrics = db.metricsSince(since);
  const perDay = new Map();
  for (let i = days - 1; i >= 0; i--) perDay.set(localDay(new Date((nowTs - i * 86400) * 1000)), 0);
  for (const m of metrics) {
    const d = localDay(new Date(m.ts * 1000));
    if (perDay.has(d)) perDay.set(d, perDay.get(d) + interval);
  }
  const onSec = [...perDay.values()].reduce((a, b) => a + b, 0);
  const avg = (k) => (metrics.length ? Math.round(metrics.reduce((s, m) => s + (m[k] || 0), 0) / metrics.length) : null);
  const max = (k) => (metrics.length ? Math.round(Math.max(...metrics.map((m) => m[k] || 0))) : null);
  const temps = metrics.map((m) => m.temp).filter((t) => t != null);
  const gpu = db.gpuMetricsSince(since);
  const gpuTemps = gpu.map((g) => g.temp).filter((t) => t != null);
  const apps = db.appUsageSince(localDay(new Date(since * 1000))).slice(0, 7);
  const games = (db.gameUsageSince ? db.gameUsageSince(localDay(new Date(since * 1000))) : []).slice(0, 5);
  const outages = db.outagesSince(since);
  const speed = db.speedtestsSince(since);
  const events = db.eventsSince(since);
  const commands = db.commandsSince(since);
  const devicesNew = db.netDevices().filter((d) => d.first_seen >= since);
  return {
    days, since, perDay: [...perDay.entries()], onSec,
    cpuAvg: avg('cpu'), cpuMax: max('cpu'), ramAvg: avg('ram'), ramMax: max('ram'),
    tempMax: temps.length ? Math.round(Math.max(...temps)) : null,
    gpuTempMax: gpuTemps.length ? Math.round(Math.max(...gpuTemps)) : null,
    gpuUtilAvg: gpu.length ? Math.round(gpu.reduce((s, g) => s + (g.util || 0), 0) / gpu.length) : null,
    apps, games, freed: db.freedSince(since),
    outages: { count: outages.length, total: outages.reduce((s, o) => s + Math.max(0, (o.end || nowTs) - o.start), 0), longest: outages.reduce((mx, o) => Math.max(mx, (o.end || nowTs) - o.start), 0) },
    speed: speed.length ? { last: speed[0], avgDown: +(speed.reduce((s, x) => s + x.down, 0) / speed.length).toFixed(1), count: speed.length } : null,
    devicesNew,
    alerts: events.filter((e) => e.category === 'alert').length,
    logins: events.filter((e) => e.category === 'login').length,
    intruder: events.filter((e) => e.category === 'security' && /Неверный пароль/.test(e.message)).length,
    commands: { total: commands.length, telegram: commands.filter((c) => c.source === 'telegram').length, mobile: commands.filter((c) => c.source === 'mobile').length },
    uninstalled: commands.filter((c) => c.action === 'uninstall').map((c) => c.arg),
  };
}

/** Текст отчёта для Telegram (HTML). */
function format(ctx, d) {
  const L = [];
  L.push(`📅 <b>Отчёт за неделю — ${E(ctx.pcName)}</b>`);
  const from = new Date(d.since * 1000);
  L.push(`<i>${from.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })} — ${new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}</i>`, '');
  L.push(`⏱ <b>Компьютер работал: ${fmtH(d.onSec)}</b>`);
  const maxDay = Math.max(...d.perDay.map(([, s]) => s), 1);
  for (const [day, s] of d.perDay) {
    const dt = new Date(day + 'T12:00:00');
    L.push(`<code>${DAYS[dt.getDay()]} ${bar(s, maxDay)}</code> ${s ? fmtH(s) : '—'}`);
  }
  L.push('');
  if (d.cpuAvg != null) {
    L.push('📊 <b>Нагрузка</b>');
    L.push(`Процессор: в среднем ${d.cpuAvg}%, максимум ${d.cpuMax}%`);
    L.push(`Память: в среднем ${d.ramAvg}%, максимум ${d.ramMax}%`);
    if (d.tempMax != null) L.push(`Температура процессора: до ${d.tempMax}°C`);
    if (d.gpuTempMax != null) L.push(`Видеокарта: до ${d.gpuTempMax}°C, загрузка в среднем ${d.gpuUtilAvg}%`);
    L.push('');
  }
  if (d.apps.length) {
    L.push('🏆 <b>Больше всего времени</b>');
    const top = d.apps[0].seconds;
    d.apps.forEach((a, i) => L.push(`${i + 1}. ${E(niceName(a.name))} — ${fmtH(a.seconds)} <code>${bar(a.seconds, top, 6)}</code>`));
    L.push('');
  }
  if (d.games && d.games.length) {
    L.push(`🕹 <b>Игры: ${fmtH(d.games.reduce((x, g) => x + g.seconds, 0))}</b>`);
    for (const g of d.games) L.push(`• ${E(g.title || g.exe)} — ${fmtH(g.seconds)}${g.fps_n ? ` · ${Math.round(g.fps_sum / g.fps_n)} FPS` : ''}`);
    L.push('');
  }
  L.push('🌐 <b>Интернет</b>');
  L.push(d.outages.count ? `Обрывов: ${d.outages.count}, всего без связи ${fmtH(d.outages.total)} (самый долгий — ${fmtH(d.outages.longest)})` : 'Обрывов не было 👍');
  if (d.speed) L.push(`Скорость: ↓ ${d.speed.last.down} / ↑ ${d.speed.last.up} Мбит/с, задержка ${d.speed.last.ping} мс (замеров: ${d.speed.count})`);
  if (d.devicesNew.length) L.push(`Новых устройств в сети: ${d.devicesNew.length} — ${E(d.devicesNew.slice(0, 5).map((x) => x.label || x.name || x.ip).join(', '))}`);
  L.push('');
  L.push('🛡 <b>Безопасность и действия</b>');
  L.push(`Тревог (перегрев, нагрузка, место): ${d.alerts}`);
  if (d.intruder) L.push(`⚠️ Попыток входа с неверным паролем: ${d.intruder} (фото приходили в чат)`);
  L.push(`Команд с телефона и из Telegram: ${d.commands.total}`);
  if (d.freed) L.push(`🧹 Освобождено места: ${fmtBytes(d.freed)}`);
  if (d.uninstalled.length) L.push(`🗑 Удалены программы: ${E(d.uninstalled.slice(0, 5).join(', '))}`);
  return L.join('\n');
}

function build(ctx, days = 7) {
  const data = collect(ctx, days);
  return { data, text: format(ctx, data) };
}

/** Пора ли отправить отчёт: воскресенье после 20:00 (или понедельник, если в воскресенье ПК был выключен). */
function isDue(lastSent, now = new Date()) {
  const dow = now.getDay();
  const ready = (dow === 0 && now.getHours() >= 20) || dow === 1;
  return ready && (!lastSent || now.getTime() / 1000 - lastSent > 5 * 86400);
}

module.exports = { collect, format, build, isDue };
