'use strict';
// Интерфейс приложения PC Full Control.
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const api = (channel, data) => window.pcc.invoke(channel, data);

let STATE = null;
let ACTIONS = {};
let page = 'overview';
let logMode = 'events';
let statusTimer = null;

// ================= Утилиты =================
function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) n.append(c instanceof Node ? c : String(c));
  return n;
}

function fmtBytes(n) {
  if (n === null || n === undefined) return '—';
  const u = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let i = 0;
  while (Math.abs(n) >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i ? n.toFixed(1) : n.toFixed(0)) + ' ' + u[i];
}

function fmtDuration(sec) {
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400); const h = Math.floor((sec % 86400) / 3600); const m = Math.floor((sec % 3600) / 60);
  return (d ? d + ' д ' : '') + (h ? h + ' ч ' : '') + m + ' мин';
}

const fmtTime = (ts) => new Date(ts * 1000).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function confirmDialog(text) {
  return new Promise((resolve) => {
    $('#modal-text').textContent = text;
    $('#modal').classList.remove('hidden');
    const done = (v) => { $('#modal').classList.add('hidden'); resolve(v); };
    $('#modal-yes').onclick = () => done(true);
    $('#modal-no').onclick = () => done(false);
  });
}

function showResult(sel, text, ok = true) {
  const n = $(sel);
  n.textContent = text;
  n.className = 'toast-line ' + (ok ? 'ok' : 'err');
}

// ================= Навигация =================
$$('.nav button').forEach((b) => b.addEventListener('click', () => go(b.dataset.page)));
document.addEventListener('click', (e) => {
  const g = e.target.closest('[data-goto]');
  if (g) go(g.dataset.goto);
  const link = e.target.closest('[data-link]');
  if (link) { e.preventDefault(); api('open-external', { url: link.dataset.link }); }
});

function go(p) {
  page = p;
  $$('.page').forEach((s) => s.classList.add('hidden'));
  $('#page-' + p).classList.remove('hidden');
  $$('.nav button').forEach((b) => b.classList.toggle('active', b.dataset.page === p));
  clearInterval(statusTimer);
  if (p === 'overview') {
    loadStatus(); loadChart();
    statusTimer = setInterval(() => { if (!document.hidden) loadStatus(); }, 5000);
  } else if (p === 'tasks') loadTasks();
  else if (p === 'log') loadLog();
  else if (p === 'settings') fillSettings();
}

// ================= Состояние =================
async function loadState() {
  STATE = await api('get-state');
  ACTIONS = Object.fromEntries(STATE.actions.map((a) => [a.name, a]));
  $('#pc-name').textContent = STATE.pcName;
  $('#version').textContent = STATE.version;
  $$('.win-only').forEach((b) => b.classList.toggle('hidden', !STATE.isWin));
  renderBot();
  renderPhone();
  if (!$('#task-action').options.length) fillTaskForm();
}

function renderBot() {
  const b = STATE.bot;
  const status = !b.configured ? 'stopped' : b.status;
  const text = !b.configured ? 'Telegram не подключён'
    : { online: `@${b.username} на связи`, connecting: 'Подключение…', error: b.error || 'Ошибка' }[status] || 'Остановлен';
  $('#bot-pill .dot').className = 'dot ' + status;
  $('#bot-pill-text').textContent = text;
  $('#setup-banner').classList.toggle('hidden', b.configured && STATE.users.length > 0);
}

function renderPhone() {
  const b = STATE.bot;
  $('#token-setup').classList.toggle('hidden', b.configured);
  $('#token-done').classList.toggle('hidden', !b.configured);
  $('#step1-num').classList.toggle('done', b.configured && b.status === 'online');
  $('#bot-name').textContent = b.username ? '@' + b.username : '…';
  $('#bot-state').textContent = b.status === 'online' ? '🟢 на связи' : b.status === 'error' ? '🔴 ' + b.error : '🟡 подключение…';

  const pair = STATE.pairing;
  $('#pair-box').classList.toggle('hidden', !pair.qr);
  $('#pair-wait').classList.toggle('hidden', !!pair.qr);
  $('#pair-wait').textContent = b.configured ? 'Подключаюсь к Telegram…' : 'Сначала подключите бота (шаг 1).';
  if (pair.qr) {
    $('#pair-qr').src = pair.qr;
    $('#pair-cmd').textContent = '/pair ' + pair.code;
  }
  const users = $('#users');
  if (!STATE.users.length) {
    users.replaceChildren(el('div', { class: 'empty', text: 'Пока ни один телефон не привязан.' }));
  } else {
    users.replaceChildren(...STATE.users.map((u) => el('div', { class: 'item' },
      el('span', { text: '📱' }),
      el('div', { class: 'main' },
        el('div', { text: (u.name || 'Без имени') + (u.username ? ' · @' + u.username : '') }),
        el('div', { class: 'meta', text: `ID ${u.user_id} · привязан ${fmtTime(u.added)}` })),
      el('button', {
        class: 'btn small danger', text: 'Отвязать',
        onclick: async () => {
          if (!(await confirmDialog('Отвязать этот телефон? Он больше не сможет управлять компьютером.'))) return;
          await api('remove-user', { userId: u.user_id });
          await loadState();
        },
      }))));
  }
  $('#test-notify').disabled = !STATE.users.length;
}

