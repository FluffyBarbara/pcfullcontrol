'use strict';
// PC Full Control — интерфейс программы на ПК.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const api = (channel, data) => window.pcc.invoke(channel, data);

let STATE = null;
let ACTIONS = {};
let page = 'overview';
let timers = {};

// ===================== утилиты =====================
function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) n.append(c instanceof Node ? c : String(c));
  return n;
}
const ic = (name, size = 18) => Icons.el(name, size);

function fmtBytes(n) {
  if (n === null || n === undefined) return '—';
  const u = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let i = 0;
  while (Math.abs(n) >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i ? n.toFixed(1) : n.toFixed(0)) + ' ' + u[i];
}
function fmtDur(sec) {
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400); const h = Math.floor((sec % 86400) / 3600); const m = Math.floor((sec % 3600) / 60);
  return (d ? d + ' д ' : '') + (h ? h + ' ч ' : '') + m + ' мин';
}
const fmtTime = (ts) => new Date(ts * 1000).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const fmtDate = (iso) => new Date(iso + 'T12:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
function ago(ts) {
  const s = Date.now() / 1000 - ts;
  if (s < 90) return 'только что';
  if (s < 3600) return `${Math.round(s / 60)} мин назад`;
  if (s < 86400) return `${Math.round(s / 3600)} ч назад`;
  return fmtTime(ts);
}

// Скрытые данные (IP, MAC, пользователь): размыты, по нажатию видны 10 секунд, затем снова скрываются
const revealedUntil = {};
const revealTimers = {};
function setRevealed(key, on) {
  document.querySelectorAll(`.secret[data-key="${key}"]`).forEach((x) => {
    x.classList.toggle('revealed', on);
    x.querySelector('.secret-eye').replaceChildren(ic(on ? 'eyeOff' : 'eye', 14));
    x.setAttribute('aria-label', on ? 'Скрыть' : 'Показать на 10 секунд');
  });
}
function secret(text, key) {
  const n = el('span', { class: 'secret', 'data-key': key, role: 'button', tabindex: '0', 'data-tip': 'Нажмите, чтобы показать на 10 секунд. Нажмите ещё раз, чтобы скрыть сразу' },
    el('span', { class: 'secret-val', text }), el('span', { class: 'secret-eye' }, ic('eye', 14)), el('i', { class: 'secret-timer' }));
  if ((revealedUntil[key] || 0) > Date.now()) {
    n.classList.add('revealed');
    n.querySelector('.secret-eye').replaceChildren(ic('eyeOff', 14));
  }
  const toggle = (e) => {
    e.stopPropagation();
    e.preventDefault();
    clearTimeout(revealTimers[key]);
    if ((revealedUntil[key] || 0) > Date.now()) { revealedUntil[key] = 0; setRevealed(key, false); return; }
    revealedUntil[key] = Date.now() + 10000;
    setRevealed(key, true);
    revealTimers[key] = setTimeout(() => setRevealed(key, false), 10000);
  };
  n.addEventListener('click', toggle);
  n.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') toggle(e); });
  return n;
}

function toast(text, kind = 'ok') {
  const t = el('div', { class: 'toast ' + kind }, ic(kind === 'err' ? 'alert' : kind === 'info' ? 'info' : 'check', 18), el('span', { text }));
  $('#toasts').append(t);
  setTimeout(() => t.remove(), Math.min(8000, 2500 + text.length * 30));
}

// ===================== окна =====================
let modalResolve = null;
function openModal(content, cls = '') {
  const card = $('#modal-card');
  card.className = 'modal-card ' + cls;
  card.replaceChildren(...[].concat(content));
  $('#modal').classList.remove('hidden');
  return new Promise((r) => { modalResolve = r; });
}
function closeModal(v = null) {
  $('#modal').classList.add('hidden');
  if (modalResolve) { const r = modalResolve; modalResolve = null; r(v); }
}
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(null); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal').classList.contains('hidden')) closeModal(null); });

function confirmModal(title, text, yes = 'Да', danger = true) {
  return openModal([
    el('h3', { text: title }), el('p', { text }),
    el('div', { class: 'row end' },
      el('button', { class: 'btn', 'data-tip': 'Закрыть окно, ничего не меняя', onclick: () => closeModal(false) }, 'Отмена'),
      el('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), 'data-tip': text, onclick: () => closeModal(true) }, yes)),
  ]);
}

function promptModal(title, hint) {
  const input = el('input', { class: 'input', placeholder: hint });
  const ok = () => { if (input.value.trim()) closeModal(input.value.trim()); };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
  const p = openModal([el('h3', { text: title }), input, el('div', { class: 'row end mt' },
    el('button', { class: 'btn', onclick: () => closeModal(null) }, 'Отмена'), el('button', { class: 'btn primary', onclick: ok }, 'Готово'))]);
  setTimeout(() => input.focus(), 50);
  return p;
}

function changeList(items) {
  return items.map(([icon, text]) => el('div', { class: 'change' }, ic(icon, 18), el('span', { text })));
}

async function showWhatsNew(from, to, cleanup = null) {
  const versions = Changelog.between(from, to);
  if (!versions.length) return;
  const body = el('div', { class: 'wn-body' });
  for (const v of versions) {
    body.append(el('div', { class: 'wn-version', text: `Версия ${v.version} · ${v.title}` }), ...changeList(v.items));
  }
  // Что программа сама удалила после обновления (данные старой версии, старые установщики)
  if (cleanup && cleanup.items && cleanup.items.length) {
    body.append(el('div', { class: 'wn-cleanup' },
      el('div', {}, el('b', { text: `Удалены данные старой версии${cleanup.total ? ` — освобождено ${fmtBytes(cleanup.total)}` : ''}` })),
      ...cleanup.items.slice(0, 8).map((x) => el('div', { class: 'muted', text: '• ' + x.what + (x.freed ? ` (${fmtBytes(x.freed)})` : '') }))));
  }
  await openModal([
    el('div', { class: 'wn-hero' }, el('div', { class: 'wn-ic' }, ic('sparkles', 28)),
      el('h3', { text: 'Что нового' }),
      el('p', { class: 'muted', text: from ? `PC Full Control обновлён: ${from} → ${to}` : `PC Full Control ${to}` })),
    body,
    el('div', { class: 'wn-foot' }, el('button', { class: 'btn primary lg', onclick: () => closeModal(true) }, 'Отлично')),
  ], 'whatsnew');
}

// ===================== навигация =====================
$$('#nav button').forEach((b) => b.addEventListener('click', () => go(b.dataset.page)));
document.addEventListener('click', (e) => {
  const g = e.target.closest('[data-goto]');
  if (g) go(g.dataset.goto);
  const link = e.target.closest('[data-link]');
  if (link) { e.preventDefault(); api('open-external', { url: link.dataset.link }).catch((er) => toast(er.message, 'err')); }
});

function go(p) {
  page = p;
  $$('.page').forEach((s) => s.classList.toggle('hidden', s.id !== 'page-' + p));
  $$('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.page === p));
  Object.values(timers).forEach(clearInterval);
  timers = {};
  $('#content').scrollTop = 0;
  if (p === 'overview') {
    loadStatus(); loadChart();
    timers.s = setInterval(() => { if (!document.hidden) loadStatus(); }, 4000);
  } else if (p === 'phone') {
    loadMobile();
    timers.m = setInterval(loadMobile, 5000);
  } else if (p === 'control') loadVolume();
  else if (p === 'processes') { loadProcesses(); timers.p = setInterval(() => { if (!document.hidden) loadProcesses(); }, 5000); }
  else if (p === 'optimize') Optimize.show();
  else if (p === 'hardware') { Extras.hardware(); More.hardware(); timers.h = setInterval(() => { if (!document.hidden) Extras.gpuOnly(); }, 2500); timers.ht = setInterval(() => { if (!document.hidden) More.temps(); }, 60000); }
  else if (p === 'music') { Music.show(); timers.mu = setInterval(() => { if (!document.hidden) Music.refresh(); }, 2000); timers.mt = setInterval(Music.tick, 500); }
  else if (p === 'network') { Extras.network(); timers.n = setInterval(() => { if (!document.hidden) Extras.network(); }, 8000); }
  else if (p === 'tasks') loadTasks();
  else if (p === 'log') loadLog();
  else if (p === 'settings') { fillSettings(); More.security(); }
  else if (p === 'about') renderAbout();
}

// ===================== состояние =====================
async function loadState() {
  STATE = await api('get-state');
  if (STATE.config && typeof More !== 'undefined') More.applyTheme(STATE.config.ui);
  ACTIONS = Object.fromEntries(STATE.actions.map((a) => [a.name, a]));
  $('#brand-sub').textContent = STATE.pcName;
  $('#hero-name').textContent = STATE.pcName;
  $('#about-version').textContent = STATE.version;
  $('#terminal-card').classList.toggle('hidden', !STATE.config.security.allowShell);
  renderSideStatus();
  renderTelegram();
  renderHeroPills();
  if (!$('#task-action').options.length) fillTaskForm();
  renderControlTiles();
  renderQuickTiles();
  const upd = STATE.update && STATE.update.hasUpdate;
  $('#title-update').classList.toggle('hidden', !upd);
  if (['downloading', 'downloaded', 'installing'].includes(UPD.status)) renderUpdateState(UPD);
  $('#about-dot').classList.toggle('hidden', !upd);
}

function botInfo() {
  const b = STATE.bot;
  if (!b.configured) return { cls: '', text: 'Telegram не подключён' };
  if (b.status === 'online') return { cls: 'online', text: `@${b.username} на связи` };
  if (b.status === 'error') return { cls: 'error', text: b.error || 'Ошибка Telegram' };
  return { cls: 'connecting', text: 'Подключение к Telegram…' };
}

function renderSideStatus() {
  const b = botInfo();
  $('#s-tg-dot').className = 'dot ' + b.cls;
  $('#s-tg').textContent = b.text;
  const m = STATE.mobile;
  const n = m.devices;
  $('#s-app-dot').className = 'dot ' + (m.status === 'running' ? (n ? 'online' : 'connecting') : m.status === 'error' ? 'error' : '');
  $('#s-app').textContent = m.status === 'error' ? m.error : !m.enabled ? 'Приложение выключено' : n ? `Телефонов: ${n}` : 'Телефон не привязан';
  const needSetup = !(b.cls === 'online' && STATE.users.length) && !n;
  $('#phone-dot').classList.toggle('hidden', !needSetup);
  $('#setup-banner').classList.toggle('hidden', !needSetup);
}

function renderHeroPills() {
  const b = botInfo();
  const n = STATE.mobile.devices;
  $('#hero-pills').replaceChildren(
    el('span', { class: 'pill ' + (b.cls === 'online' ? 'ok' : b.cls === 'error' ? 'err' : '') }, ic('telegram', 14), b.cls === 'online' ? 'Telegram' : 'Telegram выкл.'),
    el('span', { class: 'pill ' + (n ? 'ok' : '') }, ic('phone', 14), n ? `Телефонов: ${n}` : 'Нет телефонов'),
    el('span', { class: 'pill ' + (STATE.muted ? 'warn' : 'ok') }, ic(STATE.muted ? 'bellOff' : 'bell', 14), STATE.muted ? 'Уведомления выкл.' : 'Уведомления'),
  );
}

// ===================== обзор =====================
const RING_GRADS = {
  cpu: ['#6d7cff', '#8b9bff'], ram: ['#a855f7', '#e879f9'], disk: ['#06b6d4', '#22d3ee'], temp: ['#f97316', '#fbbf24'], gpu: ['#10b981', '#34d399'],
};
/** Мини-график последнего часа под показателем (из той же истории, что и большой график). */
function spark(key, field) {
  const rows = (chartData || []).filter((r) => r[field] !== null && r[field] !== undefined);
  if (rows.length < 3) return null;
  const vals = rows.slice(-120).map((r) => r[field]);
  const max = field === 'temp' ? Math.max(...vals, 50) : 100;
  const w = 160; const h = 30;
  const pts = vals.map((v, i) => [(i / (vals.length - 1)) * w, h - (Math.max(0, Math.min(max, v)) / max) * (h - 3) - 1.5]);
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'spark');
  const [c1, c2] = RING_GRADS[key] || RING_GRADS.cpu;
  const gid = 'sp-' + key;
  const defs = document.createElementNS(ns, 'defs');
  const lg = document.createElementNS(ns, 'linearGradient');
  lg.setAttribute('id', gid); lg.setAttribute('x1', '0'); lg.setAttribute('x2', '0'); lg.setAttribute('y1', '0'); lg.setAttribute('y2', '1');
  [[0, c2], [1, 'transparent']].forEach(([o, col]) => { const st = document.createElementNS(ns, 'stop'); st.setAttribute('offset', String(o)); st.setAttribute('stop-color', col); lg.append(st); });
  defs.append(lg);
  const area = document.createElementNS(ns, 'path');
  area.setAttribute('d', `${d}L${w},${h}L0,${h}Z`); area.setAttribute('class', 'area'); area.setAttribute('fill', `url(#${gid})`);
  const line = document.createElementNS(ns, 'path');
  line.setAttribute('d', d); line.setAttribute('class', 'line'); line.setAttribute('stroke', c1);
  svg.append(defs, area, line);
  return svg;
}

function ringCard(key, icon, label, percent, value, sub, display) {
  const r = 38; const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(100, percent || 0));
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 92 92');
  const id = 'g-' + key;
  const defs = document.createElementNS(ns, 'defs');
  const lg = document.createElementNS(ns, 'linearGradient');
  lg.setAttribute('id', id); lg.setAttribute('x1', '0'); lg.setAttribute('y1', '0'); lg.setAttribute('x2', '1'); lg.setAttribute('y2', '1');
  RING_GRADS[key].forEach((col, i) => { const st = document.createElementNS(ns, 'stop'); st.setAttribute('offset', String(i)); st.setAttribute('stop-color', col); lg.append(st); });
  defs.append(lg);
  const mk = (attrs) => { const n = document.createElementNS(ns, 'circle'); Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v)); return n; };
  svg.append(defs, mk({ cx: 46, cy: 46, r, fill: 'none', 'stroke-width': 9, class: 'track' }),
    mk({ cx: 46, cy: 46, r, fill: 'none', 'stroke-width': 9, 'stroke-linecap': 'round', class: 'val', stroke: `url(#${id})`, 'stroke-dasharray': c, 'stroke-dashoffset': c * (1 - p / 100) }));
  return el('div', { class: 'card gauge' },
    el('div', { class: 'ring' }, svg, el('div', { class: 'ring-num' }, el('span', {}, display ?? Math.round(p), el('small', { text: display ? '' : '%' })))),
    el('div', { class: 'g-info' }, el('div', { class: 'g-label' }, ic(icon, 15), label), el('div', { class: 'g-value', text: value }), el('div', { class: 'g-sub', text: sub || '' }),
      spark(key, { cpu: 'cpu', ram: 'ram', disk: null, temp: 'temp' }[key])));
}

