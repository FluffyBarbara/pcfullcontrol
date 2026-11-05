'use strict';

// ================= Утилиты =================
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const TOKEN_KEY = 'pcc_token';
let token = null;
try { token = localStorage.getItem(TOKEN_KEY); } catch (e) { /* приватный режим */ }

let INFO = null;
let ACTIONS = {};
let currentTab = 'home';
let statusTimer = null;
let jobsTimer = null;
let shotTimer = null;
let filesPath = '';
let filesParent = null;

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function fmtBytes(n) {
  if (n === null || n === undefined) return '—';
  const u = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let i = 0;
  while (Math.abs(n) >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n.toFixed(0) : n.toFixed(1)) + ' ' + u[i];
}

function fmtDuration(sec) {
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
  return (d ? d + ' д ' : '') + (h ? h + ' ч ' : '') + m + ' мин';
}

function fmtTime(ts) {
  const d = new Date(ts * 1000);
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

let toastTimer = null;
function toast(text, kind = '') {
  const t = $('#toast');
  t.textContent = text;
  t.className = 'toast ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), Math.min(8000, 2500 + text.length * 30));
}

function confirmDialog(text) {
  return new Promise((resolve) => {
    $('#modal-text').textContent = text;
    $('#modal').classList.remove('hidden');
    const done = (v) => {
      $('#modal').classList.add('hidden');
      $('#modal-yes').onclick = $('#modal-no').onclick = null;
      resolve(v);
    };
    $('#modal-yes').onclick = () => done(true);
    $('#modal-no').onclick = () => done(false);
  });
}

async function api(path, opts = {}) {
  const headers = {};
  if (token) headers['Authorization'] = 'Bearer ' + token;
  let body = opts.body;
  if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.json);
  }
  const method = opts.method || (body !== undefined ? 'POST' : 'GET');
  let r;
  try {
    r = await fetch(path, { method, headers, body });
  } catch (e) {
    setOnline(false);
    throw new Error('Нет связи с компьютером');
  }
  setOnline(true);
  if (r.status === 401 && path !== '/api/login') {
    showLogin();
    throw new Error('Требуется вход');
  }
  if (!r.ok) {
    let detail = 'Ошибка ' + r.status;
    try { detail = (await r.json()).detail || detail; } catch (e) { /* не JSON */ }
    throw new Error(detail);
  }
  if (opts.raw) return r;
  const ct = r.headers.get('content-type') || '';
  return ct.includes('json') ? r.json() : r.text();
}

function setOnline(on) {
  const d = $('#online-dot');
  d.classList.toggle('on', on);
  d.classList.toggle('off', !on);
}