// ================= Телефон =================
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
  } catch (err) {
    $('#token-error').textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Подключить';
  }
});

$('#change-token').addEventListener('click', async () => {
  if (!(await confirmDialog('Отключить текущего бота? Привязанные телефоны останутся в списке.'))) return;
  await api('set-token', { token: '' });
  await loadState();
});
$('#open-bot').addEventListener('click', () => STATE.bot.username && api('open-external', { url: `https://t.me/${STATE.bot.username}` }));
$('#regen-pair').addEventListener('click', async () => { await api('regen-pair'); await loadState(); });
$('#test-notify').addEventListener('click', async () => {
  try { await api('test-notify'); $('#test-notify').textContent = '✅ Отправлено — проверьте Telegram'; } catch (e) { $('#test-notify').textContent = '❌ ' + e.message; }
  setTimeout(() => { $('#test-notify').textContent = '🔔 Отправить тестовое уведомление'; }, 4000);
});

// ================= Обзор =================
function statCard(label, value, sub, percent) {
  const c = el('div', { class: 'stat' }, el('div', { class: 'label', text: label }), el('div', { class: 'value', text: value }));
  if (percent !== null && percent !== undefined) {
    const fill = el('i');
    fill.style.width = Math.min(100, percent) + '%';
    c.append(el('div', { class: percent >= 90 ? 'bar hot' : percent >= 70 ? 'bar mid' : 'bar' }, fill));
  }
  if (sub) c.append(el('div', { class: 'sub', text: sub }));
  return c;
}

async function loadStatus() {
  let s;
  try { s = await api('get-status'); } catch (e) { return; }
  $('#os-name').textContent = s.os;
  const cards = [
    statCard('Процессор', s.cpu.percent.toFixed(0) + '%', `${s.cpu.threads} потоков`, s.cpu.percent),
    statCard('Память', s.ram.percent.toFixed(0) + '%', `${fmtBytes(s.ram.used)} из ${fmtBytes(s.ram.total)}`, s.ram.percent),
  ];
  for (const d of s.disks.slice(0, 4)) cards.push(statCard('Диск ' + d.mount, d.percent.toFixed(0) + '%', 'свободно ' + fmtBytes(d.free), d.percent));
  if (s.temp !== null) cards.push(statCard('Температура CPU', Math.round(s.temp) + '°C', null, s.temp));
  for (const g of s.gpus) cards.push(statCard('Видеокарта', Math.round(g.util) + '%', g.name, g.util));
  if (s.battery) cards.push(statCard('Батарея', s.battery.percent + '%', s.battery.plugged ? 'заряжается' : 'от батареи', s.battery.percent));
  cards.push(statCard('Работает', fmtDuration(s.uptime), 'с ' + fmtTime(s.bootTime)));
  cards.push(statCard('Сеть', s.ips[0] || '—', s.ips.slice(1).join(', ') || 'локальный IP'));
  $('#stats').replaceChildren(...cards);
}

let chartData = [];
$('#chart-range').addEventListener('change', loadChart);
window.addEventListener('resize', drawChart);
window.pcc.on('metrics', () => { if (page === 'overview') loadChart(); });

async function loadChart() {
  try { chartData = await api('get-metrics', { hours: Number($('#chart-range').value) }); } catch (e) { return; }
  drawChart();
}