/** «Добрый вечер · четверг, 5 ноября» */
function greeting() {
  const d = new Date();
  const h = d.getHours();
  const hi = h < 5 ? 'Доброй ночи' : h < 12 ? 'Доброе утро' : h < 18 ? 'Добрый день' : 'Добрый вечер';
  return `${hi} · ${d.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })}`;
}

/** «AMD Ryzen 5 3600 6-Core Processor» → «AMD Ryzen 5 3600», «Intel(R) Core(TM) i7-9700K CPU @ 3.60GHz» → «Intel Core i7-9700K». */
function cpuName(model) {
  return String(model || '').replace(/\((R|TM|tm|r)\)/g, '').replace(/\bCPU\b|\bProcessor\b|\d+-Core|with Radeon.*$|@\s*[\d.]+\s*GHz/gi, '')
    .replace(/\s+/g, ' ').trim();
}

async function loadStatus() {
  let s;
  try { s = await api('get-status'); } catch (e) { return; }
  $('#hero-sub').textContent = `${s.os} · работает ${fmtDur(s.uptime)}`;
  $('#hero-greet').textContent = greeting();
  const disk = s.disks.length ? s.disks.reduce((a, b) => (b.total > a.total ? b : a)) : null;
  const cards = [
    ringCard('cpu', 'cpu', 'Процессор', s.cpu.percent, `${s.cpu.threads} потоков`, s.cpu.mhz ? `${s.cpu.mhz} МГц` : ''),
    ringCard('ram', 'memory', 'Память', s.ram.percent, fmtBytes(s.ram.used), `из ${fmtBytes(s.ram.total)}`),
    ringCard('disk', 'disk', 'Диск ' + (disk ? disk.mount : ''), disk ? disk.percent : 0, disk ? fmtBytes(disk.free) : '—', disk ? `свободно из ${fmtBytes(disk.total)}` : ''),
  ];
  if (s.temp !== null && s.temp !== undefined) cards.push(ringCard('temp', 'temp', 'Температура', s.temp, `${Math.round(s.temp)}°C`, 'процессор', Math.round(s.temp) + '°'));
  else if (s.gpus && s.gpus[0]) cards.push(ringCard('gpu', 'gpu', 'Видеокарта', s.gpus[0].util, s.gpus[0].name, s.gpus[0].temp !== null ? `${Math.round(s.gpus[0].temp)}°C` : ''));
  else if (s.battery) cards.push(ringCard('gpu', 'battery', 'Батарея', s.battery.percent, `${s.battery.percent}%`, s.battery.plugged ? 'заряжается' : 'от батареи'));
  else cards.push(ringCard('gpu', 'clock', 'Работает', Math.min(100, (s.uptime / 86400) * 100), fmtDur(s.uptime), 'с ' + fmtTime(s.bootTime), Math.floor(s.uptime / 3600) + 'ч'));
  $('#gauges').replaceChildren(...cards);

  $('#disks').replaceChildren(...s.disks.slice(0, 6).map((d) => {
    const fill = el('i');
    fill.style.width = d.percent + '%';
    return el('div', { class: 'disk' },
      el('div', { class: 'disk-top' }, el('b', { text: d.mount }), el('span', { class: 'muted', text: `${fmtBytes(d.free)} свободно из ${fmtBytes(d.total)}` })),
      el('div', { class: 'bar ' + (d.percent >= 90 ? 'hot' : d.percent >= 75 ? 'mid' : '') }, fill));
  }));
  const kv = (k, v, key, extra) => el('div', { class: 'kv' }, el('span', { text: k }), key ? el('b', {}, secret(v, key), extra || null) : el('b', { class: 'plain', text: v, title: v }));
  // Основной адрес — в капсуле, остальные — счётчиком «+N», чтобы строка не переносилась
  const ipMore = s.ips.length > 1 ? el('span', { class: 'more', text: '+' + (s.ips.length - 1), 'data-tip': 'Ещё адреса компьютера — полный список в разделе «Телефон»' }) : null;
  const rows = [kv('Имя', s.hostname), kv('Процессор', cpuName(s.cpu.model) || '—'), kv('IP-адрес', s.ips[0] || '—', 'ip', ipMore), kv('Пользователь', s.users.join(', ') || '—', 'user'), kv('Включён', fmtTime(s.bootTime))];
  for (const g of s.gpus || []) rows.push(kv('Видеокарта', `${g.name} · ${Math.round(g.util)}%`));
  if (s.battery) rows.push(kv('Батарея', `${s.battery.percent}% ${s.battery.plugged ? '· заряжается' : ''}`));
  $('#sysinfo').replaceChildren(...rows);
}