// ================= Вход =================
function showLogin() {
  token = null;
  try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ }
  stopTimers();
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
  $('#password').focus();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').textContent = '';
  try {
    const res = await api('/api/login', { json: { password: $('#password').value } });
    token = res.token;
    try { localStorage.setItem(TOKEN_KEY, token); } catch (e2) { /* ignore */ }
    $('#password').value = '';
    await startApp();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

async function startApp() {
  INFO = await api('/api/info');
  ACTIONS = Object.fromEntries(INFO.actions.map((a) => [a.name, a]));
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#pc-name').textContent = INFO.pc_name;
  $('#header-sub').textContent = INFO.os;
  $('#version').textContent = 'PC Control ' + INFO.version;
  $$('.win-only').forEach((b) => b.classList.toggle('hidden', !INFO.is_windows));
  $('#terminal-card').classList.toggle('hidden', !INFO.allow_shell);
  // Скрыть кнопки недоступных действий
  $$('[data-act]').forEach((b) => { if (!ACTIONS[b.dataset.act]) b.classList.add('hidden'); });
  renderApps();
  renderMonitors();
  fillTaskForm();
  switchTab(currentTab);
}

function stopTimers() {
  clearInterval(statusTimer); clearInterval(jobsTimer); clearInterval(shotTimer);
  statusTimer = jobsTimer = shotTimer = null;
  $('#auto-shot').checked = false;
}

// ================= Вкладки =================
$$('.bottomnav button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

function switchTab(tab) {
  currentTab = tab;
  $$('.tab').forEach((s) => s.classList.add('hidden'));
  $('#tab-' + tab).classList.remove('hidden');
  $$('.bottomnav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  clearInterval(statusTimer);
  statusTimer = null;
  if (tab === 'home') {
    loadStatus(); loadChart();
    statusTimer = setInterval(() => { if (!document.hidden) loadStatus(); }, 5000);
  } else if (tab === 'proc') loadProcesses();
  else if (tab === 'files') loadFiles(filesPath);
  else if (tab === 'tasks') loadTasks();
  else if (tab === 'more') { loadJobs(); loadLog(); loadSettings(); }
  window.scrollTo(0, 0);
}

// ================= Действия =================
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  let arg = btn.dataset.arg || '';
  if (btn.dataset.argInput) {
    const input = document.getElementById(btn.dataset.argInput);
    arg = input.value.trim();
    const a = ACTIONS[btn.dataset.act];
    if (a && a.arg_required && !arg) { input.focus(); toast('Введите: ' + a.arg_hint); return; }
  }
  await runAction(btn.dataset.act, arg, btn, btn.dataset.output === '1');
});

async function runAction(name, arg = '', btn = null, showOutput = false) {
  const a = ACTIONS[name];
  if (!a) return;
  if (a.dangerous) {
    const ok = await confirmDialog(a.title + (arg ? ' (' + arg + ')' : '') + '?');
    if (!ok) return;
  }
  if (btn) btn.disabled = true;
  try {
    const res = await api('/api/action/' + name, { json: { arg } });
    if (showOutput && res.ok) {
      const out = $('#quick-output');
      out.textContent = res.result;
      out.classList.remove('hidden');
    } else {
      toast(res.result, res.ok ? 'ok' : 'err');
    }
    if (a.category === 'updates' || name === 'restart_agent') setTimeout(loadJobs, 800);
    if (a.category === 'media') setTimeout(loadStatus, 300);
    return res;
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ================= Главная =================
function statCard(label, value, sub, percent) {
  const card = el('div', { class: 'stat' },
    el('div', { class: 'label', text: label }),
    el('div', { class: 'value', text: value }),
  );
  if (percent !== undefined && percent !== null) {
    const cls = percent >= 90 ? 'bar hot' : percent >= 70 ? 'bar mid' : 'bar';
    const fill = el('i');
    fill.style.width = Math.min(100, percent) + '%';
    card.append(el('div', { class: cls }, fill));
  }
  if (sub) card.append(el('div', { class: 'sub mt', text: sub }));
  return card;
}

let volumeDragging = false;
async function loadStatus() {
  let s;
  try { s = await api('/api/status'); } catch (e) { return; }
  const cards = [
    statCard('CPU', s.cpu.percent.toFixed(0) + '%', (s.cpu.threads || '?') + ' потоков' + (s.cpu.freq_mhz ? ', ' + s.cpu.freq_mhz + ' МГц' : ''), s.cpu.percent),
    statCard('Память', s.ram.percent.toFixed(0) + '%', fmtBytes(s.ram.used) + ' / ' + fmtBytes(s.ram.total), s.ram.percent),
  ];
  if (s.disks.length) {
    const main = s.disks.reduce((a, b) => (b.total > a.total ? b : a));
    cards.push(statCard('Диск ' + main.mount, main.percent.toFixed(0) + '%', 'свободно ' + fmtBytes(main.free), main.percent));
  }
  if (s.temp !== null && s.temp !== undefined) cards.push(statCard('Температура CPU', s.temp.toFixed(0) + '°C', null, s.temp));
  for (const g of s.gpus || []) cards.push(statCard('GPU', g.util.toFixed(0) + '% · ' + g.temp.toFixed(0) + '°C', g.name, g.util));
  if (s.battery) cards.push(statCard('Батарея', s.battery.percent + '%', s.battery.plugged ? 'заряжается' : 'от батареи', s.battery.percent));
  cards.push(statCard('Работает', fmtDuration(s.uptime), 'процессов: ' + s.process_count));
  cards.push(statCard('Сеть', (s.net.ips[0] || '—'), '↑ ' + fmtBytes(s.net.sent) + '  ↓ ' + fmtBytes(s.net.recv)));
  $('#stats').replaceChildren(...cards);

  if (s.volume !== null && s.volume !== undefined && !volumeDragging) {
    $('#volume').value = s.volume;
    $('#vol-label').textContent = s.volume + '%';
  } else if (s.volume === null) {
    $('#vol-label').textContent = '';
  }
  $('#notif-toggle').checked = !s.notifications_muted;
}

$('#volume').addEventListener('input', () => {
  volumeDragging = true;
  $('#vol-label').textContent = $('#volume').value + '%';
});
$('#volume').addEventListener('change', async () => {
  await runAction('set_volume', $('#volume').value);
  volumeDragging = false;
});

// --- график ---
$('#chart-range').addEventListener('change', loadChart);
let chartData = [];
async function loadChart() {
  try { chartData = await api('/api/metrics?hours=' + $('#chart-range').value); } catch (e) { return; }
  drawChart();
}
window.addEventListener('resize', drawChart);

function drawChart() {
  const c = $('#chart');
  if (!c || c.offsetParent === null) return;
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight;
  c.width = w * dpr; c.height = h * dpr;
  const ctx = c.getContext('2d');
  ctx.scale(dpr, dpr);
  const css = getComputedStyle(document.documentElement);
  const grid = css.getPropertyValue('--border').trim();
  const muted = css.getPropertyValue('--muted').trim();
  ctx.clearRect(0, 0, w, h);
  ctx.font = '11px sans-serif';
  ctx.fillStyle = muted;
  ctx.strokeStyle = grid;
  ctx.lineWidth = 1;
  const padL = 28, padB = 4, padT = 6;
  for (const v of [0, 50, 100]) {
    const y = padT + (h - padT - padB) * (1 - v / 100);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w, y); ctx.stroke();
    ctx.fillText(String(v), 2, y + 4);
  }
  if (chartData.length < 2) {
    ctx.fillText('Данные копятся… (раз в ' + 30 + ' с)', padL + 8, h / 2);
    return;
  }
  const t0 = chartData[0].ts, t1 = chartData[chartData.length - 1].ts;
  const x = (ts) => padL + (w - padL) * ((ts - t0) / Math.max(1, t1 - t0));
  const y = (v) => padT + (h - padT - padB) * (1 - Math.min(100, Math.max(0, v)) / 100);
  for (const [key, color] of [['ram', '--ram'], ['cpu', '--cpu'], ['temp', '--temp']]) {
    ctx.strokeStyle = css.getPropertyValue(color).trim();
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let started = false;
    for (const p of chartData) {
      if (p[key] === null || p[key] === undefined) { started = false; continue; }
      if (!started) { ctx.moveTo(x(p.ts), y(p[key])); started = true; } else ctx.lineTo(x(p.ts), y(p[key]));
    }
    ctx.stroke();
  }
}

// --- скриншот ---
function renderMonitors() {
  const sel = $('#monitor-select');
  sel.replaceChildren(el('option', { value: '0', text: 'Все экраны' }));
  for (let i = 1; i <= (INFO.monitors || 1); i++) sel.append(el('option', { value: String(i), text: 'Монитор ' + i }));
  sel.classList.toggle('hidden', (INFO.monitors || 1) < 2);
}

async function loadImage(url, btn) {
  if (btn) btn.disabled = true;
  try {
    const r = await api(url, { raw: true });
    const blob = await r.blob();
    const img = $('#shot');
    if (img.src) URL.revokeObjectURL(img.src);
    img.src = URL.createObjectURL(blob);
    img.classList.remove('hidden');
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
}

$('#btn-shot').addEventListener('click', () => loadImage('/api/screenshot?monitor=' + $('#monitor-select').value, $('#btn-shot')));
$('#btn-webcam').addEventListener('click', () => loadImage('/api/webcam', $('#btn-webcam')));
$('#shot').addEventListener('click', () => window.open($('#shot').src, '_blank'));
$('#auto-shot').addEventListener('change', (e) => {
  clearInterval(shotTimer);
  if (e.target.checked) {
    $('#btn-shot').click();
    shotTimer = setInterval(() => { if (!document.hidden && currentTab === 'home') $('#btn-shot').click(); }, 3000);
  }
});

// ================= Процессы =================
let procSearchTimer = null;
$('#proc-search').addEventListener('input', () => { clearTimeout(procSearchTimer); procSearchTimer = setTimeout(loadProcesses, 400); });
$('#proc-sort').addEventListener('change', loadProcesses);
$('#proc-refresh').addEventListener('click', loadProcesses);

async function loadProcesses() {
  const list = $('#proc-list');
  const q = encodeURIComponent($('#proc-search').value.trim());
  let procs;
  try { procs = await api(`/api/processes?sort=${$('#proc-sort').value}&q=${q}&limit=80`); } catch (e) { toast(e.message, 'err'); return; }
  if (!procs.length) { list.replaceChildren(el('div', { class: 'empty', text: 'Ничего не найдено' })); return; }
  list.replaceChildren(...procs.map((p) => el('div', { class: 'item' },
    el('div', { class: 'main' },
      el('div', { class: 'title', text: p.name }),
      el('div', { class: 'meta', text: `PID ${p.pid} · CPU ${p.cpu}% · ${fmtBytes(p.mem)}${p.user ? ' · ' + p.user : ''}` }),
    ),
    el('div', { class: 'actions' },
      el('button', { class: 'btn small danger', text: '✖', title: 'Завершить',
        onclick: async () => { const r = await runAction('kill', String(p.pid)); if (r && r.ok) loadProcesses(); } }),
    ),
  )));
}

// ================= Файлы =================
$('#files-up').addEventListener('click', () => loadFiles(filesParent || ''));
$('#files-roots').addEventListener('click', () => loadFiles(''));

async function loadFiles(path) {
  let res;
  try { res = await api('/api/files?path=' + encodeURIComponent(path || '')); } catch (e) { toast(e.message, 'err'); return; }
  filesPath = res.path;
  filesParent = res.parent;
  $('#files-path').textContent = res.path || 'Расположения';
  $('#files-up').disabled = !res.path;
  const list = $('#files-list');
  if (!res.entries.length) { list.replaceChildren(el('div', { class: 'empty', text: 'Папка пуста' })); return; }
  list.replaceChildren(...res.entries.slice(0, 500).map((f) => {
    if (f.is_dir) {
      return el('div', { class: 'item clickable', onclick: () => loadFiles(f.path) },
        el('span', { text: '📁' }),
        el('div', { class: 'main' }, el('div', { class: 'title', text: f.name })),
      );
    }
    return el('div', { class: 'item' },
      el('span', { text: '📄' }),
      el('div', { class: 'main' },
        el('div', { class: 'title', text: f.name }),
        el('div', { class: 'meta', text: fmtBytes(f.size) + (f.mtime ? ' · ' + fmtTime(f.mtime) : '') }),
      ),
      el('div', { class: 'actions' },
        el('button', { class: 'btn small', text: '⬇', title: 'Скачать', onclick: () => downloadFile(f) }),
        el('button', { class: 'btn small', text: '▶', title: 'Открыть на ПК', onclick: () => runAction('launch', f.path) }),
        el('button', { class: 'btn small danger', text: '🗑', title: 'Удалить', onclick: () => deleteFile(f) }),
      ),
    );
  }));
}

async function downloadFile(f) {
  toast('Скачивание ' + f.name + '…');
  try {
    const r = await api('/api/files/download?path=' + encodeURIComponent(f.path), { raw: true });
    const blob = await r.blob();
    const a = el('a', { href: URL.createObjectURL(blob), download: f.name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  } catch (e) { toast(e.message, 'err'); }
}

async function deleteFile(f) {
  if (!(await confirmDialog('Удалить файл «' + f.name + '»?'))) return;
  try { await api('/api/files/delete', { json: { path: f.path } }); toast('Удалено', 'ok'); loadFiles(filesPath); } catch (e) { toast(e.message, 'err'); }
}

$('#file-upload').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  for (const [i, file] of files.entries()) {
    $('#upload-progress').textContent = `Загрузка ${i + 1}/${files.length}: ${file.name}…`;
    const fd = new FormData();
    fd.append('file', file);
    fd.append('directory', filesPath || '');
    try {
      const res = await api('/api/files/upload', { body: fd });
      toast('Сохранено: ' + res.path, 'ok');
    } catch (err) { toast(err.message, 'err'); }
  }
  $('#upload-progress').textContent = '';
  e.target.value = '';
  if (filesPath) loadFiles(filesPath);
});

// ================= Задачи =================
const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

function fillTaskForm() {
  const sel = $('#task-action');
  const cats = { power: 'Питание', media: 'Медиа', updates: 'Обновления', system: 'Система', misc: 'Разное' };
  sel.replaceChildren();
  for (const [cat, title] of Object.entries(cats)) {
    const group = el('optgroup', { label: title });
    INFO.actions.filter((a) => a.category === cat).forEach((a) => group.append(el('option', { value: a.name, text: a.title })));
    if (group.children.length) sel.append(group);
  }
  $('#task-weekdays').replaceChildren(...WEEKDAYS.map((d, i) =>
    el('label', {}, el('input', { type: 'checkbox', value: String(i), checked: true }), el('span', { text: d }))));
  const dt = new Date(Date.now() + 3600e3);
  dt.setMinutes(dt.getMinutes() - dt.getTimezoneOffset());
  $('#task-at').value = dt.toISOString().slice(0, 16);
  updateTaskForm();
}

function updateTaskForm() {
  const a = ACTIONS[$('#task-action').value];
  $('#task-arg-wrap').classList.toggle('hidden', !(a && a.arg_hint));
  if (a) $('#task-arg').placeholder = a.arg_hint;
  const kind = $('#task-kind').value;
  $('#task-in-wrap').classList.toggle('hidden', kind !== 'in');
  $('#task-at-wrap').classList.toggle('hidden', kind !== 'at');
  $('#task-daily-wrap').classList.toggle('hidden', kind !== 'daily');
}
$('#task-action').addEventListener('change', updateTaskForm);
$('#task-kind').addEventListener('change', updateTaskForm);

$('#task-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const kind = $('#task-kind').value;
  const body = { action: $('#task-action').value, arg: $('#task-arg').value.trim(), kind };
  if (kind === 'in') body.delay_minutes = parseFloat($('#task-delay').value);
  if (kind === 'at') body.run_at = $('#task-at').value;
  if (kind === 'daily') {
    body.time_of_day = $('#task-time').value;
    body.weekdays = $$('#task-weekdays input:checked').map((i) => parseInt(i.value, 10));
  }
  try {
    const t = await api('/api/tasks', { json: body });
    toast('Добавлено: ' + t.description, 'ok');
    $('#task-arg').value = '';
    loadTasks();
  } catch (err) { toast(err.message, 'err'); }
});

async function loadTasks() {
  let tasks;
  try { tasks = await api('/api/tasks'); } catch (e) { return; }
  const list = $('#tasks-list');
  if (!tasks.length) { list.replaceChildren(el('div', { class: 'empty', text: 'Задач пока нет' })); return; }
  list.replaceChildren(...tasks.map((t) => el('div', { class: 'item' + (t.enabled ? '' : ' off') },
    el('div', { class: 'main' },
      el('div', { class: 'title wrap', text: t.description }),
      t.last_run ? el('div', { class: 'meta', text: 'последний запуск: ' + fmtTime(t.last_run) }) : null,
    ),
    el('div', { class: 'actions' },
      el('button', { class: 'btn small', text: t.enabled ? '⏸' : '▶', title: t.enabled ? 'Выключить' : 'Включить',
        onclick: async () => { await api(`/api/tasks/${t.id}/toggle`, { method: 'POST' }); loadTasks(); } }),
      el('button', { class: 'btn small danger', text: '🗑', title: 'Удалить',
        onclick: async () => { if (await confirmDialog('Удалить задачу #' + t.id + '?')) { await api('/api/tasks/' + t.id, { method: 'DELETE' }); loadTasks(); } } }),
    ),
  )));
}

// ================= Ещё =================
function renderApps() {
  const box = $('#apps');
  box.replaceChildren(...(INFO.apps || []).map((name, i) =>
    el('button', { class: 'btn', text: '🚀 ' + name, onclick: () => runApp(i) })));
}
async function runApp(i) {
  try {
    const res = await api('/api/apps/' + i, { method: 'POST' });
    toast(res.result, res.ok ? 'ok' : 'err');
  } catch (err) { toast(err.message, 'err'); }
}

async function loadJobs() {
  let jobs;
  try { jobs = await api('/api/jobs'); } catch (e) { return; }
  const icons = { running: '⏳', done: '✅', error: '❌' };
  const box = $('#jobs-list');
  box.replaceChildren(...jobs.slice(0, 8).map((j) => el('details', {},
    el('summary', { text: `${icons[j.status] || '•'} #${j.id} ${j.title} · ${fmtTime(j.started)}` }),
    el('pre', { class: 'output', text: j.status === 'running' ? 'Выполняется…' : (j.output || '(нет вывода)') }),
  )));
  const running = jobs.some((j) => j.status === 'running');
  clearInterval(jobsTimer);
  jobsTimer = running && currentTab === 'more' ? setInterval(loadJobs, 5000) : null;
}

$('#log-mode').addEventListener('change', loadLog);
async function loadLog() {
  const mode = $('#log-mode').value;
  let rows;
  try { rows = await api('/api/' + mode + '?limit=100'); } catch (e) { return; }
  const icons = { info: 'ℹ️', warning: '⚠️', critical: '🚨' };
  const box = $('#log-list');
  if (!rows.length) { box.replaceChildren(el('div', { class: 'empty', text: 'Пусто' })); return; }
  box.replaceChildren(...rows.map((r) => mode === 'events'
    ? el('div', { class: 'log-row' }, el('time', { text: fmtTime(r.ts) }), (icons[r.level] || '') + ' ' + r.message)
    : el('div', { class: 'log-row' }, el('time', { text: fmtTime(r.ts) }),
      `${r.ok ? '✅' : '❌'} [${r.source}] ${r.action}${r.arg ? ' «' + r.arg.slice(0, 60) + '»' : ''}`)));
}

async function loadSettings() {
  const tg = INFO.telegram;
  let text;
  if (!tg.enabled) text = 'Telegram не настроен: укажите telegram.token в config.yaml и перезапустите агент.';
  else {
    text = `Telegram-бот${tg.bot ? ' @' + tg.bot : ''}, привязано пользователей: ${tg.users}. `;
    text += `Код привязки нового телефона: /pair ${tg.pair_code}`;
  }
  $('#tg-info').textContent = text;
  try {
    const sessions = await api('/api/sessions');
    $('#sessions').replaceChildren(...sessions.map((s) =>
      el('div', { class: 'log-row' }, el('time', { text: fmtTime(s.last_seen) }), `${s.ip} · ${(s.user_agent || '').slice(0, 60)}`)));
  } catch (e) { /* ignore */ }
  try {
    const s = await api('/api/status');
    $('#notif-toggle').checked = !s.notifications_muted;
  } catch (e) { /* ignore */ }
}

$('#notif-toggle').addEventListener('change', async (e) => {
  try {
    await api('/api/notifications', { json: { muted: !e.target.checked } });
    toast(e.target.checked ? 'Уведомления включены' : 'Уведомления выключены (кроме критических)', 'ok');
  } catch (err) { toast(err.message, 'err'); }
});

$('#pwd-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/password', { json: { old: $('#pwd-old').value, new: $('#pwd-new').value } });
    toast('Пароль изменён. Войдите заново.', 'ok');
    setTimeout(showLogin, 1200);
  } catch (err) { toast(err.message, 'err'); }
});

$('#revoke-all').addEventListener('click', async () => {
  if (!(await confirmDialog('Завершить все сеансы веб-панели (включая этот)?'))) return;
  try { await api('/api/sessions/revoke_all', { method: 'POST' }); } catch (e) { /* ignore */ }
  showLogin();
});

$('#logout').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
  showLogin();
});

$('#terminal-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const cmd = $('#terminal-input').value.trim();
  if (!cmd) return;
  const out = $('#terminal-output');
  out.textContent = '$ ' + cmd + '\nВыполняется…';
  try {
    const res = await api('/api/action/shell', { json: { arg: cmd } });
    out.textContent = res.result;
  } catch (err) { out.textContent = err.message; }
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && token && currentTab === 'home') loadStatus();
});

// ================= Старт =================
(async () => {
  if (!token) { showLogin(); return; }
  try { await startApp(); } catch (e) { showLogin(); }
})();