function drawChart() {
  const c = $('#chart');
  if (!c.offsetParent) return;
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth; const h = c.clientHeight;
  c.width = w * dpr; c.height = h * dpr;
  const g = c.getContext('2d');
  g.scale(dpr, dpr);
  const css = getComputedStyle(document.documentElement);
  const v = (n) => css.getPropertyValue(n).trim();
  g.font = '11px "Segoe UI", sans-serif';
  g.fillStyle = v('--muted');
  g.strokeStyle = v('--border');
  const L = 30; const T = 6; const B = 4;
  const y = (val) => T + (h - T - B) * (1 - Math.max(0, Math.min(100, val)) / 100);
  for (const val of [0, 50, 100]) {
    g.beginPath(); g.moveTo(L, y(val)); g.lineTo(w, y(val)); g.stroke();
    g.fillText(String(val), 2, y(val) + 4);
  }
  if (chartData.length < 2) { g.fillText('Данные собираются (каждые 30 секунд)…', L + 10, h / 2); return; }
  const t0 = chartData[0].ts; const t1 = chartData[chartData.length - 1].ts;
  const x = (ts) => L + (w - L) * ((ts - t0) / Math.max(1, t1 - t0));
  for (const [key, color] of [['ram', '--ram'], ['cpu', '--cpu'], ['temp', '--temp']]) {
    g.strokeStyle = v(color); g.lineWidth = 2; g.lineJoin = 'round';
    g.beginPath();
    let started = false;
    for (const p of chartData) {
      if (p[key] === null || p[key] === undefined) { started = false; continue; }
      if (started) g.lineTo(x(p.ts), y(p[key])); else { g.moveTo(x(p.ts), y(p[key])); started = true; }
    }
    g.stroke();
  }
}

// ================= Управление =================
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const name = btn.dataset.act;
  const a = ACTIONS[name];
  if (!a) return;
  const arg = btn.dataset.arg ? document.getElementById(btn.dataset.arg).value.trim() : '';
  if (a.argRequired && !arg) { showResult('#action-result', 'Введите ' + a.argHint, false); return; }
  if (a.dangerous && !(await confirmDialog(a.title + '?'))) return;
  btn.disabled = true;
  try {
    const r = await api('run-action', { name, arg });
    showResult('#action-result', r.result, r.ok);
  } catch (err) {
    showResult('#action-result', err.message, false);
  } finally {
    btn.disabled = false;
  }
});

// ================= Задачи =================
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
  if (kind === 'daily') {
    t.timeOfDay = $('#task-time').value;
    t.weekdays = $$('#task-days input:checked').map((i) => Number(i.value));
  }
  try {
    await api('add-task', t);
    $('#task-arg').value = '';
    loadTasks();
  } catch (err) {
    $('#task-error').textContent = err.message;
  }
});

async function loadTasks() {
  const tasks = await api('get-tasks');
  const box = $('#tasks');
  if (!tasks.length) { box.replaceChildren(el('div', { class: 'card empty', text: 'Задач пока нет.' })); return; }
  box.replaceChildren(...tasks.map((t) => el('div', { class: 'item' + (t.enabled ? '' : ' off') },
    el('div', { class: 'main' },
      el('div', { text: t.description }),
      t.last_run ? el('div', { class: 'meta', text: 'последний запуск: ' + fmtTime(t.last_run) }) : null),
    el('button', { class: 'btn small', text: t.enabled ? '⏸ Выключить' : '▶ Включить', onclick: async () => { await api('toggle-task', { id: t.id }); loadTasks(); } }),
    el('button', { class: 'btn small danger', text: '🗑', title: 'Удалить', onclick: async () => { await api('delete-task', { id: t.id }); loadTasks(); } }))));
}

// ================= Журнал =================
$$('#log-tabs button').forEach((b) => b.addEventListener('click', () => {
  logMode = b.dataset.mode;
  $$('#log-tabs button').forEach((x) => x.classList.toggle('active', x === b));
  loadLog();
}));