let chartHours = 1;
let chartData = [];
$$('#chart-range button').forEach((b) => b.addEventListener('click', () => {
  chartHours = Number(b.dataset.h);
  $$('#chart-range button').forEach((x) => x.classList.toggle('active', x === b));
  loadChart();
}));
window.addEventListener('resize', drawChart);
window.pcc.on('metrics', () => { if (page === 'overview') loadChart(); });

async function loadChart() {
  try { chartData = await api('get-metrics', { hours: chartHours }); } catch (e) { return; }
  drawChart();
}

function drawChart() {
  const c = $('#chart');
  if (!c.offsetParent) return;
  const dpr = devicePixelRatio || 1;
  const w = c.clientWidth; const h = c.clientHeight;
  c.width = w * dpr; c.height = h * dpr;
  const g = c.getContext('2d');
  g.scale(dpr, dpr);
  const css = getComputedStyle(document.documentElement);
  const v = (n) => css.getPropertyValue(n).trim();
  const L = 32; const T = 8; const B = 22;
  const y = (val) => T + (h - T - B) * (1 - Math.max(0, Math.min(100, val)) / 100);
  g.font = '11px "Segoe UI", sans-serif';
  g.fillStyle = v('--dim');
  g.strokeStyle = `rgba(${v('--ov')}, .06)`;
  for (const val of [0, 25, 50, 75, 100]) {
    g.beginPath(); g.moveTo(L, y(val)); g.lineTo(w, y(val)); g.stroke();
    g.fillText(String(val), 4, y(val) + 4);
  }
  if (chartData.length < 2) { g.fillText('Данные собираются (каждые 30 секунд)…', L + 12, h / 2); return; }
  const t0 = chartData[0].ts; const t1 = chartData[chartData.length - 1].ts;
  const x = (ts) => L + (w - L - 4) * ((ts - t0) / Math.max(1, t1 - t0));
  // подписи времени
  for (let i = 0; i <= 4; i++) {
    const ts = t0 + ((t1 - t0) * i) / 4;
    const d = new Date(ts * 1000);
    const label = chartHours > 24 ? d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) : d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    g.fillText(label, Math.min(w - 36, x(ts) - (i ? 14 : 0)), h - 4);
  }
  for (const [key, color, fill] of [['ram', '--ram', true], ['cpu', '--cpu', true], ['temp', '--temp', false]]) {
    const col = v(color);
    const pts = chartData.filter((p) => p[key] !== null && p[key] !== undefined);
    if (pts.length < 2) continue;
    g.beginPath();
    pts.forEach((p, i) => (i ? g.lineTo(x(p.ts), y(p[key])) : g.moveTo(x(p.ts), y(p[key]))));
    g.strokeStyle = col; g.lineWidth = 2; g.lineJoin = 'round'; g.stroke();
    if (fill) {
      g.lineTo(x(pts[pts.length - 1].ts), y(0)); g.lineTo(x(pts[0].ts), y(0)); g.closePath();
      const grad = g.createLinearGradient(0, T, 0, h - B);
      grad.addColorStop(0, col + '40'); grad.addColorStop(1, col + '00');
      g.fillStyle = grad; g.fill();
    }
  }
}

// ===================== действия =====================
async function runAction(name, arg = '', tileEl = null) {
  const a = ACTIONS[name];
  if (!a) return null;
  if (a.argRequired && !arg) {
    arg = await promptModal(a.title, a.argHint);
    if (!arg) return null;
  }
  if (a.dangerous && !(await confirmModal(a.title + '?', arg ? `Параметр: ${arg}` : 'Действие будет выполнено на этом компьютере.', a.title))) return null;
  if (tileEl) tileEl.classList.add('busy');
  try {
    const r = await api('run-action', { name, arg });
    if (name === 'clipboard_get' && r.ok) openModal([el('h3', { text: 'Буфер обмена' }), el('pre', { class: 'output', text: r.result }), el('div', { class: 'row end mt' }, el('button', { class: 'btn', onclick: () => closeModal() }, 'Закрыть'))]);
    else toast(r.result, r.ok ? 'ok' : 'err');
    if (a.category === 'media') setTimeout(loadVolume, 400);
    return r;
  } catch (e) {
    toast(e.message, 'err');
    return null;
  } finally {
    if (tileEl) tileEl.classList.remove('busy');
  }
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const arg = b.dataset.arg ? document.getElementById(b.dataset.arg).value.trim() : '';
  runAction(b.dataset.act, arg);
});

const SHORT = {
  shutdown: 'Выключить', reboot: 'Перезагрузить', cancel_shutdown: 'Отменить выключение', monitor_off: 'Выключить монитор',
  check_updates: 'Проверить обновления', upgrade_all: 'Обновить все программы', win_update_check: 'Windows Update',
  win_update_install: 'Установить обновления Windows', app_update: 'Обновить PC Full Control', status_report: 'Отчёт в Telegram',
  screenshot: 'Скриншот в Telegram', webcam: 'Камера в Telegram', open_url: 'Открыть ссылку', launch: 'Запустить программу',
  clipboard_get: 'Буфер обмена', clipboard_set: 'Записать в буфер', notify: 'Напоминание', empty_recycle_bin: 'Очистить корзину',
  restart_app: 'Перезапустить программу', message: 'Сообщение на экран', say: 'Озвучить текст', lock: 'Заблокировать',
  logoff: 'Выйти из системы', sleep: 'Спящий режим', hibernate: 'Гибернация',
};
const CONTROL = [
  ['Питание', [['shutdown', 'danger'], ['reboot', 'warn'], ['sleep'], ['hibernate'], ['lock'], ['logoff'], ['monitor_off'], ['cancel_shutdown']]],
  ['Обновление ПО', [['check_updates', 'cyan'], ['upgrade_all', 'cyan'], ['win_update_check', 'cyan'], ['win_update_install', 'cyan'], ['app_update', 'green']]],
  ['В Telegram', [['screenshot'], ['webcam'], ['status_report']]],
  ['Разное', [['open_url'], ['launch'], ['clipboard_get'], ['clipboard_set'], ['notify'], ['empty_recycle_bin', 'warn'], ['restart_app']]],
];
function tile(name, tone = '', sub = '') {
  if (!ACTIONS[name]) return null;
  const t = el('button', { class: 'tile ' + tone, 'data-act': name }, el('span', { class: 'tile-ic' }, ic(Icons.ACTION_ICONS[name] || 'zap', 19)),
    el('span', {}, SHORT[name] || ACTIONS[name].title, sub ? el('small', { text: sub }) : null));
  t.addEventListener('click', () => runAction(name, '', t));
  return t;
}
function renderControlTiles() {
  const box = $('#control-tiles');
  box.replaceChildren();
  for (const [title, items] of CONTROL) {
    const tiles = items.map(([n, tone]) => tile(n, tone)).filter(Boolean);
    if (tiles.length) box.append(el('div', { class: 'section-label mt22', text: title }), el('div', { class: 'tiles' }, tiles));
  }
}
function renderQuickTiles() {
  $('#quick-tiles').replaceChildren(...[['lock'], ['monitor_off'], ['screenshot'], ['check_updates', 'cyan'], ['empty_recycle_bin', 'warn'], ['shutdown', 'danger']]
    .map(([n, t]) => tile(n, t)).filter(Boolean));
}

let volDrag = false;
async function loadVolume() {
  try {
    const s = await api('get-status');
    if (s.volume && !volDrag) setVol(s.volume.level, s.volume.muted);
  } catch (e) { /* ignore */ }
}
function setVol(level, muted) {
  const v = $('#volume');
  v.value = level;
  v.style.setProperty('--p', level + '%');
  $('#vol-num').textContent = muted ? 'выкл.' : level + '%';
}
$('#volume').addEventListener('input', (e) => { volDrag = true; setVol(e.target.value, false); });
$('#volume').addEventListener('change', async (e) => { await runAction('set_volume', e.target.value); volDrag = false; });

$('#terminal-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const cmd = $('#terminal-input').value.trim();
  if (!cmd) return;
  const out = $('#terminal-output');
  out.classList.remove('hidden');
  out.textContent = 'PS> ' + cmd + '\nВыполняется…';
  try { out.textContent = (await api('run-action', { name: 'shell', arg: cmd })).result; } catch (err) { out.textContent = err.message; }
});