async function loadLog() {
  const rows = await api('get-log', { mode: logMode });
  const box = $('#log');
  if (!rows.length) { box.replaceChildren(el('div', { class: 'empty', text: 'Пока пусто' })); return; }
  const icons = { info: 'ℹ️', warning: '⚠️', critical: '🚨', running: '⏳', done: '✅', error: '❌' };
  const src = { telegram: 'Telegram', app: 'ПК', scheduler: 'планировщик' };
  if (logMode === 'jobs') {
    const open = new Set($$('#log details[open]').map((d) => d.dataset.id));
    box.replaceChildren(...rows.map((j) => el('details', { class: 'log-row', 'data-id': String(j.id), open: open.has(String(j.id)) },
      el('summary', {}, el('time', { text: fmtTime(j.started) }), `${icons[j.status] || ''} #${j.id} ${j.title}`),
      el('pre', { class: 'output', text: j.status === 'running' ? 'Выполняется…' : (j.output || '(нет вывода)') }))));
  } else if (logMode === 'commands') {
    box.replaceChildren(...rows.map((r) => el('div', { class: 'log-row' }, el('time', { text: fmtTime(r.ts) }),
      `${r.ok ? '✅' : '❌'} [${src[r.source] || r.source}] ${ACTIONS[r.action] ? ACTIONS[r.action].title : r.action}${r.arg ? ' «' + r.arg.slice(0, 80) + '»' : ''}`)));
  } else {
    box.replaceChildren(...rows.map((r) => el('div', { class: 'log-row' }, el('time', { text: fmtTime(r.ts) }), `${icons[r.level] || ''} ${r.message}`)));
  }
}

// ================= Настройки =================
const getPath = (obj, p) => p.split('.').reduce((o, k) => (o ? o[k] : undefined), obj);
function setPath(obj, p, val) {
  const keys = p.split('.');
  let o = obj;
  keys.slice(0, -1).forEach((k) => { o[k] = o[k] || {}; o = o[k]; });
  o[keys[keys.length - 1]] = val;
}

function appRow(app = { name: '', cmd: '' }) {
  return el('div', { class: 'row app-row' },
    el('input', { placeholder: 'Название', value: app.name, class: 'app-name' }),
    el('input', { placeholder: 'Программа или путь, например chrome.exe', value: app.cmd, class: 'app-cmd' }),
    el('button', { class: 'btn small danger', type: 'button', text: '✖', onclick: (e) => e.target.closest('.app-row').remove() }));
}
$('#add-app').addEventListener('click', () => $('#apps').append(appRow()));

function fillSettings() {
  const cfg = STATE.config;
  $$('[data-cfg]').forEach((inp) => {
    const v = getPath(cfg, inp.dataset.cfg);
    if (inp.type === 'checkbox') inp.checked = !!v;
    else if ('list' in inp.dataset) inp.value = (v || []).join(', ');
    else if ('lines' in inp.dataset) inp.value = (v || []).join('\n');
    else inp.value = v ?? '';
  });
  $('#autostart').checked = STATE.autostart.enabled;
  $('#notif-enabled').checked = !STATE.muted;
  $('#apps').replaceChildren(...cfg.apps.map(appRow));
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
  patch.apps = $$('.app-row').map((r) => ({ name: r.querySelector('.app-name').value.trim(), cmd: r.querySelector('.app-cmd').value.trim() }))
    .filter((a) => a.name && a.cmd);
  try {
    await api('save-config', patch);
    await api('set-muted', { muted: !$('#notif-enabled').checked });
    if ($('#autostart').checked !== STATE.autostart.enabled) await api('set-autostart', { enabled: $('#autostart').checked });
    await loadState();
    fillSettings();
    showResult('#settings-result', '✅ Настройки сохранены');
  } catch (e) {
    showResult('#settings-result', e.message, false);
  }
});

$('#check-update').addEventListener('click', async () => {
  $('#update-result').textContent = 'Проверяю…';
  try {
    const r = await api('check-app-update');
    $('#update-result').textContent = r.hasUpdate
      ? `Доступна версия ${r.latest}. Установить можно из Telegram: «🔄 Обновления → 🤖 Обновить PC Full Control».`
      : r.latest ? `Установлена последняя версия (${r.current}).` : (r.message || 'Релизы не найдены');
  } catch (e) {
    $('#update-result').textContent = 'Не удалось проверить: ' + e.message;
  }
});
$('#open-data').addEventListener('click', () => api('open-data-dir'));
$('#quit-app').addEventListener('click', async () => {
  if (await confirmDialog('Выйти из приложения? Управление с телефона перестанет работать до следующего запуска.')) api('quit');
});

// ================= Обновления от главного процесса =================
let refreshTimer = null;
window.pcc.on('refresh', () => {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    await loadState();
    if (page === 'log') loadLog();
    if (page === 'tasks') loadTasks();
  }, 300);
});

(async () => {
  await loadState();
  go(STATE.bot.configured && STATE.users.length ? 'overview' : 'phone');
})();