// ===================== телефон =====================
$$('#phone-tabs button').forEach((b) => b.addEventListener('click', () => {
  $$('#phone-tabs button').forEach((x) => x.classList.toggle('active', x === b));
  $('#phone-app').classList.toggle('hidden', b.dataset.tab !== 'app');
  $('#phone-tg').classList.toggle('hidden', b.dataset.tab !== 'tg');
}));

let lastCode = '';
async function loadMobile() {
  let m;
  try { m = await api('mobile-info'); } catch (e) { return; }
  const st = $('#m-status');
  st.className = 'pill ' + (m.status === 'running' ? 'ok' : m.status === 'error' ? 'err' : 'warn');
  st.replaceChildren(el('span', { class: 'dot ' + (m.status === 'running' ? 'ok' : m.status === 'error' ? 'err' : 'warn') }),
    m.status === 'running' ? 'Ожидает подключения' : m.status === 'error' ? m.error : 'Выключено в настройках');
  if (m.qr) $('#m-qr').src = m.qr;
  if (m.code !== lastCode) {
    lastCode = m.code;
    $('#m-code').replaceChildren(...m.code.split('').map((d) => el('span', { text: d })));
  }
  const left = Math.max(0, Math.round((m.expires - Date.now()) / 1000));
  $('#m-code-meta').textContent = `Код действует ещё ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  $('#m-addrs').replaceChildren(...(m.addresses.length ? m.addresses : ['нет сети']).map((a) => el('div', { class: 'addr' }, ic('wifi', 16), el('code', {}, secret(a.replace(/^http:\/\//, ''), 'ip')))));
  $('#m-step3').classList.toggle('done', m.devices.length > 0);
  const box = $('#m-devices');
  if (!m.devices.length) box.replaceChildren(el('div', { class: 'empty' }, ic('phone', 28), 'Пока ни один телефон не привязан'));
  else {
    box.replaceChildren(...m.devices.map((d) => el('div', { class: 'item' },
      el('div', { class: 'item-ic' }, ic(d.platform === 'ios' ? 'apple' : d.platform === 'android' ? 'android' : 'phone', 18)),
      el('div', { class: 'item-main' }, el('div', { class: 'item-title', text: d.name }),
        el('div', { class: 'item-sub' }, `в сети ${ago(d.last_seen)} · `, secret(d.ip || '—', 'ip'), ` · привязан ${fmtTime(d.created)}`)),
      el('button', { class: 'btn sm danger', 'data-tip': 'Отвязать телефон — он больше не сможет управлять компьютером', onclick: async () => {
        if (!(await confirmModal('Отвязать телефон?', `«${d.name}» больше не сможет управлять компьютером.`, 'Отвязать'))) return;
        await api('remove-device', { id: d.id });
        loadMobile(); loadState();
      } }, 'Отвязать'))));
  }
}
$('#m-regen').addEventListener('click', async () => { await api('mobile-regen'); loadMobile(); });

function renderTelegram() {
  const b = STATE.bot;
  const bi = botInfo();
  const st = $('#tg-status');
  st.className = 'pill ' + (bi.cls === 'online' ? 'ok' : bi.cls === 'error' ? 'err' : bi.cls ? 'warn' : '');
  st.replaceChildren(el('span', { class: 'dot ' + bi.cls }), bi.text);
  $('#tg-setup').classList.toggle('hidden', b.configured);
  $('#tg-done').classList.toggle('hidden', !b.configured);
  $('#tg-name').textContent = b.username ? '@' + b.username : '';
  $('#tg-state').textContent = bi.text;
  if (STATE.pairing.qr) { $('#tg-qr').src = STATE.pairing.qr; $('#tg-cmd').textContent = '/pair ' + STATE.pairing.code; }
  const box = $('#tg-users');
  if (!STATE.users.length) box.replaceChildren(el('div', { class: 'empty' }, ic('telegram', 28), 'Пока ни один аккаунт не привязан'));
  else {
    box.replaceChildren(...STATE.users.map((u) => el('div', { class: 'item' },
      el('div', { class: 'item-ic' }, ic('telegram', 18)),
      el('div', { class: 'item-main' }, el('div', { class: 'item-title', text: (u.name || 'Без имени') + (u.username ? ' · @' + u.username : '') }),
        el('div', { class: 'item-sub', text: `ID ${u.user_id} · привязан ${fmtTime(u.added)}` })),
      el('button', { class: 'btn sm danger', 'data-tip': 'Отвязать этот аккаунт Telegram — он перестанет получать уведомления и управлять ПК', onclick: async () => {
        if (!(await confirmModal('Отвязать аккаунт?', 'Этот аккаунт Telegram больше не сможет управлять компьютером.', 'Отвязать'))) return;
        await api('remove-user', { userId: u.user_id });
        loadState();
      } }, 'Отвязать'))));
  }
  $('#tg-test').disabled = !STATE.users.length;
}

$('#token-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#token-error').textContent = '';
  const btn = e.submitter;
  btn.disabled = true;
  btn.textContent = 'Проверяю…';
  try {
    await api('set-token', { token: $('#token-input').value });
    $('#token-input').value = '';
    await loadState();
    toast('Бот подключён');
  } catch (err) {
    $('#token-error').textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Подключить';
  }
});
$('#tg-change').addEventListener('click', async () => {
  if (!(await confirmModal('Отключить бота?', 'Привязанные аккаунты останутся в списке.', 'Отключить'))) return;
  await api('set-token', { token: '' });
  loadState();
});
$('#tg-open').addEventListener('click', () => STATE.bot.username && api('open-external', { url: `https://t.me/${STATE.bot.username}` }));
$('#tg-regen').addEventListener('click', async () => { await api('regen-pair'); loadState(); });
$('#tg-test').addEventListener('click', async () => {
  try { await api('test-notify'); toast('Отправлено — проверьте Telegram'); } catch (e) { toast(e.message, 'err'); }
});

// ===================== процессы =====================
let procSort = 'cpu';
let procTimer;
$('#proc-search').addEventListener('input', () => { clearTimeout(procTimer); procTimer = setTimeout(loadProcesses, 300); });
$('#proc-refresh').addEventListener('click', loadProcesses);
$$('#proc-sort button').forEach((b) => b.addEventListener('click', () => {
  procSort = b.dataset.sort;
  $$('#proc-sort button').forEach((x) => x.classList.toggle('active', x === b));
  loadProcesses();
}));

async function loadProcesses() {
  let list;
  try { list = await api('get-processes', { sort: procSort, query: $('#proc-search').value.trim() }); } catch (e) { toast(e.message, 'err'); return; }
  $('#proc-count').textContent = `Показано ${list.length} процессов`;
  const maxCpu = Math.max(10, ...list.map((p) => p.cpu));
  $('#proc-body').replaceChildren(...list.map((p) => {
    const fill = el('i');
    fill.style.width = Math.min(100, (p.cpu / maxCpu) * 100) + '%';
    return el('tr', {},
      el('td', { class: 'name', text: p.name, title: p.name }),
      el('td', { class: 'num dim', text: String(p.pid) }),
      el('td', { class: 'num' }, el('div', { class: 'cpu-cell' }, el('div', { class: 'bar' }, fill), el('span', { text: p.cpu.toFixed(1) + '%' }))),
      el('td', { class: 'num', text: fmtBytes(p.mem) }),
      el('td', { class: 'dim', text: p.user || '' }),
      el('td', { class: 'num' }, el('button', { class: 'btn sm danger', 'data-tip': 'Завершить этот процесс (несохранённые данные в нём пропадут)', onclick: async () => {
        const r = await runAction('kill', String(p.pid));
        if (r && r.ok) loadProcesses();
      } }, ic('x', 14))));
  }));
}

// ===================== задачи =====================
const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
function fillTaskForm() {
  const cats = { power: 'Питание', media: 'Звук', updates: 'Обновления', system: 'Система', misc: 'Разное' };
  const sel = $('#task-action');
  sel.replaceChildren();
  for (const [cat, title] of Object.entries(cats)) {
    const grp = el('optgroup', { label: title });
    STATE.actions.filter((a) => a.category === cat).forEach((a) => grp.append(el('option', { value: a.name, text: a.title })));
    if (grp.children.length) sel.append(grp);
  }
  $('#task-days').replaceChildren(...WEEKDAYS.map((d, i) => el('label', {}, el('input', { type: 'checkbox', value: String(i), checked: true }), el('span', { text: d }))));
  const dt = new Date(Date.now() + 3600e3);
  dt.setMinutes(dt.getMinutes() - dt.getTimezoneOffset());
  $('#task-at').value = dt.toISOString().slice(0, 16);
  updateTaskForm();
}
function updateTaskForm() {
  const a = ACTIONS[$('#task-action').value];
  $('#task-arg-wrap').classList.toggle('hidden', !(a && a.argHint));
  if (a) $('#task-arg').placeholder = a.argHint;
  const k = $('#task-kind').value;
  $('#task-in-wrap').classList.toggle('hidden', k !== 'in');
  $('#task-at-wrap').classList.toggle('hidden', k !== 'at');
  $('#task-time-wrap').classList.toggle('hidden', k !== 'daily');
  $('#task-days').classList.toggle('hidden', k !== 'daily');
}
$('#task-action').addEventListener('change', updateTaskForm);
$('#task-kind').addEventListener('change', updateTaskForm);
$('#task-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#task-error').textContent = '';
  const kind = $('#task-kind').value;
  const t = { action: $('#task-action').value, arg: $('#task-arg').value.trim(), kind };
  if (kind === 'in') t.delayMinutes = Number($('#task-delay').value);
  if (kind === 'at') t.runAt = $('#task-at').value;
  if (kind === 'daily') { t.timeOfDay = $('#task-time').value; t.weekdays = $$('#task-days input:checked').map((i) => Number(i.value)); }
  try {
    await api('add-task', t);
    $('#task-arg').value = '';
    toast('Задача добавлена');
    loadTasks();
  } catch (err) { $('#task-error').textContent = err.message; }
});
async function loadTasks() {
  const tasks = await api('get-tasks');
  const box = $('#tasks');
  if (!tasks.length) { box.replaceChildren(el('div', { class: 'empty' }, ic('calendar', 30), 'Задач пока нет')); return; }
  box.replaceChildren(...tasks.map((t) => {
    const sw = el('label', { class: 'switch' }, el('input', { type: 'checkbox', checked: !!t.enabled }), el('span'));
    sw.querySelector('input').addEventListener('change', async () => { await api('toggle-task', { id: t.id }); loadTasks(); });
    return el('div', { class: 'item' + (t.enabled ? '' : ' off') },
      el('div', { class: 'item-ic' }, ic(Icons.ACTION_ICONS[t.action] || 'clock', 18)),
      el('div', { class: 'item-main' }, el('div', { class: 'item-title', text: t.description.replace(/^#\d+\s*(🔁|🕐)?\s*/u, '') }),
        el('div', { class: 'item-sub', text: (t.kind === 'daily' ? 'повторяется' : 'один раз') + (t.last_run ? ' · последний запуск ' + fmtTime(t.last_run) : '') })),
      sw,
      el('button', { class: 'btn sm ghost', 'data-tip': 'Удалить задачу из расписания', onclick: async () => { await api('delete-task', { id: t.id }); loadTasks(); } }, ic('trash', 15)));
  }));
}

// ===================== журнал =====================
let logMode = 'events';
$$('#log-tabs button').forEach((b) => b.addEventListener('click', () => {
  logMode = b.dataset.mode;
  $$('#log-tabs button').forEach((x) => x.classList.toggle('active', x === b));
  loadLog();
}));
async function loadLog() {
  const rows = await api('get-log', { mode: logMode });
  const box = $('#log');
  if (!rows.length) { box.replaceChildren(el('div', { class: 'empty' }, ic('list', 30), 'Пока пусто')); return; }
  const src = { telegram: 'Telegram', app: 'ПК', scheduler: 'планировщик', mobile: 'телефон' };
  if (logMode === 'jobs') {
    const open = new Set($$('details.job[open]').map((d) => d.dataset.id));
    box.replaceChildren(...rows.map((j) => el('details', { class: 'job', 'data-id': String(j.id), open: open.has(String(j.id)) },
      el('summary', {}, ic(j.status === 'running' ? 'hourglass' : j.status === 'done' ? 'check' : 'alert', 17),
        el('b', { text: j.title }), el('span', { class: 'spacer' }),
        el('span', { class: 'pill ' + (j.status === 'done' ? 'ok' : j.status === 'error' ? 'err' : 'warn'), text: j.status === 'done' ? 'готово' : j.status === 'error' ? 'ошибка' : 'выполняется' }),
        el('span', { class: 'dim small', text: fmtTime(j.started) })),
      el('pre', { class: 'output', text: j.status === 'running' ? 'Выполняется…' : (j.output || '(нет вывода)') }))));
  } else if (logMode === 'commands') {
    box.replaceChildren(...rows.map((r) => el('div', { class: 'log-row ' + (r.ok ? 'success' : 'fail') },
      ic(Icons.ACTION_ICONS[r.action] || 'zap', 16), el('time', { text: fmtTime(r.ts) }),
      el('div', { class: 'msg' }, (ACTIONS[r.action] ? ACTIONS[r.action].title : r.action) + (r.arg ? ` «${r.arg.slice(0, 80)}»` : ''), el('span', { class: 'dim small', text: '  · ' + (src[r.source] || r.source) + (r.user ? ' · ' + r.user : '') })))));
  } else {
    box.replaceChildren(...rows.map((r) => el('div', { class: 'log-row ' + r.level },
      ic(r.level === 'info' ? 'info' : 'alert', 16), el('time', { text: fmtTime(r.ts) }), el('div', { class: 'msg', text: r.message }))));
  }
}

// ===================== настройки =====================
const getPath = (o, p) => p.split('.').reduce((x, k) => (x ? x[k] : undefined), o);
function setPath(o, p, v) {
  const ks = p.split('.');
  let x = o;
  ks.slice(0, -1).forEach((k) => { x[k] = x[k] || {}; x = x[k]; });
  x[ks[ks.length - 1]] = v;
}
function appRow(a = { name: '', cmd: '' }) {
  return el('div', { class: 'row app-row' },
    el('input', { class: 'input app-name', placeholder: 'Название', value: a.name }),
    el('input', { class: 'input app-cmd', placeholder: 'Программа или путь, например steam.exe', value: a.cmd }),
    el('button', { class: 'btn sm ghost', type: 'button', 'data-tip': 'Убрать программу из списка быстрого запуска', onclick: (e) => e.target.closest('.app-row').remove() }, ic('x', 15)));
}
$('#add-app').addEventListener('click', () => $('#apps').append(appRow()));
async function loadWol() {
  let w;
  try { w = await api('wol-info'); } catch (e) { return; }
  $('#wol-card').classList.toggle('hidden', !w.isWin && !w.iface);
  $('#wol-iface').textContent = w.iface ? w.iface.name : 'не найден';
  $('#wol-mac').replaceChildren(w.iface ? secret(w.iface.mac, 'mac') : document.createTextNode('—'));
  $('#wol-type').textContent = w.iface ? (w.iface.wifi ? 'Wi-Fi — включение по сети может не работать' : 'по кабелю') : '—';
  const al = w.autologon || {};
  $('#al-off').classList.toggle('hidden', !!al.enabled || !al.supported);
  $('#al-on').classList.toggle('hidden', !al.enabled);
  $('#al-user').textContent = al.enabled ? `включено для «${al.user}»` : '';
  if (!al.supported) $('#al-error').textContent = 'Доступно только в Windows';
}
$('#wol-setup').addEventListener('click', async (e) => {
  e.currentTarget.disabled = true;
  try {
    const out = await api('wol-setup');
    openModal([el('h3', { text: 'Настройка включения по сети' }), el('pre', { class: 'output', text: out }),
      el('div', { class: 'row end mt' }, el('button', { class: 'btn primary', onclick: () => closeModal() }, 'Понятно'))]);
  } catch (err) { toast(err.message, 'err'); }
  e.currentTarget.disabled = false;
});
$('#al-enable').addEventListener('click', async () => {
  $('#al-error').textContent = '';
  const pw = $('#al-password').value;
  if (!pw) { $('#al-error').textContent = 'Введите пароль'; return; }
  if (!(await confirmModal('Включить вход без пароля?', 'Если компьютер включат с телефона, Windows войдёт сама. Если включат кнопкой — программа сразу заблокирует экран, но рабочий стол может мелькнуть на 1–3 секунды.', 'Включить', false))) return;
  $('#al-enable').disabled = true;
  try { await api('autologon-enable', { password: pw }); $('#al-password').value = ''; toast('Вход без пароля включён'); }
  catch (e) { $('#al-error').textContent = e.message; }
  $('#al-enable').disabled = false;
  loadWol();
});
$('#al-disable').addEventListener('click', async () => {
  try { await api('autologon-disable'); toast('Вход без пароля выключен'); } catch (e) { toast(e.message, 'err'); }
  loadWol();
});

function fillSettings() {
  loadWol();
  $$('[data-cfg]').forEach((inp) => {
    const v = getPath(STATE.config, inp.dataset.cfg);
    if (inp.type === 'checkbox') inp.checked = !!v;
    else if ('list' in inp.dataset) inp.value = (v || []).join(', ');
    else if ('lines' in inp.dataset) inp.value = (v || []).join('\n');
    else inp.value = v ?? '';
  });
  $('#autostart').checked = STATE.autostart.enabled;
  $('#notif-enabled').checked = !STATE.muted;
  $('#apps').replaceChildren(...STATE.config.apps.map(appRow));
  $('#settings-result').textContent = '';
}
$('#save-settings').addEventListener('click', async () => {
  const patch = {};
  $$('[data-cfg]').forEach((inp) => {
    let v;
    if (inp.type === 'checkbox') v = inp.checked;
    else if ('num' in inp.dataset) v = Number(inp.value);
    else if ('list' in inp.dataset) v = inp.value.split(',').map((x) => x.trim()).filter(Boolean);
    else if ('lines' in inp.dataset) v = inp.value.split('\n').map((x) => x.trim()).filter(Boolean);
    else v = inp.value.trim();
    setPath(patch, inp.dataset.cfg, v);
  });
  patch.apps = $$('.app-row').map((r) => ({ name: $('.app-name', r).value.trim(), cmd: $('.app-cmd', r).value.trim() })).filter((a) => a.name && a.cmd);
  try {
    await api('save-config', patch);
    await api('set-muted', { muted: !$('#notif-enabled').checked });
    if ($('#autostart').checked !== STATE.autostart.enabled) await api('set-autostart', { enabled: $('#autostart').checked });
    await loadState();
    fillSettings();
    $('#settings-result').textContent = 'Сохранено';
    toast('Настройки сохранены');
  } catch (e) { toast(e.message, 'err'); }
});

// ===================== о программе =====================
function renderAbout() {
  const box = $('#changelog');
  box.replaceChildren(...Changelog.CHANGELOG.map((v) => el('div', { class: 'tl-item' + (v.version === STATE.version ? ' current' : '') },
    el('div', { class: 'tl-head' }, el('b', { text: 'Версия ' + v.version }), v.version === STATE.version ? el('span', { class: 'pill ok', text: 'установлена' }) : null,
      el('span', { class: 'dim small', text: fmtDate(v.date) })),
    el('div', { class: 'muted small mb6', text: v.title }), ...changeList(v.items))));
  renderUpdate(STATE.update);
}
function renderUpdate(u) {
  if (!u) return;
  const busy = ['downloading', 'downloaded', 'installing'].includes(UPD.status);
  $('#install-update').classList.toggle('hidden', !u.hasUpdate || busy);
  if (busy) return;
  $('#update-result').textContent = u.hasUpdate ? `Доступна версия ${u.latest}. Программа скачает её, установит и сразу откроется новой версией.`
    : u.latest ? `Установлена последняя версия (${u.current}).` : (u.message || '');
}

// Состояние обновления приходит из главного процесса: проверка → скачивание (с процентами) → установка
let UPD = { status: 'idle' };
function renderUpdateState(st) {
  UPD = st || UPD;
  const box = $('#upd-progress');
  const pill = $('#title-update');
  const busy = ['downloading', 'downloaded', 'installing'].includes(UPD.status);
  box.classList.toggle('hidden', !busy);
  box.classList.toggle('indeterminate', UPD.status !== 'downloading' || !UPD.total);
  if (busy) {
    $('#install-update').classList.add('hidden');
    $('#upd-bar').style.width = (UPD.percent || 0) + '%';
    if (UPD.status === 'downloading') {
      $('#upd-text').textContent = `Скачиваю версию ${UPD.latest}` + (UPD.total ? ` · ${fmtBytes(UPD.transferred)} из ${fmtBytes(UPD.total)}` : '')
        + (UPD.speed ? ` · ${fmtBytes(UPD.speed)}/с` : '');
      $('#upd-pct').textContent = (UPD.percent || 0) + '%';
    } else {
      $('#upd-text').textContent = `Устанавливаю версию ${UPD.latest} — программа закроется и через минуту откроется новой версией`;
      $('#upd-pct').textContent = '';
    }
    $('#update-result').textContent = '';
    pill.classList.remove('hidden');
    pill.replaceChildren(ic('download', 14), UPD.status === 'downloading' ? `Обновление ${UPD.percent || 0}%` : 'Установка обновления…');
  } else if (UPD.status === 'error') {
    $('#update-result').textContent = 'Обновление не удалось: ' + UPD.error;
    $('#install-update').disabled = false;
  }
}
window.pcc.on('update-state', (st) => {
  renderUpdateState(st);
  if (st.status === 'error') toast('Обновление не удалось: ' + st.error, 'err');
});

$('#check-update').addEventListener('click', async () => {
  $('#update-result').textContent = 'Проверяю…';
  try { STATE.update = await api('check-app-update'); renderUpdate(STATE.update); loadState(); } catch (e) { $('#update-result').textContent = 'Не удалось проверить: ' + e.message; }
});
$('#install-update').addEventListener('click', async () => {
  const v = STATE.update && STATE.update.latest;
  if (!(await confirmModal(`Обновить до ${v || 'новой версии'}?`, 'Программа скачает обновление, установит его и сама откроется уже новой версией. Это займёт 1–2 минуты.', 'Обновить', false))) return;
  $('#install-update').disabled = true;
  try {
    const r = await api('update-start');
    $('#update-result').textContent = r;
    renderUpdateState(await api('update-state'));
  } catch (e) { $('#update-result').textContent = e.message; $('#install-update').disabled = false; }
});
// Новая версия найдена (при запуске программы, открытии окна или по расписанию) — предлагаем обновиться
const updateDismissed = new Set();
let updatePromptOpen = false;
async function promptUpdate(u) {
  if (!u || !u.hasUpdate || updateDismissed.has(u.latest) || updatePromptOpen) return;
  if (['downloading', 'downloaded', 'installing'].includes(UPD.status)) return;
  // Не перебиваем другое открытое окно — дождёмся, пока его закроют
  while (!$('#modal').classList.contains('hidden')) await new Promise((r) => setTimeout(r, 500));
  updatePromptOpen = true;
  const notes = u.notes || {};
  const list = (notes.items || []).map((t) => el('div', { class: 'change' }, ic('check', 18), el('span', { text: t })));
  const ok = await openModal([
    el('div', { class: 'wn-hero' }, el('div', { class: 'wn-ic' }, ic('download', 28)),
      el('h3', { text: `Доступна версия ${u.latest}` }),
      el('p', { class: 'muted', text: `Сейчас установлена ${u.current}. Обновление скачается, установится и программа сама откроется новой версией — 1–2 минуты.` })),
    list.length ? el('div', { class: 'wn-body' }, notes.title ? el('div', { class: 'wn-version', text: notes.title }) : null, ...list) : null,
    el('div', { class: 'wn-foot row center' },
      el('button', { class: 'btn lg', 'data-tip': 'Напомнить при следующем запуске программы', onclick: () => closeModal(false) }, 'Позже'),
      el('button', { class: 'btn primary lg', 'data-tip': 'Скачать и установить новую версию прямо сейчас', onclick: () => closeModal(true) }, ic('download', 17), 'Обновить сейчас')),
  ], 'whatsnew');
  updatePromptOpen = false;
  if (!ok) { updateDismissed.add(u.latest); return; }
  STATE.update = u;
  go('about');
  try {
    const r = await api('update-start');
    toast(r, 'info');
    renderUpdateState(await api('update-state'));
  } catch (e) { toast(e.message, 'err'); }
}
window.pcc.on('update-available', (u) => { if (STATE) { STATE.update = u; renderUpdate(u); } promptUpdate(u); });

$('#title-update').addEventListener('click', () => go('about'));
$('#show-whatsnew').addEventListener('click', () => showWhatsNew(null, STATE.version));
$('#open-data').addEventListener('click', () => api('open-data-dir'));
$('#quit-app').addEventListener('click', async () => {
  if (await confirmModal('Выйти из программы?', 'Управление с телефона перестанет работать до следующего запуска.', 'Выйти')) api('quit');
});

// ===================== события от главного процесса =====================
let refreshT;
window.pcc.on('refresh', () => {
  clearTimeout(refreshT);
  refreshT = setTimeout(async () => {
    await loadState();
    if (page === 'log') loadLog();
    if (page === 'tasks') loadTasks();
  }, 300);
});

// ===================== подсказки к кнопкам =====================
// Наведите курсор на любую кнопку — через полсекунды появится описание, что она делает.
const tipEl = $('#tip');
let tipTarget = null;
let tipTimer = null;
function placeTip(target) {
  const r = target.getBoundingClientRect();
  tipEl.classList.remove('hidden', 'below');
  const tw = tipEl.offsetWidth;
  const th = tipEl.offsetHeight;
  let x = r.left + r.width / 2 - tw / 2;
  x = Math.max(8, Math.min(window.innerWidth - tw - 8, x));
  let y = r.top - th - 10;
  if (y < 50) { y = r.bottom + 10; tipEl.classList.add('below'); }
  tipEl.style.left = x + 'px';
  tipEl.style.top = y + 'px';
  tipEl.style.setProperty('--arrow-x', Math.max(12, Math.min(tw - 12, r.left + r.width / 2 - x)) + 'px');
}
function hideTip() {
  clearTimeout(tipTimer);
  tipTarget = null;
  tipEl.classList.add('hidden');
}
document.addEventListener('mouseover', (e) => {
  const t = e.target.closest('[data-tip]');
  if (t === tipTarget) return;
  hideTip();
  if (!t || !t.dataset.tip) return;
  tipTarget = t;
  tipTimer = setTimeout(() => {
    if (tipTarget !== t || !document.contains(t)) return;
    tipEl.textContent = t.dataset.tip;
    placeTip(t);
  }, 450);
});
document.addEventListener('mousedown', hideTip, true);
document.addEventListener('scroll', hideTip, true);
window.addEventListener('blur', hideTip);
// Новые кнопки (списки, окна) получают описания автоматически
let tipsQueued = false;
new MutationObserver(() => {
  if (tipsQueued) return;
  tipsQueued = true;
  requestAnimationFrame(() => { tipsQueued = false; Tips.apply(Tips.PC); });
}).observe(document.body, { childList: true, subtree: true });

(async () => {
  Icons.hydrate();
  Tips.apply(Tips.PC);
  await loadState();
  renderUpdateState(await api('update-state'));
  const needSetup = !STATE.mobile.devices && !(STATE.bot.configured && STATE.users.length);
  go(needSetup ? 'phone' : 'overview');
  const wn = await api('whatsnew-state');
  if (wn && wn.pending) {
    await showWhatsNew(wn.pending.from, wn.pending.to, wn.cleanup);
    api('whatsnew-ack');
  }
  if (STATE.update && STATE.update.hasUpdate) promptUpdate(STATE.update);
})();
